// Трекер ByteTrack: присваивает людям устойчивые ID между кадрами.
// Порт ultralytics BYTETracker с параметрами bytetrack.yaml (через iOS ByteTracker.swift),
// чтобы ID и счётчики совпадали с Python и iOS.

import { type Box, iou } from "./geometry";
import type { Keypoint } from "./headpose";
import { KalmanFilterXYAH, type Matrix } from "./kalman";

/** Сырая детекция нейросети (после NMS), в пикселях кадра. */
export interface RawDetection {
  box: Box;
  score: number;
  keypoints: Keypoint[];
}

export interface ByteTrackConfig {
  trackHighThresh: number;
  trackLowThresh: number;
  newTrackThresh: number;
  trackBuffer: number;
  matchThresh: number;
  fuseScore: boolean;
  /** ultralytics всегда передаёт frame_rate = 30, поэтому max_time_lost = trackBuffer кадров. */
  frameRate: number;
}

export const defaultByteTrackConfig = (): ByteTrackConfig => ({
  trackHighThresh: 0.25,
  trackLowThresh: 0.1,
  newTrackThresh: 0.25,
  trackBuffer: 30,
  matchThresh: 0.8,
  fuseScore: true,
  frameRate: 30,
});

type State = "new" | "tracked" | "lost" | "removed";

class STrack {
  trackId = 0;
  isActivated = false;
  state: State = "new";
  mean: number[] | null = null;
  cov: Matrix | null = null;
  detTLWH: number[];
  score: number;
  detIndex: number;
  frameId = 0;
  startFrame = 0;
  trackletLen = 0;

  constructor(det: RawDetection, index: number) {
    this.detTLWH = [det.box.x1, det.box.y1, det.box.x2 - det.box.x1, det.box.y2 - det.box.y1];
    this.score = det.score;
    this.detIndex = index;
  }

  get endFrame(): number {
    return this.frameId;
  }

  /** Текущая рамка (top-left, w, h): из состояния фильтра, если оно есть. */
  get tlwh(): number[] {
    const m = this.mean;
    if (!m) return this.detTLWH;
    const w = m[2] * m[3];
    return [m[0] - w / 2, m[1] - m[3] / 2, w, m[3]];
  }

  get xyxy(): Box {
    const r = this.tlwh;
    return { x1: r[0], y1: r[1], x2: r[0] + r[2], y2: r[1] + r[3] };
  }

  static xyah(tlwh: number[]): number[] {
    return [tlwh[0] + tlwh[2] / 2, tlwh[1] + tlwh[3] / 2, tlwh[2] / tlwh[3], tlwh[3]];
  }

  activate(kf: KalmanFilterXYAH, frameId: number, newId: number): void {
    this.trackId = newId;
    const { mean, cov } = kf.initiate(STrack.xyah(this.detTLWH));
    this.mean = mean;
    this.cov = cov;
    this.trackletLen = 0;
    this.state = "tracked";
    if (frameId === 1) this.isActivated = true;
    this.frameId = frameId;
    this.startFrame = frameId;
  }

  reActivate(det: STrack, kf: KalmanFilterXYAH, frameId: number): void {
    const { mean, cov } = kf.update(this.mean!, this.cov!, STrack.xyah(det.tlwh));
    this.mean = mean;
    this.cov = cov;
    this.trackletLen = 0;
    this.state = "tracked";
    this.isActivated = true;
    this.frameId = frameId;
    this.score = det.score;
    this.detIndex = det.detIndex;
  }

  update(det: STrack, kf: KalmanFilterXYAH, frameId: number): void {
    this.frameId = frameId;
    this.trackletLen += 1;
    const { mean, cov } = kf.update(this.mean!, this.cov!, STrack.xyah(det.tlwh));
    this.mean = mean;
    this.cov = cov;
    this.state = "tracked";
    this.isActivated = true;
    this.score = det.score;
    this.detIndex = det.detIndex;
  }
}

/** Результат трекинга для одного человека в кадре. */
export interface TrackOutput {
  trackId: number;
  /** Рамка из фильтра Калмана (как отдаёт ultralytics). */
  box: Box;
  /** Индекс исходной детекции — оттуда берутся ключевые точки. */
  detIndex: number;
}

export class ByteTracker {
  private readonly kf = new KalmanFilterXYAH();
  private tracked: STrack[] = [];
  private lost: STrack[] = [];
  private removed: STrack[] = [];
  private frameId = 0;
  private nextId = 0;
  private readonly maxTimeLost: number;

