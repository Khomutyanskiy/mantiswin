// Рисование поверх кадра: разметка (зона, линия, вход) и люди с рамками.

import type { Pt } from "../engine/geometry";
import type { OverlayBox, PersonState } from "../engine/session";

export interface Markup {
  zone: Pt[];
  lineEnabled: boolean;
  line: Pt[];
  entranceEnabled: boolean;
  entrance: Pt[];
}

export const FULL_FRAME: Pt[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
export const VERTICAL_LINE: Pt[] = [{ x: 0.5, y: 0.05 }, { x: 0.5, y: 0.95 }];
export const HORIZONTAL_LINE: Pt[] = [{ x: 0.05, y: 0.6 }, { x: 0.95, y: 0.6 }];
export const DEFAULT_ENTRANCE: Pt[] = [{ x: 0.2, y: 0.8 }, { x: 0.8, y: 0.8 }];

export const defaultMarkup = (): Markup => ({
  zone: FULL_FRAME.map((p) => ({ ...p })),
  lineEnabled: true,
  line: VERTICAL_LINE.map((p) => ({ ...p })),
  entranceEnabled: false,
  entrance: DEFAULT_ENTRANCE.map((p) => ({ ...p })),
});

const C = {
  gray: "#9aa3b5",
  white: "#ffffff",
  green: "#5bd97f",
  yellow: "#ffd23f",
  cyan: "#47d7f0",
  red: "#ff5a4a",
  accent: "#8fe36d",
};

export const stateColor = (s: PersonState): string =>
  s === "looked" ? C.yellow : s === "slowed" ? C.green : s === "passed" ? C.white : C.gray;

/** Сколько пикселей холста в одном CSS-пикселе экрана: линии и подписи одинаковой толщины на любом видео. */
const unit = (ctx: CanvasRenderingContext2D) => {
  const c = ctx.canvas;
  const w = c instanceof HTMLCanvasElement ? c.getBoundingClientRect().width : 0;
  return w > 0 ? c.width / w : Math.max(1.5, Math.max(c.width, c.height) / 640);
};

export function drawMarkup(ctx: CanvasRenderingContext2D, m: Markup, opts: { handles?: boolean; active?: string | null } = {}): void {
  const W = ctx.canvas.width, H = ctx.canvas.height, u = unit(ctx);
  const px = (p: Pt) => [p.x * W, p.y * H] as const;
  ctx.save();
  ctx.lineJoin = "round";

  // Зона: затемняем всё вне зоны, если она не на весь кадр
  const full = m.zone.every((p, i) => p.x === FULL_FRAME[i].x && p.y === FULL_FRAME[i].y);
  if (!full) {
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    m.zone.forEach((p, i) => (i ? ctx.lineTo(...px(p)) : ctx.moveTo(...px(p))));
    ctx.closePath();
    ctx.fillStyle = "rgba(5, 10, 30, 0.45)";
    ctx.fill("evenodd");
  }
  ctx.beginPath();
  m.zone.forEach((p, i) => (i ? ctx.lineTo(...px(p)) : ctx.moveTo(...px(p))));
  ctx.closePath();
  ctx.strokeStyle = C.cyan;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = u * 1.5;
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (m.lineEnabled) {
    ctx.beginPath();
    ctx.moveTo(...px(m.line[0]));
    ctx.lineTo(...px(m.line[1]));
    ctx.strokeStyle = C.red;
    ctx.lineWidth = u * 2;
    ctx.stroke();
    // стрелка «вперёд»: в какую сторону считается forward
    const [ax, ay] = px(m.line[0]), [bx, by] = px(m.line[1]);
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = -(by - ay) / len, ny = (bx - ax) / len; // нормаль на сторону side > 0
    const s = u * 14;
    ctx.beginPath();
    ctx.moveTo(mx + nx * s * 0.4, my + ny * s * 0.4);
    ctx.lineTo(mx + nx * s * 1.6, my + ny * s * 1.6);
    ctx.lineWidth = u * 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(mx + nx * s * 2, my + ny * s * 2);
    ctx.lineTo(mx + nx * s * 1.3 + ny * s * 0.5, my + ny * s * 1.3 - nx * s * 0.5);
    ctx.lineTo(mx + nx * s * 1.3 - ny * s * 0.5, my + ny * s * 1.3 + nx * s * 0.5);
    ctx.closePath();
    ctx.fillStyle = C.red;
    ctx.fill();
  }

  if (m.entranceEnabled) {
    ctx.beginPath();
    ctx.moveTo(...px(m.entrance[0]));
    ctx.lineTo(...px(m.entrance[1]));
    ctx.setLineDash([u * 8, u * 5]);
    ctx.strokeStyle = C.green;
    ctx.lineWidth = u * 2;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (opts.handles) {
    const handle = (p: Pt, color: string, id: string) => {
      // точки на краю кадра рисуем чуть внутри, чтобы их было видно и удобно хватать
      const r0 = u * 10;
      const x = Math.min(W - r0, Math.max(r0, p.x * W)), y = Math.min(H - r0, Math.max(r0, p.y * H));
      ctx.beginPath();
      ctx.arc(x, y, u * (opts.active === id ? 11 : 8), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(10, 18, 48, 0.75)";
      ctx.fill();
      ctx.lineWidth = u * 2;
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    m.zone.forEach((p, i) => handle(p, C.cyan, `zone${i}`));
    if (m.lineEnabled) m.line.forEach((p, i) => handle(p, C.red, `line${i}`));
    if (m.entranceEnabled) m.entrance.forEach((p, i) => handle(p, C.green, `entrance${i}`));
  }
  ctx.restore();
}

export function drawPeople(ctx: CanvasRenderingContext2D, boxes: OverlayBox[], numberOf: (id: number) => number = (id) => id): void {
  const u = unit(ctx);
  ctx.save();
  ctx.font = `600 ${Math.round(u * 11)}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.textBaseline = "bottom";
  for (const b of boxes) {
    const { x1, y1, x2, y2 } = b.box;
    const color = stateColor(b.state);
    ctx.globalAlpha = b.inZone ? 1 : 0.45;
    ctx.lineWidth = u * (b.state === "tracked" ? 1.5 : 2.5);
    ctx.strokeStyle = color;
    if (b.state === "tracked") ctx.setLineDash([u * 4, u * 3]);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.setLineDash([]);

    // смотрит сейчас — кольцо у головы
    if (b.lookingNow && b.keypoints) {
      const nose = b.keypoints[0];
      ctx.beginPath();
      ctx.arc(nose.x, nose.y, Math.max(u * 7, (x2 - x1) * 0.18), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 210, 63, 0.28)";
      ctx.fill();
      ctx.strokeStyle = C.yellow;
      ctx.lineWidth = u * 1.5;
      ctx.stroke();
    }

    // подпись: номер и скорость в ростах/с
    const label = `${numberOf(b.trackId)}${b.speed !== null ? ` · ${b.speed.toFixed(2)}` : ""}`;
    const tw = ctx.measureText(label).width;
    const pad = u * 3;
    const lh = u * 15;
    const ly = Math.max(y1, lh);
    ctx.fillStyle = "rgba(10, 18, 48, 0.8)";
    ctx.fillRect(x1, ly - lh, tw + pad * 2, lh);
    ctx.fillStyle = color;
    ctx.fillText(label, x1 + pad, ly - u * 2);
  }
  ctx.restore();
}

/** Точки разметки для перетаскивания: id → нормированная точка. */
export function handlePoints(m: Markup): [string, Pt][] {
  const out: [string, Pt][] = m.zone.map((p, i) => [`zone${i}`, p]);
  if (m.lineEnabled) m.line.forEach((p, i) => out.push([`line${i}`, p]));
  if (m.entranceEnabled) m.entrance.forEach((p, i) => out.push([`entrance${i}`, p]));
  return out;
}
