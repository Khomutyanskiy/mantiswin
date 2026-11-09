// Место под видео мониторинга — порт VideoStorage.swift: режим записи, лимит по объёму, срок хранения,
// проверка свободного места, расписание записи, размытие лиц. Файлы — на диске этого компьютера через мост
// (Mantis Агент, приложение для Windows, npm run dev/serve), без моста — в хранилище браузера (IndexedDB).

import type { ReportStore } from "../reports/store";
import type { VideoFiles } from "../reports/view";
import { prefBool, prefJSON, prefNum, prefStr, scheduleOpen, setPref } from "../settings/prefs";
import type { VideoSink } from "./writer";

const apiUrl = (path: string) => new URL(`api/${path}`, new URL(import.meta.env.BASE_URL, location.href)).href;

/** Не начинать запись, если на диске свободно меньше (ГБ); остановить, если осталось меньше. */
export const MIN_FREE_TO_START_GB = 5;
export const MIN_FREE_WHILE_RECORDING_GB = 2;

export type VideoMode = "off" | "always";

export const videoPrefs = {
  /** Записывать видео во время мониторинга (раньше «только с людьми» — теперь «всё время» + режим событий). */
  get mode(): VideoMode {
    const m = prefStr("pilot.videoMode", "off");
    return m === "off" ? "off" : "always";
  },
  set mode(v: VideoMode) {
    setPref("pilot.videoMode", v);
  },
  /** true — ролики по событиям (движение и люди), false — всё время одним файлом. */
  get events(): boolean {
    return prefBool("video.events", true);
  },
  set events(v: boolean) {
    setPref("video.events", v);
  },
  get keepDays(): number {
    return prefNum("video.keepDays", 14);
  },
  set keepDays(v: number) {
    setPref("video.keepDays", Math.max(1, Math.round(v)));
  },
  get maxGB(): number {
    return prefNum("video.maxGB", 30);
  },
  set maxGB(v: number) {
    setPref("video.maxGB", Math.max(1, Math.round(v)));
  },
  /** Чувствительность к движению: 1 — только заметное, 5 — малейшее. */
  get motionLevel(): number {
    return prefNum("video.motionLevel", 3);
  },
  set motionLevel(v: number) {
    setPref("video.motionLevel", Math.min(5, Math.max(1, Math.round(v))));
  },
  get blurFaces(): boolean {
    return prefBool("video.blurFaces", true);
  },
  set blurFaces(v: boolean) {
    setPref("video.blurFaces", v);
  },
  get scheduleOn(): boolean {
    return prefBool("video.schedule.on", false);
  },
  set scheduleOn(v: boolean) {
    setPref("video.schedule.on", v);
  },
  get start(): number {
    return prefNum("video.schedule.start", 9 * 60);
  },
  set start(v: number) {
    setPref("video.schedule.start", v);
  },
  get end(): number {
    return prefNum("video.schedule.end", 22 * 60);
  },
  set end(v: number) {
    setPref("video.schedule.end", v);
  },
  get days(): number[] {
    return prefJSON<number[]>("video.schedule.days", [1, 2, 3, 4, 5, 6, 7]);
  },
  set days(v: number[]) {
    setPref("video.schedule.days", [...v].sort());
  },
};

/** Порог яркости пикселя и доля изменившегося кадра для уровня движения. */
export function motionThresholds(): { pixel: number; fraction: number } {
  switch (videoPrefs.motionLevel) {
    case 1: return { pixel: 30, fraction: 0.05 };
    case 2: return { pixel: 23, fraction: 0.03 };
    case 4: return { pixel: 14, fraction: 0.008 };
    case 5: return { pixel: 10, fraction: 0.004 };
    default: return { pixel: 18, fraction: 0.015 };
  }
}

/** Можно ли писать видео прямо сейчас (по расписанию записи). */
export const recordingAllowed = (d = new Date()) =>
  !videoPrefs.scheduleOn || scheduleOpen(d, videoPrefs.start, videoPrefs.end, videoPrefs.days);

export const gbText = (bytes: number) => {
  const g = bytes / 1024 ** 3;
  return g >= 10 ? `${Math.round(g)} ГБ` : `${g.toFixed(1).replace(".", ",")} ГБ`;
};

