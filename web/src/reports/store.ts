// Отчёты: один отчёт на каждый запуск мониторинга, демо, анализ видео и быстрый показ — порт ReportSummary и
// ReportStore (Business.swift, Mantis для Mac). Хранятся на этом компьютере (localStorage) и в Firestore
// users/{uid}/reports/{id} — в том же виде, что пишут Mac и iPhone (даты — Timestamp), поэтому отчёты общие.

import { Timestamp, collection, deleteDoc, doc, getDocs, setDoc } from "firebase/firestore";
import { firestore } from "../cloud/firebase";
import { type HourStat, addHours, emptyHour, parseHour } from "../pilot/hours";

/** Ролик камеры (запись по событиям — несколько; «всё время» — один). */
export interface ReportClip {
  file: string;
  /** Начало ролика, мс (0 — неизвестно, старые отчёты). */
  start: number;
  seconds: number;
  /** Были ли в ролике люди (иначе — только движение). */
  people: boolean;
}

/** Строка отчёта мониторинга по одной камере. */
export interface ReportCamera {
  name: string;
  people: number;
  passed: number;
  slowed: number;
  looked: number;
  entered?: number;
  /** Имя файла видео в папке отчёта и длительность записи, с. */
  video?: string;
  videoSeconds?: number;
  /** Сколько секунд камера считала. */
  seconds?: number;
  clips?: ReportClip[];
}

export type ReportSource = "video" | "camera" | "demo" | "summary";

export interface ReportSummary {
  id: string;
  /** Когда сохранён, мс. */
  date: number;
  source: ReportSource;
  title: string;
  duration: number;
  people: number;
  passed: number;
  slowed: number;
  looked: number;
  stopped: number;
  approached: number;
  entered?: number;
  score?: number;
  revenue?: number;
  perMonth?: number;
  /** Мониторинг: когда запустили, мс. */
  started?: number;
  cameras?: ReportCamera[];
  /** Папка с видео этого запуска (на этом компьютере). */
  videoFolder?: string;
  /** Данные запуска по часам (ключ 2026-10-03-14) — как в «Статистике». */
  hours?: Record<string, HourStat>;
  /** Запись цифрового двойника этого запуска (id в «Записях»). */
  twinID?: string;
  /** Конец периода (у сводного отчёта — конец последнего из отчётов), мс. */
  ended?: number;
  /** Сводный отчёт: сколько отчётов в него вошло. */
  sourcesCount?: number;
}

