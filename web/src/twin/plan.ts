// Цифровой двойник точки — данные и геометрия. Порт TwinModel.swift (macOS).
// План помещения или улицы в метрах; камеры пилота привязаны к плану по 4 точкам на полу (гомография)
// или «по сектору» (место, поворот, угол обзора, дальность). Ноги людей из кадра переводятся в координаты плана.

import { type Box, type Pt, pointInPolygon, polygonArea, segmentsIntersect } from "../engine/geometry";
import type { PersonState } from "../engine/session";

const P = (x: number, y: number): Pt => ({ x, y });
const hypot = Math.hypot;

// ---------------------------------------------------------------- гомография

/** Проективное преобразование плоскости: 3×3 по строкам, h33 = 1. */
export type Homography = number[];

/** По 4 парам точек (src → dst). null — точки вырождены. */
export function homographyFrom(src: Pt[], dst: Pt[]): Homography | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], u = dst[i].x, v = dst[i].y;
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Гаусс с выбором главного элемента
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col; r < 8; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) <= 1e-12) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      if (f === 0) continue;
      for (let c = col; c < 9; c++) a[r][c] -= f * a[col][c];
    }
  }
  const h = a.map((row, i) => row[8] / a[i][i]);
  h.push(1);
  return h.every(Number.isFinite) ? h : null;
}

/** Точка и знак w (для отсечения точек «за горизонтом»). */
export function hmap(m: Homography, p: Pt): { pt: Pt; w: number } {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  return { pt: P((m[0] * p.x + m[1] * p.y + m[2]) / w, (m[3] * p.x + m[4] * p.y + m[5]) / w), w };
}

export function hinverse(m: Homography): Homography | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) <= 1e-12) return null;
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
  if (Math.abs(inv[8]) <= 1e-12) return null;
  return inv.map((v) => v / inv[8]);
}

// ---------------------------------------------------------------- план

/** Привязка камеры к плану: 4 точки на полу в кадре (доли 0…1) и те же точки на плане (метры). */
export interface CameraCalibration {
  imagePts: Pt[];
  planPts: Pt[];
  /** Где висит камера на плане (метры); нет — оценка по привязке. */
  cameraPos?: Pt | null;
  /** Куда повёрнута камера (радианы); нет — по привязке. */
  cameraAngle?: number | null;
  fovDeg?: number | null;
  rangeM?: number | null;
  /** "sector" — привязка по сектору (пола в кадре нет). */
  mode?: string | null;
}

export interface TwinZone {
  id: string;
  name: string;
  points: Pt[];
  color: number;
}

/** Отрезок стены магазина: сторона edge (от угла edge к следующему), доли t0 < t1 вдоль неё. */
export interface WallSpan {
  edge: number;
  t0: number;
  t1: number;
}

/** Выносной штендер: центр (метры) и поворот (радианы). */
export interface TwinStand {
  id: string;
  pos: Pt;
  angle: number;
}

/** Стеллаж или витрина (прилавок) — в магазине или просто на плане: прямоугольник с местом, поворотом и размером. */
export type FixtureKind = "rack" | "showcase";
export interface TwinFixture {
  id: string;
  kind: FixtureKind;
  pos: Pt;
  angle: number;
  /** Длина (вдоль) и глубина, м. */
  width: number;
  depth: number;
}
export const FIXTURE_KINDS: Record<FixtureKind, { title: string; label: string; width: number; depth: number }> = {
  rack: { title: "Стеллаж", label: "СТЕЛЛАЖ", width: 2.0, depth: 0.5 },
  showcase: { title: "Витрина", label: "ВИТРИНА", width: 1.6, depth: 0.7 },
};

export interface TwinPlan {
  widthM: number;
  depthM: number;
  zones: TwinZone[];
  calibrations: Record<string, CameraCalibration>;
  backgroundOpacity: number;
  shop: Pt[];
  showcases: WallSpan[];
  doors: WallSpan[];
  stands: TwinStand[];
  /** Стеллажи и витрины — в магазине или на плане. */
  fixtures: TwinFixture[];
}

export const newId = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const defaultPlan = (): TwinPlan => ({
  widthM: 12, depthM: 8, zones: [], calibrations: {}, backgroundOpacity: 0.55, shop: [], showcases: [], doors: [], stands: [], fixtures: [],
});

