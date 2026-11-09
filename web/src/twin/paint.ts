// Рисование плана двойника на холсте: подложка, сетка в метрах, тепловая карта, зоны, магазин с витринами
// и входами, штендеры, камеры с сектором обзора, люди со следами. Порт PlanPainter (TwinView.swift, macOS).

import type { Pt } from "../engine/geometry";
import type { PersonState } from "../engine/session";
import {
  type CameraMark, FIXTURE_KINDS, STAND_W, type TwinFixture, fixtureCorners, type TwinDayStats, type TwinPerson, type TwinPlan, type TwinZone, cameraColor, doorLines, fmt1,
  hasShop, nearestFixture, ray, rayInside, rayLength, showcaseLines, standCorners, standFacing, walls, zoneCentroid, zoneColor,
} from "./plan";

export const C = {
  bg: "#0a1230",
  panel: "#111d45",
  moon: "#e8eef8",
  dim: "#95a3c7",
  focus: "#8fe36d",
  stand: "#ff9e40",
  rack: "#dbb380",
  showcase: "#73d9ff",
  entrance: "#59e680",
};

/** Цвета людей на плане — как в iOS (PlanPainter.personColor, тёмная тема): идёт — Theme.accent, прошёл — белый,
 *  притормозил — системный зелёный, смотрит — системный жёлтый. Одинаково на телефоне, в вебе и в кабинете. */
export const PERSON_COLORS: Record<PersonState, string> = { tracked: "#8fa6ff", passed: "#ffffff", slowed: "#30d158", looked: "#ffd60a" };
export const personColor = (s: PersonState) => PERSON_COLORS[s] ?? PERSON_COLORS.tracked;

/** Геометрия плана на экране: прямоугольник плана и точек на метр. */
export class PlanFrame {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly k: number;

  constructor(plan: TwinPlan, width: number, height: number, inset = 44) {
    const w = Math.max(1, width - inset * 2), h = Math.max(1, height - inset * 2);
    this.k = Math.min(w / plan.widthM, h / plan.depthM);
    this.w = plan.widthM * this.k;
    this.h = plan.depthM * this.k;
    this.x = (width - this.w) / 2;
    this.y = (height - this.h) / 2;
  }

  pt(p: Pt): [number, number] {
    return [this.x + p.x * this.k, this.y + p.y * this.k];
  }
  meters(cx: number, cy: number): Pt {
    return { x: (cx - this.x) / this.k, y: (cy - this.y) / this.k };
  }
  path(ctx: CanvasRenderingContext2D, pts: Pt[], closed = true): void {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(...this.pt(p)) : ctx.moveTo(...this.pt(p))));
    if (closed) ctx.closePath();
  }
}

/** Холст под размер на экране (с учётом плотности пикселей); рисуем в CSS-пикселях. */
export function fitCanvas(c: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } {
  const r = c.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const font = (px: number, weight = 600, mono = false) =>
  `${weight} ${px}px ${mono ? '"JetBrains Mono", ui-monospace, monospace' : '"Onest Variable", system-ui, sans-serif'}`;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Подпись на плашке. */
export function tag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, bg: string, fg = "#000", px = 10, mono = false): void {
  ctx.font = font(px, 700, mono);
  const tw = ctx.measureText(text).width;
  roundRect(ctx, x - tw / 2 - 5, y - px / 2 - 3, tw + 10, px + 6, 4);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y + 0.5);
}

/** Подпись размера на тёмной плашке. */
export const dimLabel = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) =>
  tag(ctx, text, x, y, "rgba(10, 18, 48, 0.85)", color, 10, true);

