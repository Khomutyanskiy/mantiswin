// Цифровой двойник в облаке: что уходит в Realtime Database и как план синхронизируется с кабинетом
// (Firebase подменён — проверяем формат как у TwinPublisher.swift в iOS).
import { beforeEach, describe, expect, it, vi } from "vitest";

const writes: { path: string; value: unknown }[] = [];
const fsWrites: { path: string; value: Record<string, unknown> }[] = [];
let metaListener: ((snap: { val: () => unknown }) => void) | null = null;
let siteSnapshot: ((snap: { data: () => Record<string, unknown> | undefined }) => void) | null = null;

vi.mock("firebase/database", () => ({
  getDatabase: () => ({}),
  forceWebSockets: () => undefined,
  ref: (_db: unknown, path: string) => ({ path }),
  set: async (r: { path: string }, value: unknown) => void writes.push({ path: r.path, value }),
  update: async (r: { path: string }, value: unknown) => void writes.push({ path: r.path, value }),
  onDisconnect: () => ({ remove: async () => undefined, update: async () => undefined }),
  onValue: (_r: unknown, cb: typeof metaListener) => {
    metaListener = cb;
    return () => undefined;
  },
  serverTimestamp: () => "TS",
}));
vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, ...p: string[]) => ({ path: p.join("/") }),
  setDoc: async (r: { path: string }, value: Record<string, unknown>) => void fsWrites.push({ path: r.path, value }),
  onSnapshot: (_r: unknown, cb: typeof siteSnapshot) => {
    siteSnapshot = cb;
    return () => undefined;
  },
  serverTimestamp: () => "FTS",
}));
vi.mock("../src/cloud/firebase", () => ({ firebaseApp: () => ({}), firestore: () => ({}), friendlyError: (e: unknown) => String(e) }));
vi.mock("../src/desktop", () => ({ desktopShell: null }));
vi.mock("../src/multi/model", () => ({ desktopDeviceId: () => "desk-test" }));

(globalThis as unknown as { window: unknown }).window ??= { addEventListener: () => undefined };

const { TwinPublisher, safeKey } = await import("../src/cloud/twinPublisher");
const { defaultPlan } = await import("../src/twin/plan");
const { newChannelConfig } = await import("../src/multi/channel");

const hour = (people: number) => ({ people, looked: 1, slowed: 2, passed: 0, entered: 3, seconds: 60 });

function setup() {
  const cfg = newChannelConfig({ id: "cam.1", name: "Витрина" });
  const channel = {
    id: cfg.id, config: cfg, isCounting: true, isLive: true, fps: 9.87,
    last: { width: 1280, height: 720, at: 0, boxes: [{ trackId: 12, box: { x1: 600, y1: 200, x2: 680, y2: 560 }, state: "looked", lookingNow: true, speed: null, inZone: true, keypoints: null }] },
  };
  const twin = {
    plan: defaultPlan(),
    backgroundBlob: null,
    people: [{ id: "cam.1#12", pos: { x: 6.123, y: 3.456 }, trail: [], state: "looked", cameras: 2, speed: null }],
    savePlan: vi.fn(async function (this: { plan: unknown }, p: unknown) { twin.plan = p as typeof twin.plan; }),
  };
  const pilot = { channels: [channel], running: true, today: () => hour(10), todayFor: () => hour(4) };
  const account = { uid: "u1", state: { profile: { point: "Пушкинская", name: "" } } };
  const onPlanFromCloud = vi.fn();
  let demo: unknown = null;
  const pub = new TwinPublisher({ account, pilot, twin, deviceName: () => "Mantis · браузер", onPlanFromCloud, demo: () => demo } as never);
  const tick = () => (pub as unknown as { tick: () => Promise<void> }).tick();
  return { pub, twin, pilot, tick, onPlanFromCloud, setDemo: (d: unknown) => (demo = d) };
}

beforeEach(() => {
  writes.length = 0;
  fsWrites.length = 0;
  siteSnapshot = null;
  metaListener = null;
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k),
  };
});