export function normalizePlan(p: Partial<TwinPlan> | null | undefined): TwinPlan {
  const d = defaultPlan();
  const v = { ...d, ...(p ?? {}) } as TwinPlan;
  for (const k of ["zones", "shop", "showcases", "doors", "stands", "fixtures"] as const) if (!Array.isArray(v[k])) (v as unknown as Record<string, unknown[]>)[k] = [];
  if (!v.calibrations || typeof v.calibrations !== "object") v.calibrations = {};
  if (!(v.widthM > 0)) v.widthM = 12;
  if (!(v.depthM > 0)) v.depthM = 8;
  return v;
}

export const STAND_W = 0.7;
export const STAND_D = 0.45;
export const DEFAULT_FOV = 70;
export const PERSON_H = 1.7;
export const PERSON_W = 0.55;

export const standFacing = (s: TwinStand): Pt => P(-Math.sin(s.angle), Math.cos(s.angle));

export function standCorners(s: TwinStand, inflate = 0): Pt[] {
  const hw = STAND_W / 2 + inflate, hd = STAND_D / 2 + inflate;
  const c = Math.cos(s.angle), sn = Math.sin(s.angle);
  return [P(-hw, -hd), P(hw, -hd), P(hw, hd), P(-hw, hd)].map((q) => P(s.pos.x + q.x * c - q.y * sn, s.pos.y + q.x * sn + q.y * c));
}

/** Лицевая сторона (у витрины — откуда смотрят; стеллаж — с обеих сторон) и направление вдоль. */
export const fixtureFacing = (f: TwinFixture): Pt => P(-Math.sin(f.angle), Math.cos(f.angle));
export const fixtureAlong = (f: TwinFixture): Pt => P(Math.cos(f.angle), Math.sin(f.angle));

/** Углы (с запасом inflate); лицевая сторона — между углами 2 и 3. */
export function fixtureCorners(f: TwinFixture, inflate = 0): Pt[] {
  const hw = f.width / 2 + inflate, hd = f.depth / 2 + inflate;
  const c = Math.cos(f.angle), sn = Math.sin(f.angle);
  return [P(-hw, -hd), P(hw, -hd), P(hw, hd), P(-hw, hd)].map((q) => P(f.pos.x + q.x * c - q.y * sn, f.pos.y + q.x * sn + q.y * c));
}

export function newFixture(kind: FixtureKind, pos: Pt, angle = 0): TwinFixture {
  return { id: newId(), kind, pos, angle, width: FIXTURE_KINDS[kind].width, depth: FIXTURE_KINDS[kind].depth };
}

/** Размер клетки тепловой карты: 25 см, на больших планах крупнее (не больше ~160 клеток по стороне). */
export const planCell = (p: TwinPlan) => Math.max(0.25, Math.max(p.widthM, p.depthM) / 160);
export const planCols = (p: TwinPlan) => Math.max(1, Math.ceil(p.widthM / planCell(p)));
export const planRows = (p: TwinPlan) => Math.max(1, Math.ceil(p.depthM / planCell(p)));

export const planContains = (p: TwinPlan, q: Pt, margin = 0) =>
  q.x >= -margin && q.y >= -margin && q.x <= p.widthM + margin && q.y <= p.depthM + margin;

export const hasShop = (p: TwinPlan) => p.shop.length >= 3;

export function defaultShop(W: number, D: number): Pt[] {
  const x0 = Math.min(1, W * 0.1), x1 = W - x0;
  const y0 = Math.min(0.5, D * 0.05), y1 = Math.max(y0 + 1, D * 0.55);
  return [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
}

export function edge(p: TwinPlan, i: number): [Pt, Pt] | null {
  if (!hasShop(p) || i < 0 || i >= p.shop.length) return null;
  return [p.shop[i], p.shop[(i + 1) % p.shop.length]];
}

export function pointOn(p: TwinPlan, e: number, t: number): Pt | null {
  const ab = edge(p, e);
  if (!ab) return null;
  const [a, b] = ab;
  return P(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
}

export function spanPoints(p: TwinPlan, s: WallSpan): Pt[] {
  const a = pointOn(p, s.edge, s.t0), b = pointOn(p, s.edge, s.t1);
  return a && b ? [a, b] : [];
}

export const showcaseLines = (p: TwinPlan) => p.showcases.map((s) => spanPoints(p, s)).filter((l) => l.length === 2);
export const doorLines = (p: TwinPlan) => p.doors.map((s) => spanPoints(p, s)).filter((l) => l.length === 2);

export const insideShop = (p: TwinPlan, q: Pt) => hasShop(p) && pointInPolygon(q, p.shop);

/** Наружная нормаль стороны магазина (единичная). */
export function outwardNormal(p: TwinPlan, e: number): Pt | null {
  const ab = edge(p, e);
  if (!ab) return null;
  const [a, b] = ab;
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = Math.max(1e-9, hypot(dx, dy));
  let n = P(dy / l, -dx / l);
  const mid = P((a.x + b.x) / 2 + n.x * 0.05, (a.y + b.y) / 2 + n.y * 0.05);
  if (insideShop(p, mid)) n = P(-n.x, -n.y);
  return n;
}

/** Ближайшая точка на стенах магазина: сторона и доля вдоль неё. */
export function nearestWall(p: TwinPlan, q: Pt): { edge: number; t: number; dist: number } | null {
  if (!hasShop(p)) return null;
  let best: { edge: number; t: number; dist: number } | null = null;
  for (let i = 0; i < p.shop.length; i++) {
    const [a, b] = edge(p, i)!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = Math.max(1e-12, dx * dx + dy * dy);
    const t = Math.min(1, Math.max(0, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2));
    const d = hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy));
    if (!best || d < best.dist) best = { edge: i, t, dist: d };
  }
  return best;
}

