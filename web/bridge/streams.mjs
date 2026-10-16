// RTSP → JPEG-кадры через ffmpeg. Браузер не умеет читать RTSP, поэтому мост держит последний кадр
// каждой камеры в памяти, а страница забирает его запросом GET /api/streams/:id/frame.
// Обрыв потока — ffmpeg перезапускается сам; поток без зрителей минуту — останавливается.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);

/** Где взять ffmpeg: пакет ffmpeg-static (ставится с npm install) или системный (brew install ffmpeg). */
export function findFfmpeg() {
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try {
    const p = require("ffmpeg-static");
    if (typeof p === "string") candidates.push(p);
  } catch {
    /* пакета нет */
  }
  candidates.push("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", "ffmpeg");
  for (const c of candidates) {
    if (c !== "ffmpeg" && !existsSync(c)) continue;
    try {
      const r = spawnSync(c, ["-hide_banner", "-version"], { timeout: 5000 });
      if (r.status === 0) return { path: c, version: String(r.stdout).split("\n")[0].replace(/^ffmpeg version /, "").split(" ")[0] };
    } catch {
      /* следующий */
    }
  }
  return null;
}

/** Подставить логин и пароль в rtsp://host/... (если их там ещё нет). */
export function withCredentials(url, user, password) {
  try {
    const u = new URL(url);
    if (user && !u.username) {
      u.username = user;
      u.password = password ?? "";
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** Скрыть пароль в адресе для логов и ответов. */
export const redact = (url) => url.replace(/(rtsp:\/\/[^:/@]+:)[^@]*@/i, "$1***@");

/** Понятный текст ошибки по выводу ffmpeg. */
function explain(stderr) {
  const s = stderr.toLowerCase();
  if (s.includes("401") || s.includes("unauthorized")) return "Неверный логин или пароль камеры";
  if (s.includes("404") || s.includes("not found")) return "Камера не знает такой адрес потока — проверьте путь";
  if (s.includes("connection refused")) return "Камера отказала в соединении: проверьте адрес и порт";
  if (s.includes("timed out") || s.includes("timeout") || s.includes("no route") || s.includes("unreachable")) return "Камера не отвечает: проверьте, что она в той же сети";
  if (s.includes("invalid data") || s.includes("could not find codec")) return "Не удалось разобрать видео: включите в камере H.264 или H.265";
  const last = stderr.trim().split("\n").filter(Boolean).pop();
  return last ? `ffmpeg: ${last.slice(0, 200)}` : "Поток прервался";
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

class Stream {
  constructor(ffmpeg, url, opts) {
    this.id = randomUUID();
    this.ffmpeg = ffmpeg;
    this.url = url; // уже с логином и паролем
    this.fps = opts.fps ?? 15;
    this.maxWidth = opts.maxWidth ?? 1280;
    this.frame = null;
    this.seq = 0;
    this.width = 0;
    this.height = 0;
    this.state = "connecting";
    this.error = null;
    this.lastAccess = Date.now();
    this.restarts = 0;
    this.stopped = false;
    this.proc = null;
    this.start();
  }

  start() {
    if (this.stopped) return;
    this.state = this.frame ? "reconnecting" : "connecting";
    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-rtsp_transport", "tcp", "-timeout", "8000000",
      "-fflags", "nobuffer", "-flags", "low_delay",
      "-i", this.url,
      "-an", "-vf", `fps=${this.fps},scale='min(${this.maxWidth},iw)':-2`,
      "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4", "-",
    ];
    const proc = spawn(this.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    let buf = Buffer.alloc(0);
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      // забираем все целые JPEG из буфера, оставляем последний
      for (;;) {
        const s = buf.indexOf(SOI);
        if (s < 0) {
          buf = Buffer.alloc(0);
          break;
        }
        const e = buf.indexOf(EOI, s + 2);
        if (e < 0) {
          if (s > 0) buf = buf.subarray(s);
          break;
        }
        this.setFrame(Buffer.from(buf.subarray(s, e + 2)));
        buf = buf.subarray(e + 2);
      }
      if (buf.length > 20_000_000) buf = Buffer.alloc(0);
    });
    proc.stderr.on("data", (c) => {
      stderr = (stderr + c.toString()).slice(-4000);
    });
    proc.on("error", (e) => {
      stderr += String(e.message);
    });
    proc.on("close", () => {
      if (this.proc === proc) this.proc = null;
      if (this.stopped) return;
      this.error = explain(stderr);
      this.state = "error";
      this.restarts += 1;
      const wait = Math.min(30_000, 2000 * this.restarts);
      setTimeout(() => this.start(), wait);
    });
  }

  setFrame(jpeg) {
    this.frame = jpeg;
    this.seq += 1;
    this.state = "live";
    this.error = null;
    this.restarts = 0;
    if (!this.width) {
      const size = jpegSize(jpeg);
      if (size) [this.width, this.height] = size;
    }
  }

  stop() {
    this.stopped = true;
    this.proc?.kill("SIGKILL");
    this.proc = null;
  }

  status() {
    return { id: this.id, state: this.state, error: this.error, width: this.width, height: this.height, seq: this.seq, url: redact(this.url) };
  }
}

/** Размер JPEG по маркеру SOF. */
export function jpegSize(b) {
  const u16 = (k) => (b[k] << 8) | b[k + 1];
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    const len = u16(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [u16(i + 7), u16(i + 5)];
    }
    i += 2 + len;
  }
  return null;
}

export class StreamManager {
  constructor() {
    this.streams = new Map();
    this.ff = undefined;
    this.timer = setInterval(() => this.cleanup(), 10_000);
    this.timer.unref?.();
  }

  ffmpeg() {
    if (this.ff === undefined) this.ff = findFfmpeg();
    return this.ff;
  }

  /** Открыть поток. Если такой адрес уже открыт — вернуть его (страница могла перезагрузиться). */
  open(url, user, password, opts = {}) {
    const ff = this.ffmpeg();
    if (!ff) throw new Error("ffmpeg не найден. Выполните npm install в папке web или brew install ffmpeg");
    const full = withCredentials(url, user, password);
    for (const s of this.streams.values()) {
      if (s.url === full) {
        s.lastAccess = Date.now();
        return s;
      }
    }
    const s = new Stream(ff.path, full, opts);
    this.streams.set(s.id, s);
    return s;
  }

  get(id) {
    const s = this.streams.get(id);
    if (s) s.lastAccess = Date.now();
    return s;
  }

  close(id) {
    const s = this.streams.get(id);
    if (s) {
      s.stop();
      this.streams.delete(id);
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [id, s] of this.streams) if (now - s.lastAccess > 60_000) this.close(id);
  }

  closeAll() {
    for (const id of [...this.streams.keys()]) this.close(id);
    clearInterval(this.timer);
  }
}
