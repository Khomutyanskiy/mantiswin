// Живой цифровой двойник: раз в 0,2 с берёт людей со всех привязанных камер пилота, переводит на план,
// сливает одного человека с нескольких камер в одну точку, копит тепловую карту и заходы в зоны за день.
// Демо-режим — синтетические прохожие (в статистику дня не идут). Порт класса TwinModel (macOS).

import { type Pt, pointInPolygon } from "../engine/geometry";
import type { OverlayBox, PersonState } from "../engine/session";
import {
  CameraProjector, type CameraCalibration, type RecCameraRef, type RecFrame, type RecordingData, STATE_RANK, type TwinDayStats,
  type TwinPerson, type TwinPlan, clearPath, dayKey, defaultPlan, hasShop, heatIndex, insideShop,
  nearestWall, newDayStats, normalizePlan, obstacles, outwardNormal, planCell, planCols, planContains, planRows, pointOn,
  recPerson, floorPointsUntouched, standCorners, STAND_D, statsFit, zoneCentroid, fixtureAlong, fixtureCorners, fixtureFacing, insideObstacle,
} from "./plan";
import { blobImage, getBlob, loadJSON, putBlob, saveJSON } from "./store";

/** Камера, которая отдаёт людей на план (камера пилота). */
export interface TwinSource {
  id: string;
  title: string;
  isLive: boolean;
  last: { boxes: OverlayBox[]; width: number; height: number; at: number } | null;
}

/** Где хранится план, итоги дня и подложка. У раздела «Демо» — свои, чтобы не трогать план мониторинга. */
export interface TwinStorage {
  plan: string;
  stats: string;
  bg: string;
}
const LIVE_STORAGE: TwinStorage = { plan: "mantis.twin.plan.v1", stats: "mantis.twin.today.v1", bg: "twin:plan" };

interface Track {
  cam: string;
  pos: Pt;
  trail: Pt[];
  state: PersonState;
  lastSeen: number;
  zones: Set<string>;
  counted: boolean;
  speed: number | null;
}

interface Goal {
  point: Pt;
  pause: number;
  state: PersonState;
}
interface Walker {
  key: string;
  pos: Pt;
  goals: Goal[];
  path: Pt[];
  speed: number;
  pause: number;
  pausing: boolean;
  state: PersonState;
  slowFor: number;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const rint = (a: number, b: number) => Math.floor(rnd(a, b + 1));
const pick = <T>(a: T[]): T | undefined => a[Math.floor(Math.random() * a.length)];

export class TwinModel {
  plan: TwinPlan;
  /** Подложка плана (Blob — для записей, картинка — для рисования). */
  backgroundBlob: Blob | null = null;
  background: ImageBitmap | null = null;
  people: TwinPerson[] = [];
  occupancy: Record<string, number> = {};
  stats: TwinDayStats;
  heatMax = 0;
  demo = false;
  liveCameras = new Set<string>();
  recorder: { started: number; plan: TwinPlan; cameras: RecCameraRef[]; demo: boolean; frames: RecFrame[] } | null = null;

  private tracks = new Map<string, Track>();
  private projectors = new Map<string, CameraProjector>();
  private timer = 0;
  private lastTick = performance.now();
  private lastSave = 0;
  private dirty = false;
  private savedStats: TwinDayStats | null = null;
  private walkers: Walker[] = [];
  private walkerSeq = 0;
  private spawnIn = 0;
  private listeners = new Set<() => void>();

  private readonly keys: TwinStorage;