export function edgeLength(p: TwinPlan, e: number): number {
  const ab = edge(p, e);
  return ab ? hypot(ab[1].x - ab[0].x, ab[1].y - ab[0].y) : 0;
}

/** Свободное место на стороне e под участок длиной lenM: середина, четверти, края. */
export function freeSpan(p: TwinPlan, e: number, lengthM: number): WallSpan | null {
  const L = edgeLength(p, e);
  if (L <= 0.3) return null;
  const half = Math.min(0.5, lengthM / L / 2);
  const taken = [...p.showcases, ...p.doors].filter((s) => s.edge === e);
  for (const c of [0.3, 0.7, 0.5, 0.15, 0.85]) {
    const s = { edge: e, t0: Math.max(0, c - half), t1: Math.min(1, c + half) };
    if (!taken.some((x) => x.t0 < s.t1 && s.t0 < x.t1)) return s;
  }
  return null;
}

/** Стены, через которые не пройти: все стороны магазина, кроме проёмов дверей (витрины — тоже стена). */
export function walls(p: TwinPlan): [Pt, Pt][] {
  if (!hasShop(p)) return [];
  const out: [Pt, Pt][] = [];
  for (let i = 0; i < p.shop.length; i++) {
    const gaps = p.doors.filter((d) => d.edge === i).map((d) => [d.t0, d.t1]).sort((a, b) => a[0] - b[0]);
    let t = 0;
    for (const g of gaps) {
      if (g[1] <= t) continue;
      if (g[0] > t) {
        const a = pointOn(p, i, t), b = pointOn(p, i, g[0]);
        if (a && b) out.push([a, b]);
      }
      t = Math.max(t, g[1]);
    }
    if (t < 1) {
      const a = pointOn(p, i, t), b = pointOn(p, i, 1);
      if (a && b) out.push([a, b]);
    }
  }
  return out;
}

export function obstacles(p: TwinPlan): [Pt, Pt][] {
  const out = walls(p);
  for (const c of [...p.stands.map((s) => standCorners(s, 0.15)), ...(p.fixtures ?? []).map((f) => fixtureCorners(f, 0.15))]) {
    for (let i = 0; i < 4; i++) out.push([c[i], c[(i + 1) % 4]]);
  }
  return out;
}

export const clearPath = (p: TwinPlan, a: Pt, b: Pt, obs = obstacles(p)) => !obs.some(([c, d]) => segmentsIntersect(a, b, c, d));
export const insideStand = (p: TwinPlan, q: Pt, inflate = 0.15) => p.stands.some((s) => pointInPolygon(q, standCorners(s, inflate)));
/** Внутри штендера, стеллажа или витрины (с запасом). */
export const insideObstacle = (p: TwinPlan, q: Pt, inflate = 0.15) =>
  insideStand(p, q, inflate) || (p.fixtures ?? []).some((f) => pointInPolygon(q, fixtureCorners(f, inflate)));

