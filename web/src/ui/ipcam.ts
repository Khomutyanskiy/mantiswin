// Окно «IP-камера» — как настройки IP-камеры в iOS: поиск в сети, вход по ONVIF, шаблоны марок, ручной адрес.
// Результат — подключённый источник кадров и настройки, которые можно сохранить для пилота.

import {
  type FoundCamera, type IpCameraConfig, type LiveSource, bridgeInfo, loadIpCamera, onvifStream, openIpCamera, scanCameras,
} from "../sources";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const EXAMPLES = [
  { brand: "Hikvision (доп. поток)", url: "rtsp://192.168.1.64:554/Streaming/Channels/102" },
  { brand: "Dahua (доп. поток)", url: "rtsp://192.168.1.108:554/cam/realmonitor?channel=1&subtype=1" },
  { brand: "Uniview", url: "rtsp://192.168.1.13:554/media/video2" },
  { brand: "TP-Link VIGI / Tapo", url: "rtsp://192.168.1.100:554/stream2" },
  { brand: "Тест с этого компьютера (mediamtx)", url: "rtsp://localhost:8554/cam" },
];

const dialog = () => $<HTMLDialogElement>("#ip-dialog");

let current: FoundCamera | null = null;
let titleHint = "";
let resolver: ((r: { cfg: IpCameraConfig; source: LiveSource } | null) => void) | null = null;
let wired = false;
let scannedOnce = false;

function show(section: "find" | "login" | "brand"): void {
  $("#ip-find").hidden = section !== "find";
  $("#ip-login").hidden = section !== "login";
  $("#ip-brand").hidden = section !== "brand";
  $("#ip-manual").hidden = section !== "find";
}

function setError(text: string | null): void {
  const e = $("#ip-error");
  e.hidden = !text;
  e.textContent = text ?? "";
}

function setProgress(text: string | null): void {
  const p = $("#ip-progress");
  p.hidden = !text;
  p.replaceChildren();
  if (text) {
    const sp = document.createElement("span");
    sp.className = "spinner";
    p.append(sp, document.createTextNode(text));
  }
}

function camTitle(c: FoundCamera): string {
  return c.name || c.hardware || (c.onvifURL ? "ONVIF-камера" : "Устройство с RTSP");
}

function camSubtitle(c: FoundCamera): string {
  const parts = [c.ip];
  if (c.hardware && c.hardware !== camTitle(c)) parts.push(c.hardware);
  if (c.onvifURL) parts.push("ONVIF");
  if (c.rtspPorts.length) parts.push("RTSP :" + c.rtspPorts.join(", :"));
  return parts.join(" · ");
}

async function scan(): Promise<void> {
  const list = $("#ip-results");
  const btn = $<HTMLButtonElement>("#ip-scan");
  btn.disabled = true;
  scannedOnce = true;
  const row = document.createElement("li");
  row.className = "empty-row";
  const sp = document.createElement("span");
  sp.className = "spinner";
  row.append(sp, document.createTextNode("Ищем камеры в сети…"));
  list.replaceChildren(row);
  try {
    const r = await scanCameras();
    $("#ip-subnet").textContent = r.subnets.map((s) => s.description).join(", ");
    if (!r.cameras.length) {
      const li = document.createElement("li");
      li.className = "empty-row";
      li.textContent = `Камеры не найдены${r.subnets.length ? ` в сети ${r.subnets.map((s) => s.description).join(", ")}` : ""}. Проверьте, что компьютер подключён к сети магазина, или введите адрес вручную.`;
      list.replaceChildren(li);
      return;
    }
    list.replaceChildren(
      ...r.cameras.map((c) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        const ico = document.createElement("span");
        ico.className = c.onvifURL ? "ico onvif" : "ico";
        const txt = document.createElement("span");
        const t = document.createElement("b");
        t.textContent = camTitle(c);
        const s = document.createElement("small");
        s.textContent = camSubtitle(c);
        txt.append(t, s);
        const ch = document.createElement("span");
        ch.className = "chev";
        ch.textContent = "›";
        b.append(ico, txt, ch);
        b.addEventListener("click", () => pick(c));
        li.append(b);
        return li;
      }),
    );
  } catch (e) {
    const li = document.createElement("li");
    li.className = "empty-row";
    li.textContent = `Поиск не удался: ${(e as Error).message}`;
    list.replaceChildren(li);
  } finally {
    btn.disabled = false;
  }
}

