// Хранилище двойника в браузере: план и статистика дня — localStorage, картинки подложек и записи
// (с копией видео) — IndexedDB. Как папка Twin/ в Application Support у Mantis для Mac.

import { type RecordingData, Timeline, normalizePlan } from "./plan";

const DB = "mantis-twin";
const VER = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
      if (!db.objectStoreNames.contains("recordings")) db.createObjectStore("recordings", { keyPath: "id" });
      if (!db.objectStoreNames.contains("recdata")) db.createObjectStore("recdata");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

let dbp: Promise<IDBDatabase> | null = null;
const db = () => (dbp ??= openDb());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tx<T = unknown>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<any> | void): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? (req.result as T) : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function getBlob(key: string): Promise<Blob | null> {
  try {
    return ((await tx<Blob>("blobs", "readonly", (s) => s.get(key))) as Blob | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function putBlob(key: string, b: Blob | null): Promise<void> {
  try {
    await tx("blobs", "readwrite", (s) => { if (b) s.put(b, key); else s.delete(key); });
  } catch (e) {
    console.warn("[mantis] двойник: не удалось сохранить картинку", e);
  }
}

/** Картинка из Blob (для рисования на холсте). */
export async function blobImage(b: Blob | null): Promise<ImageBitmap | null> {
  if (!b) return null;
  try {
    return await createImageBitmap(b);
  } catch {
    return null;
  }
}

export function loadJSON<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}

export function saveJSON(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch (e) {
    console.warn("[mantis] двойник: хранилище браузера переполнено", e);
  }
}

// ---------------------------------------------------------------- записи

export type RecSource = "video" | "live" | "demo";

export interface RecordingMeta {
  id: string;
  name: string;
  created: number;
  source: RecSource;
  duration: number;
  people: number;
  peak: number;
  hasVideo: boolean;
}

export const SOURCE_TITLES: Record<RecSource, string> = { video: "Видео", live: "Живые камеры", demo: "Демо" };

export async function listRecordings(): Promise<RecordingMeta[]> {
  try {
    const all = ((await tx<RecordingMeta[]>("recordings", "readonly", (s) => s.getAll() as IDBRequest<RecordingMeta[]>)) ?? []) as RecordingMeta[];
    return all.sort((a, b) => b.created - a.created);
  } catch {
    return [];
  }
}

export async function saveRecording(
  name: string, source: RecSource, data: RecordingData, video: Blob | null, background: Blob | null,
): Promise<RecordingMeta | null> {
  const id = crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const tl = new Timeline(data.plan, data.frames);
  const meta: RecordingMeta = {
    id, name, created: Date.now(), source, duration: data.frames[data.frames.length - 1]?.t ?? 0,
    people: tl.stats.people, peak: tl.stats.peak, hasVideo: !!video,
  };
  try {
    await tx("recdata", "readwrite", (s) => s.put(data, id));
    if (video) await tx("blobs", "readwrite", (s) => s.put(video, `rec:${id}:video`));
    if (background) await tx("blobs", "readwrite", (s) => s.put(background, `rec:${id}:plan`));
    await tx("recordings", "readwrite", (s) => s.put(meta));
    return meta;
  } catch (e) {
    console.warn("[mantis] запись двойника не сохранилась", e);
    await deleteRecording(id).catch(() => undefined);
    return null;
  }
}

export async function loadRecording(id: string): Promise<{ data: RecordingData; background: Blob | null; video: Blob | null } | null> {
  const data = (await tx<RecordingData>("recdata", "readonly", (s) => s.get(id))) as RecordingData | undefined;
  if (!data) return null;
  data.plan = normalizePlan(data.plan);
  return { data, background: await getBlob(`rec:${id}:plan`), video: await getBlob(`rec:${id}:video`) };
}

export async function renameRecording(m: RecordingMeta, name: string): Promise<void> {
  const n = name.trim();
  if (!n) return;
  await tx("recordings", "readwrite", (s) => s.put({ ...m, name: n }));
}

export async function deleteRecording(id: string): Promise<void> {
  await tx("recordings", "readwrite", (s) => s.delete(id));
  await tx("recdata", "readwrite", (s) => s.delete(id));
  await tx("blobs", "readwrite", (s) => s.delete(`rec:${id}:video`));
  await tx("blobs", "readwrite", (s) => s.delete(`rec:${id}:plan`));
}
