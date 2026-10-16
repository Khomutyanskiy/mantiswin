// Чувствительность камеры: что считать человеком, а что — ложным срабатыванием.
// Порт DetectionFilter.swift (macOS): уровень, минимальный рост, строгость «посмотрел / притормозил».
// Применяется между нейросетью и трекером, у каждой камеры пилота — своя.

import type { RawDetection } from "../engine/bytetrack";
import type { AnalyticsConfig } from "../engine/config";

export interface DetectionFilter {
  /** 0 — максимальная чувствительность … 4 — минимальная (меньше ложных срабатываний). */
  level: number;
  /** Минимальный рост фигуры в % от высоты кадра; 0 — не ограничивать. */
  minHeightPercent: number;
  /** Строгость «посмотрел / притормозил»: 0 — мягкая, 1 — обычная, 2 — строгая. */
  behavior: number;
}

export const defaultFilter = (): DetectionFilter => ({ level: 1, minHeightPercent: 0, behavior: 1 });

export const LEVEL_TITLES = ["Максимальная", "Стандартная", "Сниженная", "Низкая", "Минимальная"];
export const LEVEL_HINTS = [
  "Ловит всех, даже плохо видимых. Возможны ложные срабатывания.",
  "Как по умолчанию — подходит для большинства камер.",
  "Нужна уверенность нейросети выше, фигура должна продержаться дольше.",
  "Для сложных сцен: отражения, плакаты, мелькания у края кадра.",
  "Только чётко видимые люди, которые пробыли в кадре 2 секунды и дольше.",
];
export const BEHAVIOR_TITLES = ["Мягкая", "Обычная", "Строгая"];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
const lv = (f: DetectionFilter) => clamp(f.level ?? 1, 0, 4);
const bh = (f: DetectionFilter) => clamp(f.behavior ?? 1, 0, 2);

/** Минимальная уверенность нейросети. */
export const minConfidence = (f: DetectionFilter) => [0.25, 0.35, 0.45, 0.55, 0.65][lv(f)];
/** Сколько секунд фигура должна пробыть в зоне, чтобы её посчитали. */
export const minTrackSeconds = (f: DetectionFilter) => [0.3, 0.5, 0.8, 1.2, 2.0][lv(f)];

export function isDefaultFilter(f: DetectionFilter): boolean {
  return lv(f) === 1 && !(f.minHeightPercent > 0) && bh(f) === 1;
}

/** Короткое описание для карточки камеры. */
export function filterSummary(f: DetectionFilter): string {
  const parts: string[] = [];
  if (lv(f) !== 1) parts.push(LEVEL_TITLES[lv(f)].toLowerCase());
  if (f.minHeightPercent > 0) parts.push(`рост ≥ ${Math.round(f.minHeightPercent)}%`);
  if (bh(f) !== 1) parts.push(`поведение: ${BEHAVIOR_TITLES[bh(f)].toLowerCase()}`);
  return parts.length ? parts.join(" · ") : "стандартная";
}

/** Пороги подсчёта с учётом строгости поведения и уровня. */
export function applyFilterToConfig(cfg: AnalyticsConfig, f: DetectionFilter): AnalyticsConfig {
  const c: AnalyticsConfig = structuredClone(cfg);
  c.tracking.minTrackSeconds = minTrackSeconds(f);
  if (bh(f) === 0) {
    c.look.minLookSeconds = 0.4;
    c.look.maxYaw = 0.45;
    c.slowdown.minSlowSeconds = 0.6;
    c.slowdown.speedThreshold = 0.35;
  } else if (bh(f) === 2) {
    c.look.minLookSeconds = 1.0;
    c.look.maxYaw = 0.25;
    c.slowdown.minSlowSeconds = 1.6;
    c.slowdown.speedThreshold = 0.24;
  }
  return c;
}

/** Отбросить детекции ниже порога уверенности и слишком маленькие фигуры. */
export function filterDetections(dets: RawDetection[], f: DetectionFilter, frameHeight: number): RawDetection[] {
  const conf = minConfidence(f);
  const minH = f.minHeightPercent > 0 ? (frameHeight * f.minHeightPercent) / 100 : 0;
  return dets.filter((d) => d.score >= conf && (minH === 0 || d.box.y2 - d.box.y1 >= minH));
}