/** Новый угол на стороне e в доле s: витрины и двери остаются на своих местах. */
export function insertShopCorner(p: TwinPlan, e: number, s: number): void {
  const q = pointOn(p, e, s);
  if (!q) return;
  p.shop.splice(e + 1, 0, q);
  const fix = (sp: WallSpan): WallSpan => {
    if (sp.edge > e) return { ...sp, edge: sp.edge + 1 };
    if (sp.edge !== e) return sp;
    if (sp.t1 <= s) return { edge: e, t0: sp.t0 / s, t1: sp.t1 / s };
    if (sp.t0 >= s) return { edge: e + 1, t0: (sp.t0 - s) / (1 - s), t1: (sp.t1 - s) / (1 - s) };
    if (s - sp.t0 >= sp.t1 - s) return { edge: e, t0: sp.t0 / s, t1: 1 };
    return { edge: e + 1, t0: 0, t1: (sp.t1 - s) / (1 - s) };
  };
  p.showcases = p.showcases.map(fix);
  p.doors = p.doors.map(fix);
}

export function removeLastShopCorner(p: TwinPlan): void {
  if (p.shop.length <= 3) return;
  const n = p.shop.length;
  p.shop.pop();
  const fix = (sp: WallSpan) => (sp.edge >= n - 2 ? { ...sp, edge: n - 2 } : sp);
  p.showcases = p.showcases.map(fix);
  p.doors = p.doors.map(fix);
}

/** Сторона магазина, обращённая к улице (самая нижняя на плане). */
export function streetEdge(p: TwinPlan): number | null {
  if (!hasShop(p)) return null;
  let best = 0;
  for (let i = 1; i < p.shop.length; i++) if (pointOn(p, i, 0.5)!.y > pointOn(p, best, 0.5)!.y) best = i;
  return best;
}

export const ZONE_COLORS = ["#5c9eff", "#54d99e", "#ffb84d", "#db78ff", "#ff7380", "#66e0f2"];
export const zoneColor = (i: number) => ZONE_COLORS[((i % ZONE_COLORS.length) + ZONE_COLORS.length) % ZONE_COLORS.length];
export const CAMERA_COLORS = ["#47d7f0", "#ff6fae", "#7cf2c8", "#ff9f40", "#b18cff", "#ffd23f", "#3fc9b4", "#7a86ff"];
export const cameraColor = (i: number) => CAMERA_COLORS[((i % CAMERA_COLORS.length) + CAMERA_COLORS.length) % CAMERA_COLORS.length];

export const zoneCentroid = (z: TwinZone) => {
  const n = Math.max(1, z.points.length);
  return P(z.points.reduce((a, q) => a + q.x, 0) / n, z.points.reduce((a, q) => a + q.y, 0) / n);
};

// ---------------------------------------------------------------- привязка камеры

export const isSector = (c: CameraCalibration) => c.mode === "sector";

export function initialCalibration(plan: TwinPlan): CameraCalibration {
  const cx = plan.widthM / 2, cy = plan.depthM / 2;
  const hw = Math.min(2, plan.widthM / 4), hd = Math.min(1.5, plan.depthM / 4);
  return {
    imagePts: [P(0.3, 0.6), P(0.7, 0.6), P(0.85, 0.9), P(0.15, 0.9)],
    planPts: [P(cx - hw, cy - hd), P(cx + hw, cy - hd), P(cx + hw, cy + hd), P(cx - hw, cy + hd)],
  };
}

export const calHomography = (c: CameraCalibration) => homographyFrom(c.imagePts, c.planPts);

export function isSimpleQuad(q: Pt[]): boolean {
  if (q.length !== 4) return false;
  return !segmentsIntersect(q[0], q[1], q[2], q[3]) && !segmentsIntersect(q[1], q[2], q[3], q[0]) && polygonArea(q) > 1e-6;
}

/**
 * Привязка по полу, где 4 точки на кадре так и стоят по умолчанию (их не двигали): по ней люди легли бы
 * на план в случайное место — такую камеру на план не выводим, пока точки не расставят или не выберут «по сектору».
 */
export function floorPointsUntouched(c: CameraCalibration): boolean {
  if (isSector(c)) return false;
  const d = [P(0.3, 0.6), P(0.7, 0.6), P(0.85, 0.9), P(0.15, 0.9)];
  return c.imagePts.length === 4 && c.imagePts.every((q, i) => Math.abs(q.x - d[i].x) < 1e-6 && Math.abs(q.y - d[i].y) < 1e-6);
}

/** Камера передаёт людей на план: привязка верна и (по полу) точки расставлены. */
export const calibrationUsable = (c: CameraCalibration) => calibrationValid(c) && !floorPointsUntouched(c);

