// Автоподключение найденной IP-камеры и поворот по ONVIF — порт IPAutoConnect.swift и ONVIFPTZ.swift (Mantis для Mac).
//   • Android (IP Webcam) — адрес известен.
//   • ONVIF — камера сама отдаёт RTSP-ссылку (логин и пароль: уже известные, затем заводские).
//   • Только RTSP — пробуем пути популярных марок (Hikvision, Dahua, Uniview, TP-Link и др.).
// Проверка — запрос DESCRIBE: 200 — поток есть, 404 — не тот путь, 401 — нужен пароль.
// Неверных паролей пробуем немного (не больше 3 на камеру) — многие камеры блокируют вход после 5–7 ошибок.

import net from "node:net";
import { OnvifError, httpAuthorization, onvifStreamUri, soapCall, xmlAll, xmlAttrs, xmlFirst } from "./onvif.mjs";

/** Пути потоков популярных марок (дополнительный поток 720p — где он есть). */
export const PATHS = [
  ["Hikvision", "/Streaming/Channels/102"],
  ["Dahua", "/cam/realmonitor?channel=1&subtype=1"],
  ["Uniview", "/media/video2"],
  ["TP-Link VIGI / Tapo", "/stream2"],
  ["RTSP", "/stream1"],
  ["RTSP", "/live/ch1"],
  ["RTSP", "/h264"],
  ["RTSP", "/11"],
  ["RTSP", "/live"],
  ["RTSP", "/cam"], // тестовая камера mediamtx
  ["RTSP", "/"],
];

/** Заводские входы — после тех, что уже известны. */
export const FACTORY = [["admin", ""], ["admin", "admin"], ["admin", "12345"]];

export const androidUrl = (ip) => `rtsp://${ip}:8080/h264_ulaw.sdp`;

/** Один запрос RTSP по TCP: ответ {status, headers, body}. */
function rtspExchange(host, port, request, timeout = 3500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeout, () => done(null));
    s.on("error", () => done(null));
    s.on("connect", () => s.write(request));
    s.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      const text = buf.toString("latin1");
      const end = text.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = text.slice(0, end);
      const status = Number(/^RTSP\/1\.0 (\d+)/.exec(head)?.[1] ?? 0);
      const headers = {};
      for (const line of head.split("\r\n").slice(1)) {
        const i = line.indexOf(":");
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const len = Number(headers["content-length"] ?? 0);
      if (buf.length >= end + 4 + len) done({ status, headers, body: buf.subarray(end + 4, end + 4 + len).toString("utf8") });
    });
  });
}

/** Запрос DESCRIBE: код ответа и кодек видео (если поток есть). */
export async function describe(url, user = "", password = "") {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { status: 0, codec: null };
  }
  if (u.username && !user) {
    user = decodeURIComponent(u.username);
    password = decodeURIComponent(u.password);
  }
  u.username = "";
  u.password = "";
  const host = u.hostname, port = Number(u.port) || 554;
  const reqUrl = u.toString();
  const msg = (cseq, auth) =>
    `DESCRIBE ${reqUrl} RTSP/1.0\r\nCSeq: ${cseq}\r\nAccept: application/sdp\r\nUser-Agent: Mantis\r\n${auth ? `Authorization: ${auth}\r\n` : ""}\r\n`;
  let r = await rtspExchange(host, port, msg(1));
  if (!r) return { status: 0, codec: null };
  if (r.status === 401 && user && r.headers["www-authenticate"]) {
    r = await rtspExchange(host, port, msg(2, httpAuthorization(r.headers["www-authenticate"], "DESCRIBE", reqUrl, user, password)));
    if (!r) return { status: 0, codec: null };
  }
  if (r.status !== 200) return { status: r.status, codec: null };
  const video = r.body.split(/\r?\n(?=m=)/).find((b) => b.startsWith("m=video"));
  if (!video) return { status: 200, codec: null };
  const map = /a=rtpmap:\d+\s+([A-Za-z0-9-]+)\//.exec(video)?.[1]?.toUpperCase();
  return { status: 200, codec: map === "H265" || map === "HEVC" ? "H265" : map || "H264" };
}

/** Есть ли RTSP-сервер IP Webcam (Android) на порту 8080. */
export async function isAndroid(ip) {
  const r = await rtspExchange(ip, 8080, `OPTIONS ${androidUrl(ip)} RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: Mantis\r\n\r\n`, 1500);
  return !!r && r.status > 0;
}

/**
 * Подобрать адрес потока и вход. known — логины и пароли уже добавленных камер (пробуются первыми).
 * Ответ: {state:"ok", found:{url,user,password,codec,how}} | {state:"needsPassword"} | {state:"failed", message}.
 */