  constructor(private readonly sources: () => TwinSource[], storage: TwinStorage = LIVE_STORAGE) {
    this.keys = storage;
    const KEYS = storage;
    this.plan = normalizePlan(loadJSON<TwinPlan>(KEYS.plan) ?? defaultPlan());
    const today = dayKey(new Date());
    const s = loadJSON<TwinDayStats>(KEYS.stats);
    this.stats = s && s.day === today && statsFit(s, this.plan) ? s : newDayStats(today, this.plan);
    this.heatMax = Math.max(0, ...this.stats.heat);
    this.rebuildProjectors();
    void getBlob(storage.bg).then(async (b) => {
      this.backgroundBlob = b;
      this.background = await blobImage(b);
      this.emit();
    });
    window.addEventListener("pagehide", () => this.flush());
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Сбор раз в 0,2 с. Идёт всё время, пока открыта страница: тепло копится, даже если раздел закрыт. */
  start(): void {
    if (this.timer) return;
    this.lastTick = performance.now();
    this.timer = window.setInterval(() => this.tick(), 200);
  }

  /** Остановить такт (раздел «Демо», когда демо выключено). */
  stop(): void {
    clearInterval(this.timer);
    this.timer = 0;
  }

  // ---------------------------------------------------------------- план и привязки

  async savePlan(p: TwinPlan, background?: Blob | null): Promise<void> {
    const resized = !(planCols(p) === planCols(this.plan) && planRows(p) === planRows(this.plan) && Math.abs(planCell(p) - planCell(this.plan)) < 1e-9);
    this.plan = normalizePlan(structuredClone(p));
    this.persistPlan();
    if (background !== undefined) {
      this.backgroundBlob = background;
      this.background = await blobImage(background);
      await putBlob(this.keys.bg, background);
    }
    if (resized) {
      // клетки тепла поменялись — тепловая карта начинается заново, заходы в зоны сохраняются
      const s = newDayStats(this.stats.day, this.plan);
      s.visits = this.stats.visits;
      s.dwell = this.stats.dwell;
      s.peak = this.stats.peak;
      s.people = this.stats.people;
      if (this.demo) {
        this.savedStats = s;
        this.stats = newDayStats(this.stats.day, this.plan);
      } else this.stats = s;
      this.heatMax = 0;
    }
    const ids = new Set(this.plan.zones.map((z) => z.id));
    for (const t of this.tracks.values()) for (const z of [...t.zones]) if (!ids.has(z)) t.zones.delete(z);
    this.rebuildProjectors();
    this.save(true);
    this.emit();
  }

  setCalibration(c: CameraCalibration | null, cameraId: string): void {
    if (c) this.plan.calibrations[cameraId] = structuredClone(c);
    else delete this.plan.calibrations[cameraId];
    this.persistPlan();
    this.rebuildProjectors();
    for (const [k, t] of this.tracks) if (t.cam === cameraId) this.tracks.delete(k);
    this.emit();
  }

  calibration(id: string): CameraCalibration | null {
    return this.plan.calibrations[id] ?? null;
  }

  resetHeat(): void {
    this.stats.heat = new Array(this.stats.heat.length).fill(0);
    this.stats.visits = {};
    this.stats.dwell = {};
    this.stats.peak = this.people.length;
    this.stats.people = this.people.length;
    this.heatMax = 0;
    this.dirty = true;
    this.save(true);
    this.emit();
  }

  private persistPlan(): void {
    saveJSON(this.keys.plan, this.plan);
  }

  private rebuildProjectors(): void {
    this.projectors.clear();
    for (const [id, c] of Object.entries(this.plan.calibrations)) {
      if (floorPointsUntouched(c)) continue; // точки по полу не расставлены — людей на план не выводим
      const p = CameraProjector.create(c, this.plan);
      if (p) this.projectors.set(id, p);
    }
  }

  // ---------------------------------------------------------------- запись

  startRecording(cameras: RecCameraRef[]): void {
    this.recorder = { started: performance.now(), plan: structuredClone(this.plan), cameras, demo: this.demo, frames: [] };
    this.emit();
  }

  stopRecording(): { data: RecordingData; demo: boolean } | null {
    const r = this.recorder;
    this.recorder = null;
    this.emit();
    if (!r || r.frames.length <= 1) return null;
    return { data: { plan: r.plan, cameras: r.cameras, frames: r.frames }, demo: r.demo };
  }

  // ---------------------------------------------------------------- демо

  setDemo(on: boolean): void {
    if (on === this.demo) return;
    this.demo = on;
    this.tracks.clear();
    this.walkers = [];
    this.people = [];
    this.occupancy = {};
    if (on) {
      this.save(true);
      this.savedStats = this.stats;
      this.stats = newDayStats(this.stats.day, this.plan);
    } else {
      this.stats = this.savedStats ?? this.stats;
      this.savedStats = null;
    }
    this.heatMax = Math.max(0, ...this.stats.heat);
    this.emit();
  }

  // ---------------------------------------------------------------- такт

  private tick(): void {
    const now = performance.now();
    const dt = Math.min(1, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;
    this.rollDay();

    const obs: { key: string; cam: string; pos: Pt; state: PersonState }[] = [];
    const live = new Set<string>();
    if (this.demo) {
      for (const w of this.stepWalkers(dt)) obs.push({ key: w.key, cam: "demo", pos: w.pos, state: w.state });
    } else {
      for (const src of this.sources()) {
        const proj = this.projectors.get(src.id);
        const s = src.last;
        if (!proj || !src.isLive || !s || !(s.width > 0 && s.height > 0)) continue;
        live.add(src.id);
        for (const b of s.boxes) {
          const p = proj.projectBox(b.box, s.width, s.height);
          if (!p || !planContains(this.plan, p, 0.5)) continue;
          obs.push({
            key: `${src.id}#${b.trackId}`, cam: src.id,
            pos: { x: Math.min(Math.max(p.x, 0), this.plan.widthM), y: Math.min(Math.max(p.y, 0), this.plan.depthM) }, state: b.state,
          });
        }
      }
    }
    this.liveCameras = live;

    // треки: сглаживание положения и след
    for (const o of obs) {
      const t = this.tracks.get(o.key);
      if (t) {
        const k = 0.45;
        const old = t.pos;
        t.pos = { x: t.pos.x + (o.pos.x - t.pos.x) * k, y: t.pos.y + (o.pos.y - t.pos.y) * k };
        const sdt = (now - t.lastSeen) / 1000;
        if (sdt > 0.05) {
          const v = Math.hypot(t.pos.x - old.x, t.pos.y - old.y) / sdt;
          t.speed = t.speed === null ? v : t.speed + (v - t.speed) * 0.25;
        }
        const last = t.trail[t.trail.length - 1];
        if (!last || Math.hypot(last.x - t.pos.x, last.y - t.pos.y) >= 0.12) {
          t.trail.push(t.pos);
          if (t.trail.length > 50) t.trail.splice(0, t.trail.length - 50);
        }
        t.state = o.state;
        t.lastSeen = now;
      } else {
        this.tracks.set(o.key, { cam: o.cam, pos: o.pos, trail: [o.pos], state: o.state, lastSeen: now, zones: new Set(), counted: false, speed: null });
      }
    }
    for (const [k, t] of this.tracks) if (now - t.lastSeen >= 1500) this.tracks.delete(k);

    // слияние: один человек, видимый несколькими камерами, — одна точка
    const active = [...this.tracks].filter(([, t]) => now - t.lastSeen < 700).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const clusters: string[][] = [];
    const centers: Pt[] = [];
    for (const [key, t] of active) {
      let best = -1, bestD = 0.8;
      clusters.forEach((c, i) => {
        if (c.some((m) => this.tracks.get(m)?.cam === t.cam)) return;
        const d = Math.hypot(centers[i].x - t.pos.x, centers[i].y - t.pos.y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best >= 0) {
        const n = clusters[best].length;
        centers[best] = { x: (centers[best].x * n + t.pos.x) / (n + 1), y: (centers[best].y * n + t.pos.y) / (n + 1) };
        clusters[best].push(key);
      } else {
        clusters.push([key]);
        centers.push(t.pos);
      }
    }

    // тепло, зоны, люди
    const occ: Record<string, number> = {};
    const out: TwinPerson[] = [];
    const st = this.stats;
    clusters.forEach((members, i) => {
      const pos = centers[i];
      const ts = members.map((m) => this.tracks.get(m)!).filter(Boolean);
      if (!ts.some((t) => t.counted)) st.people += 1;
      for (const t of ts) t.counted = true;
      const idx = heatIndex(st, pos);
      if (idx < st.heat.length) {
        st.heat[idx] += dt;
        if (st.heat[idx] > this.heatMax) this.heatMax = st.heat[idx];
      }
      for (const z of this.plan.zones) {
        if (z.points.length < 3) continue;
        const inside = pointInPolygon(pos, z.points);
        const was = ts.some((t) => t.zones.has(z.id));
        if (inside) {
          occ[z.id] = (occ[z.id] ?? 0) + 1;
          st.dwell[z.id] = (st.dwell[z.id] ?? 0) + dt;
          if (!was) st.visits[z.id] = (st.visits[z.id] ?? 0) + 1;
          for (const t of ts) t.zones.add(z.id);
        } else for (const t of ts) t.zones.delete(z.id);
      }
      let lead = members[0];
      for (const m of members) if ((this.tracks.get(m)?.trail.length ?? 0) > (this.tracks.get(lead)?.trail.length ?? 0)) lead = m;
      const lt = this.tracks.get(lead);
      const state = ts.map((t) => t.state).reduce<PersonState>((a, s) => (STATE_RANK[s] > STATE_RANK[a] ? s : a), "tracked");
      out.push({ id: lead, pos, trail: [...(lt?.trail ?? []).slice(0, -1), pos], state, cameras: members.length, speed: lt?.speed ?? null });
    });
    if (out.length > st.peak) st.peak = out.length;
    if (clusters.length) this.dirty = true;
    this.people = out;
    if (this.recorder) this.recorder.frames.push({ t: (now - this.recorder.started) / 1000, p: out.map(recPerson) });
    this.occupancy = occ;
    this.save(false);
    this.emit();
  }

  // ---------------------------------------------------------------- хранение

  private rollDay(): void {
    const d = dayKey(new Date());
    if (d === this.stats.day) return;
    this.save(true);
    this.stats = newDayStats(d, this.plan);
    this.heatMax = 0;
    for (const t of this.tracks.values()) t.counted = false;
  }

  private save(force: boolean): void {
    if (this.demo || !(this.dirty || force)) return;
    if (!force && performance.now() - this.lastSave < 30_000) return;
    this.lastSave = performance.now();
    this.dirty = false;
    saveJSON(this.keys.stats, this.stats);
  }

  flush(): void {
    this.save(true);
  }

  // ---------------------------------------------------------------- демо-прохожие

  private stepWalkers(dt: number): Walker[] {
    const plan = this.plan;
    const obs = obstacles(plan);
    this.spawnIn -= dt;
    if (this.spawnIn <= 0 && this.walkers.length < 9) {
      this.spawnIn = rnd(1.2, 3.2);
      this.walkerSeq += 1;
      const start = this.streetPoint();
      if (start) {
        const goals = this.itinerary(start);
        this.walkers.push({
          key: `demo#${this.walkerSeq}`, pos: start, goals, path: goals[0] ? this.route(start, goals[0].point) : [],
          speed: rnd(0.9, 1.4), pause: 0, pausing: false, state: "tracked", slowFor: 0,
        });
      }
    }
    const keep: Walker[] = [];
    for (const w of this.walkers) {
      if (w.pausing) {
        w.pause -= dt;
        if (w.pause <= 0) {
          w.pausing = false;
          w.slowFor = 1.2;
          w.goals.shift();
          const g = w.goals[0];
          if (!g) continue;
          w.path = this.route(w.pos, g.point);
        } else {
          keep.push(w);
          continue;
        }
      }
      const target = w.path[0];
      if (!target) {
        const g = w.goals[0];
        if (g) {
          if (g.pause > 0) {
            w.pausing = true;
            w.pause = g.pause;
            w.state = g.state;
            keep.push(w);
            continue;
          }
          w.goals.shift();
          const next = w.goals[0];
          if (!next) continue; // ушёл с плана
          w.path = this.route(w.pos, next.point);
        }
        keep.push(w);
        continue;
      }
      const dx = target.x - w.pos.x, dy = target.y - w.pos.y;
      const d = Math.hypot(dx, dy);
      const nearStop = (w.goals[0]?.pause ?? 0) > 0 && w.path.length === 1 && d < 1.3;
      const slow = w.slowFor > 0 || nearStop;
      const step = w.speed * dt * (slow ? 0.45 : 1);
      let next = d <= step ? target : { x: w.pos.x + (dx / d) * step, y: w.pos.y + (dy / d) * step };
      if (!clearPath(plan, w.pos, next, obs)) {
        next = w.pos;
        const g = w.goals[0];
        if (g) w.path = this.route(w.pos, g.point);
      } else if (d <= step) w.path.shift();
      w.pos = next;
      w.slowFor -= dt;
      w.state = slow ? "slowed" : "tracked";
      keep.push(w);
    }
    this.walkers = keep;
    return keep;
  }

  /** Маршрут: сначала остановки (штендер, витрина, стеллажи в магазине), потом уход с плана. */
  private itinerary(start: Pt): Goal[] {
    const plan = this.plan;
    const exit = this.streetPoint(start) ?? start;
    const goals: Goal[] = [];
    if (!hasShop(plan)) {
      for (let i = rint(0, 2); i > 0; i--) {
        const f = plan.fixtures.length && Math.random() < 0.6 ? this.fixtureSpot(false) : null;
        goals.push({ point: f ?? this.randomTarget(), pause: rnd(2, 6), state: "looked" });
      }
      goals.push({ point: exit, pause: 0, state: "tracked" });
      return goals;
    }
    const r = Math.random();
    if (plan.stands.length && Math.random() < 0.35) {
      const s = this.standSpot();
      if (s) goals.push({ point: s, pause: rnd(1.5, 4), state: "looked" });
    }
    if (plan.fixtures.some((f) => !insideShop(plan, f.pos)) && Math.random() < 0.35) {
      const s = this.fixtureSpot(false);
      if (s) goals.push({ point: s, pause: rnd(2, 5), state: "looked" });
    }
    if (r > 0.3) {
      const s = this.showcaseSpot();
      if (s) goals.push({ point: s, pause: rnd(2, 6), state: "looked" });
    }
    if (r > 0.62 && plan.doors.length) {
      const hasInner = plan.fixtures.some((f) => insideShop(plan, f.pos));
      for (let i = rint(1, 3); i > 0; i--) {
        const p = hasInner && Math.random() < 0.7 ? this.fixtureSpot(true) ?? this.shopInteriorPoint() : this.shopInteriorPoint();
        if (p) goals.push({ point: p, pause: rnd(3, 8), state: "looked" });
      }
    }
    goals.push({ point: exit, pause: 0, state: "tracked" });
    return goals;
  }

  /** Путь a→b в обход стен: в магазин и из него — через дверь; по улице и внутри — вокруг здания,
   *  штендеров, стеллажей и витрин (кратчайший путь через их углы). */
  private route(a: Pt, b: Pt, depth = 0): Pt[] {
    const plan = this.plan;
    if (depth >= 3) return [b];
    const ia = insideShop(plan, a), ib = insideShop(plan, b);
    if (hasShop(plan) && ia !== ib) {
      const door = this.doorPoints(a, b);
      if (!door) return [];
      const first = ia ? door[1] : door[0], second = ia ? door[0] : door[1];
      return [...this.route(a, first, depth + 1), second, ...this.route(second, b, depth + 1)];
    }
    const obs = obstacles(plan);
    if (clearPath(plan, a, b, obs)) return [b];
    return this.detour(a, b, ia, obs) ?? [b];
  }

  /** Обход препятствий по углам (граф видимости, Дейкстра). */
  private detour(a: Pt, b: Pt, inside: boolean, obs: [Pt, Pt][]): Pt[] | null {
    const plan = this.plan;
    let nodes: Pt[] = [];
    if (!inside && hasShop(plan)) {
      const xs = plan.shop.map((q) => q.x), ys = plan.shop.map((q) => q.y), m = 0.7;
      const x0 = Math.min(...xs) - m, x1 = Math.max(...xs) + m, y0 = Math.min(...ys) - m, y1 = Math.max(...ys) + m;
      nodes.push({ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 });
      for (const p of plan.shop) for (const dx of [-0.6, 0.6]) for (const dy of [-0.6, 0.6]) nodes.push({ x: p.x + dx, y: p.y + dy });
    }
    nodes.push(...plan.stands.flatMap((s) => standCorners(s, 0.45)), ...plan.fixtures.flatMap((f) => fixtureCorners(f, 0.45)));
    nodes = nodes.filter((q) => planContains(plan, q, 0.3) && insideShop(plan, q) === inside && !insideObstacle(plan, q, 0.25)
      && (!inside || (nearestWall(plan, q)?.dist ?? 9) > 0.25));
    const all = [a, ...nodes, b];
    const n = all.length, goal = n - 1;
    const dist = new Array<number>(n).fill(Infinity), prev = new Array<number>(n).fill(-1), done = new Array<boolean>(n).fill(false);
    dist[0] = 0;
    for (let it = 0; it < n; it++) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || u === goal) break;
      done[u] = true;
      for (let v = 0; v < n; v++) {
        if (done[v] || v === u) continue;
        const w = Math.hypot(all[v].x - all[u].x, all[v].y - all[u].y);
        if (dist[u] + w >= dist[v] || !clearPath(plan, all[u], all[v], obs)) continue;
        dist[v] = dist[u] + w;
        prev[v] = u;
      }
    }
    if (prev[goal] < 0) return null;
    const path: Pt[] = [];
    for (let c = goal; c > 0; c = prev[c]) path.push(all[c]);
    return path.reverse();
  }

  private doorPoints(a: Pt, b: Pt): [Pt, Pt] | null {
    let best: [Pt, Pt, number] | null = null;
    for (const d of this.plan.doors) {
      const n = outwardNormal(this.plan, d.edge), c = pointOn(this.plan, d.edge, (d.t0 + d.t1) / 2);
      if (!n || !c) continue;
      const out = { x: c.x + n.x * 0.7, y: c.y + n.y * 0.7 }, inn = { x: c.x - n.x * 0.7, y: c.y - n.y * 0.7 };
      const cost = Math.hypot(c.x - a.x, c.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y);
      if (!best || cost < best[2]) best = [out, inn, cost];
    }
    return best ? [best[0], best[1]] : null;
  }

  private showcaseSpot(): Pt | null {
    const s = pick(this.plan.showcases);
    if (!s) return null;
    const n = outwardNormal(this.plan, s.edge), p = pointOn(this.plan, s.edge, rnd(s.t0, s.t1));
    if (!n || !p) return null;
    const k = rnd(0.6, 1);
    const q = { x: p.x + n.x * k, y: p.y + n.y * k };
    return planContains(this.plan, q) && !insideObstacle(this.plan, q) ? q : null;
  }

  private standSpot(): Pt | null {
    const st = pick(this.plan.stands);
    if (!st) return null;
    const side = Math.random() < 0.5 ? 1 : -1;
    const k = STAND_D / 2 + rnd(0.5, 0.8);
    const q = { x: st.pos.x - Math.sin(st.angle) * side * k, y: st.pos.y + Math.cos(st.angle) * side * k };
    return planContains(this.plan, q) && !insideShop(this.plan, q) && !insideObstacle(this.plan, q) ? q : null;
  }

  /** Остановиться у стеллажа или витрины: перед лицевой стороной (у стеллажа — с любой стороны). */
  private fixtureSpot(inside: boolean): Pt | null {
    const plan = this.plan, shop = hasShop(plan);
    const list = plan.fixtures.filter((f) => !shop || insideShop(plan, f.pos) === inside);
    for (let i = 0; i < 8; i++) {
      const fx = pick(list);
      if (!fx) return null;
      const side = fx.kind === "showcase" ? 1 : Math.random() < 0.5 ? 1 : -1;
      const n = fixtureFacing(fx), u = fixtureAlong(fx);
      const k = fx.depth / 2 + rnd(0.45, 0.75), off = rnd(-0.4, 0.4) * fx.width;
      const q = { x: fx.pos.x + n.x * k * side + u.x * off, y: fx.pos.y + n.y * k * side + u.y * off };
      if (!planContains(plan, q, -0.2) || insideObstacle(plan, q, 0.12)) continue;
      if (shop) {
        if (insideShop(plan, q) !== inside) continue;
        if (inside && (nearestWall(plan, q)?.dist ?? 9) < 0.3) continue;
      }
      return q;
    }
    return null;
  }

  private shopInteriorPoint(): Pt | null {
    const plan = this.plan;
    const roomy = (p: Pt) => insideShop(plan, p) && (nearestWall(plan, p)?.dist ?? 0) > 0.45 && !insideObstacle(plan, p, 0.3);
    const inner = plan.zones.filter((z) => z.points.length >= 3 && insideShop(plan, zoneCentroid(z)));
    const z = pick(inner);
    if (z && Math.random() < 0.75) {
      const c = zoneCentroid(z);
      for (let i = 0; i < 15; i++) {
        const p = { x: c.x + rnd(-0.6, 0.6), y: c.y + rnd(-0.6, 0.6) };
        if (pointInPolygon(p, z.points) && roomy(p)) return p;
      }
    }
    const xs = plan.shop.map((q) => q.x), ys = plan.shop.map((q) => q.y);
    for (let i = 0; i < 40; i++) {
      const p = { x: rnd(Math.min(...xs), Math.max(...xs)), y: rnd(Math.min(...ys), Math.max(...ys)) };
      if (roomy(p)) return p;
    }
    return null;
  }

  /** Точка на краю плана снаружи магазина (откуда приходят и куда уходят). */
  private streetPoint(awayFrom?: Pt): Pt | null {
    const plan = this.plan, W = plan.widthM, D = plan.depthM;
    let best: Pt | null = null;
    for (let i = 0; i < 30; i++) {
      const side = rint(0, 3);
      const p = side === 0 ? { x: 0, y: rnd(0, D) } : side === 1 ? { x: W, y: rnd(0, D) } : side === 2 ? { x: rnd(0, W), y: D } : { x: rnd(0, W), y: 0 };
      if (insideShop(plan, p) || insideObstacle(plan, p, 0.4) || (nearestWall(plan, p)?.dist ?? 9) <= 0.4) continue;
      if (!awayFrom) return p;
      const d = Math.hypot(p.x - awayFrom.x, p.y - awayFrom.y);
      if (d > Math.max(W, D) * 0.5) return p;
      if (!best || d > Math.hypot(best.x - awayFrom.x, best.y - awayFrom.y)) best = p;
    }
    return best;
  }

  private randomTarget(): Pt {
    const W = this.plan.widthM, D = this.plan.depthM;
    const zones = this.plan.zones.filter((z) => z.points.length >= 3);
    const z = pick(zones);
    if (z && Math.random() < 0.7) {
      const c = zoneCentroid(z);
      for (let i = 0; i < 12; i++) {
        const p = { x: c.x + rnd(-0.8, 0.8), y: c.y + rnd(-0.8, 0.8) };
        if (pointInPolygon(p, z.points)) return p;
      }
      return c;
    }
    return { x: rnd(W * 0.15, W * 0.85), y: rnd(D * 0.15, D * 0.85) };
  }
}