/** По полу — четырёхугольник без самопересечений с обеих сторон; по сектору — всегда. */
export const calibrationValid = (c: CameraCalibration) =>
  isSector(c) || (calHomography(c) !== null && isSimpleQuad(c.imagePts) && isSimpleQuad(c.planPts));

/** Готовая к работе привязка: кадр → план. */
export class CameraProjector {
  readonly h: Homography | null;
  readonly sign: number;
  readonly sector: { pos: Pt; angle: number; fov: number; range: number } | null;

  private constructor(h: Homography | null, sign: number, sector: CameraProjector["sector"]) {
    this.h = h;
    this.sign = sign;
    this.sector = sector;
  }

  static create(c: CameraCalibration, plan?: TwinPlan): CameraProjector | null {
    if (isSector(c)) {
      const pos = c.cameraPos ?? P((plan?.widthM ?? 12) / 2, (plan?.depthM ?? 8) - 0.5);
      return new CameraProjector(null, 1, {
        pos, angle: c.cameraAngle ?? -Math.PI / 2, fov: ((c.fovDeg ?? DEFAULT_FOV) * Math.PI) / 180, range: c.rangeM ?? 6,
      });
    }
    const h = calHomography(c);
    if (!h || !calibrationValid(c)) return null;
    const cx = c.imagePts.reduce((a, q) => a + q.x, 0) / 4, cy = c.imagePts.reduce((a, q) => a + q.y, 0) / 4;
    return new CameraProjector(h, hmap(h, P(cx, cy)).w >= 0 ? 1 : -1, null);
  }

  /** Человек в кадре (рамка в пикселях) → место на плане. */
  projectBox(b: Box, W: number, H: number): Pt | null {
    if (!(W > 0 && H > 0)) return null;
    const s = this.sector;
    if (!s) return this.project(P((b.x1 + b.x2) / 2 / W, b.y2 / H));
    const cx = (b.x1 + b.x2) / 2 / W;
    const a = s.angle + (cx - 0.5) * s.fov;
    const f = W / 2 / Math.tan(s.fov / 2);
    const cut = b.y2 > H * 0.97 || b.y1 < H * 0.02;
    const d = cut ? (f * PERSON_W) / Math.max(1, b.x2 - b.x1) : (f * PERSON_H) / Math.max(1, b.y2 - b.y1);
    const dist = Math.min(s.range, Math.max(0.3, d));
    return P(s.pos.x + Math.cos(a) * dist, s.pos.y + Math.sin(a) * dist);
  }

  /** Точка кадра (доли) → план (метры); null — выше горизонта (или привязка по сектору). */
  project(p: Pt): Pt | null {
    if (!this.h) return null;
    const r = hmap(this.h, p);
    if (!(r.w * this.sign > 1e-9) || !Number.isFinite(r.pt.x) || !Number.isFinite(r.pt.y)) return null;
    return r.pt;
  }

  /** Пол, который видит камера: проекция кадра от нижнего края вверх до горизонта (или края плана + запас). */
  coverage(plan: TwinPlan): Pt[] {
    const m = 3;
    const ok = (q: Pt | null) => (q && q.x >= -m && q.y >= -m && q.x <= plan.widthM + m && q.y <= plan.depthM + m ? q : null);
    const ys: number[] = [];
    for (let y = 1; y >= 0; y -= 0.02) {
      if (!ok(this.project(P(0, y))) || !ok(this.project(P(1, y))) || !ok(this.project(P(0.5, y)))) break;
      ys.push(y);
    }
    if (ys.length < 2) return [];
    const top = ys[ys.length - 1];
    const out: Pt[] = [];
    for (const y of ys) { const q = this.project(P(0, y)); if (q) out.push(q); }
    for (let i = 1; i <= 9; i++) { const q = ok(this.project(P(i / 10, top))); if (q) out.push(q); }
    for (const y of [...ys].reverse()) { const q = this.project(P(1, y)); if (q) out.push(q); }
    for (let i = 9; i >= 1; i--) { const q = this.project(P(i / 10, 1)); if (q) out.push(q); }
    return out;
  }

  /** Оценка места камеры: чуть позади ближнего к камере края видимого пола. */
  estimatedPosition(plan: TwinPlan): Pt | null {
    const near = this.project(P(0.5, 1));
    if (!near) return null;
    let far: Pt | null = null;
    for (let y = 0.98; y >= 0.02; y -= 0.02) {
      const q = this.project(P(0.5, y));
      if (!q || !planContains(plan, q, 3)) break;
      far = q;
    }
    if (!far) return near;
    const dx = far.x - near.x, dy = far.y - near.y;
    const d = Math.max(0.01, hypot(dx, dy));
    const back = Math.min(2, d * 0.25);
    const q = P(near.x - (dx / d) * back, near.y - (dy / d) * back);
    return P(Math.min(Math.max(q.x, -0.5), plan.widthM + 0.5), Math.min(Math.max(q.y, -0.5), plan.depthM + 0.5));
  }
}

