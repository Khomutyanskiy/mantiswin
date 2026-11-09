// Живые источники кадров: камера компьютера (getUserMedia) и IP-камера через локальный мост (bridge/).
// Подсчёт берёт кадры одинаково: grab() → ImageBitmap.

export interface LiveSource {
  kind: "webcam" | "ip";
  label: string;
  width: number;
  height: number;
  /** Свежий кадр. Для IP-камеры ждёт новый кадр, если прошлый уже отдан. */
  grab(): Promise<ImageBitmap>;
  /** Видео-элемент камеры компьютера — для быстрого предпросмотра. */
  video?: HTMLVideoElement;
  /** Источник отвалился (камеру выдернули, мост перестал отвечать). */
  lost(): boolean;
  close(): void;
}

export async function openWebcam(cameraId: string | null): Promise<LiveSource> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { ...(cameraId ? { deviceId: { exact: cameraId } } : {}), width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) await new Promise((r) => (video.onloadedmetadata = r));
  const track = stream.getVideoTracks()[0];
  let ended = false;
  track?.addEventListener("ended", () => (ended = true));
  return {
    kind: "webcam",
    label: track?.label || "Камера",
    width: video.videoWidth,
    height: video.videoHeight,
    video,
    grab: () => createImageBitmap(video),
    lost: () => ended || track?.readyState === "ended",
    close: () => {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

// ---------------------------------------------------------------- мост IP-камер

export interface BridgeInfo {
  ok: boolean;
  ffmpeg: string | null;
  subnets: string[];
}

export interface FoundCamera {
  ip: string;
  name?: string;
  hardware?: string;
  onvifURL?: string;
  rtspPorts: number[];
  templates: { title: string; url: string }[];
  /** Телефон Android с IP Webcam (RTSP на порту 8080). */
  android?: boolean;
}

export interface IpCameraConfig {
  url: string;
  user: string;
  password: string;
  /** Как показывать в списке: название и адрес. */
  title: string;
}

async function api<T>(path: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(new URL(`api/${path}`, new URL(import.meta.env.BASE_URL, location.href)), { ...init, signal: ctl.signal });
    const isJson = r.headers.get("content-type")?.includes("json");
    const data = isJson ? await r.json() : null;
    if (!r.ok) throw new Error((data as { error?: string } | null)?.error ?? `Мост ответил ${r.status}`);
    return data as T;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("Мост не ответил вовремя");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Есть ли мост (страница открыта через npm run dev / npm run serve на этом компьютере). */
export async function bridgeInfo(): Promise<BridgeInfo | null> {
  try {
    return await api<BridgeInfo>("bridge", undefined, 4000);
  } catch {
    return null;
  }
}

export function scanCameras(): Promise<{ subnets: { description: string }[]; cameras: FoundCamera[] }> {
  return api("cameras/scan", undefined, 30_000);
}

export function onvifStream(onvifURL: string, user: string, password: string): Promise<{ uri: string; profile: string; profiles: number }> {
  return api("cameras/onvif", json({ onvifURL, user, password }), 20_000);
}

interface StreamStatus {
  id: string;
  state: "connecting" | "reconnecting" | "live" | "error";
  error: string | null;
  width: number;
  height: number;
  seq: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Подключить IP-камеру: мост запускает ffmpeg, ждём первый кадр (до timeoutMs).
 * onStatus — что сейчас происходит (для подписи «Подключаюсь…»).
 */
export async function openIpCamera(
  cfg: IpCameraConfig, onStatus?: (s: string) => void, timeoutMs = 25_000, cancelled: () => boolean = () => false,
): Promise<LiveSource> {
  onStatus?.("Подключаюсь к камере…");
  let st = await api<StreamStatus>("streams", json({ url: cfg.url, user: cfg.user, password: cfg.password }));
  const id = st.id;
  const started = Date.now();
  let first: Blob | null = null;
  let seq = 0;
  while (!first) {
    if (cancelled()) {
      // подключение больше не нужно (окно закрыли, пилот остановили) — не ждём 25 с
      await api(`streams/${id}`, { method: "DELETE" }).catch(() => undefined);
      throw new Error("подключение отменено");
    }
    const r = await fetch(new URL(`api/streams/${id}/frame`, new URL(import.meta.env.BASE_URL, location.href)));
    if (r.status === 200) {
      first = await r.blob();
      seq = Number(r.headers.get("X-Frame-Seq") ?? 0);
      break;
    }
    st = (await r.json().catch(() => st)) as StreamStatus;
    // ошибка, на которую нет смысла ждать (пароль, путь) — сразу говорим
    if (st.state === "error" && st.error && /логин|пароль|адрес потока|отказала/.test(st.error)) {
      await api(`streams/${id}`, { method: "DELETE" }).catch(() => undefined);
      throw new Error(st.error);
    }
    if (Date.now() - started > timeoutMs) {
      await api(`streams/${id}`, { method: "DELETE" }).catch(() => undefined);
      throw new Error(st.error ?? "Камера не прислала ни одного кадра");
    }
    onStatus?.(st.state === "error" && st.error ? `${st.error}. Пробую ещё раз…` : "Жду первый кадр…");
    await sleep(400);
  }
  const bmp = await createImageBitmap(first);
  const width = bmp.width, height = bmp.height;
  bmp.close();

  let lastOk = Date.now();
  let closed = false;
  const frameUrl = new URL(`api/streams/${id}/frame`, new URL(import.meta.env.BASE_URL, location.href));
  return {
    kind: "ip",
    label: cfg.title,
    width,
    height,
    async grab() {
      // ждём кадр новее прошлого (камера даёт ~15 кадр/с), но не дольше 3 с
      const t0 = Date.now();
      for (;;) {
        if (closed) throw new Error("Камера отключена");
        const stale = Date.now() - t0 > 3000; // камера «замерла» — отдадим прошлый кадр, чтобы подсчёт шёл
        frameUrl.search = stale ? "" : `?after=${seq}`;
        const r = await fetch(frameUrl, { cache: "no-store" });
        if (r.status === 200) {
          seq = Number(r.headers.get("X-Frame-Seq") ?? 0);
          lastOk = Date.now();
          return createImageBitmap(await r.blob());
        } else if (r.status === 204) {
          lastOk = Date.now();
        } else if (r.status === 404) {
          throw new Error("Мост потерял поток камеры");
        } else if (Date.now() - lastOk > 20_000) {
          const err = (await r.json().catch(() => null)) as { error?: string } | null;
          throw new Error(err?.error ?? "Камера не присылает кадры");
        }
        await sleep(25);
      }
    },
    lost: () => closed || Date.now() - lastOk > 30_000,
    close() {
      if (closed) return; // мост считает зрителей — закрываем один раз
      closed = true;
      void api(`streams/${id}`, { method: "DELETE" }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------- сохранённая IP-камера

const IP_KEY = "mantis.ipcam.v1";

export function loadIpCamera(): IpCameraConfig | null {
  try {
    const c = JSON.parse(localStorage.getItem(IP_KEY) ?? "null") as IpCameraConfig | null;
    return c?.url ? c : null;
  } catch {
    return null;
  }
}

export function saveIpCamera(c: IpCameraConfig | null): void {
  try {
    if (c) localStorage.setItem(IP_KEY, JSON.stringify(c));
    else localStorage.removeItem(IP_KEY);
  } catch {
    /* нет */
  }
}

// ---------------------------------------------------------------- автоподключение и поворот (как на Mac)

export interface AutoFound {
  url: string;
  user: string;
  password: string;
  codec: string;
  /** Как нашли: ONVIF, путь марки, Android. */
  how: string;
}

export type AutoOutcome = { state: "ok"; found: AutoFound } | { state: "needsPassword" } | { state: "failed"; message: string };

/** Подобрать адрес потока и вход найденной камеры (известные пароли — первыми, затем заводские). */
export function autoConnect(cam: FoundCamera, known: [string, string][], maxWrong = 3): Promise<AutoOutcome> {
  return api("cameras/auto", json({ cam, known, maxWrong }), 90_000);
}

export interface PtzInfo {
  ptzURL: string;
  profile: string;
  user: string;
  password: string;
  zoom: boolean;
}

/** Умеет ли камера поворачиваться (ONVIF PTZ). null — нет. */
export async function ptzProbe(cfg: IpCameraConfig): Promise<PtzInfo | null> {
  let host = "";
  try {
    host = new URL(cfg.url).hostname;
  } catch {
    return null;
  }
  try {
    return (await api<{ ptz: PtzInfo | null }>("ptz/probe", json({ host, user: cfg.user, password: cfg.password }), 25_000)).ptz;
  } catch {
    return null;
  }
}

export function ptzMove(ptz: PtzInfo, pan: number, tilt: number, zoom = 0): Promise<unknown> {
  return api("ptz/move", json({ ptz, pan, tilt, zoom }), 6000).catch(() => undefined);
}

export function ptzStop(ptz: PtzInfo): Promise<unknown> {
  return api("ptz/stop", json({ ptz }), 6000).catch(() => undefined);
}