const newId = () =>
  (crypto.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`).toUpperCase();

export function newReport(p: Partial<ReportSummary> & { source: ReportSource }): ReportSummary {
  return {
    id: newId(), date: Date.now(), title: "", duration: 0, people: 0, passed: 0, slowed: 0, looked: 0, stopped: 0, approached: 0,
    ...p,
  };
}

/** Начало периода отчёта (мониторинг — запуск, иначе — дата сохранения). */
export const reportStart = (r: ReportSummary): number => r.started ?? r.date;

export const reportPlural = (n: number): string =>
  n % 10 === 1 && n % 100 !== 11 ? "отчёт" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "отчёта" : "отчётов";

/** Итог отчёта: по часам, если есть, иначе — из самого отчёта (старые отчёты, видео). */
export function reportTotal(r: ReportSummary): HourStat {
  const h = r.hours ? Object.values(r.hours) : [];
  if (h.length) return h.reduce(addHours, emptyHour());
  return { people: r.people, looked: r.looked, slowed: r.slowed, passed: r.passed, entered: r.entered ?? 0, seconds: r.duration };
}

/** Все ролики камеры (у старых отчётов — один файл video). */
export function cameraClips(c: ReportCamera): ReportClip[] {
  if (c.clips?.length) return c.clips;
  return c.video ? [{ file: c.video, start: 0, seconds: c.videoSeconds ?? 0, people: true }] : [];
}

/** Сводка из нескольких отчётов: цифры складываются, часы и камеры (по названию) объединяются. */
export function combineReports(list: ReportSummary[]): ReportSummary {
  const sorted = [...list].sort((a, b) => reportStart(a) - reportStart(b));
  const n = list.length;
  const sum = (f: (r: ReportSummary) => number) => list.reduce((a, r) => a + f(r), 0);
  const r = newReport({ source: "summary", title: `Сводный отчёт · ${n} ${reportPlural(n)}` });
  r.sourcesCount = n;
  r.started = sorted.length ? reportStart(sorted[0]) : undefined;
  r.ended = Math.max(...sorted.map((x) => reportStart(x) + (x.started !== undefined ? x.duration * 1000 : 0)));
  r.duration = sum((x) => x.duration);
  r.people = sum((x) => x.people);
  r.passed = sum((x) => x.passed);
  r.slowed = sum((x) => x.slowed);
  r.looked = sum((x) => x.looked);
  r.stopped = sum((x) => x.stopped);
  r.approached = sum((x) => x.approached);
  const ent = list.filter((x) => x.entered !== undefined);
  r.entered = ent.length ? ent.reduce((a, x) => a + (x.entered ?? 0), 0) : undefined;
  // часы — только если они есть у всех отчётов (иначе сумма по часам не сойдётся с итогами)
  if (list.length && list.every((x) => x.hours)) {
    const h: Record<string, HourStat> = {};
    for (const x of list) for (const [k, v] of Object.entries(x.hours ?? {})) h[k] = addHours(h[k] ?? emptyHour(), v);
    r.hours = h;
  }
  const cams = new Map<string, ReportCamera>();
  for (const x of list) {
    for (const c of x.cameras ?? []) {
      const m = cams.get(c.name) ?? { name: c.name, people: 0, passed: 0, slowed: 0, looked: 0 };
      m.people += c.people;
      m.passed += c.passed;
      m.slowed += c.slowed;
      m.looked += c.looked;
      if (c.entered !== undefined) m.entered = (m.entered ?? 0) + c.entered;
      if (c.seconds !== undefined) m.seconds = (m.seconds ?? 0) + c.seconds;
      cams.set(c.name, m);
    }
  }
  if (cams.size) r.cameras = [...cams.values()];
  return r;
}

// ---------------------------------------------------------------- облако (формат как у Mac и iPhone)

const toTs = (ms: number | undefined) => (ms === undefined ? undefined : Timestamp.fromMillis(ms));
const fromTs = (v: unknown): number | undefined => {
  if (v instanceof Timestamp) return v.toMillis();
  if (v && typeof v === "object" && "seconds" in v) return Number((v as { seconds: number }).seconds) * 1000;
  if (typeof v === "number") return v < 1e11 ? (v + 978307200) * 1000 : v; // Swift без Timestamp — секунды от 2001
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
};

/** Убрать undefined (Firestore их не принимает). */
function clean<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clean) as T;
  if (v && typeof v === "object" && !(v instanceof Timestamp)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = clean(x);
    return o as T;
  }
  return v;
}

export function reportToCloud(r: ReportSummary): Record<string, unknown> {
  return clean({
    ...r,
    date: toTs(r.date),
    started: toTs(r.started),
    ended: toTs(r.ended),
    cameras: r.cameras?.map((c) => ({
      ...c,
      clips: c.clips?.map((x) => ({ ...x, start: x.start ? toTs(x.start) : Timestamp.fromMillis(-62135596800000) })),
    })),
  });
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const optNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const optStr = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function reportFromCloud(id: string, d: Record<string, unknown>): ReportSummary | null {
  const date = fromTs(d.date);
  if (date === undefined) return null;
  const src = String(d.source ?? "video");
  const hours = d.hours && typeof d.hours === "object"
    ? Object.fromEntries(Object.entries(d.hours as Record<string, Record<string, unknown>>).map(([k, v]) => [k, parseHour(v)]))
    : undefined;
  const cams = Array.isArray(d.cameras)
    ? (d.cameras as Record<string, unknown>[]).map((c): ReportCamera => ({
        name: String(c.name ?? ""), people: num(c.people), passed: num(c.passed), slowed: num(c.slowed), looked: num(c.looked),
        entered: optNum(c.entered), video: optStr(c.video), videoSeconds: optNum(c.videoSeconds), seconds: optNum(c.seconds),
        clips: Array.isArray(c.clips)
          ? (c.clips as Record<string, unknown>[]).map((x) => {
              const s = fromTs(x.start) ?? 0;
              return { file: String(x.file ?? ""), start: s > 0 ? s : 0, seconds: num(x.seconds), people: !!x.people };
            })
          : undefined,
      }))
    : undefined;
  return {
    id: String(d.id ?? id), date, source: (["video", "camera", "demo", "summary"].includes(src) ? src : "video") as ReportSource,
    title: String(d.title ?? ""), duration: num(d.duration), people: num(d.people), passed: num(d.passed), slowed: num(d.slowed),
    looked: num(d.looked), stopped: num(d.stopped), approached: num(d.approached), entered: optNum(d.entered), score: optNum(d.score),
    revenue: optNum(d.revenue), perMonth: optNum(d.perMonth), started: fromTs(d.started), cameras: cams,
    videoFolder: optStr(d.videoFolder), hours, twinID: optStr(d.twinID), ended: fromTs(d.ended), sourcesCount: optNum(d.sourcesCount),
  };
}

async function saveCloud(uid: string, r: ReportSummary): Promise<void> {
  await setDoc(doc(firestore(), "users", uid, "reports", r.id), reportToCloud(r));
}
async function deleteCloud(uid: string, id: string): Promise<void> {
  await deleteDoc(doc(firestore(), "users", uid, "reports", id));
}
async function loadCloud(uid: string): Promise<ReportSummary[]> {
  const snap = await getDocs(collection(firestore(), "users", uid, "reports"));
  const out: ReportSummary[] = [];
  snap.forEach((d) => {
    const r = reportFromCloud(d.id, d.data());
    if (r) out.push(r);
  });
  return out;
}

// ---------------------------------------------------------------- хранилище

const KEY = "mantis.reports.v1";
const LIMIT = 200;
const isSample = (id: string) => id.startsWith("sample-");

export class ReportStore {
  items: ReportSummary[] = [];
  /** Кто вошёл (null — облако выключено). */
  uid: () => string | null = () => null;
  private listeners = new Set<() => void>();

  constructor() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as ReportSummary[];
      if (Array.isArray(raw)) this.items = raw.filter((r) => r && r.id && Number.isFinite(r.date));
    } catch {
      /* пусто */
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.items));
    } catch {
      // места мало — храним меньше
      try {
        localStorage.setItem(KEY, JSON.stringify(this.items.slice(0, 60)));
      } catch {
        /* нет */
      }
    }
    for (const fn of this.listeners) fn();
  }

  private cloud(fn: (uid: string) => Promise<void>): void {
    const uid = this.uid();
    if (uid) fn(uid).catch((e) => console.warn("[mantis] отчёт не ушёл в облако:", e));
  }

  get(id: string): ReportSummary | undefined {
    return this.items.find((r) => r.id === id);
  }

  add(r: ReportSummary): void {
    this.items = [r, ...this.items.filter((x) => x.id !== r.id)].slice(0, LIMIT);
    this.changed();
    if (!isSample(r.id)) this.cloud((uid) => saveCloud(uid, r));
  }

  /** Только на этом компьютере (пример — в облако не уходит). */
  addLocal(r: ReportSummary): void {
    this.items = [...this.items.filter((x) => x.id !== r.id), r].sort((a, b) => b.date - a.date);
    this.changed();
  }

  update(r: ReportSummary): void {
    const i = this.items.findIndex((x) => x.id === r.id);
    if (i < 0) return;
    this.items[i] = r;
    this.items = [...this.items];
    this.changed();
    if (!isSample(r.id)) this.cloud((uid) => saveCloud(uid, r));
  }

  delete(id: string): void {
    this.items = this.items.filter((r) => r.id !== id);
    this.changed();
    if (!isSample(id)) this.cloud((uid) => deleteCloud(uid, id));
  }

  removeLocal(id: string): void {
    this.items = this.items.filter((r) => r.id !== id);
    this.changed();
  }

  /** После входа: объединить с облаком, недостающие в облаке — отправить. */
  async pull(): Promise<void> {
    const uid = this.uid();
    if (!uid) return;
    const remote = await loadCloud(uid);
    const have = new Set(this.items.map((r) => r.id));
    const remoteIds = new Set(remote.map((r) => r.id));
    const missing = this.items.filter((r) => !isSample(r.id) && !remoteIds.has(r.id));
    this.items = [...this.items, ...remote.filter((r) => !have.has(r.id))].sort((a, b) => b.date - a.date).slice(0, LIMIT);
    this.changed();
    for (const r of missing) await saveCloud(uid, r).catch(() => undefined);
  }
}

export const reports = new ReportStore();