/** Камера на плане: где стоит, куда смотрит и какой пол видит. */
export interface CameraMark {
  name: string;
  colorIndex: number;
  position: Pt;
  coverage: Pt[];
  angle: number;
  fov: number;
  range: number;
  /** Размер плана (м): лучи камеры обрезаются по его краю. */
  planW: number;
  planD: number;
}

export function cameraMark(name: string, colorIndex: number, c: CameraCalibration, plan: TwinPlan): CameraMark | null {
  if (isSector(c)) {
    const s = CameraProjector.create(c, plan)?.sector;
    if (!s) return null;
    return { name, colorIndex, position: s.pos, coverage: [], angle: s.angle, fov: s.fov, range: s.range, planW: plan.widthM, planD: plan.depthM };
  }
  const proj = CameraProjector.create(c);
  if (!proj) return null;
  const cov = proj.coverage(plan);
  const pos = c.cameraPos ?? proj.estimatedPosition(plan);
  if (!pos) return null;
  const pts = cov.length ? cov : c.planPts;
  const target = P(pts.reduce((a, q) => a + q.x, 0) / pts.length, pts.reduce((a, q) => a + q.y, 0) / pts.length);
  const far = cov.length ? Math.max(...cov.map((q) => hypot(q.x - pos.x, q.y - pos.y))) : 8;
  return {
    name, colorIndex, position: pos, coverage: cov, planW: plan.widthM, planD: plan.depthM,
    angle: c.cameraAngle ?? Math.atan2(target.y - pos.y, target.x - pos.x),
    fov: ((c.fovDeg ?? DEFAULT_FOV) * Math.PI) / 180,
    range: c.rangeM ?? Math.min(15, Math.max(3, far)),
  };
}

/** Сколько метров луч из камеры под углом a идёт внутри плана (до края). Камера вне плана — до выхода из него. */
export function rayInside(m: CameraMark, a: number): number {
  const dx = Math.cos(a), dy = Math.sin(a), { x, y } = m.position;
  let t0 = -Infinity, t1 = Infinity;
  for (const [p, d, hi] of [[x, dx, m.planW], [y, dy, m.planD]] as const) {
    if (Math.abs(d) < 1e-12) {
      if (p < 0 || p > hi) return 0;
      continue;
    }
    const a1 = (0 - p) / d, a2 = (hi - p) / d;
    t0 = Math.max(t0, Math.min(a1, a2));
    t1 = Math.min(t1, Math.max(a1, a2));
  }
  return t1 >= Math.max(0, t0) ? Math.max(0, t1) : 0;
}

/** Длина луча с учётом края плана. */
export const rayLength = (m: CameraMark, a: number, d = m.range) => Math.min(d, rayInside(m, a));

/** Точка на луче из камеры: не дальше d и не за краем плана. */
export const ray = (m: CameraMark, a: number, d: number) => {
  const l = rayLength(m, a, d);
  return P(m.position.x + Math.cos(a) * l, m.position.y + Math.sin(a) * l);
};

/** Ближайшая точка витрины (если нет — стены магазина) и расстояние до неё. */
export function nearestFixture(m: CameraMark, plan: TwinPlan): [Pt, number] | null {
  let segs: [Pt, Pt][] = showcaseLines(plan).map((l) => [l[0], l[1]]);
  for (const f of plan.fixtures ?? []) {
    if (f.kind !== "showcase") continue;
    const c = fixtureCorners(f);
    for (let i = 0; i < 4; i++) segs.push([c[i], c[(i + 1) % 4]]);
  }
  if (!segs.length) segs = walls(plan);
  let best: [Pt, number] | null = null;
  for (const [a, b] of segs) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = Math.max(1e-12, dx * dx + dy * dy);
    const t = Math.min(1, Math.max(0, ((m.position.x - a.x) * dx + (m.position.y - a.y) * dy) / l2));
    const q = P(a.x + t * dx, a.y + t * dy);
    const d = hypot(q.x - m.position.x, q.y - m.position.y);
    if (!best || d < best[1]) best = [q, d];
  }
  return best;
}

