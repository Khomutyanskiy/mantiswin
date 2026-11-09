// Живой цифровой двойник в Firebase — как TwinPublisher.swift + SiteCloud.swift в iOS-приложении.
// Личный кабинет (cabinet.html) подписывается на эти данные и показывает точку в реальном времени.
//
// Realtime Database (только владелец, правило auth.uid == $uid), раз в секунду перезаписывается:
//   live/{uid}/{siteId}
//     meta:    { device, deviceName, platform: "web", app, status: "counting" | "idle" | "offline", point, planAt, ts }
//     today:   { people, slowed, looked, entered, turned }           — все камеры за сегодня
//     cameras: { camId: { name, kind, on, live, onPlan, fps, inFrame, w, h, today: {…} } }
//     people:  { camId: { "n12": [u, v, x, z, s, look] } }            — u, v — ноги в кадре (0…1); x, z — на полу от камеры, м
//     plan:    { id: [x, y, s, камер] }                               — люди на плане точки, м (один человек с нескольких камер — одна точка)
//   presence/{uid}/{siteId}/{deviceId}: { name, platform, since }      — само удаляется при обрыве связи
//
// Firestore (как у кабинета):
//   users/{uid}/sites/{siteId}                 — { name, planJSON, updatedAt }  план точки: в вебе он свой, синхронизируется в обе стороны
//   users/{uid}/sites/{siteId}/cameras/{camId} — реестр камер (пишется при изменениях)
//   users/{uid}/sites/{siteId}/assets/background — подложка плана (JPEG base64)
//
// Видео и лица никуда не отправляются — только координаты и счётчики.