export async function resolveCamera(cam, known = [], maxWrongLogins = 3) {
  if (cam.android) {
    const url = androidUrl(cam.ip);
    const r = await describe(url);
    if (r.codec) return { state: "ok", found: { url, user: "", password: "", codec: r.codec, how: "Android · IP Webcam" } };
    return { state: "failed", message: "Телефон не отдаёт видео — откройте IP Webcam и нажмите «Запустить»" };
  }
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const creds = [];
  for (const c of [...known, ...FACTORY]) if (!creds.some((x) => same(x, c))) creds.push(c);
  const isKnown = (c) => known.some((k) => same(k, c));
  let wrongLeft = maxWrongLogins;
  let sawAuth = false;

  // 1. ONVIF — точный адрес от самой камеры
  if (cam.onvifURL) {
    for (const [u, p] of creds) {
      try {
        const info = await onvifStreamUri(cam.onvifURL, u, p);
        const r = await describe(info.uri, u, p);
        if (r.codec) return { state: "ok", found: { url: info.uri, user: u, password: p, codec: r.codec, how: "ONVIF" } };
        break; // ссылку дали, но поток не открылся — пробуем пути марок
      } catch (e) {
        if (e instanceof OnvifError && /логин|пароль/i.test(e.message)) {
          sawAuth = true;
          if (!isKnown([u, p])) wrongLeft -= 1;
          if (wrongLeft <= 0) return { state: "needsPassword" };
        } else break;
      }
    }
  }

  // 2. Пути популярных марок
  const ports = (cam.rtspPorts ?? []).filter((p) => p !== 8080);
  let goodLogin = null;
  for (const port of ports.length ? ports : [554]) {
    for (const [brand, path] of PATHS) {
      const url = `rtsp://${cam.ip}:${port}${path}`;
      if (goodLogin) {
        const r = await describe(url, goodLogin[0], goodLogin[1]);
        if (r.codec) return { state: "ok", found: { url, user: goodLogin[0], password: goodLogin[1], codec: r.codec, how: brand } };
        continue;
      }
      const open = await describe(url);
      if (open.codec) return { state: "ok", found: { url, user: "", password: "", codec: open.codec, how: brand } };
      if (open.status !== 401) continue; // не тот путь или не RTSP
      sawAuth = true;
      // ищем вход: верный вход даёт 200 (тот путь) или 404 (вход верный, путь — нет)
      for (const c of creds) {
        if (!c[0]) continue;
        if (!isKnown(c) && wrongLeft <= 0) continue;
        const r = await describe(url, c[0], c[1]);
        if (r.codec) return { state: "ok", found: { url, user: c[0], password: c[1], codec: r.codec, how: brand } };
        if (r.status === 404) {
          goodLogin = c;
          break;
        }
        if (r.status === 401 && !isKnown(c)) wrongLeft -= 1;
      }
      // вход не зависит от пути: не подошёл здесь — не подойдёт и дальше
      if (!goodLogin) return { state: "needsPassword" };
    }
  }
  if (sawAuth && !goodLogin) return { state: "needsPassword" };
  return { state: "failed", message: "Не удалось подобрать адрес потока — укажите его вручную" };
}

// ---------------------------------------------------------------- поворот (ONVIF PTZ)

/** Порты, на которых камеры обычно держат ONVIF. */
const PTZ_PORTS = [80, 8000, 8080, 2020, 8899, 5000, 888];

/** Проверить камеру: есть ли поворот. null — нет ONVIF или нет PTZ. */
export async function ptzProbe({ host, onvifURL, user = "", password = "" }) {
  const urls = [...(onvifURL ? [onvifURL] : []), ...PTZ_PORTS.map((p) => `http://${host}:${p}/onvif/device_service`)];
  for (const device of urls) {
    let caps;
    try {
      caps = await soapCall(device, user, password, `<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>All</Category></GetCapabilities>`, 2500);
    } catch {
      continue;
    }
    // камера ответила по ONVIF — дальше другие порты не пробуем
    const ptzBlock = xmlFirst("PTZ", caps);
    const ptzURL = ptzBlock && xmlFirst("XAddr", ptzBlock);
    if (!ptzURL) return null;
    let mediaURL = device;
    const media = xmlFirst("Media", caps);
    const mx = media && xmlFirst("XAddr", media);
    if (mx) mediaURL = mx;
    let prof;
    try {
      prof = await soapCall(mediaURL, user, password, `<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>`);
    } catch {
      return null;
    }
    const tokens = xmlAttrs("token", "Profiles", prof);
    const bodies = xmlAll("Profiles", prof);
    if (!tokens.length) return null;
    // профиль, у которого настроен PTZ; иначе первый
    let token = tokens[0];
    bodies.forEach((b, i) => {
      if (i < tokens.length && token === tokens[0] && xmlFirst("PTZConfiguration", b)) token = tokens[i];
    });
    let zoom = false;
    try {
      const nodes = await soapCall(ptzURL, user, password, `<GetNodes xmlns="http://www.onvif.org/ver20/ptz/wsdl"/>`);
      zoom = (xmlFirst("SupportedPTZSpaces", nodes) ?? "").includes("ContinuousZoomVelocitySpace");
    } catch {
      /* без зума */
    }
    return { ptzURL, profile: token, user, password, zoom };
  }
  return null;
}

const f2 = (v) => Math.min(1, Math.max(-1, Number(v) || 0)).toFixed(2);

/** Крутить камеру со скоростью −1…1 (pan: вправо +, tilt: вверх +, zoom: приблизить +). */
export async function ptzMove(i, pan, tilt, zoom) {
  let velocity = "";
  if (Number(pan) || Number(tilt)) velocity += `<PanTilt xmlns="http://www.onvif.org/ver10/schema" x="${f2(pan)}" y="${f2(tilt)}"/>`;
  if (Number(zoom)) velocity += `<Zoom xmlns="http://www.onvif.org/ver10/schema" x="${f2(zoom)}"/>`;
  await soapCall(i.ptzURL, i.user, i.password,
    `<ContinuousMove xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${i.profile}</ProfileToken><Velocity>${velocity}</Velocity></ContinuousMove>`);
}

export async function ptzStop(i) {
  await soapCall(i.ptzURL, i.user, i.password,
    `<Stop xmlns="http://www.onvif.org/ver20/ptz/wsdl"><ProfileToken>${i.profile}</ProfileToken><PanTilt>true</PanTilt><Zoom>true</Zoom></Stop>`);
}
