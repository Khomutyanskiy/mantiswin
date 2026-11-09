// Окна двойника: «План и зоны» (размеры, магазин, витрины, входы, штендеры, зоны, подложка, камеры на плане)
// и привязка камеры или видео к плану (по 4 точкам на полу или по сектору). Порт TwinEditors.swift (macOS).

import { tell } from "../ui/confirm";
import { type Box, type Pt, pointInPolygon } from "../engine/geometry";
import {
  type CameraCalibration, type CameraMark, CameraProjector, FIXTURE_KINDS, type FixtureKind, STAND_D, type TwinFixture, type TwinPlan, type WallSpan,
  fixtureCorners, fixtureFacing, newFixture,
  calHomography, calibrationValid, floorPointsUntouched, cameraColor, cameraMark, defaultShop, edge, edgeLength, fmt1, freeSpan, hasShop,
  hinverse, hmap, initialCalibration, insertShopCorner, insideShop, isSector, nearestFixture, nearestWall, newId,
  normalizePlan, outwardNormal, pointOn, ray, rayInside, removeLastShopCorner, showcaseLines, doorLines, spanPoints, standCorners,
  standFacing, streetEdge, walls, zoneColor, ZONE_COLORS,
} from "./plan";
import { C, PlanFrame, dimLabel, fitCanvas, fixtureColor, paintBase, paintCamera, paintFixtures, paintZones } from "./paint";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
function button(text: string, cls: string, onClick?: (e: MouseEvent) => void, title?: string): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  if (title) b.title = title;
  if (onClick) b.addEventListener("click", (e) => {
    e.preventDefault();
    onClick(e);
  });
  return b;
}
function numberField(title: string, unit: string, get: () => number, set: (v: number) => void, onDone: () => void): { root: HTMLElement; refresh: () => void } {
  const root = el("label", "num-field");
  const input = el("input", "input");
  input.type = "number";
  input.step = "0.05";
  const u = el("span", "num-unit", unit);
  const box = el("div", "num-box");
  box.append(input, u);
  root.append(el("span", "field-label", title), box);
  const refresh = () => {
    if (document.activeElement !== input) input.value = String(Math.round(get() * 100) / 100);
  };
  input.addEventListener("change", () => {
    const v = parseFloat(input.value.replace(",", "."));
    if (Number.isFinite(v)) set(v);
    onDone();
    input.value = String(Math.round(get() * 100) / 100);
  });
  refresh();
  return { root, refresh };
}
const section = (title: string, ...nodes: Node[]) => {
  const s = el("section", "tw-card");
  s.append(el("p", "eyebrow", title), ...nodes);
  return s;
};
const round2 = (v: number) => Math.round(v * 20) / 20;
const segDist = (p: Pt, a: Pt, b: Pt) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 <= 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};
const midpoints = (pts: Pt[]) => pts.map((a, i) => {
  const b = pts[(i + 1) % pts.length];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
});
const rectOf = (pts: Pt[]): Pt[] => {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
};