function pick(c: FoundCamera): void {
  current = c;
  titleHint = `${camTitle(c)} · ${c.ip}`;
  setError(null);
  if (c.onvifURL) {
    $("#ip-login-title").textContent = camTitle(c);
    $("#ip-login-ip").textContent = c.ip;
    show("login");
    $<HTMLInputElement>("#ip-login-pass").focus();
  } else {
    $("#ip-brand-ip").textContent = c.ip;
    $("#ip-brand-list").replaceChildren(
      ...c.templates.map((t) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = t.title;
        b.addEventListener("click", () => {
          $<HTMLInputElement>("#ip-url").value = t.url;
          titleHint = `${t.title} · ${c.ip}`;
          show("find");
          $<HTMLInputElement>("#ip-user").focus();
        });
        return b;
      }),
    );
    show("brand");
  }
}

async function onvifLogin(): Promise<void> {
  if (!current?.onvifURL) return;
  const user = $<HTMLInputElement>("#ip-login-user").value.trim();
  const pass = $<HTMLInputElement>("#ip-login-pass").value;
  const btn = $<HTMLButtonElement>("#ip-login-go");
  btn.disabled = true;
  setError(null);
  setProgress("Спрашиваю у камеры адрес видеопотока…");
  try {
    const r = await onvifStream(current.onvifURL, user, pass);
    $<HTMLInputElement>("#ip-url").value = r.uri;
    $<HTMLInputElement>("#ip-user").value = user;
    $<HTMLInputElement>("#ip-pass").value = pass;
    setProgress(null);
    show("find");
    // сразу подключаем — как в iOS после ввода пароля
    titleHint = `${camTitle(current)} · ${current.ip}`;
    await connect();
  } catch (e) {
    setProgress(null);
    setError((e as Error).message);
    show("login");
  } finally {
    btn.disabled = false;
  }
}

async function connect(): Promise<void> {
  const url = $<HTMLInputElement>("#ip-url").value.trim();
  if (!/^rtsps?:\/\//i.test(url)) {
    setError("Адрес должен начинаться с rtsp://");
    return;
  }
  const cfg: IpCameraConfig = {
    url,
    user: $<HTMLInputElement>("#ip-user").value.trim(),
    password: $<HTMLInputElement>("#ip-pass").value,
    title: titleHint || hostOf(url),
  };
  const btn = $<HTMLButtonElement>("#ip-connect");
  btn.disabled = true;
  setError(null);
  try {
    const source = await openIpCamera(cfg, (s) => setProgress(s));
    setProgress(null);
    const r = resolver;
    resolver = null;
    dialog().close();
    r?.({ cfg, source });
  } catch (e) {
    setProgress(null);
    setError((e as Error).message);
  } finally {
    btn.disabled = false;
  }
}

function hostOf(url: string): string {
  try {
    return `IP-камера · ${new URL(url.replace(/^rtsps?:/i, "http:")).hostname}`;
  } catch {
    return "IP-камера";
  }
}

function wire(): void {
  if (wired) return;
  wired = true;
  $("#ip-scan").addEventListener("click", scan);
  $("#ip-login-go").addEventListener("click", onvifLogin);
  $("#ip-login-back").addEventListener("click", () => show("find"));
  $("#ip-brand-back").addEventListener("click", () => show("find"));
  $("#ip-connect").addEventListener("click", connect);
  $<HTMLInputElement>("#ip-login-pass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void onvifLogin();
    }
  });
  $("#ip-examples").replaceChildren(
    ...EXAMPLES.map((x) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      const t = document.createElement("b");
      t.textContent = x.brand;
      const c = document.createElement("code");
      c.textContent = x.url;
      b.append(t, c);
      b.addEventListener("click", () => {
        $<HTMLInputElement>("#ip-url").value = x.url;
        titleHint = "";
      });
      li.append(b);
      return li;
    }),
  );
  dialog().addEventListener("close", () => {
    const r = resolver;
    resolver = null;
    r?.(null);
  });
}

/** Открыть окно. Возвращает подключённую камеру или null, если закрыли. */
export async function chooseIpCamera(): Promise<{ cfg: IpCameraConfig; source: LiveSource } | null> {
  wire();
  setError(null);
  setProgress(null);
  show("find");
  const saved = loadIpCamera();
  if (saved) {
    $<HTMLInputElement>("#ip-url").value = saved.url;
    $<HTMLInputElement>("#ip-user").value = saved.user;
    $<HTMLInputElement>("#ip-pass").value = saved.password;
    titleHint = saved.title;
  }
  dialog().showModal();
  const info = await bridgeInfo();
  $("#ip-nobridge").hidden = !!info;
  $("#ip-noffmpeg").hidden = !info || !!info.ffmpeg;
  const usable = !!info?.ffmpeg;
  $<HTMLButtonElement>("#ip-scan").disabled = !info;
  $<HTMLButtonElement>("#ip-connect").disabled = !usable;
  if (info && !scannedOnce) void scan();
  return new Promise((resolve) => (resolver = resolve));
}