import { type Database, type Unsubscribe as DbUnsubscribe, onDisconnect, onValue, ref, serverTimestamp as rtdbTime, set, update } from "firebase/database";
import { twinDatabase } from "./rtdb";
import { type Unsubscribe, doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import pkg from "../../package.json";
import { desktopShell } from "../desktop";
import { type MultiPilot, desktopDeviceId } from "../multi/model";
import { channelColorIndex, channelLabel, channelShort } from "../multi/channel";
import type { HourStat } from "../pilot/hours";
import {
  FIXTURE_KINDS, STATE_CODE, type TwinPlan, cameraColor, cameraMark, hasShop, insideShop, normalizePlan, spanPoints, zoneColor,
} from "../twin/plan";
import type { TwinModel } from "../twin/model";
import type { Account } from "./account";
import type { DemoSnapshot } from "../demo";
import { firestore, friendlyError } from "./firebase";

export { TWIN_DB_URL } from "./rtdb";
const KEYS = { enabled: "twin.publish.enabled", site: "twin.siteID", planAt: "twin.cloud.planAt", backup: "twin.plan.beforeCloud" };
const PERSON_H = 1.7;
const FOV = (70 * Math.PI) / 180;

export type TwinCloudState =
  | { kind: "off" }
  | { kind: "signedOut" }
  | { kind: "sending"; at: Date; people: number; demo: boolean }
  /** На точке сейчас передаёт другое устройство (например, iPhone с демо) — этот компьютер его не перебивает. */
  | { kind: "standby"; other: string }
  | { kind: "error"; text: string };

function get(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function put(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* нет */
  }
}

/** Ключи Realtime Database не могут содержать . # $ [ ] / */
export const safeKey = (s: string) => s.replace(/[.#$[\]/]/g, "_");
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const statDict = (h: HourStat) => ({ people: h.people, slowed: h.slowed, looked: h.looked, entered: h.entered, turned: 0 });

export class TwinPublisher {
  state: TwinCloudState = { kind: "off" };
  private listeners = new Set<(s: TwinCloudState) => void>();
  private db: Database | null = null;
  private presenceKey: string | null = null;
  private writing = false;
  private registry = new Map<string, string>();
  // план: облако ↔ этот компьютер
  private siteUnsub: Unsubscribe | null = null;
  private siteKey: string | null = null;
  private cloud: { json: string | null; at: number } | null = null;
  private knownJSON: string;
  private pushedJSON: string | null = null;
  private pushedBg: Blob | null | undefined = undefined;
  private pushedCams: string | null = null;
  private pushing = false;
  /** Кто последним писал состояние точки (если не мы) и когда это видели. */
  private other: { device: string; name: string; active: boolean; online: boolean; at: number } | null = null;
  private metaUnsub: DbUnsubscribe | null = null;
  private wroteLast = false;
  /** План демо, уже лежащий в облаке (JSON) — шлём только при изменении, как iPhone. */
  private sentDemoPlan: string | null = null;

  constructor(private readonly o: {
    account: Account;
    pilot: MultiPilot;
    twin: TwinModel;
    deviceName: () => string;
    /** План пришёл из кабинета — перерисовать экраны. */
    onPlanFromCloud: () => void;
    /** Демо на этом компьютере (раздел «Демо»): идёт — в облако уходит демо, как с iPhone. */
    demo?: () => DemoSnapshot | null;
  }) {
    this.knownJSON = JSON.stringify(o.twin.plan);
    setInterval(() => void this.tick(), 1000);
    window.addEventListener("pagehide", () => this.goOffline());
  }

  get enabled(): boolean {
    return get(KEYS.enabled) !== "0";
  }
  set enabled(v: boolean) {
    put(KEYS.enabled, v ? "1" : "0");
    if (!v) this.goOffline();
    void this.tick();
  }

  /** Код точки (по умолчанию main) — как в iOS: на каждом магазине свой. */
  get siteId(): string {
    const s = (get(KEYS.site) ?? "").trim();
    return s ? safeKey(s) : "main";
  }
  set siteId(v: string) {
    this.goOffline();
    put(KEYS.site, v.trim());
    void this.tick();
  }

  subscribe(fn: (s: TwinCloudState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }
  private setState(s: TwinCloudState): void {
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }

  /** Выключили передачу, вышли или закрыли страницу — точка в кабинете «не на связи». */
  goOffline(): void {
    const k = this.presenceKey;
    if (!k || !this.db) return;
    const [uid, site] = k.split("/");
    void set(ref(this.db, `presence/${uid}/${site}/${desktopDeviceId()}`), null).catch(() => undefined);
    // «не на связи» ставим, только если состояние точки писали мы, — не гасим iPhone или другой компьютер
    if (this.wroteLast && !this.otherActive()) {
      void update(ref(this.db, `live/${uid}/${site}/meta`), { status: "offline", ts: rtdbTime() }).catch(() => undefined);
    }
    this.metaUnsub?.();
    this.metaUnsub = null;
    this.other = null;
    this.wroteLast = false;
    this.sentDemoPlan = null;
    this.presenceKey = null;
    this.stopSite();
  }

  // ---------------------------------------------------------------- раз в секунду

  private async tick(): Promise<void> {
    if (!this.enabled) {
      if (this.state.kind !== "off") this.setState({ kind: "off" });
      return;
    }
    const uid = this.o.account.uid;
    if (!uid) {
      if (this.presenceKey) this.goOffline();
      if (this.state.kind !== "signedOut") this.setState({ kind: "signedOut" });
      return;
    }
    const site = this.siteId;
    try {
      this.db ??= twinDatabase();
      if (this.presenceKey !== `${uid}/${site}`) await this.setPresence(uid, site);
      this.watchSite(uid, site);
      this.syncPlan(uid, site);
      this.updateRegistry(uid, site);
    } catch (e) {
      this.setState({ kind: "error", text: describe(e) });
      return;
    }
    const demo = this.o.demo?.() ?? null;
    // здесь ничего не идёт, а точку только что передавало другое устройство (iPhone, другой компьютер) — молчим:
    // иначе два устройства по очереди перезаписывают точку и в кабинете всё «передёргивается»
    if (!demo && !this.o.pilot.running && this.otherRecent()) {
      this.wroteLast = false;
      this.sentDemoPlan = null;
      this.setState({ kind: "standby", other: this.other!.name });
      return;
    }
    if (this.writing) return; // прошлая запись ещё не подтверждена — не копим очередь
    this.writing = true;
    const { payload, people } = demo ? this.demoPayload(demo) : this.payload();
    // план демо (несколько КБ) — только когда поменялся; вышли из демо — убираем
    const demoJSON = demo ? JSON.stringify(demo.plan) : null;
    if (demoJSON !== this.sentDemoPlan) payload.demoPlan = demoJSON;
    try {
      // update: каждая часть заменяется целиком, план демо остаётся, пока не поменяется (как iPhone)
      await update(ref(this.db, `live/${uid}/${site}`), payload);
      this.sentDemoPlan = demoJSON;
      this.wroteLast = true;
      this.setState({ kind: "sending", at: new Date(), people, demo: !!demo });
    } catch (e) {
      this.sentDemoPlan = null;
      this.setState({ kind: "error", text: describe(e) });
    } finally {
      this.writing = false;
    }
  }

  /** Другое устройство обновляло точку за последние 5 с (на связи, считает или нет). */
  private otherRecent(): boolean {
    const o = this.other;
    return !!o && o.online && Date.now() - o.at < 5000;
  }

  /** Другое устройство передаёт состояние точки прямо сейчас (обновлялось за последние 5 с и что-то считает). */
  private otherActive(): boolean {
    const o = this.other;
    return !!o && o.active && Date.now() - o.at < 5000;
  }

  /** Демо → облако: придуманные прохожие на плане демо, камеры демо и счётчики с запуска (как makeDemoPayload в iOS). */
  private demoPayload(d: DemoSnapshot): { payload: Record<string, unknown>; people: number } {
    const today = { people: d.counts.passed, slowed: d.counts.slowed, looked: d.counts.looked, entered: d.counts.entered, turned: 0 };
    const plan: Record<string, unknown> = {};
    for (const q of d.people) plan[safeKey(q.id)] = [r2(q.pos.x), r2(q.pos.y), STATE_CODE[q.state], 1];
    const cameras: Record<string, unknown> = {};
    for (const c of d.cameras) {
      cameras[safeKey(c.id)] = { name: c.name, kind: "demo", on: true, live: true, onPlan: true, fps: 15, inFrame: c.inFrame, today };
    }
    const p = this.o.account.state.profile;
    return {
      payload: {
        meta: {
          device: desktopDeviceId(), deviceName: this.o.deviceName(), platform: desktopShell ?? "web", app: pkg.version,
          status: "counting", demo: true, point: p.point || p.name || "", ts: rtdbTime(),
        },
        today,
        cameras: Object.keys(cameras).length ? cameras : null,
        people: null,
        plan: Object.keys(plan).length ? plan : null,
      },
      people: d.people.length,
    };
  }

  private async setPresence(uid: string, site: string): Promise<void> {
    if (this.presenceKey) this.goOffline();
    const db = this.db!;
    const pres = ref(db, `presence/${uid}/${site}/${desktopDeviceId()}`);
    await onDisconnect(pres).remove();
    await set(pres, { name: this.o.deviceName(), platform: desktopShell ?? "web", since: rtdbTime() });
    await onDisconnect(ref(db, `live/${uid}/${site}/meta`)).update({ status: "offline", ts: rtdbTime() });
    this.presenceKey = `${uid}/${site}`;
    // кто сейчас пишет состояние точки: если не мы и он активен — молчим, пока здесь ничего не идёт
    this.metaUnsub?.();
    this.metaUnsub = onValue(ref(db, `live/${uid}/${site}/meta`), (snap) => {
      const m = snap.val() as { device?: string; deviceName?: string; status?: string } | null;
      if (!m || m.device === desktopDeviceId()) return;
      this.other = {
        device: m.device ?? "", name: m.deviceName ?? "другое устройство", active: m.status === "counting", online: m.status !== "offline", at: Date.now(),
      };
    }, () => undefined);
  }

  // ---------------------------------------------------------------- снимок точки

  private payload(): { payload: Record<string, unknown>; people: number } {
    const pilot = this.o.pilot, twin = this.o.twin;
    const cameras: Record<string, unknown> = {};
    const people: Record<string, unknown> = {};
    let total = 0;
    for (const ch of pilot.channels) {
      const key = safeKey(ch.id);
      const last = ch.last;
      let inFrame = 0;
      if (ch.isCounting && last && last.width > 0 && last.height > 0) {
        const W = last.width, H = last.height;
        const f = W / 2 / Math.tan(FOV / 2);
        const list: Record<string, unknown> = {};
        for (const b of last.boxes) {
          if (!b.inZone) continue;
          const fx = (b.box.x1 + b.box.x2) / 2, fy = b.box.y2;
          const z = (f * PERSON_H) / Math.max(b.box.y2 - b.box.y1, 1);
          const x = ((fx - W / 2) * z) / f;
          list[`n${b.trackId}`] = [r3(fx / W), r3(fy / H), r2(x), r2(z), STATE_CODE[b.state], b.lookingNow ? 1 : 0];
        }
        inFrame = Object.keys(list).length;
        if (inFrame) people[key] = list;
      }
      total += inFrame;
      const c: Record<string, unknown> = {
        name: channelLabel(ch.config), kind: ch.config.kind === "ip" ? "ip" : "usb", on: ch.isCounting, live: ch.isLive,
        onPlan: !!twin.plan.calibrations[ch.id], inFrame, today: statDict(pilot.todayFor(ch.id)),
      };
      if (ch.isCounting) {
        c.fps = r1(ch.fps);
        if (last) {
          c.w = last.width;
          c.h = last.height;
        }
      }
      cameras[key] = c;
    }
    const p = this.o.account.state.profile;
    const payload: Record<string, unknown> = {
      meta: {
        device: desktopDeviceId(), deviceName: this.o.deviceName(), platform: desktopShell ?? "web", app: pkg.version,
        status: pilot.running ? "counting" : "idle", demo: false, point: p.point || p.name || "", planAt: this.cloud?.at ?? 0, ts: rtdbTime(),
      },
      today: statDict(pilot.today()),
    };
    // update() заменяет части целиком: пустые — null, чтобы не остались прежние (например, от демо)
    payload.cameras = Object.keys(cameras).length ? cameras : null;
    payload.people = Object.keys(people).length ? people : null;
    // люди на плане точки: двойник уже слил одного человека с нескольких камер в одну точку
    const plan: Record<string, unknown> = {};
    if (pilot.running) for (const q of twin.people) plan[safeKey(q.id)] = [r2(q.pos.x), r2(q.pos.y), STATE_CODE[q.state], q.cameras];
    payload.plan = Object.keys(plan).length ? plan : null;
    return { payload, people: total };
  }

  // ---------------------------------------------------------------- план и камеры в Firestore

  private stopSite(): void {
    this.siteUnsub?.();
    this.siteUnsub = null;
    this.siteKey = null;
    this.cloud = null;
    this.pushedJSON = null;
    this.pushedCams = null;
    this.pushedBg = undefined;
    this.registry.clear();
  }

  private watchSite(uid: string, site: string): void {
    const key = `${uid}/${site}`;
    if (this.siteKey === key) return;
    this.stopSite();
    this.siteKey = key;
    const p = this.o.account.state.profile;
    // точка появляется в кабинете сразу, даже если плана ещё нет
    void setDoc(doc(firestore(), "users", uid, "sites", site), { name: p.point || site, seenAt: serverTimestamp() }, { merge: true }).catch(() => undefined);
    this.siteUnsub = onSnapshot(doc(firestore(), "users", uid, "sites", site), (snap) => {
      const d = snap.data();
      this.cloud = { json: typeof d?.planJSON === "string" ? d.planJSON : null, at: typeof d?.updatedAt === "number" ? d.updatedAt : 0 };
    }, () => undefined);
  }

  /** План: правили здесь — уходит в облако; правили в кабинете (позже, чем здесь) — приходит сюда. */
  private syncPlan(uid: string, site: string): void {
    const cloud = this.cloud;
    if (!cloud || this.pushing) return; // ждём первый ответ облака
    const twin = this.o.twin;
    const json = JSON.stringify(twin.plan);
    let localAt = Number(get(KEYS.planAt) ?? 0) || 0;
    const cams = this.cameraInfo();
    const camSig = JSON.stringify(cams);
    if (json !== this.knownJSON) {
      this.knownJSON = json;
      localAt = Date.now();
      put(KEYS.planAt, String(localAt));
    }
    // первый раз: размеченный здесь план главнее облачного — он уходит в Firebase
    const marked = twin.plan.shop.length || twin.plan.zones.length || twin.plan.stands.length || (twin.plan.fixtures ?? []).length
      || Object.keys(twin.plan.calibrations).length;
    if (!localAt && marked) {
      localAt = Date.now();
      put(KEYS.planAt, String(localAt));
    }
    if (cloud.json && cloud.at > localAt && cloud.json !== json) {
      // из кабинета: подложка у плана остаётся своя. Первый раз — свой план сохраняем на всякий случай
      if (marked) put(KEYS.backup, json);
      let plan: TwinPlan;
      try {
        plan = normalizePlan(JSON.parse(cloud.json) as Partial<TwinPlan>);
      } catch {
        return;
      }
      this.pushing = true;
      void twin.savePlan(plan).then(() => {
        this.knownJSON = JSON.stringify(twin.plan);
        this.pushedJSON = this.knownJSON + camSig;
        this.pushedCams = camSig;
        put(KEYS.planAt, String(cloud.at));
        this.o.onPlanFromCloud();
      }).finally(() => (this.pushing = false));
      return;
    }
    const sig = json + camSig;
    if ((json !== cloud.json || camSig !== this.pushedCams) && sig !== this.pushedJSON) {
      const at = Math.max(localAt, Date.now());
      this.pushing = true;
      this.pushedJSON = sig;
      // planJSON — для кабинета и iPhone (TwinPlan целиком); layout — та же разметка полями: видно в консоли Firebase
      void setDoc(doc(firestore(), "users", uid, "sites", site),
        { planJSON: json, layout: layoutOf(twin.plan, cams), updatedAt: at }, { merge: true })
        .then(() => {
          put(KEYS.planAt, String(at));
          this.pushedCams = camSig;
          // снимок облака мог прийти раньше подтверждения — не затираем более новый
          if (!this.cloud || this.cloud.at <= at) this.cloud = { json, at };
        })
        .catch(() => (this.pushedJSON = null))
        .finally(() => (this.pushing = false));
    }
    // подложка плана — тоже в кабинет
    const bg = twin.backgroundBlob;
    if (bg !== this.pushedBg) {
      this.pushedBg = bg;
      void pushBackground(uid, site, bg).catch(() => (this.pushedBg = undefined));
    }
  }

  /** Камеры этого компьютера для разметки: название, псевдоним, цвет, тип. */
  private cameraInfo(): CamInfo[] {
    return this.o.pilot.channels.map((ch, i) => ({
      id: ch.id, name: channelLabel(ch.config), short: channelShort(ch.config), colorIndex: channelColorIndex(ch.config, i),
      kind: ch.config.kind === "ip" ? "ip" : "usb", direction: ch.config.direction,
    }));
  }

  /** Реестр камер точки: кабинет видит камеры этого компьютера (пишется только при изменениях). */
  private updateRegistry(uid: string, site: string): void {
    for (const ch of this.o.pilot.channels) {
      const w = ch.last?.width ?? 0, h = ch.last?.height ?? 0;
      const kind = ch.config.kind === "ip" ? "ip" : "usb";
      const name = channelLabel(ch.config);
      const sig = `${name}|${kind}|${w}x${h}`;
      if (this.registry.get(ch.id) === sig) continue;
      this.registry.set(ch.id, sig);
      const d: Record<string, unknown> = {
        name, kind, device: desktopDeviceId(), deviceName: this.o.deviceName(), platform: desktopShell ?? "web", updatedAt: serverTimestamp(),
      };
      if (w > 0 && h > 0) {
        d.width = w;
        d.height = h;
      }
      void setDoc(doc(firestore(), "users", uid, "sites", site, "cameras", ch.id), d, { merge: true }).catch(() => this.registry.delete(ch.id));
    }
  }
}

interface CamInfo {
  id: string;
  name: string;
  short: string;
  colorIndex: number;
  kind: string;
  direction: string;
}

const pt = (p: { x: number; y: number }) => ({ x: r2(p.x), y: r2(p.y) });

/** Разметка точки полями (Firestore не хранит массивы в массивах — точки как {x, y}). */
export function layoutOf(plan: TwinPlan, cams: CamInfo[]): Record<string, unknown> {
  const shop = hasShop(plan);
  const span = (k: "showcase" | "door") => (s: TwinPlan["showcases"][number], i: number) => {
    const [a, b] = spanPoints(plan, s);
    return { id: `${k}${i + 1}`, edge: s.edge, t0: r3(s.t0), t1: r3(s.t1), ...(a && b ? { a: pt(a), b: pt(b), lengthM: r2(Math.hypot(b.x - a.x, b.y - a.y)) } : {}) };
  };
  const names = new Map(cams.map((c) => [c.id, c]));
  const cameras = Object.entries(plan.calibrations).map(([id, cal], i) => {
    const c = names.get(id);
    const color = c?.colorIndex ?? i;
    const m = cameraMark(c?.short ?? "камера", color, cal, plan);
    return {
      id, name: c?.name ?? id, label: c?.short ?? null, kind: c?.kind ?? null, direction: c?.direction ?? null, color: cameraColor(color),
      mode: cal.mode === "sector" ? "sector" : "floor",
      ...(m ? { pos: pt(m.position), angleDeg: Math.round((((m.angle * 180) / Math.PI) % 360 + 360) % 360), fovDeg: Math.round((m.fov * 180) / Math.PI), rangeM: r2(m.range) } : {}),
      ...(cal.mode === "sector" ? {} : { imagePts: cal.imagePts.map((q) => ({ x: r3(q.x), y: r3(q.y) })), planPts: cal.planPts.map(pt) }),
    };
  });
  return {
    widthM: plan.widthM, depthM: plan.depthM,
    shop: plan.shop.map(pt),
    showcases: shop ? plan.showcases.map(span("showcase")) : [],
    doors: shop ? plan.doors.map(span("door")) : [],
    stands: plan.stands.map((s, i) => ({ id: s.id, name: `Штендер ${i + 1}`, pos: pt(s.pos), angleDeg: Math.round((s.angle * 180) / Math.PI) })),
    fixtures: (plan.fixtures ?? []).map((f) => ({
      id: f.id, kind: f.kind, title: FIXTURE_KINDS[f.kind].title, pos: pt(f.pos), angleDeg: Math.round((f.angle * 180) / Math.PI),
      widthM: r2(f.width), depthM: r2(f.depth), inShop: shop && insideShop(plan, f.pos),
    })),
    zones: plan.zones.map((z) => ({ id: z.id, name: z.name, color: zoneColor(z.color), points: z.points.map(pt) })),
    cameras,
  };
}

/** Подложка: до 1600 px, JPEG в Firestore (документ — до 1 МБ), как в кабинете. */
async function pushBackground(uid: string, site: string, blob: Blob | null): Promise<void> {
  const r = doc(firestore(), "users", uid, "sites", site, "assets", "background");
  if (!blob) return; // убрать подложку в кабинете — только из кабинета
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  const jpeg = c.toDataURL("image/jpeg", 0.8).split(",")[1] ?? "";
  if (jpeg.length > 950_000) return;
  await setDoc(r, { jpeg, at: Date.now() });
}

function describe(e: unknown): string {
  const t = friendlyError(e);
  return /permission/i.test(t) ? "Нет доступа: проверьте правила Realtime Database" : t;
}
