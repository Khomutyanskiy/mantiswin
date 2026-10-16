// Дополнительная аналитика по траекториям людей (итог по всему видео).
// Порт iOS ExtendedMetrics.swift (без тепловой карты): средняя скорость, остановки, время взгляда,
// подошли ближе, оглянулись, вход в магазин, группы, направления потока.
// Расстояния оцениваются по росту человека (~1,7 м) — это оценка, а не измерение.

import type { TrackSummary } from "./analytics";
import { MAX_DT } from "./analytics";
import { type Pt, median, segmentsIntersect } from "./geometry";

/** Точка траектории человека на одном проанализированном кадре. */
export interface TrackPoint {
  t: number;
  x: number; // точка ног, пиксели
  y: number;
  h: number; // высота рамки, пиксели
  inZone: boolean;
  looking: boolean;
  speed: number | null; // «ростов в секунду», как в Analytics
}

export interface ExtendedMetrics {
  people: number;
  /** Средняя скорость идущих, м/с. */
  avgSpeed: number | null;
  stopped: number;
  avgStopSeconds: number | null;
  lookers: number;
  avgLookSeconds: number | null;
  medianLookSeconds: number | null;
  totalLookSeconds: number;
  approached: number;
  lookedBack: number;
  /** null — линия входа не задана. */
  entered: number | null;
  singles: number;
  groups: number;
  peopleInGroups: number;
  towardCamera: number;
  awayFromCamera: number;
  leftToRight: number;
  rightToLeft: number;
  maxSimultaneous: number;
  enterTimes: number[];
  stopTimes: number[];
}

const PERSON_HEIGHT_M = 1.7;
const MOVING_SPEED = 0.15;
const STOP_SPEED = 0.12;
const MIN_STOP_SECONDS = 2.0;
const NEAR_FRACTION = 0.35;
const APPROACH_GROWTH = 1.3;
const MIN_LOOK_BACK_SECONDS = 0.4;

type Line = { a: Pt; b: Pt } | null;

