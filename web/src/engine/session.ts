// Сессия анализа: детекции кадра → ByteTrack → подсчёт → траектории.
// Один и тот же код работает для видеофайла, веб-камеры и тестов на эталонных данных.

import { Analytics, type AnalyticsEvent, type Counters, type TrackSummary, footOf, heightOf } from "./analytics";
import { ByteTracker, type RawDetection } from "./bytetrack";
import { REID_WINDOW, TrackReID } from "./reid";
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
  /** Сотрудник — не считается (рамка серая). */
  staff?: boolean;
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

/** Живой подсчёт (камера, мониторинг) — как LiveCameraEngine.swift на Mac. Для разбора видео не нужны. */
export interface LiveOptions {
  /** Склейка повторных треков (человек пропал на секунду и вернулся с новым номером). */
  reid?: boolean;
  /** Сотрудник: дольше стольких минут в кадре — не считается (и снимается уже засчитанное); null — считать всех. */
  staffMinutes?: number | null;
  /** Человек засчитывается в «людей в зоне», только пробыв в зоне столько секунд (minTrackSeconds). */
  seenAfter?: number;
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
  /** Отбор людей после трекера (неподвижные фигуры в пилоте); null — все. */
  trackFilter: (<P extends { trackId: number; box: Box }>(people: P[], t: number) => P[]) | null = null;
  private readonly reid: TrackReID | null;
  private readonly staffIds = new Set<number>();
  private readonly firstSeenAt = new Map<number, number>();
  private readonly zoneSince = new Map<number, number>();
  /** Сколько раз склеили треки (диагностика). */
  get merged(): number {
    return this.reid?.merged ?? 0;
  }

  /** entrance — линия входа в долях кадра (null — вход не считаем). */
  constructor(
    readonly cfg: AnalyticsConfig,
    readonly width: number,
    readonly height: number,
    entrance: Pt[] | null,
    readonly fps: number,
    readonly live: LiveOptions = {},
  ) {
    if (live.reid) {
      // трек держим дольше окна склейки — вернувшийся продолжит свою историю, а «притормозил» и «посмотрел»
      // не засчитаются ему второй раз
      cfg = structuredClone(cfg);
      cfg.tracking.lostTimeoutSeconds = Math.max(cfg.tracking.lostTimeoutSeconds, REID_WINDOW + 1);
      this.cfg = cfg;
    }
    this.reid = live.reid ? new TrackReID() : null;
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
    const ids = this.reid ? this.reid.identities(tracked.map((o) => ({ trackId: o.trackId, box: o.box })), t) : null;
    let people = tracked.map((o, i) => ({ trackId: ids ? ids[i] : o.trackId, box: o.box, keypoints: raw[o.detIndex]?.keypoints ?? null }));
    if (this.trackFilter) people = this.trackFilter(people, t);
    const events = this.analytics.update(t, people);

    let inZoneNow = 0;
    const boxes: OverlayBox[] = [];
    for (const p of people) {
      const tr = this.analytics.tracks.get(p.trackId);
      if (!tr) continue;
      // сотрудник: в кадре дольше заданного — снимаем засчитанное и больше не считаем
      const staffMin = this.live.staffMinutes;
      if (staffMin) {
        const first = this.firstSeenAt.get(p.trackId) ?? t;
        this.firstSeenAt.set(p.trackId, first);
        if (!this.staffIds.has(p.trackId) && t - first >= staffMin * 60) {
          this.staffIds.add(p.trackId);
          this.analytics.markStaff(p.trackId);
          if (this.seenIds.has(p.trackId)) this.seen = Math.max(0, this.seen - 1);
        }
        if (this.staffIds.has(p.trackId)) {
          boxes.push({ trackId: p.trackId, box: p.box, state: "tracked", lookingNow: false, speed: tr.speed, inZone: false, keypoints: p.keypoints, staff: true });
          continue;
        }
      }
      const foot = footOf(p.box);
      const traj = this.trajectories.get(p.trackId) ?? [];
      const prev = traj[traj.length - 1];
      traj.push({ t, x: foot.x, y: foot.y, h: heightOf(p.box), inZone: tr.inZone, looking: tr.lookingNow, speed: tr.speed });
      this.trajectories.set(p.trackId, traj);
      if (tr.inZone) {
        inZoneNow += 1;
        const since = this.zoneSince.get(p.trackId) ?? t;
        this.zoneSince.set(p.trackId, since);
        if (!this.seenIds.has(p.trackId) && t - since >= (this.live.seenAfter ?? 0)) {
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
        this.staffIds.delete(id);
        this.firstSeenAt.delete(id);
        this.zoneSince.delete(id);
      } else if (traj.length > 600) {
        traj.splice(0, traj.length - 600);
      }
    }
    // сотрудники и время в кадре — только для тех, кто ещё в кадре
    for (const id of [...this.firstSeenAt.keys()]) {
      if (!this.analytics.tracks.has(id)) {
        this.firstSeenAt.delete(id);
        this.staffIds.delete(id);
        this.zoneSince.delete(id);
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
