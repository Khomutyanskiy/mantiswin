// «Пример данных» — порт SampleData.swift: 2 недели статистики по двум камерам и 5 отчётов, чтобы новый клиент
// сразу увидел графики, сравнение и отчёты. Хранится только на этом компьютере, в облако не уходит,
// убирается одной кнопкой (настоящие данные не трогает).

import { showcaseScore } from "../pilot/business";
import { type HourStat, addHours, emptyHour, hourKey, keyDate } from "../pilot/hours";
import { type ReportSummary, newReport, reports } from "../reports/store";
import { prefBool, prefNum, setPref } from "./prefs";

export const SAMPLE_CAMERAS: [string, string][] = [["sample-entrance", "Пример · Вход"], ["sample-showcase", "Пример · Витрина"]];
export const SAMPLE_PREFIX = "sample-";

/** Повторяемые «случайные» числа — пример одинаковый при каждом запуске. */
function seeded(seed: number): () => number {
  let s = BigInt(Math.floor(seed) || 0x9e3779b9);
  const M = (1n << 64n) - 1n;
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & M;
    return Number(s >> 11n) / 2 ** 53;
  };
}

class SampleData {
  hours: Record<string, HourStat> = {};
  cameraHours: Record<string, Record<string, HourStat>> = {};
  private listeners = new Set<() => void>();

  constructor() {
    if (this.on) this.build();
  }

  get on(): boolean {
    return prefBool("sample.on", false);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  show(): void {
    if (this.on) return;
    setPref("sample.anchor", Math.floor(Date.now() / 1000));
    setPref("sample.on", true);
    this.build();
    this.addReports();
    this.emit();
  }

  hide(): void {
    setPref("sample.on", false);
    this.hours = {};
    this.cameraHours = {};
    for (const r of reports.items) if (r.id.startsWith(SAMPLE_PREFIX)) reports.removeLocal(r.id);
    this.emit();
  }

  private build(): void {
    const anchor = new Date(prefNum("sample.anchor", Math.floor(Date.now() / 1000)) * 1000);
    const rnd = seeded(anchor.getTime() / 1000);
    const all: Record<string, HourStat> = {};
    const cams: Record<string, Record<string, HourStat>> = { [SAMPLE_CAMERAS[0][0]]: {}, [SAMPLE_CAMERAS[1][0]]: {} };
    const today = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    for (let back = 1; back <= 14; back++) {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
      const wd = day.getDay(); // 0 — воскресенье
      const dayK = ({ 0: 1.25, 6: 1.35, 5: 1.15 } as Record<number, number>)[wd] ?? 1;
      for (let hour = 10; hour <= 21; hour++) {
        const date = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
        // два пика: обед и вечер
        const curve = 0.55 + 0.45 * Math.exp(-((hour - 13.5) ** 2) / 3) + 0.6 * Math.exp(-((hour - 18.5) ** 2) / 2.5);
        const people = Math.round(34 * curve * dayK * (0.85 + rnd() * 0.3));
        const part = (k: number) => Math.round(people * k * (0.85 + rnd() * 0.3));
        const s: HourStat = { people, looked: part(0.19), slowed: part(0.31), passed: part(0.7), entered: part(0.07), seconds: 3600 };
        const key = hourKey(date);
        all[key] = s;
        const share = 0.56 + rnd() * 0.08;
        const split = (v: number, k: number) => Math.round(v * k);
        const a: HourStat = {
          people: split(s.people, share), looked: split(s.looked, 0.35), slowed: split(s.slowed, 0.4),
          passed: split(s.passed, share), entered: s.entered, seconds: 3600,
        };
        cams[SAMPLE_CAMERAS[0][0]][key] = a;
        cams[SAMPLE_CAMERAS[1][0]][key] = {
          people: s.people - a.people, looked: s.looked - a.looked, slowed: s.slowed - a.slowed,
          passed: s.passed - a.passed, entered: 0, seconds: 3600,
        };
      }
    }
    this.hours = all;
    this.cameraHours = cams;
  }

  /** Отчёты пяти последних дней примера. */
  private addReports(): void {
    const byDay = new Map<string, string[]>();
    for (const k of Object.keys(this.hours)) {
      const d = k.slice(0, 10);
      byDay.set(d, [...(byDay.get(d) ?? []), k]);
    }
    for (const day of [...byDay.keys()].sort().slice(-5)) {
      const keys = byDay.get(day)!.sort();
      const first = keyDate(keys[0])!.getTime();
      const dayHours = Object.fromEntries(keys.map((k) => [k, this.hours[k]]));
      const t = Object.values(dayHours).reduce(addHours, emptyHour());
      const r: ReportSummary = newReport({
        source: "camera", title: "Пример · Мониторинг · 2 камеры", duration: t.seconds,
        people: t.people, passed: t.passed, slowed: t.slowed, looked: t.looked, entered: t.entered,
      });
      r.id = SAMPLE_PREFIX + day;
      r.started = first;
      r.date = first + t.seconds * 1000;
      r.hours = dayHours;
      r.cameras = SAMPLE_CAMERAS.map(([id, name]) => {
        const c = Object.entries(this.cameraHours[id] ?? {}).filter(([k]) => k.startsWith(day)).map(([, v]) => v).reduce(addHours, emptyHour());
        return { name, people: c.people, passed: c.passed, slowed: c.slowed, looked: c.looked, entered: c.entered, seconds: c.seconds };
      });
      r.score = showcaseScore(t.people, t.looked, t.slowed, 0, 0, t.entered)?.value;
      reports.addLocal(r);
    }
  }

  /** Настоящие часы + пример. */
  withSample(real: Record<string, HourStat>): Record<string, HourStat> {
    if (!this.on) return real;
    const h = { ...real };
    for (const [k, v] of Object.entries(this.hours)) h[k] = addHours(h[k] ?? emptyHour(), v);
    return h;
  }
}

export const sample = new SampleData();