// ---------------------------------------------------------------- статистика и люди

export interface TwinDayStats {
  day: string;
  cols: number;
  rows: number;
  cell: number;
  /** Секунды присутствия людей в клетке. */
  heat: number[];
  /** Заходы в зону (id → число) и суммарное время в зоне, с. */
  visits: Record<string, number>;
  dwell: Record<string, number>;
  peak: number;
  people: number;
}

export const newDayStats = (day: string, plan: TwinPlan): TwinDayStats => ({
  day, cols: planCols(plan), rows: planRows(plan), cell: planCell(plan), heat: new Array(planCols(plan) * planRows(plan)).fill(0),
  visits: {}, dwell: {}, peak: 0, people: 0,
});

export const statsFit = (s: TwinDayStats, plan: TwinPlan) =>
  s.cols === planCols(plan) && s.rows === planRows(plan) && Math.abs(s.cell - planCell(plan)) < 1e-9 && s.heat.length === s.cols * s.rows;

export function averageDwell(s: TwinDayStats, zoneId: string): number | null {
  const v = s.visits[zoneId];
  return v > 0 ? (s.dwell[zoneId] ?? 0) / v : null;
}

export function heatIndex(s: TwinDayStats, q: Pt): number {
  const cx = Math.min(s.cols - 1, Math.max(0, Math.floor(q.x / s.cell)));
  const cy = Math.min(s.rows - 1, Math.max(0, Math.floor(q.y / s.cell)));
  return cy * s.cols + cx;
}

export interface TwinPerson {
  id: string;
  pos: Pt;
  trail: Pt[];
  state: PersonState;
  /** Сколько камер видят этого человека. */
  cameras: number;
  /** Скорость по плану, м/с. */
  speed: number | null;
}

/** Скорость по точкам (время, место) за последнюю ~секунду. */
export function speedOf(samples: { t: number; p: Pt }[]): number | null {
  const last = samples[samples.length - 1];
  if (!last) return null;
  const first = samples.find((s) => last.t - s.t <= 1.2);
  if (!first || last.t - first.t < 0.3) return null;
  return hypot(last.p.x - first.p.x, last.p.y - first.p.y) / (last.t - first.t);
}

export const STATE_RANK: Record<PersonState, number> = { tracked: 0, passed: 1, slowed: 2, looked: 3 };
export const STATE_CODE: Record<PersonState, number> = STATE_RANK;
export const CODE_STATE: PersonState[] = ["tracked", "passed", "slowed", "looked"];

export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ---------------------------------------------------------------- записи и время

export interface RecPerson {
  i: string;
  x: number;
  y: number;
  /** 0 — идёт, 1 — прошёл, 2 — притормозил, 3 — смотрит. */
  s: number;
}
export interface RecFrame {
  t: number;
  p: RecPerson[];
}
export interface RecCameraRef {
  id: string;
  name: string;
  colorIndex: number;
}
export interface RecordingData {
  plan: TwinPlan;
  cameras: RecCameraRef[];
  frames: RecFrame[];
}

export const recPerson = (p: TwinPerson): RecPerson => ({
  i: p.id, x: Math.round(p.pos.x * 100) / 100, y: Math.round(p.pos.y * 100) / 100, s: STATE_CODE[p.state],
});

/** Люди на плане по времени: тепло, заходы в зоны, пики (для записи и для видео). */
export class Timeline {
  times: number[] = [];
  points: RecPerson[][] = [];
  heatCells: number[][] = [];
  heatDt: number[] = [];
  stats: TwinDayStats;
  heatMax = 0;
  zonePeak: Record<string, number> = {};
  private inZone = new Map<string, Set<string>>();
  private seen = new Set<string>();

  constructor(readonly plan: TwinPlan, frames: RecFrame[] = []) {
    this.stats = newDayStats("record", plan);
    for (const f of frames) this.add(f);
  }

  get duration(): number {
    return this.times[this.times.length - 1] ?? 0;
  }