  constructor(readonly cfg: ByteTrackConfig = defaultByteTrackConfig()) {
    this.maxTimeLost = Math.trunc((cfg.frameRate / 30) * cfg.trackBuffer);
  }

  private newId(): number {
    this.nextId += 1;
    return this.nextId;
  }

  /** width/height — размер кадра: итоговые рамки обрезаются по кадру (как Results.update в ultralytics). */
  update(detections: RawDetection[], width: number, height: number): TrackOutput[] {
    this.frameId += 1;
    const frameId = this.frameId, kf = this.kf, cfg = this.cfg;
    const activated: STrack[] = [];
    const refind: STrack[] = [];
    const lostNow: STrack[] = [];
    const removedNow: STrack[] = [];

    const high: STrack[] = [];
    const second: STrack[] = [];
    detections.forEach((d, i) => {
      if (d.score >= cfg.trackHighThresh) high.push(new STrack(d, i));
      else if (d.score > cfg.trackLowThresh) second.push(new STrack(d, i));
    });

    const unconfirmed = this.tracked.filter((t) => !t.isActivated);
    const trackedConfirmed = this.tracked.filter((t) => t.isActivated);

    // Шаг 2: первое сопоставление — уверенные детекции с активными и потерянными треками
    const pool = joint(trackedConfirmed, this.lost);
    for (const t of pool) {
      if (!t.mean || !t.cov) continue;
      const m = [...t.mean];
      if (t.state !== "tracked") m[7] = 0;
      const p = kf.predict(m, t.cov);
      t.mean = p.mean;
      t.cov = p.cov;
    }
    let dists = iouDistance(pool, high);
    if (cfg.fuseScore) dists = fuseScore(dists, high);
    const r1 = solveAssignment(dists, pool.length, high.length, cfg.matchThresh);
    for (const [it, id] of r1.matches) {
      const track = pool[it], det = high[id];
      if (track.state === "tracked") {
        track.update(det, kf, frameId);
        activated.push(track);
      } else {
        track.reActivate(det, kf, frameId);
        refind.push(track);
      }
    }

    // Шаг 3: второе сопоставление — слабые детекции с оставшимися активными треками
    const rTracked = r1.unmatchedRows.map((i) => pool[i]).filter((t) => t.state === "tracked");
    const dists2 = iouDistance(rTracked, second);
    const r2 = solveAssignment(dists2, rTracked.length, second.length, 0.5);
    for (const [it, id] of r2.matches) {
      const track = rTracked[it], det = second[id];
      if (track.state === "tracked") {
        track.update(det, kf, frameId);
        activated.push(track);
      } else {
        track.reActivate(det, kf, frameId);
        refind.push(track);
      }
    }
    for (const it of r2.unmatchedRows) {
      const track = rTracked[it];
      if (track.state !== "lost") {
        track.state = "lost";
        lostNow.push(track);
      }
    }

    // Неподтверждённые треки (появились на прошлом кадре)
    const rest = r1.unmatchedCols.map((i) => high[i]);
    let dists3 = iouDistance(unconfirmed, rest);
    if (cfg.fuseScore) dists3 = fuseScore(dists3, rest);
    const r3 = solveAssignment(dists3, unconfirmed.length, rest.length, 0.7);
    for (const [it, id] of r3.matches) {
      unconfirmed[it].update(rest[id], kf, frameId);
      activated.push(unconfirmed[it]);
    }
    for (const it of r3.unmatchedRows) {
      unconfirmed[it].state = "removed";
      removedNow.push(unconfirmed[it]);
    }

    // Шаг 4: новые треки
    for (const id of r3.unmatchedCols) {
      const track = rest[id];
      if (track.score < cfg.newTrackThresh) continue;
      track.activate(kf, frameId, this.newId());
      activated.push(track);
    }

    // Шаг 5: удаляем давно потерянные
    for (const track of this.lost) {
      if (frameId - track.endFrame > this.maxTimeLost) {
        track.state = "removed";
        removedNow.push(track);
      }
    }

    this.tracked = this.tracked.filter((t) => t.state === "tracked");
    this.tracked = joint(this.tracked, activated);
    this.tracked = joint(this.tracked, refind);
    this.lost = sub(this.lost, this.tracked);
    this.lost.push(...lostNow);
    this.lost = sub(this.lost, removedNow);
    [this.tracked, this.lost] = removeDuplicates(this.tracked, this.lost);
    this.removed.push(...removedNow);
    if (this.removed.length > 1000) this.removed.splice(0, this.removed.length - 999);

    const clampX = (v: number) => Math.min(Math.max(v, 0), width);
    const clampY = (v: number) => Math.min(Math.max(v, 0), height);
    return this.tracked
      .filter((t) => t.isActivated)
      .map((t) => {
        const b = t.xyxy;
        return { trackId: t.trackId, box: { x1: clampX(b.x1), y1: clampY(b.y1), x2: clampX(b.x2), y2: clampY(b.y2) }, detIndex: t.detIndex };
      });
  }
}