// ---------------------------------------------------------------- хранилище браузера (без моста)

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("mantis-video", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("pieces", { keyPath: "k" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
let seq = 0;

const idbSink: VideoSink = {
  ext: "mp4",
  async write(folder, name, pos, data) {
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("pieces", "readwrite");
      tx.objectStore("pieces").put({ k: `${folder}/${name}#${String(++seq + Date.now() * 1000).padStart(18, "0")}`, folder, name, pos, data, t: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

async function idbPieces(prefix: string): Promise<{ k: string; folder: string; name: string; pos: number; data: Uint8Array; t: number }[]> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pieces", "readonly");
    const r = tx.objectStore("pieces").getAll(IDBKeyRange.bound(prefix, prefix + "￿"));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbDelete(prefix: string): Promise<void> {
  const db = await idb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("pieces", "readwrite");
    tx.objectStore("pieces").delete(IDBKeyRange.bound(prefix, prefix + "￿"));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Собрать файл из кусков (в порядке записи: заголовок MP4 дописывается в начало в самом конце). */
async function idbBlob(folder: string, name: string): Promise<Blob | null> {
  const pieces = (await idbPieces(`${folder}/${name}#`)).sort((a, b) => (a.k < b.k ? -1 : 1));
  if (!pieces.length) return null;
  const size = Math.max(...pieces.map((p) => p.pos + p.data.length));
  const buf = new Uint8Array(size);
  for (const p of pieces) buf.set(p.data, p.pos);
  return new Blob([buf], { type: "video/mp4" });
}

// ---------------------------------------------------------------- мост

const bridgeSink: VideoSink = {
  ext: "mp4",
  async write(folder, name, pos, data) {
    const q = new URLSearchParams({ folder, name, pos: String(pos) });
    const r = await fetch(apiUrl(`video/write?${q}`), { method: "POST", body: data as BodyInit });
    if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `мост ответил ${r.status}`);
  },
};

export interface VideoInfo {
  onDisk: boolean;
  usedBytes: number;
  freeBytes: number | null;
  root: string | null;
}

let bridgeOk: boolean | null = null;
async function hasBridge(): Promise<boolean> {
  if (bridgeOk !== null) return bridgeOk;
  try {
    const r = await fetch(apiUrl("bridge"), { cache: "no-store" });
    bridgeOk = r.ok && !!((await r.json()) as { video?: boolean }).video;
  } catch {
    bridgeOk = false;
  }
  return bridgeOk;
}

export class VideoStorage {
  /** Видео остановлено или не начато (мало места) — показать в шапке. */
  note: string | null = null;

  constructor(private readonly reports: ReportStore) {}

  async sink(): Promise<VideoSink> {
    return (await hasBridge()) ? bridgeSink : idbSink;
  }

  async info(): Promise<VideoInfo> {
    if (await hasBridge()) {
      try {
        const j = (await (await fetch(apiUrl("video/info"), { cache: "no-store" })).json()) as { root: string; usedBytes: number; freeBytes: number | null };
        return { onDisk: true, usedBytes: j.usedBytes, freeBytes: j.freeBytes, root: j.root };
      } catch {
        /* ниже */
      }
    }
    let used = 0;
    try {
      const est = await navigator.storage?.estimate?.();
      used = est?.usage ?? 0;
      return { onDisk: false, usedBytes: used, freeBytes: est?.quota ? Math.max(0, est.quota - used) : null, root: null };
    } catch {
      return { onDisk: false, usedBytes: 0, freeBytes: null, root: null };
    }
  }

  /** Свободно, ГБ (null — не знаем). */
  async freeGB(): Promise<number | null> {
    const i = await this.info();
    return i.freeBytes === null ? null : i.freeBytes / 1024 ** 3;
  }

  /** Удалить видео старше срока и самое старое сверх лимита; у отчётов убрать ссылки на удалённое. */
  async cleanup(keep: string | null): Promise<void> {
    let removed: string[] = [];
    if (await hasBridge()) {
      try {
        const r = await fetch(apiUrl("video/cleanup"), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keepDays: videoPrefs.keepDays, maxGB: videoPrefs.maxGB, keep }),
        });
        removed = ((await r.json()) as { removed?: string[] }).removed ?? [];
      } catch {
        return;
      }
    } else {
      // в браузере — только по сроку хранения
      const oldest = Date.now() - videoPrefs.keepDays * 86400_000;
      const pieces = await idbPieces("").catch(() => []);
      const folders = new Map<string, number>();
      for (const p of pieces) folders.set(p.folder, Math.min(folders.get(p.folder) ?? Infinity, p.t));
      for (const [f, t] of folders) {
        if (f !== keep && t < oldest) {
          await idbDelete(`${f}/`);
          removed.push(f);
        }
      }
    }
    if (!removed.length) return;
    for (const r of this.reports.items) {
      if (r.videoFolder && removed.includes(r.videoFolder)) {
        this.reports.update({ ...r, videoFolder: undefined, cameras: r.cameras?.map((c) => ({ ...c, video: undefined, videoSeconds: undefined, clips: undefined })) });
      }
    }
  }

  /** Для отчётов: смотреть, удалять, показать папку. */
  files(): VideoFiles {
    return {
      url: async (folder, file) => {
        if (await hasBridge()) return apiUrl(`video/file?${new URLSearchParams({ folder, name: file })}`);
        const b = await idbBlob(folder, file).catch(() => null);
        return b ? URL.createObjectURL(b) : null;
      },
      removeFolder: async (folder) => {
        if (await hasBridge()) await fetch(apiUrl(`video/folder?${new URLSearchParams({ folder })}`), { method: "DELETE" });
        else await idbDelete(`${folder}/`);
      },
      removeFile: async (folder, file) => {
        if (await hasBridge()) await fetch(apiUrl(`video/file?${new URLSearchParams({ folder, name: file })}`), { method: "DELETE" });
        else await idbDelete(`${folder}/${file}#`);
      },
      reveal: (folder) => {
        void hasBridge().then(async (ok) => {
          if (ok) await fetch(apiUrl(`video/reveal?${new URLSearchParams({ folder })}`), { method: "POST" });
        });
      },
    };
  }

  async onDisk(): Promise<boolean> {
    return hasBridge();
  }
}

/** Имя папки запуска: «2026-11-09 10-15-00». */
export function runFolderName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