  add(f: RecFrame, firstDt = 0.2): void {
    const last = this.times[this.times.length - 1];
    const dt = last === undefined ? firstDt : Math.min(0.5, Math.max(0, f.t - last));
    const cells: number[] = [];
    const st = this.stats;
    for (const p of f.p) {
      const pos = P(p.x, p.y);
      if (!this.seen.has(p.i)) {
        this.seen.add(p.i);
        st.people += 1;
      }
      const idx = heatIndex(st, pos);
      if (idx < st.heat.length) {
        st.heat[idx] += dt;
        this.heatMax = Math.max(this.heatMax, st.heat[idx]);
        cells.push(idx);
      }
      const zs = this.inZone.get(p.i) ?? new Set<string>();
      for (const z of this.plan.zones) {
        if (z.points.length < 3) continue;
        if (pointInPolygon(pos, z.points)) {
          if (!zs.has(z.id)) st.visits[z.id] = (st.visits[z.id] ?? 0) + 1;
          zs.add(z.id);
          st.dwell[z.id] = (st.dwell[z.id] ?? 0) + dt;
        } else zs.delete(z.id);
      }
      this.inZone.set(p.i, zs);
    }
    st.peak = Math.max(st.peak, f.p.length);
    for (const z of this.plan.zones) {
      if (z.points.length < 3) continue;
      const n = f.p.filter((q) => pointInPolygon(P(q.x, q.y), z.points)).length;
      this.zonePeak[z.id] = Math.max(this.zonePeak[z.id] ?? 0, n);
    }
    this.times.push(f.t);
    this.points.push(f.p);
    this.heatCells.push(cells);
    this.heatDt.push(dt);
  }

  index(t: number): number | null {
    if (!this.times.length || t < this.times[0] - 1e-3) return null;
    let lo = 0, hi = this.times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.times[mid] <= t + 1e-3) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  people(t: number, trail = 4): TwinPerson[] {
    const i = this.index(t);
    if (i === null) return [];
    const trails = new Map<string, { t: number; p: Pt }[]>();
    for (let j = i; j >= 0 && this.times[i] - this.times[j] <= trail; j--) {
      for (const p of this.points[j]) {
        const a = trails.get(p.i) ?? [];
        a.push({ t: this.times[j], p: P(p.x, p.y) });
        trails.set(p.i, a);
      }
    }
    return this.points[i].map((p) => {
      const tr = (trails.get(p.i) ?? []).reverse();
      return { id: p.i, pos: P(p.x, p.y), trail: tr.map((x) => x.p), state: CODE_STATE[p.s] ?? "tracked", cameras: 1, speed: speedOf(tr) };
    });
  }

  occupancy(t: number): Record<string, number> {
    const i = this.index(t);
    const out: Record<string, number> = {};
    if (i === null) return out;
    for (const z of this.plan.zones) {
      if (z.points.length < 3) continue;
      out[z.id] = this.points[i].filter((q) => pointInPolygon(P(q.x, q.y), z.points)).length;
    }
    return out;
  }
}

/** Тепло «до текущего момента» с кэшем: вперёд — досчитывает, назад — пересчитывает. */
export class HeatCursor {
  grid: number[] = [];
  maxValue = 0;
  private idx = -1;

  advance(tl: Timeline, t: number): void {
    const target = tl.index(t) ?? -1;
    if (this.grid.length !== tl.stats.heat.length || target < this.idx) {
      this.grid = new Array(tl.stats.heat.length).fill(0);
      this.maxValue = 0;
      this.idx = -1;
    }
    for (let i = this.idx + 1; i <= target && i < tl.heatCells.length; i++) {
      for (const c of tl.heatCells[i]) {
        if (c >= this.grid.length) continue;
        this.grid[c] += tl.heatDt[i];
        if (this.grid[c] > this.maxValue) this.maxValue = this.grid[c];
      }
    }
    this.idx = Math.max(this.idx, target);
  }

  stats(tl: Timeline): TwinDayStats {
    return { ...tl.stats, heat: this.grid.length === tl.stats.heat.length ? this.grid : tl.stats.heat };
  }
}

// ---------------------------------------------------------------- подписи

export const fmt1 = (v: number) => v.toFixed(1).replace(".", ",");
export const fmtM = (v: number) => (v === Math.round(v) ? String(Math.round(v)) : v.toFixed(1).replace(".", ","));
export function fmtDuration(s: number): string {
  if (s < 60) return `${Math.round(s)} с`;
  return `${Math.floor(s / 60)} мин ${Math.floor(s % 60)} с`;
}
export function fmtClock(s: number): string {
  const v = Math.max(0, Math.floor(s));
  const mm = String(Math.floor(v / 60) % 60).padStart(2, "0"), ss = String(v % 60).padStart(2, "0");
  return v >= 3600 ? `${Math.floor(v / 3600)}:${mm}:${ss}` : `${Math.floor(v / 60)}:${ss}`;
}
export function peopleWord(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return "человека";
  return "человек";
}