export function computeMetrics(
  trajectories: Map<number, TrackPoint[]>,
  summaries: TrackSummary[],
  H: number,
  line: Line,
  entrance: Line,
  maxSimultaneous: number,
  fps: number,
): ExtendedMetrics {
  const m: ExtendedMetrics = {
    people: 0, avgSpeed: null, stopped: 0, avgStopSeconds: null, lookers: 0, avgLookSeconds: null,
    medianLookSeconds: null, totalLookSeconds: 0, approached: 0, lookedBack: 0, entered: entrance ? 0 : null,
    singles: 0, groups: 0, peopleInGroups: 0, towardCamera: 0, awayFromCamera: 0, leftToRight: 0, rightToLeft: 0,
    maxSimultaneous, enterTimes: [], stopTimes: [],
  };

  // Учитываем людей, которые были в зоне и продержались в кадре ≥ 0,5 с
  const tracks = new Map(
    [...trajectories.entries()]
      .filter(([, v]) => v.length >= 3 && v[v.length - 1].t - v[0].t >= 0.5 && v.some((p) => p.inZone))
      .sort((a, b) => a[0] - b[0]),
  );
  m.people = tracks.size;

  const speeds: number[] = [];
  const stopDurations: number[] = [];

  for (const v of tracks.values()) {
    // Средняя скорость: медиана скорости, пока человек идёт
    const moving = v.map((p) => p.speed).filter((s): s is number => s !== null && s > MOVING_SPEED);
    if (moving.length >= 3) speeds.push(median(moving) * PERSON_HEIGHT_M);

    // Остановка: непрерывно почти без движения ≥ 2 с
    let runStart: number | null = null;
    let bestRun = 0;
    let stopAt: number | null = null;
    for (const p of v) {
      if (p.speed !== null && p.speed < STOP_SPEED) {
        if (runStart === null) runStart = p.t;
        bestRun = Math.max(bestRun, p.t - runStart);
        if (stopAt === null && bestRun >= MIN_STOP_SECONDS) stopAt = p.t;
      } else {
        runStart = null;
      }
    }
    if (bestRun >= MIN_STOP_SECONDS) {
      m.stopped += 1;
      stopDurations.push(bestRun);
      if (stopAt !== null) m.stopTimes.push(stopAt);
    }

    // Подошёл ближе: самая крупная рамка
    let peak = 0;
    for (let i = 0; i < v.length; i++) if (v[i].h > v[peak].h) peak = i;
    const peakH = v[peak].h;
    if (peakH / H >= NEAR_FRACTION && peakH >= APPROACH_GROWTH * v[0].h) m.approached += 1;

    // Пересечения линий
    let passT: number | null = null;
    let enterT: number | null = null;
    for (let i = 1; i < v.length; i++) {
      const p0 = { x: v[i - 1].x, y: v[i - 1].y }, p1 = { x: v[i].x, y: v[i].y };
      if (passT === null && line && segmentsIntersect(p0, p1, line.a, line.b)) passT = v[i].t;
      if (enterT === null && entrance && segmentsIntersect(p0, p1, entrance.a, entrance.b)) enterT = v[i].t;
    }
    if (enterT !== null) {
      m.entered = (m.entered ?? 0) + 1;
      m.enterTimes.push(enterT);
    }

    // Оглянулся: смотрел в сторону витрины уже после прохода —
    // после пересечения линии или когда уже удаляется (рамка меньше пика на 10%)
    let back = 0;
    for (let i = 1; i < v.length; i++) {
      if (!v[i].looking) continue;
      const afterLine = passT !== null && v[i].t > passT;
      const movingAway = i > peak && v[i].h <= 0.9 * peakH;
      if (afterLine || movingAway) back += Math.min(v[i].t - v[i - 1].t, MAX_DT);
    }
    if (back >= MIN_LOOK_BACK_SECONDS) m.lookedBack += 1;

    // Направления
    const mh = median(v.map((p) => p.h));
    const dx = (v[v.length - 1].x - v[0].x) / mh;
    if (dx > 0.8) m.leftToRight += 1;
    else if (dx < -0.8) m.rightToLeft += 1;
    const ratio = v[v.length - 1].h / v[0].h;
    if (ratio > 1.25) m.towardCamera += 1;
    else if (ratio < 0.8) m.awayFromCamera += 1;
  }

  if (speeds.length) m.avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  if (stopDurations.length) m.avgStopSeconds = stopDurations.reduce((a, b) => a + b, 0) / stopDurations.length;

  // Время взгляда — из итогов подсчёта (то же, что даёт «Посмотрели»)
  const looks = summaries.filter((s) => s.looked && tracks.has(s.trackId)).map((s) => s.lookTime);
  m.lookers = looks.length;
  m.totalLookSeconds = looks.reduce((a, b) => a + b, 0);
  if (looks.length) {
    m.avgLookSeconds = m.totalLookSeconds / looks.length;
    m.medianLookSeconds = median(looks);
  }

  // Группы: идут рядом (≤ 1,2 роста, на одной глубине) ≥ 70% общего времени, общее время ≥ 2 с
  const keys = [...tracks.keys()];
  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k: number): number => {
    while (parent.get(k) !== k) k = parent.get(k)!;
    return k;
  };
  const byTime = new Map<number, Map<number, TrackPoint>>();
  for (const [k, v] of tracks) {
    const mp = new Map<number, TrackPoint>();
    for (const p of v) {
      const key = Math.round(p.t * 1000);
      if (!mp.has(key)) mp.set(key, p);
    }
    byTime.set(k, mp);
  }
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const A = byTime.get(keys[i])!, B = byTime.get(keys[j])!;
      const common = [...A.keys()].filter((t) => B.has(t));
      if (common.length < 2 * fps) continue;
      let close = 0;
      for (const t of common) {
        const pa = A.get(t)!, pb = B.get(t)!;
        const mh = (pa.h + pb.h) / 2;
        const d = Math.sqrt((pa.x - pb.x) ** 2 + (pa.y - pb.y) ** 2) / mh;
        const r = pa.h / pb.h;
        if (d < 1.2 && r > 0.75 && r < 1.33) close += 1;
      }
      if (close / common.length >= 0.7) {
        const ra = find(keys[i]), rb = find(keys[j]);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
  }
  const components = new Map<number, number>();
  for (const k of keys) components.set(find(k), (components.get(find(k)) ?? 0) + 1);
  for (const size of components.values()) {
    if (size >= 2) {
      m.groups += 1;
      m.peopleInGroups += size;
    } else {
      m.singles += 1;
    }
  }
  return m;
}
