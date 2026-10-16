// Сессия анализа: детекции кадра → ByteTrack → подсчёт → траектории.
// Один и тот же код работает для видеофайла, веб-камеры и тестов на эталонных данных.

import { Analytics, type AnalyticsEvent, type Counters, type TrackSummary, footOf, heightOf } from "./analytics";
import { ByteTracker, type RawDetection } from "./bytetrack";
import type { AnalyticsConfig } from "./config";
import { type Box, type Pt, segmentsIntersect, toPixels } from "./geometry";
import { type ExtendedMetrics, type TrackPoint, computeMetrics } from "./metrics";

export type PersonState = "tracked" | "passed" | "slowed" | "looked";

/** Что рисовать поверх кадра. */
export interface OverlayBox {
  trackId: number;
  box: Box;
  state: PersonState;
  lookingNow: boolean;
  speed: number | null;
  inZone: boolean;
  keypoints: RawDetection["keypoints"] | null;
}

export interface FrameResult {
  t: number;
  events: AnalyticsEvent[];
  boxes: OverlayBox[];
  counters: Counters;
  entered: number;
}

export interface SessionReport {
  width: number;
  height: number;
  seconds: number;
  frames: number;
  counters: Counters;
  entered: number | null;
  events: AnalyticsEvent[];
  tracks: TrackSummary[];
  metrics: ExtendedMetrics;
}

export class Session {
  readonly analytics: Analytics;
  readonly tracker = new ByteTracker();
  readonly linePx: Pt[];
  readonly zonePx: Pt[];
  readonly entrancePx: Pt[] | null;
  readonly events: AnalyticsEvent[] = [];
  readonly trajectories = new Map<number, TrackPoint[]>();
  private readonly enteredIds = new Set<number>();
  private readonly seenIds = new Set<number>();
  /** Сколько разных людей побывало в зоне (как seen в iOS LiveCameraEngine). */
  seen = 0;
  /** Сколько вошло в магазин (живой счётчик). */
  enteredCount = 0;
  private maxSimultaneous = 0;
  private frames = 0;
  private firstT: number | null = null;

  /** entrance — линия входа в долях кадра (null — вход не считаем). */
  constructor(
    readonly cfg: AnalyticsConfig,
    readonly width: number,
    readonly height: number,
    entrance: Pt[] | null,
    readonly fps: number,
  ) {
    this.linePx = cfg.countLineEnabled ? toPixels(cfg.countLine, width, height) : [];
    this.zonePx = toPixels(cfg.showcaseZone, width, height);
    this.entrancePx = entrance && entrance.length === 2 ? toPixels(entrance, width, height) : null;
    this.analytics = new Analytics(cfg, this.linePx, this.zonePx, width, height);
  }

  /** Обработать кадр с уже найденными людьми. */
  update(t: number, raw: RawDetection[]): FrameResult {
    if (this.firstT === null) this.firstT = t;
    this.frames += 1;
    const tracked = this.tracker.update(raw, this.width, this.height);
    const people = tracked.map((o) => ({ trackId: o.trackId, box: o.box, keypoints: raw[o.detIndex]?.keypoints ?? null }));
    const events = this.analytics.update(t, people);

    let inZoneNow = 0;
    const boxes: OverlayBox[] = [];
    for (const p of people) {
      const tr = this.analytics.tracks.get(p.trackId);
      if (!tr) continue;
      const foot = footOf(p.box);
      const traj = this.trajectories.get(p.trackId) ?? [];
      const prev = traj[traj.length - 1];
      traj.push({ t, x: foot.x, y: foot.y, h: heightOf(p.box), inZone: tr.inZone, looking: tr.lookingNow, speed: tr.speed });
      this.trajectories.set(p.trackId, traj);
      if (tr.inZone) {
        inZoneNow += 1;
        if (!this.seenIds.has(p.trackId)) {
          this.seenIds.add(p.trackId);
          this.seen += 1;
        }
      }

      // Вход в магазин — живой счётчик (в итогах пересчитывается по траекториям, как в iOS)
      const en = this.entrancePx;
      if (en && prev && !this.enteredIds.has(p.trackId) && segmentsIntersect({ x: prev.x, y: prev.y }, foot, en[0], en[1])) {
        this.enteredIds.add(p.trackId);
        this.enteredCount += 1;
        events.push({ t, trackId: p.trackId, kind: "entered", direction: "" });
      }

      const state: PersonState = tr.looked ? "looked" : tr.slowed ? "slowed" : tr.passed ? "passed" : "tracked";
      boxes.push({ trackId: p.trackId, box: p.box, state, lookingNow: tr.lookingNow, speed: tr.speed, inZone: tr.inZone, keypoints: p.keypoints });
    }
    this.maxSimultaneous = Math.max(this.maxSimultaneous, inZoneNow);
    this.events.push(...events);
    return { t, events, boxes, counters: { ...this.analytics.counters }, entered: this.enteredCount };
  }

  /**
   * Для долгой работы (пилот): забыть ушедших людей, чтобы память не росла.
   * Счётчики (seen, enteredCount, analytics.counters) не меняются.
   */
  prune(t: number, keepSeconds = 30): void {
    for (const [id, traj] of this.trajectories) {
      const last = traj[traj.length - 1];
      if (!this.analytics.tracks.has(id) && (!last || t - last.t > keepSeconds)) {
        this.trajectories.delete(id);
        this.enteredIds.delete(id);
        this.seenIds.delete(id);
      } else if (traj.length > 600) {
        traj.splice(0, traj.length - 600);
      }
    }
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    const fin = this.analytics.finished;
    if (fin.length > 500) fin.splice(0, fin.length - 500);
  }

  /** Закончить анализ и посчитать итоги. */
  finish(): SessionReport {
    this.analytics.closeAll();
    const line = this.linePx.length === 2 ? { a: this.linePx[0], b: this.linePx[1] } : null;
    const entrance = this.entrancePx ? { a: this.entrancePx[0], b: this.entrancePx[1] } : null;
    const metrics = computeMetrics(this.trajectories, this.analytics.finished, this.height, line, entrance, this.maxSimultaneous, this.fps);
    return {
      width: this.width,
      height: this.height,
      seconds: this.firstT === null ? 0 : this.analytics.lastT - this.firstT,
      frames: this.frames,
      counters: { ...this.analytics.counters },
      entered: metrics.entered,
      events: [...this.events],
      tracks: [...this.analytics.finished],
      metrics,
    };
  }
}