// ---- Вспомогательные функции (как в ultralytics.trackers.byte_tracker / utils.matching)

function joint(a: STrack[], b: STrack[]): STrack[] {
  const exists = new Set(a.map((t) => t.trackId));
  const res = [...a];
  for (const t of b) {
    if (!exists.has(t.trackId)) {
      exists.add(t.trackId);
      res.push(t);
    }
  }
  return res;
}

function sub(a: STrack[], b: STrack[]): STrack[] {
  const ids = new Set(b.map((t) => t.trackId));
  return a.filter((t) => !ids.has(t.trackId));
}

function removeDuplicates(a: STrack[], b: STrack[]): [STrack[], STrack[]] {
  const d = iouDistance(a, b);
  const dupA = new Set<number>(), dupB = new Set<number>();
  for (let p = 0; p < a.length; p++) {
    for (let q = 0; q < b.length; q++) {
      if (d[p][q] < 0.15) {
        const timeP = a[p].frameId - a[p].startFrame;
        const timeQ = b[q].frameId - b[q].startFrame;
        if (timeP > timeQ) dupB.add(q);
        else dupA.add(p);
      }
    }
  }
  return [a.filter((_, i) => !dupA.has(i)), b.filter((_, i) => !dupB.has(i))];
}

function iouDistance(a: STrack[], b: STrack[]): number[][] {
  const boxesB = b.map((t) => t.xyxy);
  return a.map((ta) => {
    const ba = ta.xyxy;
    return boxesB.map((bb) => 1 - iou(ba, bb));
  });
}

function fuseScore(cost: number[][], dets: STrack[]): number[][] {
  return cost.map((row) => row.map((c, j) => 1 - (1 - c) * dets[j].score));
}

/** Оптимальное сопоставление с порогом стоимости — как lap.lapjv(extend_cost=True, cost_limit=thresh). */
export function solveAssignment(
  cost: number[][],
  n: number,
  m: number,
  thresh: number,
): { matches: [number, number][]; unmatchedRows: number[]; unmatchedCols: number[] } {
  if (n === 0 || m === 0) {
    return { matches: [], unmatchedRows: [...Array(n).keys()], unmatchedCols: [...Array(m).keys()] };
  }
  // Расширенная матрица (n+m)×(n+m): реальные стоимости, «отказ» стоит thresh/2 с каждой стороны.
  const size = n + m;
  const ext: number[][] = [];
  for (let i = 0; i < size; i++) {
    const row = new Array<number>(size).fill(thresh / 2);
    if (i >= n) for (let j = m; j < size; j++) row[j] = 0;
    else for (let j = 0; j < m; j++) row[j] = cost[i][j];
    ext.push(row);
  }
  const assign = hungarian(ext);
  const matches: [number, number][] = [];
  const matchedCols = new Set<number>();
  const unmatchedRows: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = assign[i];
    if (j < m) {
      matches.push([i, j]);
      matchedCols.add(j);
    } else {
      unmatchedRows.push(i);
    }
  }
  const unmatchedCols = [...Array(m).keys()].filter((j) => !matchedCols.has(j));
  return { matches, unmatchedRows, unmatchedCols };
}

/** Венгерский алгоритм (O(n³), с потенциалами) для квадратной матрицы. Возвращает столбец для каждой строки. */
function hungarian(a: number[][]): number[] {
  const n = a.length;
  const INF = Number.MAX_VALUE;
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1); // p[j] — строка, назначенная столбцу j (1-based)
  const way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(INF);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const result = new Array<number>(n).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j] > 0) result[p[j] - 1] = j - 1;
  return result;
}
