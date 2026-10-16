// Поиск IP-камер в локальной сети и получение RTSP-ссылки через ONVIF.
// Порт iOS CameraDiscovery.swift: WS-Discovery Probe на каждый адрес подсети /24 (и групповой адрес),
// проверка портов RTSP 554/8554, затем GetCapabilities → GetProfiles → GetStreamUri с WS-Security.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import dgram from "node:dgram";
import http from "node:http";
import net from "node:net";
import os from "node:os";

// ---------------------------------------------------------------- подсети

const ipToInt = (ip) => ip.split(".").reduce((a, b) => ((a << 8) | Number(b)) >>> 0, 0);
const intToIp = (v) => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");

/** Локальные IPv4-сети компьютера (Wi-Fi/Ethernet), каждая ужата до /24 вокруг своего адреса. */
export function localSubnets() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^(utun|awdl|llw|bridge1\d|docker|veth|vmnet|vboxnet|tun|tap)/.test(name)) continue;
      if (a.address.startsWith("169.254.")) continue;
      const ip = ipToInt(a.address);
      const maskBits = Math.max(24, a.cidr ? Number(a.cidr.split("/")[1]) : 24);
      const mask = maskBits >= 32 ? 0xffffffff : (0xffffffff << (32 - maskBits)) >>> 0;
      const netw = (ip & mask) >>> 0;
      const bcast = (netw | (~mask >>> 0)) >>> 0;
      const hosts = [];
      for (let h = netw + 1; h < bcast; h++) if (h !== ip) hosts.push(intToIp(h));
      out.push({ iface: name, address: a.address, description: `${intToIp(netw)}/${maskBits}`, hosts });
    }
  }
  // en0 (Wi-Fi на Mac) первым
  return out.sort((a, b) => (a.iface === "en0" ? -1 : b.iface === "en0" ? 1 : 0)).slice(0, 3);
}

// ---------------------------------------------------------------- мини-XML

const unescapeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function xmlAll(tag, xml) {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${tag}>`, "g");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(unescapeXml(m[1].trim()));
  return out;
}
export const xmlFirst = (tag, xml) => xmlAll(tag, xml)[0] ?? null;
export function xmlAttrs(attr, tag, xml) {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tag}\\s[^>]*\\b${attr}="([^"]+)"`, "g");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

// ---------------------------------------------------------------- WS-Discovery

const probeMessage = () =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ` +
  `xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">` +
  `<e:Header><w:MessageID>uuid:${randomUUID()}</w:MessageID>` +
  `<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>` +
  `<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>` +
  `</e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`;

/** Разобрать ответ ProbeMatch: адрес ONVIF, название, модель. */
export function parseProbeMatch(ip, xml, cam = { ip, rtspPorts: [] }) {
  if (!xml.includes("ProbeMatch")) return null;
  const x = xmlFirst("XAddrs", xml);
  if (x) {
    const urls = x.split(/\s+/).filter(Boolean);
    cam.onvifURL = urls.find((u) => u.includes(ip)) ?? urls[0];
  }
  const scopes = xmlFirst("Scopes", xml);
  if (scopes) {
    for (const sc of scopes.split(/\s+/)) {
      const dec = (v) => {
        try {
          return decodeURIComponent(v);
        } catch {
          return v;
        }
      };
      if (sc.startsWith("onvif://www.onvif.org/name/")) cam.name = dec(sc.slice(27)).replace(/_/g, " ");
      else if (sc.startsWith("onvif://www.onvif.org/hardware/")) cam.hardware = dec(sc.slice(31));
    }
  }
  return cam;
}

