// HTTP API моста для страницы Mantis (тот же адрес, что и сама страница):
//   GET    /api/bridge                 — мост работает? есть ли ffmpeg
//   GET    /api/cameras/scan           — поиск камер в локальной сети
//   POST   /api/cameras/onvif          — {onvifURL, user, password, main?} → RTSP-ссылка
//   POST   /api/streams                — {url, user, password} → открыть поток
//   GET    /api/streams/:id            — состояние потока
//   GET    /api/streams/:id/frame      — последний кадр JPEG (заголовки X-Frame-Seq, X-Frame-Size)
//   POST   /api/cameras/auto           — {cam, known} → адрес потока и вход подобраны сами
//   POST   /api/ptz/probe | move | stop — поворот камеры по ONVIF
//   /api/video/*                       — видео мониторинга на диске (bridge/video.mjs)
//   DELETE /api/streams/:id            — закрыть поток (ffmpeg останавливается, когда закрыли все, кто открыл)
// Мост слушает только этот компьютер: пароли камер и видео не уходят в интернет.

import { OnvifError, localSubnets, onvifStreamUri, scanCameras, templates } from "./onvif.mjs";
import { StreamManager } from "./streams.mjs";
import { VideoStore, handleVideo } from "./video.mjs";
import { isAndroid, ptzMove, ptzProbe, ptzStop, resolveCamera } from "./autoconnect.mjs";

function send(res, code, data, headers = {}) {
  const body = typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": typeof data === "string" || Buffer.isBuffer(data) ? "application/octet-stream" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...headers,
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 100_000) reject(new Error("слишком большой запрос"));
      else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("неверный JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Запросы только с этого же компьютера (страница открыта на localhost). */
function isLocal(req) {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

/** MANTIS_EXTRA_PROBE="10.0.0.5:3702,127.0.0.1:3702" — куда ещё слать ONVIF-поиск (другая подсеть, тесты). */
function envTargets() {
  return (process.env.MANTIS_EXTRA_PROBE ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [h, p] = s.split(":");
      return [h, Number(p) || 3702];
    });
}

/** extraTargets — дополнительные адреса для ONVIF-поиска [[host, port]] (для тестов). */
export function createBridge({ extraTargets = envTargets(), allowRemote = false, videoRoot = undefined } = {}) {
  const streams = new StreamManager();
  const video = new VideoStore(videoRoot);

  async function handle(req, res, next) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return next?.();
    if (!allowRemote && !isLocal(req)) return send(res, 403, { error: "Мост доступен только с этого компьютера" });
    const parts = url.pathname.split("/").filter(Boolean); // api, ...
    try {
      if (await handleVideo(video, req, res, url, send)) return;
      if (req.method === "GET" && url.pathname === "/api/bridge") {
        const ff = streams.ffmpeg();
        return send(res, 200, { ok: true, ffmpeg: ff ? ff.version : null, subnets: localSubnets().map((s) => s.description), video: true });
      }
      if (req.method === "GET" && url.pathname === "/api/cameras/scan") {
        const r = await scanCameras({ extraTargets, androidProbe: isAndroid });
        r.cameras = r.cameras.map((c) => ({ ...c, templates: c.onvifURL ? [] : templates(c) }));
        return send(res, 200, r);
      }
      // автоподключение найденной камеры: адрес потока и вход подбираются сами (IPAutoConnect на Mac)
      if (req.method === "POST" && url.pathname === "/api/cameras/auto") {
        const b = await readJson(req);
        if (!b.cam?.ip) return send(res, 400, { error: "Нет камеры" });
        const known = Array.isArray(b.known) ? b.known.filter((k) => Array.isArray(k) && k.length === 2).map((k) => [String(k[0]), String(k[1])]) : [];
        return send(res, 200, await resolveCamera(b.cam, known, Number.isFinite(b.maxWrong) ? b.maxWrong : 3));
      }
      // поворот камеры по ONVIF
      if (req.method === "POST" && url.pathname === "/api/ptz/probe") {
        const b = await readJson(req);
        return send(res, 200, { ptz: await ptzProbe({ host: String(b.host ?? ""), onvifURL: b.onvifURL || undefined, user: String(b.user ?? ""), password: String(b.password ?? "") }) });
      }
      if (req.method === "POST" && (url.pathname === "/api/ptz/move" || url.pathname === "/api/ptz/stop")) {
        const b = await readJson(req);
        if (!b.ptz?.ptzURL) return send(res, 400, { error: "Камера не поворачивается" });
        if (url.pathname.endsWith("stop")) await ptzStop(b.ptz);
        else await ptzMove(b.ptz, b.pan, b.tilt, b.zoom);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/cameras/onvif") {
        const b = await readJson(req);
        if (!b.onvifURL) return send(res, 400, { error: "Нет адреса ONVIF" });
        const r = await onvifStreamUri(String(b.onvifURL), String(b.user ?? ""), String(b.password ?? ""), { main: !!b.main });
        return send(res, 200, r);
      }
      if (parts[1] === "streams") {
        if (req.method === "POST" && parts.length === 2) {
          const b = await readJson(req);
          const u = String(b.url ?? "").trim();
          if (!/^rtsps?:\/\//i.test(u)) return send(res, 400, { error: "Адрес должен начинаться с rtsp://" });
          const s = streams.open(u, String(b.user ?? ""), String(b.password ?? ""), { fps: Number(b.fps) || 15 });
          return send(res, 200, s.status());
        }
        const s = parts[2] ? streams.get(parts[2]) : null;
        if (!s) return send(res, 404, { error: "Поток не найден — подключите камеру заново" });
        if (req.method === "GET" && parts.length === 3) return send(res, 200, s.status());
        if (req.method === "GET" && parts[3] === "frame") {
          // кадра ещё нет — 202, чтобы браузер не сыпал ошибками в консоль, пока камера подключается
          if (!s.frame) return send(res, 202, { ...s.status(), error: s.error ?? "Ждём первый кадр" });
          // ?after=N — кадр уже есть у страницы, нового пока нет: короткий ответ без картинки
          if (url.searchParams.get("after") === String(s.seq)) {
            res.writeHead(204, { "Cache-Control": "no-store", "X-Frame-Seq": String(s.seq) });
            return res.end();
          }
          return send(res, 200, s.frame, {
            "Content-Type": "image/jpeg",
            "X-Frame-Seq": String(s.seq),
            "X-Frame-Size": `${s.width}x${s.height}`,
          });
        }
        if (req.method === "DELETE" && parts.length === 3) {
          streams.release(s.id);
          return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { error: "Нет такого метода" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return send(res, e instanceof OnvifError ? 422 : 500, { error: msg });
    }
  }

  return { handle, streams, video, close: () => streams.closeAll() };
}
