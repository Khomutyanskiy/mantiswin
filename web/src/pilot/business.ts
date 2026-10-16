// Статистика за период и пересчёт в деньги — порт iOS StatsView и Business.swift (ShowcaseScore, MoneyEstimate).

import type { BusinessProfile } from "../cloud/firebase";
import { type HourStat, addHours, emptyHour, keyDate } from "./hours";

export type Metric = "people" | "looked" | "slowed" | "entered" | "passed";

export const METRICS: { id: Metric; title: string; color: string }[] = [
  { id: "people", title: "Люди", color: "#e8eef8" },
  { id: "looked", title: "Посмотрели", color: "#ffd23f" },
  { id: "slowed", title: "Притормозили", color: "#5bd97f" },
  { id: "entered", title: "Вошли", color: "#8fe36d" },
  { id: "passed", title: "Прошли", color: "#47d7f0" },
];

export const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export interface Row {
  date: Date;
  stat: HourStat;
}

/** Часы за последние days дней (0 — всё время), по возрастанию. */
export function rowsFor(hours: Record<string, HourStat>, days: number, now = new Date()): Row[] {
  const from = days > 0 ? new Date(now.getTime() - days * 86400_000) : new Date(0);
  const out: Row[] = [];
  for (const [k, v] of Object.entries(hours)) {
    const d = keyDate(k);
    if (d && d >= from) out.push({ date: d, stat: v });
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

export const total = (rows: Row[]): HourStat => rows.reduce((a, r) => addHours(a, r.stat), emptyHour());

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export interface Bar {
  label: string;
  value: number;
}

/** Среднее за день по каждому часу (делим на число дней, когда этот час наблюдался). */
export function hourBars(rows: Row[], m: Metric): Bar[] {
  const sum = new Array(24).fill(0), n = new Array(24).fill(0);
  for (const r of rows) {
    const h = r.date.getHours();
    sum[h] += r.stat[m];
    n[h] += 1;
  }
  return sum.map((s, h) => ({ label: String(h), value: n[h] ? s / n[h] : 0 }));
}

/** Среднее за день по дням недели (Пн — первый). */
export function weekdayBars(rows: Row[], m: Metric): Bar[] {
  const sum = new Array(7).fill(0);
  const days = Array.from({ length: 7 }, () => new Set<number>());
  for (const r of rows) {
    const wd = (r.date.getDay() + 6) % 7;
    sum[wd] += r.stat[m];
    days[wd].add(dayStart(r.date));
  }
  return sum.map((s, i) => ({ label: WEEKDAYS[i], value: days[i].size ? s / days[i].size : 0 }));
}

/** Сумма по датам. */
export function dayBars(rows: Row[], m: Metric): Bar[] {
  const by = new Map<number, number>();
  for (const r of rows) by.set(dayStart(r.date), (by.get(dayStart(r.date)) ?? 0) + r.stat[m]);
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, v]) => {
      const d = new Date(t);
      return { label: `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")}`, value: v };
    });
}

export const daysObserved = (rows: Row[]): number => new Set(rows.map((r) => dayStart(r.date))).size;

// ---- Оценка витрины 0–100 (ShowcaseScore.compute)

export interface ScorePart {
  title: string;
  count: number;
  rate: number;
  target: number;
  weight: number;
}

export function showcaseScore(people: number, looked: number, slowed: number, stopped: number, approached: number, entered: number | null):
  { value: number; parts: ScorePart[]; grade: string } | null {
  if (people < 3) return null;
  const part = (title: string, count: number, target: number, weight: number): ScorePart => ({
    title, count, rate: Math.min(1, count / people), target, weight,
  });
  const parts = [part("Посмотрели", looked, 0.3, 35), part("Притормозили", slowed, 0.2, 15), part("Остановились", stopped, 0.1, 20), part("Подошли ближе", approached, 0.1, 10)];
  if (entered !== null) parts.push(part("Вошли", entered, 0.05, 20));
  const w = parts.reduce((a, p) => a + p.weight, 0);
  const value = Math.round((parts.reduce((a, p) => a + p.weight * Math.min(1, p.rate / p.target), 0) / w) * 100);
  const grade = value < 40 ? "слабо цепляет" : value < 70 ? "средне" : "сильная витрина";
  return { value, parts, grade };
}

// ---- Деньги (MoneyEstimate.compute)

export interface Money {
  basisTitle: string;
  basis: number;
  conversion: number;
  buyers: number;
  revenue: number;
  perHour: number | null;
  perMonth: number | null;
  upliftPerMonth: number | null;
}

export function money(p: BusinessProfile, people: number, looked: number, entered: number | null, duration: number): Money {
  const useEntered = entered !== null;
  const basis = entered ?? looked;
  const conversion = useEntered ? p.enterToBuy : p.lookToBuy;
  const buyers = (basis * conversion) / 100;
  const revenue = buyers * p.avgCheck;
  const e: Money = { basisTitle: useEntered ? "вошедших" : "посмотревших", basis, conversion, buyers, revenue, perHour: null, perMonth: null, upliftPerMonth: null };
  if (duration >= 60) {
    e.perHour = (revenue / duration) * 3600;
    e.perMonth = e.perHour * p.hoursPerDay * p.daysPerMonth;
    const extraLookers = ((people * 0.1) / duration) * 3600 * p.hoursPerDay * p.daysPerMonth;
    e.upliftPerMonth = ((extraLookers * p.lookToBuy) / 100) * p.avgCheck;
  }
  return e;
}

export function rubles(v: number): string {
  const r = v >= 10_000 ? Math.round(v / 1000) * 1000 : v >= 1000 ? Math.round(v / 100) * 100 : Math.round(v);
  return `${r.toLocaleString("ru-RU")} ₽`;
}
