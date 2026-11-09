// Тепловая карта разобранного видео «на кадре» — порт HeatmapScreen / HeatmapViews / HeatExport (Mantis для Mac):
// пятна там, где чаще всего стояли ноги людей, поверх кадра, где людей меньше всего. Слои: время, проход,
// притормозили, смотрели. Диапазон времени, «до / после» (сравнение двух половин), экспорт PNG и CSV.

import type { OverlayBox } from "../engine/session";

export interface HeatFrame {
  t: number;
  boxes: OverlayBox[];
}

export type HeatLayer = "time" | "passed" | "slowed" | "looked";
const LAYERS: [HeatLayer, string][] = [["time", "Где были"], ["passed", "Прошли"], ["slowed", "Притормозили"], ["looked", "Смотрели"]];

export interface HeatGrid {
  cols: number;
  rows: number;
  cell: number;
  values: Float32Array;
  max: number;
  people: number;
}

const STOPS: [number, number, number][] = [[0.1, 0.25, 0.65], [0.1, 0.7, 0.85], [0.95, 0.85, 0.2], [0.95, 0.45, 0.15], [0.9, 0.15, 0.2]];

/** Цвет по доле 0…1 (корень — чтобы слабые следы тоже были видны). */
export function heatColor(v: number, alpha = 1): string {
  const x = Math.sqrt(Math.min(1, Math.max(0, v))) * (STOPS.length - 1);
  const i = Math.min(Math.floor(x), STOPS.length - 2);
  const f = x - i;
  const a = STOPS[i], b = STOPS[i + 1];
  const c = (k: number) => Math.round((a[k] + (b[k] - a[k]) * f) * 255);
  return `rgba(${c(0)},${c(1)},${c(2)},${alpha.toFixed(3)})`;
}

const matches = (b: OverlayBox, layer: HeatLayer) =>
  !b.staff && (layer === "time" || (layer === "looked" ? b.lookingNow || b.state === "looked" : b.state === layer));

/** Сетка «на кадре»: каждый кадр добавляет время в клетку под ногами человека. */
export function buildHeat(frames: HeatFrame[], w: number, h: number, layer: HeatLayer, from = 0, to = Infinity): HeatGrid {
  const cell = Math.max(8, Math.round(Math.max(w, h) / 48));
  const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
  const values = new Float32Array(cols * rows);
  const ids = new Set<number>();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.t < from || f.t > to) continue;
    const dt = Math.min(1, (frames[i + 1]?.t ?? f.t + 0.2) - f.t);
    for (const b of f.boxes) {
      if (!matches(b, layer)) continue;
      const x = (b.box.x1 + b.box.x2) / 2, y = b.box.y2;
      const c = Math.min(cols - 1, Math.max(0, Math.floor(x / cell)));
      const r = Math.min(rows - 1, Math.max(0, Math.floor(y / cell)));
      values[r * cols + c] += dt;
      ids.add(b.trackId);
    }
  }
  let max = 0;
  for (const v of values) max = Math.max(max, v);
  return { cols, rows, cell, values, max, people: ids.size };
}