/** Probe на каждый адрес и на групповой адрес 239.255.255.250, ждём ответы timeout мс. */
export function probeOnvif(hosts, { timeout = 3000, port = 3702, extraTargets = [] } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("error", () => undefined);
    sock.on("message", (msg, rinfo) => {
      const cam = parseProbeMatch(rinfo.address, msg.toString("utf8"), found.get(rinfo.address));
      if (cam) found.set(rinfo.address, cam);
    });
    sock.bind(0, async () => {
      const probe = Buffer.from(probeMessage());
      try {
        sock.send(probe, 3702, "239.255.255.250");
      } catch {
        /* групповая рассылка может быть закрыта — есть адресная */
      }
      const targets = [...extraTargets, ...hosts.map((h) => [h, port])];
      for (let i = 0; i < targets.length; i++) {
        const [h, p] = Array.isArray(targets[i]) ? targets[i] : [targets[i], port];
        sock.send(probe, p, h, () => undefined);
        if (i % 32 === 31) await new Promise((r) => setTimeout(r, 3));
      }
      setTimeout(() => {
        sock.close();
        resolve(found);
      }, timeout);
    });
  });
}

/** Какие адреса принимают TCP-соединение на портах (пачками по 128, таймаут 600 мс). */
export async function scanPorts(hosts, ports, timeout = 600) {
  const targets = hosts.flatMap((h) => ports.map((p) => [h, p]));
  const open = new Map();
  const tryOne = ([h, p]) =>
    new Promise((resolve) => {
      const s = net.connect({ host: h, port: p });
      const done = (ok) => {
        s.destroy();
        if (ok) open.set(h, [...(open.get(h) ?? []), p]);
        resolve();
      };
      s.setTimeout(timeout, () => done(false));
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
    });
  for (let i = 0; i < targets.length; i += 128) await Promise.all(targets.slice(i, i + 128).map(tryOne));
  return open;
}

/** Полный поиск: ONVIF и порты RTSP параллельно, 3–4 секунды. */
export async function scanCameras({ subnets = localSubnets(), extraTargets = [] } = {}) {
  const hosts = subnets.flatMap((s) => s.hosts);
  const [onvif, ports] = await Promise.all([probeOnvif(hosts, { extraTargets }), scanPorts(hosts, [554, 8554])]);
  const byIp = new Map(onvif);
  for (const [ip, list] of ports) {
    const cam = byIp.get(ip) ?? { ip, rtspPorts: [] };
    cam.rtspPorts = [...list].sort((a, b) => a - b);
    byIp.set(ip, cam);
  }
  const cameras = [...byIp.values()].sort((a, b) => {
    if (!!a.onvifURL !== !!b.onvifURL) return a.onvifURL ? -1 : 1;
    return ipToInt(a.ip) - ipToInt(b.ip);
  });
  return { subnets: subnets.map((s) => ({ iface: s.iface, address: s.address, description: s.description })), cameras };
}

// ---------------------------------------------------------------- ONVIF SOAP

function security(user, password) {
  if (!user) return "";
  const nonce = randomBytes(16);
  const created = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const digest = createHash("sha1").update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password)])).digest("base64");
  return (
    `<Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">` +
    `<UsernameToken><Username>${escapeXml(user)}</Username>` +
    `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>` +
    `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-soap-message-security-1.0#Base64Binary">${nonce.toString("base64")}</Nonce>` +
    `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>` +
    `</UsernameToken></Security>`
  );
}

const escapeXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** HTTP-запрос к камере (без проверки сертификатов — только http в локальной сети). */
function httpRequest(urlStr, { method = "POST", body = "", headers = {}, timeout = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request(
      { host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers: { ...headers, "Content-Length": Buffer.byteLength(body) }, timeout },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ code: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("камера не отвечает")));
    req.on("error", reject);
    req.end(body);
  });
}

