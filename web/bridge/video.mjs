// Видео мониторинга на диске этого компьютера (как папка Monitoring у Mantis для Mac):
//   <корень>/<папка запуска «2026-11-09 10-15-00»>/<ролик>.mp4
// Страница пишет ролик кусками (запись по месту — MP4 дописывает заголовок в конце), смотрит с поддержкой Range,
// удаляет, убирает старое по сроку и объёму, открывает папку в проводнике / Finder.
//
//   GET    /api/video/info                         — {root, usedBytes, freeBytes}
//   POST   /api/video/write?folder&name&pos        — записать тело запроса с позиции pos
//   GET    /api/video/file?folder&name             — отдать ролик (Range)
//   DELETE /api/video/file?folder&name             — удалить ролик
//   DELETE /api/video/folder?folder                — удалить папку запуска
//   POST   /api/video/cleanup {keepDays,maxGB,keep} — уборка, в ответ — удалённые папки
//   POST   /api/video/reveal?folder                — показать папку

import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import { join, resolve, sep } from "node:path";

export function defaultVideoRoot() {
  if (process.env.MANTIS_VIDEO_DIR) return process.env.MANTIS_VIDEO_DIR;
  const home = os.homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Mantis Agent", "Monitoring");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Mantis Agent", "Monitoring");
  return join(home, ".local", "share", "mantis-agent", "Monitoring");
}

const SAFE = /^[^/\\:*?"<>|\0]{1,120}$/;

function sizeOf(path) {
  let total = 0;
  try {
    for (const e of readdirSync(path, { withFileTypes: true })) {
      const p = join(path, e.name);
      total += e.isDirectory() ? sizeOf(p) : statSync(p).size;
    }
  } catch {
    /* нет */
  }
  return total;
}

export class VideoStore {
  constructor(root = defaultVideoRoot()) {
    this.root = resolve(root);
  }

  /** Путь внутри корня (без выхода наружу через ..). */
  path(folder, name) {
    if (!SAFE.test(folder) || folder.includes("..") || (name !== undefined && (!SAFE.test(name) || name.includes("..")))) {
      throw new Error("Недопустимое имя файла");
    }
    const p = resolve(this.root, folder, ...(name !== undefined ? [name] : []));
    if (!p.startsWith(this.root + sep)) throw new Error("Недопустимый путь");
    return p;
  }

  info() {
    mkdirSync(this.root, { recursive: true });
    let freeBytes = null;
    try {
      const s = statfsSync(this.root);
      freeBytes = Number(s.bavail) * Number(s.bsize);
    } catch {
      /* старый рантайм — не знаем */
    }
    return { root: this.root, usedBytes: sizeOf(this.root), freeBytes };
  }

  async write(folder, name, pos, data) {
    const dir = this.path(folder);
    mkdirSync(dir, { recursive: true });
    const file = this.path(folder, name);
    const fh = await open(file, existsSync(file) ? "r+" : "w+");
    try {
      await fh.write(data, 0, data.length, pos);
    } finally {
      await fh.close();
    }
  }

  removeFile(folder, name) {
    rmSync(this.path(folder, name), { force: true });
    const dir = this.path(folder);
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* нет */
    }
  }

  removeFolder(folder) {
    rmSync(this.path(folder), { recursive: true, force: true });
  }

  /** Удалить видео старше срока и самое старое, пока всё вместе не уложится в лимит. Папку keep не трогаем. */
  cleanup(keepDays, maxGB, keep) {
    if (!existsSync(this.root)) return [];
    const folders = readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== keep)
      .map((e) => {
        const p = join(this.root, e.name);
        const st = statSync(p);
        return { name: e.name, p, t: st.birthtimeMs || st.mtimeMs, size: sizeOf(p) };
      })
      .sort((a, b) => a.t - b.t);
    const limit = Math.max(1, Number(maxGB) || 30) * 1024 ** 3;
    let total = folders.reduce((a, f) => a + f.size, 0) + (keep ? sizeOf(join(this.root, keep)) : 0);
    const oldest = Date.now() - Math.max(1, Number(keepDays) || 14) * 86400_000;
    const removed = [];
    for (const f of folders) {
      if (f.t < oldest || total > limit) {
        rmSync(f.p, { recursive: true, force: true });
        total -= f.size;
        removed.push(f.name);
      }
    }
    return removed;
  }

  reveal(folder) {
    const p = folder ? this.path(folder) : this.root;
    mkdirSync(p, { recursive: true });
    const cmd = process.platform === "win32" ? ["explorer", [p]] : process.platform === "darwin" ? ["open", [p]] : ["xdg-open", [p]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore", windowsHide: false }).unref();
  }

  /** Отдать ролик с поддержкой Range (перемотка в <video>). */
  serve(req, res, folder, name) {
    const file = this.path(folder, name);
    if (!existsSync(file)) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "Файл не найден" }));
    }
    const size = statSync(file).size;
    const type = name.endsWith(".webm") ? "video/webm" : "video/mp4";
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    const base = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin" };
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
      res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...base, "Content-Length": size });
      createReadStream(file).pipe(res);
    }
  }
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolveP, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) reject(new Error("слишком большой кусок"));
      else chunks.push(c);
    });
    req.on("end", () => resolveP(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Обработать /api/video/*. Возвращает true, если запрос наш. */
export async function handleVideo(store, req, res, url, send) {
  if (!url.pathname.startsWith("/api/video/")) return false;
  const q = (k) => url.searchParams.get(k) ?? "";
  const route = url.pathname.slice("/api/video/".length);
  if (req.method === "GET" && route === "info") return send(res, 200, store.info()), true;
  if (req.method === "POST" && route === "write") {
    const data = await readBody(req);
    await store.write(q("folder"), q("name"), Number(q("pos")) || 0, data);
    return send(res, 200, { ok: true, bytes: data.length }), true;
  }
  if (req.method === "GET" && route === "file") return store.serve(req, res, q("folder"), q("name")), true;
  if (req.method === "DELETE" && route === "file") return store.removeFile(q("folder"), q("name")), send(res, 200, { ok: true }), true;
  if (req.method === "DELETE" && route === "folder") return store.removeFolder(q("folder")), send(res, 200, { ok: true }), true;
  if (req.method === "POST" && route === "cleanup") {
    const b = JSON.parse((await readBody(req, 10_000)).toString("utf8") || "{}");
    return send(res, 200, { removed: store.cleanup(b.keepDays, b.maxGB, b.keep) }), true;
  }
  if (req.method === "POST" && route === "reveal") return store.reveal(q("folder")), send(res, 200, { ok: true }), true;
  return send(res, 404, { error: "Нет такого метода" }), true;
}