function handle(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, big: boolean): void {
  const r = big ? 8 : 6;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = big ? 3 : 2;
  ctx.stroke();
}
function plus(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.moveTo(x - 3.5, y);
  ctx.lineTo(x + 3.5, y);
  ctx.moveTo(x, y - 3.5);
  ctx.lineTo(x, y + 3.5);
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1.6;
  ctx.stroke();
}
/** Ручка поворота: пунктир от центра и белый кружок со стрелкой. */
function knob(ctx: CanvasRenderingContext2D, cx: number, cy: number, kx: number, ky: number, color: string): void {
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(kx, ky);
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(kx, ky, 9, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = "700 11px system-ui, sans-serif";
  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("↻", kx, ky + 0.5);
}
const snapDeg = (d: number) => ((Math.round(d / 5) * 5) % 360 + 720) % 360;

export interface CameraRef {
  id: string;
  name: string;
  colorIndex: number;
}

// ================================================================ «План и зоны»

type SpanKind = "showcase" | "door";
type Drag =
  | { t: "corner"; id: string; i: number }
  | { t: "zone"; id: string; orig: Pt[] }
  | { t: "shopCorner"; i: number }
  | { t: "shop"; orig: Pt[] }
  | { t: "spanEnd"; k: SpanKind; i: number; end: number }
  | { t: "span"; k: SpanKind; i: number }
  | { t: "stand"; id: string; orig: Pt }
  | { t: "standKnob"; id: string }
  | { t: "fixture"; id: string; orig: Pt }
  | { t: "fixtureKnob"; id: string }
  | { t: "camera"; id: string; orig: Pt }
  | { t: "cameraKnob"; id: string }
  | { t: "cameraRange"; id: string }
  | { t: "cameraFov"; id: string };

export interface PlanEditResult {
  plan: TwinPlan;
  /** undefined — подложка не менялась; null — убрана. */
  background?: Blob | null;
}

type PlanEditorInput = {
  plan: TwinPlan;
  background: ImageBitmap | null;
  cameras: CameraRef[];
  /** Камеры можно добавлять и убирать прямо на плане (раздел «Демо»: придуманные камеры). Список меняется на месте. */
  editCameras?: (cams: CameraRef[]) => void;
};

/** Окно «План и зоны» (Сохранить / Отмена). */
export function openPlanEditor(o: PlanEditorInput): Promise<PlanEditResult | null> {
  return planEditor(o, null);
}

/**
 * Встроенный редактор — шаг «План» раздела «Мониторинг»: без кнопок окна, изменения сохраняются сами
 * (через полсекунды после правки; подложка — сразу). Как PlanEditorView(inline: true) на Mac.
 */
export function mountPlanEditor(container: HTMLElement, o: PlanEditorInput, onSave: (r: PlanEditResult) => void): void {
  void planEditor(o, { container, onSave });
}

function planEditor(o: PlanEditorInput, inline: { container: HTMLElement; onSave: (r: PlanEditResult) => void } | null): Promise<PlanEditResult | null> {
  return new Promise((resolve) => {
    const dialog = el("dialog", "dialog tw-editor");
    if (!inline) document.body.append(dialog);
    let draft: TwinPlan = normalizePlan(structuredClone(o.plan));
    const original = JSON.stringify(draft);
    let bg = o.background;
    let bgBlob: Blob | null | undefined = undefined;
    let selected: string | null = null;
    let drag: Drag | null = null;
    let start: Pt = { x: 0, y: 0 };
    let result: PlanEditResult | null = null;
    const SHOP = "shop";
    const key = (k: SpanKind, i: number) => `${k}#${i}`;
    const spans = (k: SpanKind) => (k === "showcase" ? draft.showcases : draft.doors);
    const setSpans = (k: SpanKind, v: WallSpan[]) => (k === "showcase" ? (draft.showcases = v) : (draft.doors = v));
    const spanPts = (k: SpanKind, i: number) => (spans(k)[i] ? spanPoints(draft, spans(k)[i]) : []);

    const canvas = el("canvas", "tw-canvas");
    let frame = new PlanFrame(draft, 800, 600);
    const marks = (): [CameraRef, CameraMark][] =>
      o.cameras.flatMap((r) => {
        const c = draft.calibrations[r.id];
        const m = c ? cameraMark(r.name, r.colorIndex, c, draft) : null;
        return m ? [[r, m] as [CameraRef, CameraMark]] : [];
      });
    const camKnob = (m: CameraMark) => {
      const [x, y] = frame.pt(m.position);
      return [x + 40 * Math.cos(m.angle), y + 40 * Math.sin(m.angle)] as const;
    };
    const standKnob = (st: TwinPlan["stands"][number]) => {
      const [x, y] = frame.pt(st.pos);
      const n = standFacing(st), r = Math.max(34, frame.k * (STAND_D / 2 + 0.5));
      return [x + n.x * r, y + n.y * r] as const;
    };
    const fixtureKnob = (fx: TwinFixture) => {
      const [x, y] = frame.pt(fx.pos);
      const n = fixtureFacing(fx), r = Math.max(34, frame.k * (fx.depth / 2 + 0.5));
      return [x + n.x * r, y + n.y * r] as const;
    };
    const sectorHandles = (m: CameraMark) => [ray(m, m.angle, m.range), ray(m, m.angle - m.fov / 2, m.range), ray(m, m.angle + m.fov / 2, m.range)];
    const snap = (p: Pt): Pt => ({ x: round2(Math.min(Math.max(p.x, 0), draft.widthM)), y: round2(Math.min(Math.max(p.y, 0), draft.depthM)) });
    const moved = (orig: Pt[], dx: number, dy: number) => {
      const ddx = Math.min(Math.max(dx, -Math.min(...orig.map((p) => p.x))), draft.widthM - Math.max(...orig.map((p) => p.x)));
      const ddy = Math.min(Math.max(dy, -Math.min(...orig.map((p) => p.y))), draft.depthM - Math.max(...orig.map((p) => p.y)));
      return orig.map((p) => ({ x: round2(p.x + ddx), y: round2(p.y + ddy) }));
    };
    const fixCamera = (id: string, m: CameraMark) => {
      const c = draft.calibrations[id];
      if (!c) return;
      c.cameraPos ??= m.position;
      c.cameraAngle ??= m.angle;
    };

    // ---------------------------------------------------------------- рисование
    function draw(): void {
      const { ctx, w, h } = fitCanvas(canvas);
      frame = new PlanFrame(draft, w, h);
      const f = frame;
      paintBase(ctx, draft, f, bg);
      paintFixtures(ctx, draft, f);
      paintZones(ctx, draft.zones, f, null, selected);
      for (const [ref, m] of marks()) {
        paintCamera(ctx, m, f, draft);
        const color = cameraColor(ref.colorIndex);
        const [cx, cy] = f.pt(m.position);
        knob(ctx, cx, cy, ...camKnob(m), color);
        for (const p of sectorHandles(m)) handle(ctx, ...f.pt(p), color, selected === `cam:${ref.id}`);
      }
      if (hasShop(draft)) {
        const on = selected === SHOP;
        if (on) {
          ctx.setLineDash([6, 4]);
          f.path(ctx, draft.shop);
          ctx.strokeStyle = C.focus;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.setLineDash([]);
        }
        for (const p of draft.shop) handle(ctx, ...f.pt(p), C.moon, on);
        if (on) for (const m of midpoints(draft.shop)) plus(ctx, ...f.pt(m), C.moon);
      }
      for (const k of ["showcase", "door"] as SpanKind[]) {
        const color = k === "showcase" ? C.showcase : C.entrance;
        spans(k).forEach((_, i) => spanPts(k, i).forEach((p) => handle(ctx, ...f.pt(p), color, selected === key(k, i))));
      }
      for (const st of draft.stands) {
        if (st.id !== selected) continue;
        ctx.setLineDash([4, 3]);
        f.path(ctx, standCorners(st, 0.12));
        ctx.strokeStyle = C.focus;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        knob(ctx, ...f.pt(st.pos), ...standKnob(st), C.stand);
      }
      for (const fx of draft.fixtures) {
        if (fx.id !== selected) continue;
        ctx.setLineDash([4, 3]);
        f.path(ctx, fixtureCorners(fx, 0.12));
        ctx.strokeStyle = C.focus;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        knob(ctx, ...f.pt(fx.pos), ...fixtureKnob(fx), fixtureColor(fx));
      }
      for (const z of draft.zones) {
        if (z.points.length < 3) continue;
        const color = zoneColor(z.color), on = selected === z.id;
        for (const p of z.points) handle(ctx, ...f.pt(p), color, on);
        if (on) for (const m of midpoints(z.points)) plus(ctx, ...f.pt(m), color);
      }
    }

    // ---------------------------------------------------------------- что под курсором
    function hit(x: number, y: number): Drag | null {
      const f = frame;
      const near = (p: Pt, r = 14) => {
        const [cx, cy] = f.pt(p);
        return Math.hypot(cx - x, cy - y) < r;
      };
      const ms = marks();
      for (const [ref, m] of ms) {
        const [kx, ky] = camKnob(m);
        if (Math.hypot(kx - x, ky - y) < 12) return { t: "cameraKnob", id: ref.id };
      }
      for (const st of draft.stands) {
        if (st.id !== selected) continue;
        const [kx, ky] = standKnob(st);
        if (Math.hypot(kx - x, ky - y) < 12) return { t: "standKnob", id: st.id };
      }
      for (const fx of draft.fixtures) {
        if (fx.id !== selected) continue;
        const [kx, ky] = fixtureKnob(fx);
        if (Math.hypot(kx - x, ky - y) < 12) return { t: "fixtureKnob", id: fx.id };
      }
      for (const [ref, m] of ms) {
        const hs = sectorHandles(m);
        if (near(hs[0], 12)) return { t: "cameraRange", id: ref.id };
        if (near(hs[1], 12) || near(hs[2], 12)) return { t: "cameraFov", id: ref.id };
      }
      for (const [ref, m] of ms) if (near(m.position, 16)) return { t: "camera", id: ref.id, orig: m.position };
      const order = [...draft.zones.filter((z) => z.id === selected), ...draft.zones.filter((z) => z.id !== selected)];
      for (const z of order) {
        const i = z.points.findIndex((p) => near(p));
        if (i >= 0) return { t: "corner", id: z.id, i };
      }
      for (const k of ["door", "showcase"] as SpanKind[]) {
        for (let si = 0; si < spans(k).length; si++) {
          const i = spanPts(k, si).findIndex((p) => near(p, 12));
          if (i >= 0) return { t: "spanEnd", k, i: si, end: i };
        }
      }
      const sc = draft.shop.findIndex((p) => near(p));
      if (sc >= 0) return { t: "shopCorner", i: sc };
      const sz = order.find((z) => z.id === selected);
      if (sz) {
        const i = midpoints(sz.points).findIndex((m) => near(m, 12));
        if (i >= 0) return { t: "corner", id: sz.id, i: -(i + 1) };
      }
      if (selected === SHOP && hasShop(draft)) {
        const i = midpoints(draft.shop).findIndex((m) => near(m, 12));
        if (i >= 0) return { t: "shopCorner", i: -(i + 1) };
      }
      const m = f.meters(x, y);
      for (const st of [...draft.stands].reverse()) if (pointInPolygon(m, standCorners(st, 0.1))) return { t: "stand", id: st.id, orig: st.pos };
      // выбранный стеллаж — первым (если лежит поверх другого)
      const fxOrder = [...draft.fixtures.filter((q) => q.id === selected), ...[...draft.fixtures].reverse().filter((q) => q.id !== selected)];
      for (const fx of fxOrder) if (pointInPolygon(m, fixtureCorners(fx, 0.08))) return { t: "fixture", id: fx.id, orig: fx.pos };
      for (const k of ["door", "showcase"] as SpanKind[]) {
        for (let si = 0; si < spans(k).length; si++) {
          const pts = spanPts(k, si);
          if (pts.length === 2 && segDist(m, pts[0], pts[1]) * f.k < 10) return { t: "span", k, i: si };
        }
      }
      const z = order.find((zz) => zz.points.length >= 3 && pointInPolygon(m, zz.points));
      if (z) return { t: "zone", id: z.id, orig: z.points.map((p) => ({ ...p })) };
      if (insideShop(draft, m)) return { t: "shop", orig: draft.shop.map((p) => ({ ...p })) };
      return null;
    }

    const local = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };
    canvas.addEventListener("pointerdown", (e) => {
      const [x, y] = local(e);
      let h = hit(x, y);
      if (!h) {
        selected = null;
        refreshPanel();
        draw();
        return;
      }
      // «+» на стороне — вставляем угол и тянем его
      if (h.t === "corner" && h.i < 0) {
        const z = draft.zones.find((zz) => zz.id === (h as { id: string }).id)!;
        const after = -h.i - 1;
        z.points.splice(after + 1, 0, snap(frame.meters(x, y)));
        h = { t: "corner", id: z.id, i: after + 1 };
      }
      if (h.t === "shopCorner" && h.i < 0) {
        const e2 = -h.i - 1;
        insertShopCorner(draft, e2, 0.5);
        h = { t: "shopCorner", i: e2 + 1 };
      }
      drag = h;
      start = frame.meters(x, y);
      switch (h.t) {
        case "corner": case "zone": selected = h.id; break;
        case "shopCorner": case "shop": selected = SHOP; break;
        case "spanEnd": case "span": selected = key(h.k, h.i); break;
        case "stand": case "standKnob": case "fixture": case "fixtureKnob": selected = h.id; break;
        default: selected = `cam:${h.id}`;
      }
      canvas.setPointerCapture(e.pointerId);
      refreshPanel();
      draw();
    });
    canvas.addEventListener("pointermove", (e) => {
      const [x, y] = local(e);
      if (!drag) {
        const h = hit(x, y);
        canvas.style.cursor = !h ? "default" : ["corner", "shopCorner", "spanEnd"].includes(h.t) ? "crosshair"
          : ["standKnob", "fixtureKnob", "cameraKnob", "cameraRange", "cameraFov"].includes(h.t) ? "pointer" : "grab";
        return;
      }
      const b = frame.meters(x, y), a = start;
      const d = drag;
      switch (d.t) {
        case "corner": {
          const z = draft.zones.find((zz) => zz.id === d.id);
          if (z && d.i >= 0 && d.i < z.points.length) z.points[d.i] = snap(b);
          break;
        }
        case "zone": {
          const z = draft.zones.find((zz) => zz.id === d.id);
          if (z) z.points = moved(d.orig, b.x - a.x, b.y - a.y);
          break;
        }
        case "shopCorner":
          if (d.i >= 0 && d.i < draft.shop.length) draft.shop[d.i] = snap(b);
          break;
        case "shop":
          draft.shop = moved(d.orig, b.x - a.x, b.y - a.y);
          break;
        case "spanEnd": {
          const s = { ...spans(d.k)[d.i] };
          const ab = s && edge(draft, s.edge);
          if (!ab) break;
          const [p0, p1] = ab;
          const dx = p1.x - p0.x, dy = p1.y - p0.y;
          const t = Math.min(1, Math.max(0, ((b.x - p0.x) * dx + (b.y - p0.y) * dy) / Math.max(1e-9, dx * dx + dy * dy)));
          const minT = 0.3 / Math.max(0.3, edgeLength(draft, s.edge));
          if (d.end === 0) s.t0 = Math.min(t, s.t1 - minT);
          else s.t1 = Math.max(t, s.t0 + minT);
          s.t0 = Math.max(0, s.t0);
          s.t1 = Math.min(1, s.t1);
          const v = [...spans(d.k)];
          v[d.i] = s;
          setSpans(d.k, v);
          break;
        }
        case "span": {
          const s = spans(d.k)[d.i];
          const w = nearestWall(draft, b);
          if (!s || !w) break;
          const lenM = (s.t1 - s.t0) * edgeLength(draft, s.edge);
          const E = Math.max(0.01, edgeLength(draft, w.edge));
          const half = Math.min(0.5, lenM / 2 / E);
          const c = Math.min(Math.max(w.t, half), 1 - half);
          const v = [...spans(d.k)];
          v[d.i] = { edge: w.edge, t0: c - half, t1: c + half };
          setSpans(d.k, v);
          break;
        }
        case "stand": {
          const st = draft.stands.find((s) => s.id === d.id);
          if (st) st.pos = snap({ x: d.orig.x + b.x - a.x, y: d.orig.y + b.y - a.y });
          break;
        }
        case "standKnob": {
          const st = draft.stands.find((s) => s.id === d.id);
          if (!st) break;
          const [cx, cy] = frame.pt(st.pos);
          st.angle = (snapDeg((Math.atan2(y - cy, x - cx) * 180) / Math.PI - 90) * Math.PI) / 180;
          break;
        }
        case "fixture": {
          const fx = draft.fixtures.find((q) => q.id === d.id);
          if (fx) fx.pos = snap({ x: d.orig.x + b.x - a.x, y: d.orig.y + b.y - a.y });
          break;
        }
        case "fixtureKnob": {
          const fx = draft.fixtures.find((q) => q.id === d.id);
          if (!fx) break;
          const [cx, cy] = frame.pt(fx.pos);
          fx.angle = (snapDeg((Math.atan2(y - cy, x - cx) * 180) / Math.PI - 90) * Math.PI) / 180;
          break;
        }
        case "camera": {
          const c = draft.calibrations[d.id];
          if (!c) break;
          const p = { x: d.orig.x + b.x - a.x, y: d.orig.y + b.y - a.y };
          c.cameraPos = { x: round2(Math.min(Math.max(p.x, -0.8), draft.widthM + 0.8)), y: round2(Math.min(Math.max(p.y, -0.8), draft.depthM + 0.8)) };
          break;
        }
        case "cameraKnob": {
          const m = marks().find(([r]) => r.id === d.id)?.[1];
          const c = draft.calibrations[d.id];
          if (!m || !c) break;
          const [cx, cy] = frame.pt(m.position);
          c.cameraPos ??= m.position; // место фиксируем, чтобы камера не прыгала при повороте
          c.cameraAngle = (snapDeg((Math.atan2(y - cy, x - cx) * 180) / Math.PI) * Math.PI) / 180;
          break;
        }
        case "cameraRange": {
          const m = marks().find(([r]) => r.id === d.id)?.[1];
          if (!m) break;
          fixCamera(d.id, m);
          draft.calibrations[d.id].rangeM = Math.round(Math.min(40, Math.max(1, Math.min(Math.hypot(b.x - m.position.x, b.y - m.position.y), rayInside(m, m.angle) || 40))) * 10) / 10;
          break;
        }
        case "cameraFov": {
          const m = marks().find(([r]) => r.id === d.id)?.[1];
          if (!m) break;
          fixCamera(d.id, m);
          let delta = Math.atan2(b.y - m.position.y, b.x - m.position.x) - m.angle;
          while (delta > Math.PI) delta -= 2 * Math.PI;
          while (delta < -Math.PI) delta += 2 * Math.PI;
          draft.calibrations[d.id].fovDeg = Math.min(170, Math.max(20, Math.round((Math.abs(delta) * 2 * 180) / Math.PI / 5) * 5));
          break;
        }
      }
      draw();
      liveRefresh();
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      refreshPanel();
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    // ---------------------------------------------------------------- панель
    const panel = el("div", "tw-panel");
    let liveFields: { refresh: () => void }[] = [];
    function liveRefresh(): void {
      for (const f of liveFields) f.refresh();
      saveBtn.disabled = JSON.stringify(draft) === original && bgBlob === undefined;
      if (inline) autosave();
    }
    const changed = () => {
      draw();
      liveRefresh();
    };

    /** Рамка многоугольника: сдвиг и масштаб с сохранением формы. */
    function boxField(get: () => Pt[], set: (v: Pt[]) => void, field: "x" | "y" | "w" | "h", title: string) {
      const bounds = () => {
        const pts = get();
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      };
      return numberField(title, "м", () => {
        const b = bounds();
        return field === "x" ? b.x0 : field === "y" ? b.y0 : field === "w" ? b.x1 - b.x0 : b.y1 - b.y0;
      }, (v) => {
        const pts = get();
        if (!pts.length) return;
        const b = bounds();
        const w = Math.max(0.01, b.x1 - b.x0), h = Math.max(0.01, b.y1 - b.y0);
        if (field === "x") {
          const nx = Math.min(Math.max(0, v), draft.widthM - w);
          set(pts.map((p) => ({ x: round2(p.x - b.x0 + nx), y: p.y })));
        } else if (field === "y") {
          const ny = Math.min(Math.max(0, v), draft.depthM - h);
          set(pts.map((p) => ({ x: p.x, y: round2(p.y - b.y0 + ny) })));
        } else if (field === "w") {
          const nw = Math.min(Math.max(0.2, v), draft.widthM - b.x0);
          set(pts.map((p) => ({ x: round2(b.x0 + ((p.x - b.x0) * nw) / w), y: p.y })));
        } else {
          const nh = Math.min(Math.max(0.2, v), draft.depthM - b.y0);
          set(pts.map((p) => ({ x: p.x, y: round2(b.y0 + ((p.y - b.y0) * nh) / h) })));
        }
      }, changed);
    }
    const row = (...n: Node[]) => {
      const r = el("div", "tw-row");
      r.append(...n);
      return r;
    };

    function refreshPanel(): void {
      liveFields = [];
      const nodes: Node[] = [];
      // размеры
      const fw = numberField("Ширина", "м", () => draft.widthM, (v) => (draft.widthM = Math.min(300, Math.max(1, v))), () => {
        refreshPanel();
        draw();
      });
      const fd = numberField("Глубина", "м", () => draft.depthM, (v) => (draft.depthM = Math.min(300, Math.max(1, v))), () => {
        refreshPanel();
        draw();
      });
      nodes.push(section("Размеры плана", row(fw.root, fd.root),
        el("p", "hint-small", "Весь план — магазин и улица перед ним. Если поменять размер, тепловая карта дня начнётся заново.")));

      // магазин
      const shopNodes: Node[] = [];
      if (hasShop(draft)) {
        const get = () => draft.shop, set = (v: Pt[]) => (draft.shop = v);
        const fs = (["x", "y", "w", "h"] as const).map((k, i) => boxField(get, set, k, ["Слева", "Сверху", "Ширина", "Глубина"][i]));
        liveFields.push(...fs);
        shopNodes.push(row(fs[0].root, fs[1].root), row(fs[2].root, fs[3].root));
        const minus = button("− угол", "btn small", () => {
          removeLastShopCorner(draft);
          refreshPanel();
          draw();
        }, "Убрать последний угол");
        minus.disabled = draft.shop.length <= 3;
        shopNodes.push(row(
          button("Прямоугольник", "btn small", () => {
            const was = streetEdge(draft);
            draft.shop = rectOf(draft.shop);
            for (const k of ["showcase", "door"] as SpanKind[]) setSpans(k, spans(k).map((s) => (s.edge > 3 || s.edge === was ? { ...s, edge: 2 } : s)));
            refreshPanel();
            draw();
          }, "Сделать прямоугольником"),
          minus,
          el("span", "grow"),
          button("Убрать", "btn small", () => {
            draft.shop = [];
            draft.showcases = [];
            draft.doors = [];
            selected = null;
            refreshPanel();
            draw();
          }),
        ));
        for (const [k, title, item, color] of [["showcase", "Витрины", "Витрина", C.showcase], ["door", "Входы", "Вход", C.entrance]] as const) {
          const list = el("div", "tw-list");
          const head = row(el("b", undefined, title), el("span", "grow"), button("Добавить", "chip", () => addSpan(k)));
          spans(k).forEach((sp, i) => {
            const r = el("div", "tw-item");
            if (selected === key(k, i)) r.classList.add("on");
            const dot = el("i", "tw-dot");
            dot.style.background = color;
            r.append(dot, el("span", undefined, `${item} ${i + 1}`), el("span", "mono small faint", `${fmt1((sp.t1 - sp.t0) * edgeLength(draft, sp.edge))} м`),
              el("span", "grow"),
              button("Убрать", "link danger", () => {
                setSpans(k, spans(k).filter((_, j) => j !== i));
                selected = null;
                refreshPanel();
                draw();
              }));
            r.addEventListener("click", (e) => {
              if ((e.target as HTMLElement).closest("button")) return;
              selected = key(k, i);
              refreshPanel();
              draw();
            });
            list.append(r);
          });
          shopNodes.push(head, list);
        }
      } else {
        shopNodes.push(button("Отметить магазин", "btn primary wide", () => addShop()));
      }
      nodes.push(section("Магазин", ...shopNodes, el("p", "hint-small", hasShop(draft)
        ? "Углы тяните на плане, «+» на стороне добавляет угол — так задаётся любая форма. Витрина и дверь — на стенах магазина."
        : "Отметьте магазин, затем витрину и дверь на его стенах. В демо люди проходят внутрь только через дверь.")));

      // придуманные камеры (демо)
      if (o.editCameras) {
        const list = el("div", "tw-list");
        for (const ref of o.cameras) {
          const it = el("div", "tw-item");
          if (selected === `cam:${ref.id}`) it.classList.add("on");
          const dot = el("i", "tw-dot");
          dot.style.background = cameraColor(ref.colorIndex);
          it.append(dot, el("span", undefined, ref.name), el("span", "grow"), button("Убрать", "link danger", () => {
            delete draft.calibrations[ref.id];
            o.cameras.splice(o.cameras.indexOf(ref), 1);
            if (selected === `cam:${ref.id}`) selected = null;
            o.editCameras?.(o.cameras);
            refreshPanel();
            changed();
          }));
          it.addEventListener("click", (e) => {
            if ((e.target as HTMLElement).closest("button")) return;
            selected = `cam:${ref.id}`;
            refreshPanel();
            draw();
          });
          list.append(it);
        }
        const add = button("Добавить камеру", "btn small", () => {
          const used = new Set(o.cameras.map((c) => c.colorIndex));
          let color = 0;
          while (used.has(color) && color < 7) color++;
          let n = o.cameras.length + 1;
          while (o.cameras.some((c) => c.name === `Камера ${n}`)) n++;
          const id = `demo-cam-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
          // новая камера — у нижнего края, смотрит вверх; следующие — правее/левее, чтобы не легли друг на друга
          const k = o.cameras.length;
          const fx = k === 0 ? 0.5 : 0.15 + 0.7 * ((0.5 + k * 0.382) % 1);
          draft.calibrations[id] = {
            ...initialCalibration(draft), mode: "sector", cameraPos: { x: round2(draft.widthM * fx), y: round2(Math.max(0.5, draft.depthM - 0.5)) },
            cameraAngle: -Math.PI / 2, fovDeg: 70, rangeM: Math.min(8, Math.round(draft.depthM)),
          };
          o.cameras.push({ id, name: `Камера ${n}`, colorIndex: color });
          selected = `cam:${id}`;
          o.editCameras?.(o.cameras);
          refreshPanel();
          changed();
        });
        add.classList.add("wide");
        nodes.push(section("Камеры", add, ...(o.cameras.length ? [list] : []),
          el("p", "hint-small", o.cameras.length ? "Тяните значок — место, белую ручку — поворот, точки на дуге — дальность и угол обзора." : "Придуманные камеры: поставьте на план и поверните — в демо будет видно, кого какая камера видит.")));
      }

      // выбранная камера
      if (selected?.startsWith("cam:")) {
        const id = selected.slice(4);
        const ref = o.cameras.find((r) => r.id === id);
        const m = marks().find(([r]) => r.id === id)?.[1];
        if (ref && m) {
          const cal = () => draft.calibrations[id];
          const curMark = () => marks().find(([r]) => r.id === id)?.[1] ?? m;
          const ffov = numberField("Угол обзора", "°", () => cal()?.fovDeg ?? (curMark().fov * 180) / Math.PI, (v) => {
            fixCamera(id, curMark());
            cal().fovDeg = Math.min(170, Math.max(20, v));
          }, changed);
          const frange = numberField("Дальность", "м", () => cal()?.rangeM ?? curMark().range, (v) => {
            fixCamera(id, curMark());
            cal().rangeM = Math.min(40, Math.max(1, v));
          }, changed);
          const fang = numberField("Поворот", "°", () => Math.round(((((curMark().angle * 180) / Math.PI) % 360) + 360) % 360), (v) => {
            fixCamera(id, curMark());
            cal().cameraAngle = (v * Math.PI) / 180;
          }, changed);
          const toShowcase = el("div", "num-field");
          const tsv = el("b", "mono");
          toShowcase.append(el("span", "field-label", "До витрины"), tsv);
          const tsRefresh = { refresh: () => {
            const nf = nearestFixture(curMark(), draft);
            tsv.textContent = nf ? `${fmt1(nf[1])} м` : "—";
          } };
          tsRefresh.refresh();
          liveFields.push(ffov, frange, fang, tsRefresh);
          nodes.push(section(`Камера · ${ref.name}`, row(ffov.root, frange.root), row(fang.root, toShowcase),
            ...(o.editCameras ? [] : [button("Авто — по привязке", "btn small", () => {
              const c = cal();
              c.cameraPos = c.cameraAngle = c.fovDeg = c.rangeM = null;
              refreshPanel();
              draw();
            })]),
            el("p", "hint-small", "Тяните значок — место, белую ручку — поворот, точку на дуге — дальность, точки на краях — угол обзора.")));
        }
      }

      // стеллажи и витрины (внутри магазина или на плане)
      const fxList = el("div", "tw-list");
      draft.fixtures.forEach((fx, i) => {
        const on = selected === fx.id;
        const n = draft.fixtures.slice(0, i).filter((q) => q.kind === fx.kind).length + 1;
        const r = el("div", "tw-item tw-fx");
        if (on) r.classList.add("on");
        const sw = el("i", "tw-fx-sw");
        sw.style.background = fixtureColor(fx);
        r.append(sw, el("span", undefined, `${FIXTURE_KINDS[fx.kind].title} ${n}`),
          el("span", "small faint mono", `${fmt1(fx.width)} × ${fmt1(fx.depth)} м · ${hasShop(draft) && insideShop(draft, fx.pos) ? "в магазине" : "на плане"}`),
          el("span", "grow"),
          button("⧉", "link", () => {
            const nf = fixtureFacing(fx);
            const c = { ...structuredClone(fx), id: newId(), pos: snap({ x: fx.pos.x + nf.x * (fx.depth + 1), y: fx.pos.y + nf.y * (fx.depth + 1) }) };
            draft.fixtures.push(c);
            selected = c.id;
            refreshPanel();
            changed();
          }, "Копия рядом — удобно для ряда стеллажей"),
          button("Убрать", "link danger", () => {
            draft.fixtures = draft.fixtures.filter((q) => q.id !== fx.id);
            if (on) selected = null;
            refreshPanel();
            changed();
          }));
        r.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest("button, input")) return;
          selected = fx.id;
          refreshPanel();
          draw();
        });
        fxList.append(r);
        if (on) {
          const get = () => draft.fixtures.find((q) => q.id === fx.id) ?? fx;
          const fl = numberField("Длина", "м", () => get().width, (v) => (get().width = Math.min(30, Math.max(0.2, Math.round(v * 20) / 20))), changed);
          const fdp = numberField("Глубина", "м", () => get().depth, (v) => (get().depth = Math.min(30, Math.max(0.2, Math.round(v * 20) / 20))), changed);
          const fa = numberField("Поворот", "°", () => Math.round(((((get().angle * 180) / Math.PI) % 360) + 360) % 360), (v) => (get().angle = (v * Math.PI) / 180), changed);
          liveFields.push(fl, fdp, fa);
          const kinds = el("div", "seg tw-fx-kind");
          kinds.style.gridTemplateColumns = "repeat(2, 1fr)";
          for (const k of ["rack", "showcase"] as FixtureKind[]) {
            const label = el("label");
            const input = el("input");
            input.type = "radio";
            input.name = `fx-kind-${fx.id}`;
            input.checked = fx.kind === k;
            input.addEventListener("change", () => {
              if (!input.checked) return;
              get().kind = k;
              refreshPanel();
              changed();
            });
            label.append(input, el("span", undefined, FIXTURE_KINDS[k].title));
            kinds.append(label);
          }
          const box = el("div", "tw-fx-edit");
          box.append(row(fl.root, fdp.root), row(fa.root, kinds),
            el("p", "hint-small", fx.kind === "showcase" ? "Поворот — белой ручкой: лицевая (белая) сторона смотрит на ручку." : "Поворот — белой ручкой на плане. Покупатели подходят с обеих сторон."));
          fxList.append(box);
        }
      });
      const fxAdd = row(button("+ Стеллаж", "btn small", () => addFixture("rack"), "Добавить стеллаж"),
        button("+ Витрина", "btn small", () => addFixture("showcase"), "Добавить витрину (прилавок) внутри магазина или на плане"));
      nodes.push(section("Стеллажи и витрины", fxList, fxAdd,
        el("p", "hint-small", "Ставьте внутри магазина или в любом месте плана. Белая сторона витрины — лицевая. В демо прохожие обходят их и останавливаются посмотреть.")));

      // штендеры
      const stList = el("div", "tw-list");
      draft.stands.forEach((st, i) => {
        const r = el("div", "tw-item");
        if (selected === st.id) r.classList.add("on");
        const dot = el("i", "tw-dot");
        dot.style.background = C.stand;
        r.append(dot, el("span", undefined, `Штендер ${i + 1}`));
        if (selected === st.id) r.append(el("span", "small faint", `поворот ${Math.round((((st.angle * 180) / Math.PI) % 360 + 360) % 360)}°`));
        r.append(el("span", "grow"), button("Убрать", "link danger", () => {
          draft.stands = draft.stands.filter((s) => s.id !== st.id);
          if (selected === st.id) selected = null;
          refreshPanel();
          draw();
        }));
        r.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          selected = st.id;
          refreshPanel();
          draw();
        });
        stList.append(r);
      });
      nodes.push(section("Выносная реклама", stList, button("Добавить штендер", "btn small", () => addStand()),
        el("p", "hint-small", "Штендеры на улице. Поворот — белой ручкой на плане, фасад смотрит на ручку. В демо прохожие их обходят и иногда останавливаются почитать.")));

      // зоны
      const zList = el("div", "tw-list");
      for (const z of draft.zones) {
        const r = el("div", "tw-item");
        if (selected === z.id) r.classList.add("on");
        const sw = button("", "tw-swatch", () => {
          z.color = (z.color + 1) % ZONE_COLORS.length;
          refreshPanel();
          draw();
        }, "Сменить цвет");
        sw.style.background = zoneColor(z.color);
        const name = el("input", "input tw-name");
        name.value = z.name;
        name.addEventListener("input", () => {
          z.name = name.value;
          draw();
          liveRefresh();
        });
        r.append(sw, name,
          button(selected === z.id ? "Готово" : "Править", "link", () => {
            selected = selected === z.id ? null : z.id;
            refreshPanel();
            draw();
          }),
          button("Удалить", "link danger", () => {
            draft.zones = draft.zones.filter((x) => x.id !== z.id);
            if (selected === z.id) selected = null;
            refreshPanel();
            draw();
          }));
        zList.append(r);
      }
      nodes.push(section("Зоны", zList, button("Добавить зону", "btn small", () => addZone()),
        el("p", "hint-small", "Витрина снаружи, касса, стеллажи, примерочная — по каждой зоне считаются заходы и время.")));

      const sz = draft.zones.find((z) => z.id === selected);
      if (sz) {
        const get = () => draft.zones.find((z) => z.id === sz.id)?.points ?? [], set = (v: Pt[]) => (sz.points = v);
        const fs = (["x", "y", "w", "h"] as const).map((k, i) => boxField(get, set, k, ["Слева", "Сверху", "Ширина", "Глубина"][i]));
        liveFields.push(...fs);
        const minus = button("− угол", "btn small", () => {
          if (sz.points.length > 3) sz.points.pop();
          refreshPanel();
          draw();
        });
        minus.disabled = sz.points.length <= 3;
        nodes.push(section("Выбранная зона", row(fs[0].root, fs[1].root), row(fs[2].root, fs[3].root),
          row(button("Прямоугольник", "btn small", () => {
            sz.points = rectOf(sz.points);
            refreshPanel();
            draw();
          }), minus),
          el("p", "hint-small", "Размер меняет зону целиком, сохраняя форму. Углы — тяните на плане.")));
      }

      // подложка
      const file = el("input");
      file.type = "file";
      file.accept = "image/*";
      file.hidden = true;
      file.addEventListener("change", async () => {
        const fl = file.files?.[0];
        if (!fl) return;
        try {
          const img = await createImageBitmap(fl);
          bg = img;
          bgBlob = fl;
          // ширину оставляем, глубину подгоняем под пропорции картинки
          if (img.width > 0 && img.height > 0) draft.depthM = Math.round(((draft.widthM * img.height) / img.width) * 10) / 10;
        } catch {
          void tell("Не удалось открыть картинку", "Выберите файл PNG, JPEG или WebP.");
        }
        refreshPanel();
        draw();
      });
      const bgNodes: Node[] = [row(button(bg ? "Заменить…" : "Выбрать план…", "btn small", () => file.click()),
        ...(bg ? [button("Убрать", "btn small", () => {
          bg = null;
          bgBlob = null;
          refreshPanel();
          draw();
        })] : [])), file];
      if (bg) {
        const op = el("input", "range");
        op.type = "range";
        op.min = "0.1";
        op.max = "1";
        op.step = "0.05";
        op.value = String(draft.backgroundOpacity);
        op.addEventListener("input", () => {
          draft.backgroundOpacity = Number(op.value);
          changed();
        });
        bgNodes.push(el("span", "field-label", "Яркость подложки"), op);
      }
      nodes.push(section("Подложка", ...bgNodes, el("p", "hint-small", "Картинка плана растягивается на весь план — подберите размеры под неё.")));
      panel.replaceChildren(...nodes);
      liveRefresh();
    }

    function addShop(): void {
      draft.shop = defaultShop(draft.widthM, draft.depthM).map(snap);
      selected = SHOP;
      refreshPanel();
      draw();
    }
    function addSpan(k: SpanKind): void {
      if (!hasShop(draft)) draft.shop = defaultShop(draft.widthM, draft.depthM).map(snap);
      const street = streetEdge(draft);
      if (street === null) return;
      const len = k === "showcase" ? 3 : 1.2;
      for (const e of [street, ...draft.shop.map((_, i) => i).filter((i) => i !== street)]) {
        const s = freeSpan(draft, e, len);
        if (s) {
          setSpans(k, [...spans(k), s]);
          selected = key(k, spans(k).length - 1);
          break;
        }
      }
      refreshPanel();
      draw();
    }
    function addStand(): void {
      let p = { x: draft.widthM / 2, y: draft.depthM * 0.8 };
      const e = streetEdge(draft);
      const n = e !== null ? outwardNormal(draft, e) : null;
      if (e !== null && n) {
        const w = pointOn(draft, e, [0.2, 0.5, 0.8][draft.stands.length % 3]);
        if (w) p = { x: w.x + n.x * 1.8, y: w.y + n.y * 1.8 };
      }
      const st = { id: newId(), pos: snap(p), angle: 0 };
      draft.stands.push(st);
      selected = st.id;
      refreshPanel();
      draw();
    }
    /** Новый стеллаж или витрина: в магазине (если есть), иначе посередине плана — на свободное место. */
    function addFixture(kind: FixtureKind): void {
      let center = { x: draft.widthM / 2, y: draft.depthM / 2 };
      let box = { x0: 0.5, x1: draft.widthM - 0.5, y0: 0.5, y1: draft.depthM - 0.5 };
      const shop = hasShop(draft);
      if (shop) {
        const xs = draft.shop.map((q) => q.x), ys = draft.shop.map((q) => q.y);
        center = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
        box = { x0: Math.min(...xs) + 0.8, x1: Math.max(...xs) - 0.8, y0: Math.min(...ys) + 0.8, y1: Math.max(...ys) - 0.8 };
      }
      const fx = newFixture(kind, snap(center));
      // ищем место, где не пересекается с другими
      const sx = fx.width + 0.9, sy = fx.depth + 1.2;
      search: for (let rr = 0; rr < 6; rr++) {
        for (let dy = -rr; dy <= rr; dy++) {
          for (let dx = -rr; dx <= rr; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== rr) continue;
            const p = { x: center.x + dx * sx, y: center.y + dy * sy };
            if (p.x < box.x0 || p.x > box.x1 || p.y < box.y0 || p.y > box.y1) continue;
            if (shop && !insideShop(draft, p)) continue;
            if (!draft.fixtures.some((q) => Math.hypot(q.pos.x - p.x, q.pos.y - p.y) < Math.max(sx, sy) * 0.8)) {
              fx.pos = snap(p);
              break search;
            }
          }
        }
      }
      draft.fixtures.push(fx);
      selected = fx.id;
      refreshPanel();
      changed();
    }
    function addZone(): void {
      const w = Math.min(3, draft.widthM / 3), h = Math.min(2, draft.depthM / 3);
      const n = draft.zones.length;
      const cx = draft.widthM / 2 + ((n % 3) - 1) * 0.6, cy = draft.depthM / 2 + (n % 2) * 0.6;
      const z = {
        id: newId(), name: `Зона ${n + 1}`, color: n % ZONE_COLORS.length,
        points: [{ x: cx - w / 2, y: cy - h / 2 }, { x: cx + w / 2, y: cy - h / 2 }, { x: cx + w / 2, y: cy + h / 2 }, { x: cx - w / 2, y: cy + h / 2 }].map(snap),
      };
      draft.zones.push(z);
      selected = z.id;
      refreshPanel();
      draw();
    }

    // ---------------------------------------------------------------- автосохранение (встроенный режим)
    let lastSaved = original;
    let saveTimer = 0;
    const cleaned = (): TwinPlan => {
      const p = structuredClone(draft);
      const c = (q: Pt) => ({ x: Math.min(Math.max(q.x, 0), p.widthM), y: Math.min(Math.max(q.y, 0), p.depthM) });
      p.zones.forEach((z, i) => {
        z.points = z.points.map(c);
        if (!z.name.trim()) z.name = `Зона ${i + 1}`;
      });
      p.shop = p.shop.map(c);
      for (const fx of p.fixtures) fx.pos = c(fx.pos);
      return p;
    };
    function autosave(): void {
      if (!inline) return;
      if (bgBlob !== undefined) {
        // подложка — сразу
        clearTimeout(saveTimer);
        lastSaved = JSON.stringify(draft);
        inline.onSave({ plan: cleaned(), background: bgBlob });
        bgBlob = undefined;
        return;
      }
      if (JSON.stringify(draft) === lastSaved) return;
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        if (drag) return autosave(); // тянем — сохраним, когда отпустим
        lastSaved = JSON.stringify(draft);
        inline.onSave({ plan: cleaned() });
      }, 500);
    }

    // ---------------------------------------------------------------- окно
    const form = el("form", "dialog-inner");
    form.addEventListener("submit", (e) => e.preventDefault());
    const head = el("div", "dialog-head");
    head.append(el("h2", undefined, "План и зоны"), button("✕", "icon-btn", () => dialog.close()));
    const body = el("div", "tw-editor-body");
    const left = el("div", "tw-editor-left");
    const hint = el("p", "hint-small faint", "Тяните угол — размер и форма · «+» на стороне — новый угол · тяните магазин, зону, витрину, дверь, штендер или камеру — перенос · белая ручка ↻ — поворот");
    left.append(canvas, hint);
    body.append(left, panel);
    const actions = el("div", "tw-actions");
    const saveBtn = button("Сохранить", "btn primary", () => {
      const p = draft;
      const c = (q: Pt) => ({ x: Math.min(Math.max(q.x, 0), p.widthM), y: Math.min(Math.max(q.y, 0), p.depthM) });
      p.zones.forEach((z, i) => {
        z.points = z.points.map(c);
        if (!z.name.trim()) z.name = `Зона ${i + 1}`;
      });
      p.shop = p.shop.map(c);
      result = { plan: p, ...(bgBlob !== undefined ? { background: bgBlob } : {}) };
      dialog.close();
    });
    actions.append(button("Отмена", "btn ghost", () => dialog.close()), saveBtn);
    form.append(head, body, actions);
    dialog.append(form);
    dialog.addEventListener("close", () => {
      ro.disconnect();
      dialog.remove();
      resolve(result);
    });
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    if (inline) {
      body.classList.add("tw-editor-inline");
      inline.container.replaceChildren(body);
      // контейнер очистили (шаг закрыт, план пересобран) — сохранить несохранённое и отключиться
      const mo = new MutationObserver(() => {
        if (body.isConnected) return;
        mo.disconnect();
        ro.disconnect();
        if (JSON.stringify(draft) !== lastSaved) {
          clearTimeout(saveTimer);
          inline.onSave({ plan: cleaned() });
        }
      });
      mo.observe(inline.container, { childList: true });
      refreshPanel();
      draw();
      resolve(null);
      return;
    }
    refreshPanel();
    dialog.showModal();
    draw();
  });
}

// ================================================================ привязка к плану (камера или видео)

/** Кадр для привязки: картинка, люди на нём (рамки в пикселях) и размер кадра. */
export interface StillFrame {
  image: CanvasImageSource | null;
  boxes: Box[];
  width: number;
  height: number;
}

export const HANDLE_COLORS = ["#ff6b6b", "#5bd97f", "#47d7f0", "#ffd23f"];

/**
 * Окно привязки. Возвращает привязку, null — «Убрать привязку», undefined — отмена.
 * still() вызывается при каждой перерисовке (для живой камеры кадр обновляется), onTick — раз в 400 мс.
 */
export function openCalibration(o: {
  title: string;
  plan: TwinPlan;
  background: ImageBitmap | null;
  initial: CameraCalibration | null;
  colorIndex: number;
  canRemove: boolean;
  still: () => StillFrame;
  message: () => string;
  /** Блок над привязкой (настройка камеры: «Где витрина»). */
  top?: HTMLElement;
  /** Подпись камеры на плане (псевдоним или название; читается при каждой перерисовке). */
  markName?: () => string;
  /** Цвет камеры, если его можно поменять в окне (читается при каждой перерисовке). */
  colorOf?: () => number;
  /** Зона витрины на кадре — 4 угла в долях кадра; двигаются на кадре, массив меняется на месте. */
  zone?: Pt[];
}): Promise<CameraCalibration | null | undefined> {
  return new Promise((resolve) => {
    const plan = o.plan;
    const dialog = el("dialog", "dialog tw-editor");
    document.body.append(dialog);
    // новая привязка — по сектору (камера на плане, поворот, угол, дальность); по полу — если в кадре виден пол
    const cal: CameraCalibration = structuredClone(o.initial ?? {
      ...initialCalibration(plan), mode: "sector", cameraPos: { x: plan.widthM / 2, y: plan.depthM - 0.5 }, cameraAngle: -Math.PI / 2, rangeM: 6,
    });
    // у старых привязок по сектору точек пола может не быть — подставляем по умолчанию
    if (cal.imagePts.length < 4 || cal.planPts.length < 4) {
      const d = initialCalibration(plan);
      if (cal.imagePts.length < 4) cal.imagePts = d.imagePts;
      if (cal.planPts.length < 4) cal.planPts = d.planPts;
    }
    let result: CameraCalibration | null | undefined = undefined;
    const colorIdx = () => o.colorOf?.() ?? o.colorIndex;
    const mark = () => cameraMark(o.markName?.() || "камера", colorIdx(), cal, plan);

    const imgCanvas = el("canvas", "tw-canvas");
    const planCanvas = el("canvas", "tw-canvas");
    let imgRect = { x: 0, y: 0, w: 1, h: 1 };
    let pf = new PlanFrame(plan, 600, 400);
    let dragImage: number | null = null;
    let dragPlan: number | null = null;

    // ---------------------------------------------------------------- кадр
    function drawImage(): void {
      const st = o.still();
      const W = st.width || 1280, H = st.height || 720;
      // высота окон — по пропорциям кадра (без чёрных полос), но в пределах экрана
      const pw = imgCanvas.parentElement?.clientWidth ?? 0;
      if (pw > 0) {
        const hh = `${Math.round(Math.max(240, Math.min(((pw - 24) * H) / W + 24, window.innerHeight - 330)))}px`;
        if (imgCanvas.style.height !== hh) {
          imgCanvas.style.height = hh;
          planCanvas.style.height = hh;
        }
      }
      const { ctx, w, h } = fitCanvas(imgCanvas);
      const k = Math.min((w - 24) / W, (h - 24) / H); // поле 12 px: ручки углов по краю кадра видны целиком
      imgRect = { x: (w - W * k) / 2, y: (h - H * k) / 2, w: W * k, h: H * k };
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      if (st.image) ctx.drawImage(st.image, imgRect.x, imgRect.y, imgRect.w, imgRect.h);
      else {
        ctx.fillStyle = C.dim;
        ctx.font = "500 13px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(o.message(), w / 2, h / 2);
      }
      const v = (p: Pt) => [imgRect.x + p.x * imgRect.w, imgRect.y + p.y * imgRect.h] as const;
      ctx.save();
      ctx.beginPath();
      ctx.rect(imgRect.x, imgRect.y, imgRect.w, imgRect.h);
      ctx.clip();
      const sector = isSector(cal);
      const H0 = calHomography(cal);
      const inv = !sector && calibrationValid(cal) && H0 ? hinverse(H0) : null;
      if (inv) {
        // сетка пола, зоны, стены, витрины и входы (план → кадр)
        const ref = hmap(inv, cal.planPts[0]).w >= 0 ? 1 : -1;
        const line = (a: Pt, b: Pt, c: string, lw: number) => {
          ctx.beginPath();
          let open = false;
          for (let i = 0; i <= 40; i++) {
            const t = i / 40;
            const r = hmap(inv, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
            if (!(r.w * ref > 1e-9) || Math.abs(r.pt.x) >= 5 || Math.abs(r.pt.y) >= 5) {
              open = false;
              continue;
            }
            if (open) ctx.lineTo(...v(r.pt));
            else {
              ctx.moveTo(...v(r.pt));
              open = true;
            }
          }
          ctx.strokeStyle = c;
          ctx.lineWidth = lw;
          ctx.stroke();
        };
        for (let x = 0; x <= plan.widthM + 0.001; x++) line({ x, y: 0 }, { x, y: plan.depthM }, "rgba(143, 227, 109, 0.55)", 1);
        for (let y = 0; y <= plan.depthM + 0.001; y++) line({ x: 0, y }, { x: plan.widthM, y }, "rgba(143, 227, 109, 0.55)", 1);
        for (const z of plan.zones) {
          if (z.points.length < 3) continue;
          const pts = [...z.points, z.points[0]];
          for (let i = 1; i < pts.length; i++) line(pts[i - 1], pts[i], zoneColor(z.color), 2);
        }
        for (const [a, b] of walls(plan)) line(a, b, "rgba(232, 238, 248, 0.85)", 2.5);
        for (const l of showcaseLines(plan)) line(l[0], l[1], C.showcase, 4);
        for (const l of doorLines(plan)) line(l[0], l[1], C.entrance, 4);
        for (const s of plan.stands) {
          const c = [...standCorners(s), standCorners(s)[0]];
          for (let i = 1; i < c.length; i++) line(c[i - 1], c[i], C.stand, 2);
        }
        for (const fx of plan.fixtures) {
          const c = [...fixtureCorners(fx), fixtureCorners(fx)[0]];
          for (let i = 1; i < c.length; i++) line(c[i - 1], c[i], fixtureColor(fx), 2);
        }
      }
      if (sector) {
        const proj = CameraProjector.create(cal, plan);
        if (st.width > 0 && proj?.sector) {
          const sx = imgRect.w / st.width, sy = imgRect.h / st.height;
          for (const b of st.boxes) {
            const r = { x: imgRect.x + b.x1 * sx, y: imgRect.y + b.y1 * sy, w: (b.x2 - b.x1) * sx, h: (b.y2 - b.y1) * sy };
            ctx.strokeStyle = "#ffd23f";
            ctx.lineWidth = 2;
            ctx.strokeRect(r.x, r.y, r.w, r.h);
            const q = proj.projectBox(b, st.width, st.height);
            if (q) dimLabel(ctx, `${fmt1(Math.hypot(q.x - proj.sector.pos.x, q.y - proj.sector.pos.y))} м`, r.x + r.w / 2, r.y + 12, "#ffd23f");
          }
        }
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(imgRect.x + imgRect.w / 2, imgRect.y);
        ctx.lineTo(imgRect.x + imgRect.w / 2, imgRect.y + imgRect.h);
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        if (st.width > 0) {
          for (const b of st.boxes) {
            const [x, y] = v({ x: (b.x1 + b.x2) / 2 / st.width, y: b.y2 / st.height });
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fillStyle = "#fff";
            ctx.fill();
          }
        }
        quad(ctx, cal.imagePts.map((p) => v(p)));
      }
      ctx.restore();
      if (o.zone) drawZone(ctx, o.zone.map((p) => v(p))); // ручки по краям кадра не обрезаются
    }

    /** Зона витрины: вне её кадр притемнён, по углам голубые ручки. */
    function drawZone(ctx: CanvasRenderingContext2D, pts: (readonly [number, number])[]): void {
      ctx.beginPath();
      ctx.rect(imgRect.x, imgRect.y, imgRect.w, imgRect.h);
      pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
      ctx.closePath();
      ctx.fillStyle = "rgba(5, 10, 30, 0.4)";
      ctx.fill("evenodd");
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
      ctx.closePath();
      ctx.strokeStyle = C.showcase;
      ctx.lineWidth = 2;
      ctx.stroke();
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], 7, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(5, 10, 30, 0.6)";
        ctx.fill();
        ctx.strokeStyle = C.showcase;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }

    function quad(ctx: CanvasRenderingContext2D, pts: (readonly [number, number])[]): void {
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
      ctx.closePath();
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      pts.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p[0], p[1], 10, 0, Math.PI * 2);
        ctx.fillStyle = HANDLE_COLORS[i];
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.font = "700 11px system-ui, sans-serif";
        ctx.fillStyle = "#000";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(i + 1), p[0], p[1] + 0.5);
      });
    }

    // ---------------------------------------------------------------- план
    const camKnob = (m: CameraMark) => {
      const [x, y] = pf.pt(m.position);
      return [x + 38 * Math.cos(m.angle), y + 38 * Math.sin(m.angle)] as const;
    };
    function drawPlan(): void {
      const { ctx, w, h } = fitCanvas(planCanvas);
      pf = new PlanFrame(plan, w, h);
      const m = mark();
      paintBase(ctx, plan, pf, o.background);
      if (m) paintCamera(ctx, m, pf, plan);
      paintZones(ctx, plan.zones, pf);
      paintFixtures(ctx, plan, pf);
      const st = o.still();
      const proj = CameraProjector.create(cal, plan);
      if (proj && st.width > 0) {
        for (const b of st.boxes) {
          const q = proj.projectBox(b, st.width, st.height);
          if (!q || q.x < -1 || q.y < -1 || q.x > plan.widthM + 1 || q.y > plan.depthM + 1) continue;
          const [x, y] = pf.pt(q);
          ctx.beginPath();
          ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.fillStyle = "#ffd23f";
          ctx.fill();
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      if (!isSector(cal)) quad(ctx, cal.planPts.map((p) => pf.pt(p)));
      if (m) {
        const [cx, cy] = pf.pt(m.position);
        const color = cameraColor(colorIdx());
        knob(ctx, cx, cy, ...camKnob(m), color);
        for (const p of [ray(m, m.angle, m.range), ray(m, m.angle - m.fov / 2, m.range), ray(m, m.angle + m.fov / 2, m.range)]) handle(ctx, ...pf.pt(p), color, false);
      }
    }

    const nearest = (pts: (readonly [number, number])[], x: number, y: number) => {
      let best = -1, bd = 22;
      pts.forEach((p, i) => {
        const d = Math.hypot(p[0] - x, p[1] - y);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      return best >= 0 ? best : null;
    };
    const localOf = (c: HTMLCanvasElement, e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };

    // ручки на кадре: 0..3 — точки пола (по полу), 4..7 — углы зоны витрины
    imgCanvas.addEventListener("pointerdown", (e) => {
      const [x, y] = localOf(imgCanvas, e);
      const px = (p: Pt) => [imgRect.x + p.x * imgRect.w, imgRect.y + p.y * imgRect.h] as const;
      const far = [-9999, -9999] as const;
      const pts = [...(isSector(cal) ? [far, far, far, far] : cal.imagePts.map(px)), ...(o.zone ?? []).map(px)];
      dragImage = nearest(pts, x, y);
      if (dragImage !== null) imgCanvas.setPointerCapture(e.pointerId);
    });
    imgCanvas.addEventListener("pointermove", (e) => {
      if (dragImage === null) return;
      const [x, y] = localOf(imgCanvas, e);
      const p = { x: Math.min(1, Math.max(0, (x - imgRect.x) / imgRect.w)), y: Math.min(1, Math.max(0, (y - imgRect.y) / imgRect.h)) };
      if (dragImage < 4) cal.imagePts[dragImage] = p;
      else if (o.zone) o.zone[dragImage - 4] = p;
      redraw();
    });
    imgCanvas.addEventListener("pointerup", () => (dragImage = null));

    planCanvas.addEventListener("pointerdown", (e) => {
      const [x, y] = localOf(planCanvas, e);
      const m = mark();
      // по сектору 4 точки не используются
      const pts: (readonly [number, number])[] = isSector(cal) ? [[-9999, -9999], [-9999, -9999], [-9999, -9999], [-9999, -9999]] : cal.planPts.map((p) => pf.pt(p));
      if (m) {
        pts.push(pf.pt(m.position), camKnob(m), pf.pt(ray(m, m.angle, m.range)), pf.pt(ray(m, m.angle - m.fov / 2, m.range)), pf.pt(ray(m, m.angle + m.fov / 2, m.range)));
      }
      dragPlan = nearest(pts, x, y);
      if (dragPlan !== null) planCanvas.setPointerCapture(e.pointerId);
    });
    planCanvas.addEventListener("pointermove", (e) => {
      if (dragPlan === null) return;
      const [x, y] = localOf(planCanvas, e);
      const q = pf.meters(x, y);
      const m = mark();
      const i = dragPlan;
      if (i >= 6 && m) {
        cal.cameraPos ??= m.position;
        cal.cameraAngle ??= m.angle;
        if (i === 6) cal.rangeM = Math.round(Math.min(40, Math.max(1, Math.min(Math.hypot(q.x - m.position.x, q.y - m.position.y), rayInside(m, m.angle) || 40))) * 10) / 10;
        else {
          let delta = Math.atan2(q.y - m.position.y, q.x - m.position.x) - m.angle;
          while (delta > Math.PI) delta -= 2 * Math.PI;
          while (delta < -Math.PI) delta += 2 * Math.PI;
          cal.fovDeg = Math.min(170, Math.max(20, Math.round((Math.abs(delta) * 2 * 180) / Math.PI / 5) * 5));
        }
      } else if (i === 5 && m) {
        const [cx, cy] = pf.pt(m.position);
        cal.cameraAngle = ((Math.round((Math.atan2(y - cy, x - cx) * 180) / Math.PI / 5) * 5) * Math.PI) / 180;
      } else if (i === 4) {
        cal.cameraPos = { x: round2(Math.min(Math.max(q.x, -0.8), plan.widthM + 0.8)), y: round2(Math.min(Math.max(q.y, -0.8), plan.depthM + 0.8)) };
      } else if (i < 4) {
        cal.planPts[i] = { x: round2(Math.min(Math.max(q.x, 0), plan.widthM)), y: round2(Math.min(Math.max(q.y, 0), plan.depthM)) };
      }
      redraw();
    });
    planCanvas.addEventListener("pointerup", () => (dragPlan = null));

    // ---------------------------------------------------------------- подписи и поля
    const modeSeg = el("div", "seg tw-mode");
    modeSeg.style.gridTemplateColumns = "repeat(2, 1fr)";
    for (const [v, t] of [["sector", "По сектору · без пола"], ["floor", "По полу · 4 точки"]] as const) {
      const label = el("label");
      const input = el("input");
      input.type = "radio";
      input.name = "tw-cal-mode";
      input.value = v;
      input.checked = (v === "sector") === isSector(cal);
      input.addEventListener("change", () => {
        if (!input.checked) return;
        if (v === "sector") {
          const mk = mark();
          cal.mode = "sector";
          cal.cameraPos ??= mk?.position ?? { x: plan.widthM / 2, y: plan.depthM - 0.5 };
          cal.cameraAngle ??= mk?.angle ?? -Math.PI / 2;
          cal.rangeM ??= 6;
        } else cal.mode = null;
        redraw();
      });
      label.append(input, el("span", undefined, t));
      modeSeg.append(label);
    }
    const explain = el("p", "hint-small");
    const coords = el("div", "tw-coords");
    const coordInputs: HTMLInputElement[][] = [];
    for (let i = 0; i < 4; i++) {
      const g = el("div", "tw-coord");
      const n = el("b", "tw-num", String(i + 1));
      n.style.background = HANDLE_COLORS[i];
      const ins = (["x", "y"] as const).map((k) => {
        const input = el("input", "input");
        input.type = "number";
        input.step = "0.05";
        input.addEventListener("change", () => {
          const val = parseFloat(input.value.replace(",", "."));
          if (Number.isFinite(val)) cal.planPts[i] = { ...cal.planPts[i], [k]: Math.min(k === "x" ? plan.widthM : plan.depthM, Math.max(0, val)) };
          redraw();
        });
        return input;
      });
      coordInputs.push(ins);
      g.append(n, el("span", "small faint", "X"), ins[0], el("span", "small faint", "Y"), ins[1], el("span", "small faint", "м"));
      coords.append(g);
    }
    const angleBox = el("label", "tw-coord");
    const angleIn = el("input", "input");
    angleIn.type = "number";
    angleIn.step = "5";
    angleIn.title = "Поворот камеры на плане, 0–360°";
    angleIn.addEventListener("change", () => {
      const val = parseFloat(angleIn.value);
      if (Number.isFinite(val)) cal.cameraAngle = (val * Math.PI) / 180;
      redraw();
    });
    angleBox.append(el("span", "small faint", "↻"), angleIn, el("span", "small faint", "°"));
    const warn = el("span", "tw-warn", "Точки пересекаются — расставьте по кругу");
    const autoBtn = button("Авто", "btn small", () => {
      cal.cameraPos = cal.cameraAngle = cal.fovDeg = cal.rangeM = null;
      redraw();
    }, "Место и поворот камеры — по привязке");

    function syncFields(): void {
      const sector = isSector(cal);
      explain.hidden = sector;
      explain.textContent = "Найдите в кадре 4 точки на полу, которые легко узнать на плане: углы плитки, ковра, разметки, основания стен. Поставьте цветные точки на кадре и те же точки на плане. Сетка пола на кадре должна лечь ровно. Значок камеры на плане перетащите туда, где она висит, а белой ручкой рядом поверните его куда смотрит камера.";
      coordInputs.forEach((ins, i) => {
        (ins[0].parentElement as HTMLElement).hidden = sector;
        if (document.activeElement !== ins[0]) ins[0].value = String(cal.planPts[i].x);
        if (document.activeElement !== ins[1]) ins[1].value = String(cal.planPts[i].y);
      });
      const valid = calibrationValid(cal);
      const untouched = floorPointsUntouched(cal);
      warn.textContent = !valid ? "Точки пересекаются — расставьте по кругу"
        : "Точки на кадре стоят по умолчанию — поставьте их на пол или выберите «По сектору» (если пола в кадре нет)";
      warn.hidden = sector || (valid && !untouched);
      angleBox.hidden = !sector && !valid;
      const m = mark();
      if (document.activeElement !== angleIn) angleIn.value = String(Math.round(((((m?.angle ?? 0) * 180) / Math.PI) % 360 + 360) % 360));
      autoBtn.hidden = sector || !valid || (cal.cameraPos == null && cal.cameraAngle == null && cal.fovDeg == null && cal.rangeM == null);
      saveBtn.disabled = !valid || untouched;
    }

    function redraw(): void {
      drawImage();
      drawPlan();
      syncFields();
    }

    // ---------------------------------------------------------------- окно
    const form = el("form", "dialog-inner");
    form.addEventListener("submit", (e) => e.preventDefault());
    const head = el("div", "dialog-head");
    head.append(el("h2", undefined, o.title), button("✕", "icon-btn", () => dialog.close()));
    const top = el("div", "tw-row tw-cal-top");
    top.append(modeSeg, el("span", "grow"));

    const panes = el("div", "tw-panes");
    const pane = (title: string, c: HTMLCanvasElement) => {
      const p = el("div", "tw-pane");
      p.append(el("p", "eyebrow", title), c);
      return p;
    };
    panes.append(pane(o.zone ? "Кадр · голубые углы — зона витрины" : "Кадр", imgCanvas), pane("План", planCanvas));
    coords.append(angleBox, warn, autoBtn);
    const actions = el("div", "tw-actions");
    const saveBtn = button("Сохранить", "btn primary", () => {
      result = structuredClone(cal);
      dialog.close();
    });
    actions.append(button("Отмена", "btn ghost", () => dialog.close()), saveBtn);
    form.append(head, ...(o.top ? [o.top] : []), top, explain, panes, coords, actions);
    dialog.append(form);
    const timer = window.setInterval(() => {
      drawImage();
      drawPlan();
    }, 400);
    const ro = new ResizeObserver(() => redraw());
    ro.observe(imgCanvas);
    ro.observe(planCanvas);
    dialog.addEventListener("close", () => {
      clearInterval(timer);
      ro.disconnect();
      dialog.remove();
      resolve(result);
    });
    dialog.showModal();
    redraw();
  });
}