describe("цифровой двойник в облаке", () => {
  it("раз в секунду — снимок точки в live/{uid}/{site}, как у iPhone", async () => {
    const { tick } = setup();
    await tick();
    const live = writes.find((w) => w.path === "live/u1/main")!.value as Record<string, Record<string, unknown>>;
    expect(live.meta).toMatchObject({ device: "desk-test", platform: "web", status: "counting", point: "Пушкинская", ts: "TS" });
    expect(live.today).toEqual({ people: 10, slowed: 2, looked: 1, entered: 3, turned: 0 });
    const cam = (live.cameras as Record<string, Record<string, unknown>>)[safeKey("cam.1")];
    expect(cam).toMatchObject({ name: "Витрина", kind: "usb", on: true, live: true, inFrame: 1, fps: 9.9, w: 1280, h: 720 });
    const n12 = ((live.people as Record<string, Record<string, number[]>>)["cam_1"]).n12;
    expect(n12.slice(0, 2)).toEqual([0.5, 0.778]);
    expect(n12.slice(4)).toEqual([3, 1]); // смотрит
    expect(live.plan).toEqual({ "cam_1_12": [6.12, 3.46, 3, 2] });
    // присутствие и реестр камер для кабинета
    expect(writes.some((w) => w.path === "presence/u1/main/desk-test")).toBe(true);
    expect(fsWrites.find((w) => w.path === "users/u1/sites/main/cameras/cam.1")?.value).toMatchObject({ name: "Витрина", kind: "usb", width: 1280 });
  });

  it("план: свой уходит в кабинет, правка из кабинета приходит сюда", async () => {
    const { tick, twin, onPlanFromCloud } = setup();
    await tick();
    siteSnapshot!({ data: () => ({}) }); // в облаке плана нет
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    const pushed = fsWrites.find((w) => w.path === "users/u1/sites/main" && "planJSON" in w.value)!;
    expect(JSON.parse(pushed.value.planJSON as string).widthM).toBe(12);
    // в кабинете поменяли ширину позже
    const cloudPlan = { ...defaultPlan(), widthM: 20 };
    siteSnapshot!({ data: () => ({ planJSON: JSON.stringify(cloudPlan), updatedAt: Date.now() + 60_000 }) });
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(twin.savePlan).toHaveBeenCalled();
    expect(twin.plan.widthM).toBe(20);
    expect(onPlanFromCloud).toHaveBeenCalled();
  });

  it("вся разметка — магазин, витрины, входы, штендеры, стеллажи, зоны, камеры — уходит в Firebase", async () => {
    const { tick, twin } = setup();
    const { defaultShop, newFixture } = await import("../src/twin/plan");
    const plan = defaultPlan();
    plan.shop = defaultShop(12, 8);
    plan.showcases = [{ edge: 2, t0: 0.4, t1: 0.8 }];
    plan.doors = [{ edge: 2, t0: 0.1, t1: 0.25 }];
    plan.stands = [{ id: "s1", pos: { x: 6, y: 7.5 }, angle: 0 }];
    plan.fixtures = [newFixture("rack", { x: 5, y: 3 })];
    plan.zones = [{ id: "z", name: "Касса", color: 1, points: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }] }];
    plan.calibrations["cam.1"] = { imagePts: [], planPts: [], mode: "sector", cameraPos: { x: 6, y: 1 }, cameraAngle: Math.PI / 2, fovDeg: 80, rangeM: 7 };
    twin.plan = plan;
    await tick();
    // в облаке уже лежит чужой план (например, с iPhone) — размеченный здесь главнее
    siteSnapshot!({ data: () => ({ planJSON: JSON.stringify(defaultPlan()), updatedAt: 1000 }) });
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(twin.savePlan).not.toHaveBeenCalled();
    const w = fsWrites.filter((x) => x.path === "users/u1/sites/main" && "planJSON" in x.value).pop()!;
    expect(JSON.parse(w.value.planJSON as string).stands).toHaveLength(1);
    const L = w.value.layout as Record<string, unknown[]>;
    expect(L.shop).toHaveLength(4);
    expect(L.showcases[0]).toMatchObject({ id: "showcase1", edge: 2 });
    expect((L.showcases[0] as { lengthM: number }).lengthM).toBeGreaterThan(0);
    expect(L.doors).toHaveLength(1);
    expect(L.stands[0]).toMatchObject({ name: "Штендер 1", pos: { x: 6, y: 7.5 } });
    expect(L.fixtures[0]).toMatchObject({ kind: "rack", title: "Стеллаж", widthM: 2, inShop: true });
    expect(L.zones[0]).toMatchObject({ name: "Касса" });
    expect(L.cameras[0]).toMatchObject({ id: "cam.1", name: "Витрина", kind: "usb", mode: "sector", pos: { x: 6, y: 1 }, angleDeg: 90, fovDeg: 80, rangeM: 7 });
    // ни одного массива в массиве — иначе Firestore не примет
    const nested = (v: unknown): boolean => Array.isArray(v) ? v.some((x) => Array.isArray(x) || nested(x)) : !!v && typeof v === "object" && Object.values(v).some(nested);
    expect(nested(L)).toBe(false);
  });

  it("демо здесь — в облако уходит демо с планом демо, как с iPhone", async () => {
    const { tick, setDemo } = setup();
    const plan = { ...defaultPlan(), widthM: 15 };
    setDemo({
      plan, people: [{ id: "demo#3", pos: { x: 2, y: 3 }, trail: [], state: "slowed", cameras: 1, speed: null }],
      cameras: [{ id: "demo-cam-1", name: "Камера 1", inFrame: 1 }], counts: { passed: 7, slowed: 3, looked: 2, entered: 1 },
    });
    await tick();
    const live = writes.filter((w) => w.path === "live/u1/main").pop()!.value as Record<string, unknown>;
    expect(live.meta).toMatchObject({ demo: true, status: "counting" });
    expect(live.today).toEqual({ people: 7, slowed: 3, looked: 2, entered: 1, turned: 0 });
    expect(live.plan).toEqual({ "demo_3": [2, 3, 2, 1] });
    expect((live.cameras as Record<string, unknown>)["demo-cam-1"]).toMatchObject({ kind: "demo", inFrame: 1 });
    expect(JSON.parse(live.demoPlan as string).widthM).toBe(15);
    // следующий раз план демо не шлём — он не менялся
    await tick();
    expect("demoPlan" in (writes.filter((w) => w.path === "live/u1/main").pop()!.value as object)).toBe(false);
    // демо остановили — план демо убираем
    setDemo(null);
    await tick();
    expect((writes.filter((w) => w.path === "live/u1/main").pop()!.value as Record<string, unknown>).demoPlan).toBeNull();
  });

  it("на точке передаёт iPhone с демо, а здесь ничего не идёт — не перебиваем его", async () => {
    const { tick, pilot, pub } = setup();
    await tick();
    (pilot as { running: boolean }).running = false;
    metaListener!({ val: () => ({ device: "iphone-1", deviceName: "iPhone Алексея", status: "counting", demo: true }) });
    writes.length = 0;
    await tick();
    expect(writes.find((w) => w.path === "live/u1/main")).toBeUndefined();
    expect(pub.state).toEqual({ kind: "standby", other: "iPhone Алексея" });
    // выход отсюда не гасит iPhone
    pub.enabled = false;
    expect(writes.find((w) => w.path === "live/u1/main/meta")).toBeUndefined();
  });

  it("iPhone на связи без подсчёта, здесь тоже ничего — молчим, чтобы точка не «передёргивалась»", async () => {
    const { tick, pilot, pub } = setup();
    await tick();
    (pilot as { running: boolean }).running = false;
    metaListener!({ val: () => ({ device: "iphone-1", deviceName: "iPhone", status: "idle" }) });
    writes.length = 0;
    await tick();
    expect(writes.find((w) => w.path === "live/u1/main")).toBeUndefined();
    expect(pub.state.kind).toBe("standby");
    // а мониторинг здесь запустили — передаём
    (pilot as { running: boolean }).running = true;
    await tick();
    expect(writes.find((w) => w.path === "live/u1/main")).toBeDefined();
  });

  it("выключили — точка «не на связи»", async () => {
    const { pub, tick } = setup();
    await tick();
    writes.length = 0;
    pub.enabled = false;
    expect(writes.find((w) => w.path === "live/u1/main/meta")?.value).toMatchObject({ status: "offline" });
    expect(writes.find((w) => w.path === "presence/u1/main/desk-test")?.value).toBeNull();
  });
});