export function paintBase(ctx: CanvasRenderingContext2D, plan: TwinPlan, f: PlanFrame, bg: ImageBitmap | null): void {
  roundRect(ctx, f.x, f.y, f.w, f.h, 4);
  ctx.fillStyle = "rgba(10, 18, 48, 0.85)";
  ctx.fill();
  if (bg) {
    ctx.save();
    ctx.globalAlpha = plan.backgroundOpacity;
    ctx.drawImage(bg, f.x, f.y, f.w, f.h);
    ctx.restore();
  }
  if (f.k >= 8) {
    ctx.lineWidth = 1;
    for (const major of [false, true]) {
      ctx.beginPath();
      for (let x = 1; x < plan.widthM; x++) {
        if ((x % 5 === 0) !== major) continue;
        ctx.moveTo(...f.pt({ x, y: 0 }));
        ctx.lineTo(...f.pt({ x, y: plan.depthM }));
      }
      for (let y = 1; y < plan.depthM; y++) {
        if ((y % 5 === 0) !== major) continue;
        ctx.moveTo(...f.pt({ x: 0, y }));
        ctx.lineTo(...f.pt({ x: plan.widthM, y }));
      }
      ctx.strokeStyle = major ? "rgba(232, 238, 248, 0.14)" : "rgba(232, 238, 248, 0.06)";
      ctx.stroke();
    }
  }
  roundRect(ctx, f.x, f.y, f.w, f.h, 4);
  ctx.strokeStyle = "rgba(232, 238, 248, 0.35)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // подписи метров
  const step = [1, 2, 5, 10, 20, 50].find((s) => s * f.k >= 44) ?? 100;
  ctx.font = font(9, 500, true);
  ctx.fillStyle = C.dim;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let m = 0; m <= plan.widthM + 0.001; m += step) ctx.fillText(String(m), f.x + m * f.k, f.y - 9);
  for (let m = step; m <= plan.depthM + 0.001; m += step) ctx.fillText(String(m), f.x - 12, f.y + m * f.k);
  ctx.fillText("м", f.x - 12, f.y - 9);
}

/** Синий → бирюзовый → жёлтый → красный. */
export function heatColor(t: number, alpha: number): string {
  const stops = [[0.25, 0.45, 1], [0.2, 0.85, 0.9], [1, 0.85, 0.25], [1, 0.3, 0.25]];
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x)), u = x - i;
  const c = stops[i].map((a, j) => Math.round((a + (stops[i + 1][j] - a) * u) * 255));
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

export function paintHeat(ctx: CanvasRenderingContext2D, s: TwinDayStats, maxValue: number, f: PlanFrame): void {
  if (!(maxValue > 0)) return;
  const size = s.cell * f.k;
  for (let row = 0; row < s.rows; row++) {
    for (let col = 0; col < s.cols; col++) {
      const v = s.heat[row * s.cols + col];
      if (!(v > 0)) continue;
      const n = Math.sqrt(v / maxValue);
      if (n <= 0.04) continue;
      ctx.fillStyle = heatColor(n, 0.18 + 0.62 * n);
      ctx.fillRect(f.x + col * size, f.y + row * size, size + 0.5, size + 0.5);
    }
  }
}

export function paintZones(ctx: CanvasRenderingContext2D, zones: TwinZone[], f: PlanFrame, occupancy?: Record<string, number> | null, selected?: string | null): void {
  for (const z of zones) {
    if (z.points.length < 3) continue;
    const color = zoneColor(z.color);
    const busy = (occupancy?.[z.id] ?? 0) > 0;
    f.path(ctx, z.points);
    ctx.globalAlpha = selected === z.id ? 0.28 : busy ? 0.24 : 0.12;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = color;
    ctx.lineWidth = selected === z.id ? 2.5 : 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.globalAlpha = 1;
    let label = z.name;
    if (occupancy && occupancy[z.id] !== undefined) label += ` · ${occupancy[z.id]}`;
    const [cx, cy] = f.pt(zoneCentroid(z));
    ctx.font = font(11, 700);
    const tw = ctx.measureText(label).width;
    roundRect(ctx, cx - tw / 2 - 6, cy - 10, tw + 12, 20, 6);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.92;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, cx, cy + 0.5);
  }
}

