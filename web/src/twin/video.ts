// Цифровой двойник для готового видео: тот же план, но люди берутся из анализа ролика.
// Видео и план идут синхронно, тепловая карта и зоны — за ролик (до текущего момента). Порт VideoTwin.swift (macOS).

import type { AnalyticsConfig } from "../engine/config";
import type { Pt } from "../engine/geometry";
import { type OverlayBox, Session } from "../engine/session";
import type { Detector } from "../detector";
import { CameraProjector, type CameraCalibration, type RecFrame, STATE_CODE, Timeline, type TwinPlan, planContains } from "./plan";

/** Кадр анализа: время и люди (рамки в пикселях кадра). */
export interface AnalyzedFrame {
  t: number;
  boxes: OverlayBox[];
}

export interface AnalysisResult {
  width: number;
  height: number;
  duration: number;
  frames: AnalyzedFrame[];
}

/** Построить двойник по кадрам анализа: проекция ног на план, сглаживание, тепло и зоны. */
export function buildVideoTimeline(frames: AnalyzedFrame[], W: number, H: number, plan: TwinPlan, cal: CameraCalibration): Timeline | null {
  const proj = CameraProjector.create(cal, plan);
  if (!proj || !(W > 0 && H > 0)) return null;
  const tl = new Timeline(plan);
  const b = new VideoTwinBuilder(proj, plan, W, H, tl);
  for (const f of frames) b.add(f);
  return tl;
}

/** Двойник по ходу анализа (кадр за кадром). */
export class VideoTwinBuilder {
  private smooth = new Map<number, Pt>();

  constructor(private readonly proj: CameraProjector, private readonly plan: TwinPlan, private readonly W: number, private readonly H: number, readonly tl: Timeline) {}

  add(fr: AnalyzedFrame): void {
    const row: RecFrame = { t: fr.t, p: [] };
    for (const b of fr.boxes) {
      const p = this.proj.projectBox(b.box, this.W, this.H);
      if (!p || !planContains(this.plan, p, 0.5)) continue;
      const c = { x: Math.min(Math.max(p.x, 0), this.plan.widthM), y: Math.min(Math.max(p.y, 0), this.plan.depthM) };
      const prev = this.smooth.get(b.trackId);
      const s = prev ? { x: prev.x + (c.x - prev.x) * 0.5, y: prev.y + (c.y - prev.y) * 0.5 } : c;
      this.smooth.set(b.trackId, s);
      row.p.push({ i: String(b.trackId), x: s.x, y: s.y, s: STATE_CODE[b.state] });
    }
    this.tl.add(row, 1 / 15);
  }
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-4 && video.readyState >= 2) return resolve();
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    video.currentTime = t;
  });
}

/** Открыть видео (без звука, для кадров). */
export function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = url;
    v.addEventListener("loadeddata", () => resolve(v), { once: true });
    v.addEventListener("error", () => reject(new Error("видео не открывается в этом браузере")), { once: true });
  });
}

/** Кадр видео в момент t (для привязки). */
export async function grabStill(video: HTMLVideoElement, t: number): Promise<ImageBitmap> {
  await seekTo(video, Math.min(Math.max(0, t), Math.max(0, video.duration - 0.05)));
  return createImageBitmap(video);
}

/**
 * Анализ ролика: кадры по 15 в секунду → нейросеть → трекер → подсчёт. onFrame — каждый кадр (двойник строится на ходу).
 */
export async function analyzeVideo(
  video: HTMLVideoElement, det: Detector, cfg: AnalyticsConfig, entrance: Pt[] | null, fps: number,
  onFrame: (f: AnalyzedFrame, progress: number) => void, cancelled: () => boolean,
): Promise<AnalysisResult> {
  video.pause();
  const W = video.videoWidth, H = video.videoHeight;
  const duration = video.duration;
  const total = Math.max(1, Math.floor(duration * fps));
  const session = new Session(cfg, W, H, entrance, fps);
  const frames: AnalyzedFrame[] = [];
  await seekTo(video, 0);
  for (let k = 0; k < total; k++) {
    if (cancelled()) throw new Error("отменено");
    const t = k / fps;
    const job = await det.submit(video, W, H);
    const next = k + 1 < total ? seekTo(video, (k + 1) / fps) : Promise.resolve();
    const res = await job.result;
    const fr = session.update(t, res.detections);
    const f = { t, boxes: fr.boxes };
    frames.push(f);
    onFrame(f, (k + 1) / total);
    await next;
  }
  return { width: W, height: H, duration, frames };
}