/** Заголовок Authorization для HTTP Basic или Digest (в т.ч. qop=auth). */
export function httpAuthorization(challenge, method, uri, user, password) {
  if (!/digest/i.test(challenge)) return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  const value = (k) => new RegExp(`${k}="([^"]*)"`, "i").exec(challenge)?.[1];
  const md5 = (s) => createHash("md5").update(s).digest("hex");
  const realm = value("realm") ?? "", nonce = value("nonce") ?? "";
  const ha1 = md5(`${user}:${realm}:${password}`), ha2 = md5(`${method}:${uri}`);
  let h = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}"`;
  const qop = value("qop");
  if (qop && qop.includes("auth")) {
    const cnonce = randomBytes(4).toString("hex"), nc = "00000001";
    h += `, qop=auth, nc=${nc}, cnonce="${cnonce}", response="${md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)}"`;
  } else {
    h += `, response="${md5(`${ha1}:${nonce}:${ha2}`)}"`;
  }
  const opaque = value("opaque");
  if (opaque) h += `, opaque="${opaque}"`;
  return h;
}

export class OnvifError extends Error {}

async function soapCall(url, user, password, body) {
  const envelope =
    `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Header>${security(user, password)}</s:Header>` +
    `<s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">${body}</s:Body></s:Envelope>`;
  const headers = { "Content-Type": "application/soap+xml; charset=utf-8", "User-Agent": "Mantis" };
  let r = await httpRequest(url, { body: envelope, headers });
  if (r.code === 401 && user && r.headers["www-authenticate"]) {
    const u = new URL(url);
    const auth = httpAuthorization(String(r.headers["www-authenticate"]), "POST", u.pathname + u.search, user, password);
    r = await httpRequest(url, { body: envelope, headers: { ...headers, Authorization: auth } });
  }
  if (r.code === 401 || /NotAuthorized|FailedAuthentication/.test(r.body)) throw new OnvifError("Неверный логин или пароль камеры");
  if (r.code < 200 || r.code >= 300) {
    const reason = xmlFirst("Text", r.body);
    throw new OnvifError(reason ? `Камера: ${reason}` : `Камера ответила HTTP ${r.code}`);
  }
  return r.body;
}

/** RTSP-ссылка дополнительного потока (второй профиль; если его нет — основной), как в iOS. */
export async function onvifStreamUri(deviceURL, user, password, { main = false } = {}) {
  const caps = await soapCall(deviceURL, user, password,
    `<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>All</Category></GetCapabilities>`);
  let mediaURL = deviceURL;
  const media = xmlFirst("Media", caps);
  const x = media && xmlFirst("XAddr", media);
  if (x) mediaURL = x;
  const prof = await soapCall(mediaURL, user, password, `<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>`);
  const tokens = xmlAttrs("token", "Profiles", prof);
  if (!tokens.length) throw new OnvifError("В камере нет видеопрофилей");
  const token = !main && tokens.length > 1 ? tokens[1] : tokens[0];
  const uriXml = await soapCall(mediaURL, user, password,
    `<GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl"><StreamSetup>` +
      `<Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream>` +
      `<Transport xmlns="http://www.onvif.org/ver10/schema"><Protocol>RTSP</Protocol></Transport>` +
      `</StreamSetup><ProfileToken>${escapeXml(token)}</ProfileToken></GetStreamUri>`);
  const uri = xmlFirst("Uri", uriXml);
  if (!uri || !uri.toLowerCase().startsWith("rtsp")) throw new OnvifError("Камера не отдала RTSP-ссылку");
  return { uri, profile: token, profiles: tokens.length };
}

/** Шаблоны путей для камер без ONVIF — как в iOS. */
export function templates(cam) {
  const port = cam.rtspPorts?.[0] ?? 554;
  const base = `rtsp://${cam.ip}:${port}`;
  const t = [
    { title: "Hikvision", url: `${base}/Streaming/Channels/102` },
    { title: "Dahua", url: `${base}/cam/realmonitor?channel=1&subtype=1` },
    { title: "Uniview", url: `${base}/media/video2` },
    { title: "TP-Link VIGI / Tapo", url: `${base}/stream2` },
  ];
  if (port === 8554) t.unshift({ title: "Тестовая камера (mediamtx)", url: `${base}/cam` });
  return t;
}