/** Магазин (стены), витрины, входы и выносные штендеры. */
export function paintFixtures(ctx: CanvasRenderingContext2D, plan: TwinPlan, f: PlanFrame): void {
  if (hasShop(plan)) {
    f.path(ctx, plan.shop);
    ctx.fillStyle = "rgba(46, 63, 122, 0.35)";
    ctx.fill();
    ctx.beginPath();
    for (const [a, b] of walls(plan)) {
      ctx.moveTo(...f.pt(a));
      ctx.lineTo(...f.pt(b));
    }
    ctx.strokeStyle = "rgba(232, 238, 248, 0.75)";
    ctx.lineWidth = 4;
    ctx.lineCap = "square";
    ctx.stroke();
    ctx.lineCap = "butt";
    const xs = plan.shop.map((q) => q.x), ys = plan.shop.map((q) => q.y);
    ctx.font = font(10, 800);
    ctx.fillStyle = "rgba(232, 238, 248, 0.55)";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("МАГАЗИН", ...f.pt({ x: Math.min(...xs) + 0.25, y: Math.min(...ys) + 0.25 }));
    for (const l of showcaseLines(plan)) {
      const a = f.pt(l[0]), b = f.pt(l[1]);
      for (const [w, c] of [[14, "rgba(115, 217, 255, 0.35)"], [6, C.showcase], [1.2, "rgba(255,255,255,0.85)"]] as const) {
        ctx.beginPath();
        ctx.moveTo(...a);
        ctx.lineTo(...b);
        ctx.strokeStyle = c;
        ctx.lineWidth = w;
        ctx.stroke();
      }
      tag(ctx, "ВИТРИНА", (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, C.showcase, "#000", 9.5);
    }
    for (const l of doorLines(plan)) {
      const a = f.pt(l[0]), b = f.pt(l[1]);
      ctx.beginPath();
      ctx.moveTo(...a);
      ctx.lineTo(...b);
      ctx.strokeStyle = C.entrance;
      ctx.lineWidth = 6;
      ctx.stroke();
      tag(ctx, "ВХОД", (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, C.entrance, "#000", 9.5);
    }
  }
  for (const st of plan.stands) {
    const c = standCorners(st);
    f.path(ctx, c);
    ctx.fillStyle = "rgba(255, 158, 64, 0.55)";
    ctx.fill();
    ctx.strokeStyle = C.stand;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // фасад и стрелка «куда смотрит»
    const a = f.pt(c[2]), b = f.pt(c[3]);
    ctx.beginPath();
    ctx.moveTo(...a);
    ctx.lineTo(...b);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.lineCap = "butt";
    const n = standFacing(st);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const L = Math.max(9, 0.35 * f.k);
    ctx.beginPath();
    ctx.moveTo(mid[0] + n.x * L, mid[1] + n.y * L);
    ctx.lineTo(mid[0] - n.y * L * 0.45, mid[1] + n.x * L * 0.45);
    ctx.lineTo(mid[0] + n.y * L * 0.45, mid[1] - n.x * L * 0.45);
    ctx.closePath();
    ctx.fillStyle = "#fff";
    ctx.fill();
    const [px, py] = f.pt(st.pos);
    ctx.font = font(8.5, 800);
    ctx.fillStyle = C.stand;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("ШТЕНДЕР", px, py + Math.max(10, (STAND_W * f.k) / 2 + 4));
  }
  paintStandalone(ctx, plan.fixtures ?? [], f);
}

export const fixtureColor = (fx: TwinFixture) => (fx.kind === "rack" ? C.rack : C.showcase);

/** Стеллажи (с полками вдоль) и витрины-прилавки (белая лицевая сторона) — в магазине или на плане. */
export function paintStandalone(ctx: CanvasRenderingContext2D, list: TwinFixture[], f: PlanFrame, selected: string | null = null): void {
  for (const fx of list) {
    const c = fixtureCorners(fx);
    const color = fixtureColor(fx);
    f.path(ctx, c);
    ctx.globalAlpha = fx.kind === "rack" ? 0.42 : 0.28;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineCap = "round";
    if (fx.kind === "rack") {
      ctx.beginPath();
      for (const t of [1 / 3, 2 / 3]) {
        ctx.moveTo(...f.pt({ x: c[0].x + (c[3].x - c[0].x) * t, y: c[0].y + (c[3].y - c[0].y) * t }));
        ctx.lineTo(...f.pt({ x: c[1].x + (c[2].x - c[1].x) * t, y: c[1].y + (c[2].y - c[1].y) * t }));
      }
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else {
      ctx.beginPath();
      ctx.moveTo(...f.pt(c[2]));
      ctx.lineTo(...f.pt(c[3]));
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.lineCap = "butt";
    f.path(ctx, c);
    ctx.strokeStyle = selected === fx.id ? C.focus : color;
    ctx.lineWidth = selected === fx.id ? 2.2 : 1.4;
    ctx.lineJoin = "round";
    ctx.stroke();
    if (fx.width * f.k >= 46) {
      const [px, py] = f.pt(fx.pos);
      ctx.font = font(8.5, 800);
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(FIXTURE_KINDS[fx.kind].label, px, py);
    }
  }
}

/** Камера: сектор обзора (угол и дальность), расстояние до витрины и значок, повёрнутый туда, куда смотрит. */
export function paintCamera(ctx: CanvasRenderingContext2D, cam: CameraMark, f: PlanFrame, plan?: TwinPlan | null, showCoverage = true): void {
  const color = cameraColor(cam.colorIndex);
  const [px, py] = f.pt(cam.position);
  if (showCoverage) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(f.x - 2, f.y - 2, f.w + 4, f.h + 4);
    ctx.clip();
    const n = 32;
    ctx.beginPath();
    ctx.moveTo(px, py);
    for (let i = 0; i <= n; i++) ctx.lineTo(...f.pt(ray(cam, cam.angle - cam.fov / 2 + (cam.fov * i) / n, cam.range)));
    ctx.closePath();
    ctx.globalAlpha = 0.13;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(...f.pt(ray(cam, cam.angle - cam.fov / 2, cam.range)));
    ctx.lineTo(px, py);
    ctx.lineTo(...f.pt(ray(cam, cam.angle + cam.fov / 2, cam.range)));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // дуга дальности — только там, где она внутри плана
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    let open = false;
    for (let i = 0; i <= n; i++) {
      const a = cam.angle - cam.fov / 2 + (cam.fov * i) / n;
      if (rayInside(cam, a) < cam.range - 1e-6) {
        open = false;
        continue;
      }
      const q = f.pt(ray(cam, a, cam.range));
      if (open) ctx.lineTo(...q);
      else ctx.moveTo(...q);
      open = true;
    }
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
    const axis = rayLength(cam, cam.angle);
    dimLabel(ctx, `${fmt1(axis)} м`, ...f.pt(ray(cam, cam.angle, axis * 0.62)), color);
    dimLabel(ctx, `${Math.round((cam.fov * 180) / Math.PI)}°`, ...f.pt(ray(cam, cam.angle, Math.min(axis * 0.4, 3))), color);
  }
  if (plan) {
    const nf = nearestFixture(cam, plan);
    if (nf && nf[1] > 0.05) {
      const [bx, by] = f.pt(nf[0]);
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(bx, by);
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      for (const [ex, ey] of [[px, py], [bx, by]]) {
        ctx.beginPath();
        ctx.arc(ex, ey, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
      }
      dimLabel(ctx, `${fmt1(nf[1])} м`, (px + bx) / 2, (py + by) / 2, "#fff");
    }
  }
  // значок
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(cam.angle);
  roundRect(ctx, -13, -8, 18, 16, 4);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(5, -4);
  ctx.lineTo(14, -9);
  ctx.lineTo(14, 9);
  ctx.lineTo(5, 4);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(-5, 0, 3, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fill();
  ctx.restore();
  ctx.font = font(13, 700);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(8,14,40,0.85)";
  ctx.lineJoin = "round";
  ctx.strokeText(cam.name, px, py + 22);
  ctx.fillText(cam.name, px, py + 22);
}

export interface PlanLayers {
  heat: boolean;
  trails: boolean;
  zones: boolean;
  cameras: boolean;
  speed: boolean;
}

/** План с людьми (живой двойник, видео, запись). */
export function paintPlan(
  canvas: HTMLCanvasElement,
  o: {
    plan: TwinPlan;
    background: ImageBitmap | null;
    stats?: TwinDayStats | null;
    heatMax?: number;
    people?: TwinPerson[];
    occupancy?: Record<string, number> | null;
    cameras?: CameraMark[];
    layers: PlanLayers;
  },
): PlanFrame {
  const { ctx, w, h } = fitCanvas(canvas);
  const f = new PlanFrame(o.plan, w, h);
  paintBase(ctx, o.plan, f, o.background);
  if (o.layers.heat && o.stats) paintHeat(ctx, o.stats, o.heatMax ?? 0, f);
  if (o.layers.cameras) for (const c of o.cameras ?? []) paintCamera(ctx, c, f, o.plan);
  if (o.layers.zones) paintZones(ctx, o.plan.zones, f, o.occupancy);
  paintFixtures(ctx, o.plan, f);
  const people = o.people ?? [];
  if (o.layers.trails) {
    ctx.lineCap = "round";
    ctx.lineWidth = 2.5;
    for (const p of people) {
      const n = p.trail.length;
      if (n < 2) continue;
      ctx.strokeStyle = personColor(p.state);
      for (let i = 1; i < n; i++) {
        ctx.globalAlpha = 0.08 + (0.55 * i) / n;
        ctx.beginPath();
        ctx.moveTo(...f.pt(p.trail[i - 1]));
        ctx.lineTo(...f.pt(p.trail[i]));
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = "butt";
  }
  const r = Math.max(5.5, Math.min(10, f.k * 0.22));
  for (const p of people) {
    const [cx, cy] = f.pt(p.pos);
    const color = personColor(p.state);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 2, 0, Math.PI * 2);
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (p.cameras > 1) {
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (o.layers.speed && p.speed !== null) {
      dimLabel(ctx, p.speed < 0.15 ? "стоит" : `${fmt1(p.speed)} м/с`, cx, cy - r - 11, color);
    }
  }
  return f;
}
