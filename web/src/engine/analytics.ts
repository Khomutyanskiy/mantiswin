// Логика подсчёта: прошёл / притормозил / посмотрел.
// Порт python/mantis/analytics.py и iOS Analytics.swift один в один.
// Не зависит от нейросети и трекера — на вход идут уже отслеженные люди (track id + рамка + точки).

import type { AnalyticsConfig } from "./config";
import { type Box, type Pt, median, pointInPolygon, polygonArea, segmentsIntersect, sideOfLine } from "./geometry";
import { type Keypoint, estimateHeadPose, isLooking } from "./headpose";

export const MAX_DT = 0.5; // секунды; больший разрыв между кадрами не учитываем в накоплении времени

/** Человек в кадре после трекинга. */
export interface TrackedPerson {
  trackId: number;
  box: Box;
  keypoints: Keypoint[] | null;
}

export const footOf = (b: Box): Pt => ({ x: (b.x1 + b.x2) / 2, y: b.y2 });
export const heightOf = (b: Box): number => Math.max(1, b.y2 - b.y1);

export type EventKind = "passed" | "slowed" | "looked" | "entered";

export interface AnalyticsEvent {
  t: number;
  trackId: number;
  kind: EventKind;
  direction: "" | "forward" | "backward";
}

export interface Counters {
  passed: number;
  passedForward: number;
  passedBackward: number;
  slowed: number;
  looked: number;
}

export interface TrackSummary {
  trackId: number;
  firstT: number;
  lastT: number;
  passed: boolean;
  direction: string;
  slowed: boolean;
  looked: boolean;
  zoneTime: number;
  slowTime: number;
  lookTime: number;
  minSpeed: number | null;
  everInZone: boolean;
}

interface HistoryItem {
  t: number;
  x: number;
  y: number;
  h: number;
}

const HISTORY_LIMIT = 120;

/** Состояние одного человека по ходу видео. */
export class TrackState {
  firstT: number;
  lastT: number;
  history: HistoryItem[] = [];
  passed = false;
  direction: "forward" | "backward" | null = null;
  zoneTime = 0;
  slowTime = 0;
  lookTime = 0;
  slowed = false;
  looked = false;
  speed: number | null = null;
  minSpeed: number | null = null;
  private _inZone = false;
  everInZone = false;
  lookingNow = false;
  box: Box;

  constructor(readonly trackId: number, t: number, box: Box) {
    this.firstT = t;
    this.lastT = t;
    this.box = box;
  }

  get inZone(): boolean {
    return this._inZone;
  }
  set inZone(v: boolean) {
    this._inZone = v;
    if (v) this.everInZone = true;
  }

  appendHistory(item: HistoryItem): void {
    this.history.push(item);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
  }

  summary(): TrackSummary {
    return {
      trackId: this.trackId, firstT: this.firstT, lastT: this.lastT, passed: this.passed,
      direction: this.direction ?? "", slowed: this.slowed, looked: this.looked, zoneTime: this.zoneTime,
      slowTime: this.slowTime, lookTime: this.lookTime, minSpeed: this.minSpeed, everInZone: this.everInZone,
    };
  }
}

export function emptyCounters(): Counters {
  return { passed: 0, passedForward: 0, passedBackward: 0, slowed: 0, looked: 0 };
}

export class Analytics {
  /** Линия подсчёта в пикселях; null — линия выключена, «прошёл» не считается. */
  readonly line: { a: Pt; b: Pt } | null;
  readonly tracks = new Map<number, TrackState>();
  readonly finished: TrackSummary[] = [];
  readonly counters: Counters = emptyCounters();
  lastT = 0;
  /** Фокусное расстояние в пикселях (для скорости по глубине); 0 — не учитывать движение к камере. */
  readonly focal: number;
  /** Зона детекции — весь кадр (тогда правило «долго в зоне» не применяется). */
  readonly zoneIsFull: boolean;

  /** line и zone — уже в пикселях кадра. */
  constructor(
    readonly cfg: AnalyticsConfig,
    line: Pt[],
    readonly zone: Pt[],
    frameWidth?: number,
    frameHeight?: number,
  ) {
    this.line = cfg.countLineEnabled && line.length === 2 ? { a: line[0], b: line[1] } : null;
    if (frameWidth !== undefined && frameHeight !== undefined) {
      this.focal = cfg.slowdown.focalRatio * Math.max(frameWidth, frameHeight);
      this.zoneIsFull = polygonArea(zone) >= 0.98 * frameWidth * frameHeight;
    } else {
      this.focal = 0;
      this.zoneIsFull = false;
    }
  }