/** Размытые пятна поверх кадра. */
export function paintHeat(ctx: CanvasRenderingContext2D, g: HeatGrid, scale: number, opacity = 0.8): void {
  if (g.max <= 0) return;
  const cs = g.cell * scale;
  ctx.save();
  ctx.filter = `blur(${Math.max(2, cs * 0.55)}px)`;
  for (let i = 0; i < g.values.length; i++) {
    const v0 = g.values[i];
    if (v0 <= 0) continue;
    const v = v0 / g.max;
    const cx = ((i % g.cols) + 0.5) * cs, cy = (Math.floor(i / g.cols) + 0.5) * cs;
    const r = cs * (0.55 + 0.35 * Math.sqrt(v));
    ctx.fillStyle = heatColor(v, opacity * (0.35 + 0.65 * Math.sqrt(v)));
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Сравнение: красный — стало больше, синий — меньше. */
function paintDiff(ctx: CanvasRenderingContext2D, a: HeatGrid, b: HeatGrid, scale: number): void {
  const cs = a.cell * scale;
  const ta = a.values.reduce((s, v) => s + v, 0) || 1, tb = b.values.reduce((s, v) => s + v, 0) || 1;
  const d = a.values.map((v, i) => b.values[i] / tb - v / ta);
  let m = 0;
  for (const v of d) m = Math.max(m, Math.abs(v));
  if (!m) return;
  ctx.save();
  ctx.filter = `blur(${Math.max(2, cs * 0.55)}px)`;
  d.forEach((v0, i) => {
    if (!v0) return;
    const v = v0 / m;
    const al = 0.15 + 0.8 * Math.sqrt(Math.abs(v));
    ctx.fillStyle = v > 0 ? `rgba(242,77,51,${al})` : `rgba(51,140,255,${al})`;
    ctx.beginPath();
    ctx.arc(((i % a.cols) + 0.5) * cs, (Math.floor(i / a.cols) + 0.5) * cs, cs * 0.75, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

/** Кадр с наименьшим числом людей — фон карты. */
export function quietTime(frames: HeatFrame[]): number {
  let best = frames[0];
  for (const f of frames) if (f.boxes.length < (best?.boxes.length ?? Infinity)) best = f;
  return best?.t ?? 0;
}

async function stillAt(video: HTMLVideoElement, t: number): Promise<ImageBitmap | null> {
  const v = document.createElement("video");
  v.muted = true;
  v.src = video.currentSrc || video.src;
  try {
    await new Promise<void>((ok, bad) => {
      v.onloadeddata = () => ok();
      v.onerror = () => bad(new Error("видео"));
    });
    v.currentTime = Math.min(t, (v.duration || t + 1) - 0.05);
    await new Promise<void>((ok) => (v.onseeked = () => ok()));
    return await createImageBitmap(v);
  } catch {
    return null;
  } finally {
    v.removeAttribute("src");
    v.load();
  }
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Окно тепловой карты. */
export async function openHeatmap(o: { frames: HeatFrame[]; video: HTMLVideoElement; width: number; height: number; title: string }): Promise<void> {
  const { frames, width: W, height: H } = o;
  if (!frames.length) return;
  const duration = frames[frames.length - 1].t;
  const bg = await stillAt(o.video, quietTime(frames));

  const dlg = document.createElement("dialog");
  dlg.className = "dialog heat-dialog";
  const inner = document.createElement("div");
  inner.className = "dialog-inner";
  const head = document.createElement("div");
  head.className = "dialog-head";
  const h2 = document.createElement("h2");
  h2.textContent = `Тепловая карта · ${o.title}`;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "tip-x";
  close.textContent = "×";
  close.addEventListener("click", () => dlg.close());
  head.append(h2, close);

  const bar = document.createElement("div");
  bar.className = "heat-bar";
  const chips = document.createElement("span");
  chips.className = "set-seg";
  let layer: HeatLayer = "time";
  let compare = false;
  for (const [v, t] of LAYERS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = t;
    b.dataset.v = v;
    b.addEventListener("click", () => {
      layer = v;
      draw();
    });
    chips.append(b);
  }
  const cmp = document.createElement("button");
  cmp.type = "button";
  cmp.className = "chip";
  cmp.textContent = "До / после";
  cmp.title = "Сравнить первую и вторую половину выбранного времени: красный — стало больше, синий — меньше";
  cmp.addEventListener("click", () => {
    compare = !compare;
    draw();
  });
  chips.append(cmp);

  const range = document.createElement("div");
  range.className = "heat-range";
  const r1 = document.createElement("input"), r2 = document.createElement("input");
  for (const r of [r1, r2]) {
    r.type = "range";
    r.min = "0";
    r.max = String(Math.ceil(duration));
    r.step = "1";
    r.addEventListener("input", () => draw());
  }
  r1.value = "0";
  r2.value = r2.max;
  const rl = document.createElement("small");
  rl.className = "mono";
  range.append(r1, r2, rl);
  bar.append(chips, range);

  const canvas = document.createElement("canvas");
  canvas.className = "heat-canvas";
  const scale = Math.min(1, 1280 / W);
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const info = document.createElement("p");
  info.className = "set-note";

  const acts = document.createElement("div");
  acts.className = "set-actions";
  const png = document.createElement("button");
  png.type = "button";
  png.className = "btn small";
  png.textContent = "Сохранить PNG";
  const csv = document.createElement("button");
  csv.type = "button";
  csv.className = "btn small ghost";
  csv.textContent = "Сетка CSV";
  acts.append(png, csv);

  inner.append(head, bar, canvas, info, acts);
  dlg.append(inner);
  document.body.append(dlg);
  dlg.addEventListener("close", () => {
    bg?.close();
    dlg.remove();
  });

  let grid: HeatGrid = buildHeat(frames, W, H, layer);
  function draw(): void {
    let a = Number(r1.value), b = Number(r2.value);
    if (a > b) [a, b] = [b, a];
    rl.textContent = `${fmt(a)} – ${fmt(b)}`;
    chips.querySelectorAll<HTMLButtonElement>("button[data-v]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.v === layer)));
    cmp.setAttribute("aria-pressed", String(compare));
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (bg) {
      ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = "#0a1230";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    grid = buildHeat(frames, W, H, layer, a, b);
    if (compare) {
      const mid = (a + b) / 2;
      paintDiff(ctx, buildHeat(frames, W, H, layer, a, mid), buildHeat(frames, W, H, layer, mid, b), scale);
      info.textContent = `Красный — во второй половине (${fmt(mid)} – ${fmt(b)}) людей здесь стало больше, синий — меньше.`;
    } else {
      paintHeat(ctx, grid, scale);
      const top = grid.values.indexOf(grid.max);
      info.textContent = grid.max > 0
        ? `${grid.people} чел. · самое «горячее» место — ${Math.round(grid.max)} с в одной клетке (${top % grid.cols + 1}-я колонка, ${Math.floor(top / grid.cols) + 1}-й ряд).`
        : "В этом слое и времени людей не было.";
    }
  }
  png.addEventListener("click", () => {
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `Тепловая карта ${o.title}.png`;
      document.body.append(a);
      a.click();
      setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 10_000);
    }, "image/png");
  });
  csv.addEventListener("click", () => {
    const rows = ["row;col;x_px;y_px;seconds"];
    grid.values.forEach((v, i) => {
      if (v > 0) {
        const c = i % grid.cols, r = Math.floor(i / grid.cols);
        rows.push(`${r + 1};${c + 1};${Math.round((c + 0.5) * grid.cell)};${Math.round((r + 0.5) * grid.cell)};${v.toFixed(1).replace(".", ",")}`);
      }
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" }));
    a.download = `Тепловая карта ${o.title}.csv`;
    document.body.append(a);
    a.click();
    setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 10_000);
  });
  draw();
  dlg.showModal();
}