  /** Сглаженная скорость в «ростах в секунду» за окно smoothingSeconds. */
  private speed(tr: TrackState): number | null {
    const win = this.cfg.slowdown.smoothingSeconds;
    const last = tr.history[tr.history.length - 1];
    if (!last) return null;
    const tNow = last.t;
    const pts = tr.history.filter((h) => tNow - h.t <= win);
    if (pts.length < 2 || pts[pts.length - 1].t - pts[0].t < win * 0.5) return null;
    const p0 = pts[0], p1 = pts[pts.length - 1];
    const h = median(pts.map((p) => p.h));
    const dist = Math.sqrt((p1.x - p0.x) * (p1.x - p0.x) + (p1.y - p0.y) * (p1.y - p0.y));
    const lateral = dist / h / (p1.t - p0.t);
    if (this.focal <= 0) return lateral;
    // Движение к камере/от камеры: человек почти не сдвигается, но растёт/уменьшается.
    // Скорость по глубине в «ростах в секунду» = (f/h) * |d ln h / dt|, наклон — по МНК за окно.
    const dwin = this.cfg.slowdown.depthWindowSeconds;
    const dp = tr.history.filter((p) => tNow - p.t <= dwin);
    let depth = 0;
    if (dp.length >= 3) {
      const n = dp.length;
      let sumT = 0, sumL = 0;
      for (const p of dp) sumT += p.t;
      for (const p of dp) sumL += Math.log(p.h);
      const mt = sumT / n, ml = sumL / n;
      let den = 0;
      for (const p of dp) den += (p.t - mt) * (p.t - mt);
      if (den > 0) {
        let num = 0;
        for (const p of dp) num += (p.t - mt) * (Math.log(p.h) - ml);
        depth = (this.focal / h) * Math.abs(num / den);
      }
    }
    return Math.pow(lateral * lateral + depth * depth, 0.5);
  }

  /** Обработать один кадр. t — время кадра в секундах. Возвращает новые события. */
  update(t: number, people: TrackedPerson[]): AnalyticsEvent[] {
    this.lastT = t;
    const events: AnalyticsEvent[] = [];
    const sd = this.cfg.slowdown, lk = this.cfg.look;

    for (const det of people) {
      const foot = footOf(det.box);
      const height = heightOf(det.box);
      const tr = this.tracks.get(det.trackId);
      if (!tr) {
        const fresh = new TrackState(det.trackId, t, det.box);
        fresh.appendHistory({ t, x: foot.x, y: foot.y, h: height });
        fresh.inZone = pointInPolygon(foot, this.zone);
        this.tracks.set(det.trackId, fresh);
        continue;
      }

      const dt = Math.min(Math.max(t - tr.lastT, 0), MAX_DT);
      const prev = tr.history[tr.history.length - 1];
      tr.appendHistory({ t, x: foot.x, y: foot.y, h: height });
      tr.lastT = t;
      tr.box = det.box;

      // 1. Прошёл: отрезок движения ног пересёк линию подсчёта
      const ln = this.line;
      if (ln && !tr.passed && segmentsIntersect({ x: prev.x, y: prev.y }, foot, ln.a, ln.b)) {
        tr.passed = true;
        const dir = sideOfLine(foot, ln.a, ln.b) > 0 ? "forward" : "backward";
        tr.direction = dir;
        this.counters.passed += 1;
        if (dir === "forward") this.counters.passedForward += 1;
        else this.counters.passedBackward += 1;
        events.push({ t, trackId: tr.trackId, kind: "passed", direction: dir });
      }

      // 2. Притормозил: медленно в зоне или долго в зоне
      tr.inZone = pointInPolygon(foot, this.zone);
      tr.speed = this.speed(tr);
      if (tr.inZone) {
        tr.zoneTime += dt;
        if (tr.speed !== null) {
          tr.minSpeed = tr.minSpeed === null ? tr.speed : Math.min(tr.minSpeed, tr.speed);
          if (tr.speed < sd.speedThreshold) tr.slowTime += dt;
        }
        // «Долго в зоне» имеет смысл только для зоны у витрины, а не для всего кадра
        const dwellOK = !(this.zoneIsFull && sd.dwellOnlyWithZone);
        if (!tr.slowed && (tr.slowTime >= sd.minSlowSeconds || (dwellOK && tr.zoneTime >= sd.dwellSeconds))) {
          tr.slowed = true;
          this.counters.slowed += 1;
          events.push({ t, trackId: tr.trackId, kind: "slowed", direction: "" });
        }
      }

      // 3. Посмотрел: голова повёрнута к витрине, пока человек в зоне
      const pose = estimateHeadPose(det.keypoints, lk.minKeypointConf);
      tr.lookingNow = tr.inZone && isLooking(pose, lk.showcaseDirection, lk.maxYaw, lk.minSideYaw);
      if (tr.lookingNow) {
        tr.lookTime += dt;
        if (!tr.looked && tr.lookTime >= lk.minLookSeconds) {
          tr.looked = true;
          this.counters.looked += 1;
          events.push({ t, trackId: tr.trackId, kind: "looked", direction: "" });
        }
      }
    }

    this.closeLost(t);
    return events;
  }

  private closeLost(t: number): void {
    const timeout = this.cfg.tracking.lostTimeoutSeconds;
    const lost = [...this.tracks.entries()].filter(([, tr]) => t - tr.lastT > timeout).map(([id]) => id).sort((a, b) => a - b);
    for (const id of lost) {
      const tr = this.tracks.get(id)!;
      this.tracks.delete(id);
      this.finish(tr);
    }
  }

  private finish(tr: TrackState): void {
    if (tr.lastT - tr.firstT >= this.cfg.tracking.minTrackSeconds) this.finished.push(tr.summary());
  }

  closeAll(): void {
    for (const id of [...this.tracks.keys()].sort((a, b) => a - b)) this.finish(this.tracks.get(id)!);
    this.tracks.clear();
  }
}
