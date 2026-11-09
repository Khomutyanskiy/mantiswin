// Точки: живой цифровой двойник каждой точки с любого устройства — раздел «Точки» в приложении
// и отдельная страница личного кабинета (cabinet.html) для руководителя.
//
// Откуда данные:
//   Realtime Database  live/{uid}/{site}        — раз в секунду пишет устройство на точке (iPhone: TwinPublisher.swift)
//                      presence/{uid}/{site}/…  — устройство на связи (само исчезает при обрыве)
//   Firestore          users/{uid}/sites/{site} — { name, planJSON, updatedAt }: план точки рисуется здесь, во вкладке «План»
//                      …/sites/{site}/cameras/{camId} — реестр камер точки (пишет устройство)
//                      …/sites/{site}/frames/{camId}  — размытый кадр камеры для привязки к плану
//                      …/sites/{site}/assets/background — подложка плана (JPEG base64)
//
// Видео сюда не приходит — только координаты людей на плане и счётчики.

import "./cabinet.css";
import type { User } from "firebase/auth";
import { type Database, type Unsubscribe as DbUnsubscribe, onValue, ref } from "firebase/database";
import { twinDatabase } from "../cloud/rtdb";
import {
  type Firestore, type Unsubscribe, collection, deleteDoc, doc, getDoc, getFirestore, onSnapshot, setDoc,
} from "firebase/firestore";
import { firebaseApp, friendlyError, resetPassword, signIn, signOut } from "../cloud/firebase";
import { ask } from "../ui/confirm";
import { pointInPolygon } from "../engine/geometry";
import type { PersonState } from "../engine/session";
import { type CameraRef, mountPlanEditor, openCalibration } from "../twin/editors";
import { type PlanLayers, paintPlan, personColor } from "../twin/paint";
import { type CameraMark, type TwinPerson, type TwinPlan, CODE_STATE, cameraMark, defaultPlan, normalizePlan } from "../twin/plan";

// ---------------------------------------------------------------- настройки

/** Realtime Database проекта (как в iOS: TwinKeys.defaultDatabaseURL). Другой адрес — ?db=… (запоминается). */
const DEFAULT_DB = "https://jinpix-ac93d-default-rtdb.europe-west1.firebasedatabase.app";
const DB_KEY = "cabinet.db";
const SITE_KEY = "cabinet.site";
const TAB_KEY = "cabinet.tab";
/** Нет обновлений дольше — «нет связи». */
const STALE_MS = 6000;

function storageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function storageSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* нет хранилища — не страшно */
  }
}

const dbFromQuery = new URLSearchParams(location.search).get("db");
if (dbFromQuery) storageSet(DB_KEY, dbFromQuery);
const DB_URL = storageGet(DB_KEY) || DEFAULT_DB;

// ---------------------------------------------------------------- данные

interface LiveStat {
  people?: number;
  slowed?: number;
  looked?: number;
  entered?: number;
  turned?: number;
}
interface LiveCamera {
  name?: string;
  kind?: string;
  on?: boolean;
  live?: boolean;
  onPlan?: boolean;
  fps?: number;
  inFrame?: number;
  today?: LiveStat;
}
interface LiveDoc {
  meta?: { device?: string; deviceName?: string; platform?: string; status?: string; point?: string; ts?: number; demo?: boolean };
  /** Демо на телефоне: план демо (TwinPlan в JSON) — с примерным магазином и двумя демо-камерами. */
  demoPlan?: string | null;
  today?: LiveStat;
  cameras?: Record<string, LiveCamera>;
  /** id → [x, y, состояние 0–3, камер]. */
  plan?: Record<string, [number, number, number, number]>;
}
interface RegCamera {
  id: string;
  name: string;
  kind: string;
  deviceName: string;
  width: number;
  height: number;
  frameAt: Date | null;
  /** С какого устройства камера: ios, mac, web, windows. */
  platform: string;
}
interface SiteInfo {
  id: string;
  name: string;
}
/** Человек на экране: плавный переезд между обновлениями. */
interface Shown {
  from: { x: number; y: number };
  to: { x: number; y: number };
  t0: number;
  state: PersonState;
  cameras: number;
  trail: { x: number; y: number }[];
}

type Tab = "now" | "plan" | "cameras";

const S = {
  user: null as User | null,
  sites: [] as SiteInfo[],
  online: {} as Record<string, string[]>,
  site: storageGet(SITE_KEY) || "main",
  tab: (storageGet(TAB_KEY) as Tab) || "now",
  plan: null as TwinPlan | null,
  planAt: 0,
  background: null as ImageBitmap | null,
  live: null as LiveDoc | null,
  liveAt: 0,
  cameras: [] as RegCamera[],
  shown: new Map<string, Shown>(),
  /** Есть ли соединение с Realtime Database и с какого момента ждём его. */
  connected: false,
  waitingSince: 0,
};

let fs: Firestore;
let rtdb: Database;
const unsubs: (Unsubscribe | DbUnsubscribe)[] = [];
let siteUnsubs: (Unsubscribe | DbUnsubscribe)[] = [];

// ---------------------------------------------------------------- DOM

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v as EventListener);
    else if (k === "text") e.textContent = String(v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c) e.append(c);
  return e;
}

let root: HTMLElement = document.createElement("div");
/** Встроено в приложение (раздел «Точки»): без своего входа, шапки с логотипом и «Выйти». */
let embedded = false;
let openProfile: (() => void) | null = null;
let visible = true;
const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("ru-RU");
const pct = (a: number | undefined, b: number | undefined) => (b && b > 0 ? `${Math.round(((a ?? 0) / b) * 100)}%` : "—");

// ---------------------------------------------------------------- вход

function renderLogin(error = ""): void {
  root.replaceChildren();
  if (embedded) {
    root.append(h("div", { class: "cab-empty" },
      h("h2", { text: "Войдите в аккаунт" }),
      h("p", { class: "cab-muted", text: "Здесь — все ваши точки: кто на связи, люди на плане в реальном времени, счётчики за сегодня, план и камеры. Войдите тем же аккаунтом, что в Mantis на точках." }),
      error ? h("p", { class: "cab-error", text: error }) : null,
      openProfile ? h("button", { class: "btn primary", type: "button", text: "Войти", onclick: () => openProfile?.() }) : null));
    return;
  }
  const email = h("input", { type: "email", placeholder: "Почта", autocomplete: "username", required: true });
  const pass = h("input", { type: "password", placeholder: "Пароль", autocomplete: "current-password", required: true });
  const msg = h("p", { class: "cab-error", text: error });
  const form = h(
    "form",
    { class: "cab-login" },
    h("img", { src: "./icon-192.png", alt: "", width: 56, height: 56 }),
    h("h1", { text: "Личный кабинет" }),
    h("p", { class: "cab-muted", text: "Войдите тем же аккаунтом, что в приложении Mantis на точке." }),
    email,
    pass,
    msg,
    h("button", { class: "btn primary wide", type: "submit", text: "Войти" }),
    h("button", {
      class: "btn ghost small", type: "button", text: "Забыли пароль?",
      onclick: async () => {
        if (!email.value) { msg.textContent = "Введите почту — пришлём ссылку для нового пароля"; return; }
        try {
          await resetPassword(email.value);
          msg.textContent = "Письмо отправлено";
        } catch (e) {
          msg.textContent = friendlyError(e);
        }
      },
    }),
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    msg.textContent = "";
    try {
      await signIn(email.value, pass.value);
    } catch (e) {
      msg.textContent = friendlyError(e);
    }
  });
  root.append(form);
}

// ---------------------------------------------------------------- подписки

function stopAll(list: (Unsubscribe | DbUnsubscribe)[]): void {
  for (const u of list.splice(0)) u();
}

function startUser(uid: string): void {
  stopAll(unsubs);
  fs = getFirestore(firebaseApp());
  rtdb = twinDatabase(DB_URL);
  S.connected = false;
  S.waitingSince = Date.now();
  unsubs.push(
    onValue(ref(rtdb, ".info/connected"), (snap) => {
      S.connected = snap.val() === true;
      if (!S.connected) S.waitingSince = Date.now();
      if (S.tab === "now") renderSide();
    }),
    onSnapshot(collection(fs, "users", uid, "sites"), (snap) => {
      S.sites = snap.docs.map((d) => ({ id: d.id, name: String(d.data().name ?? d.id) }));
      renderHeader();
    }, (e) => showError(friendlyError(e))),
    onValue(ref(rtdb, `presence/${uid}`), (snap) => {
      const v = (snap.val() ?? {}) as Record<string, Record<string, { name?: string }>>;
      S.online = Object.fromEntries(Object.entries(v).map(([site, devs]) => [site, Object.values(devs).map((d) => d.name ?? "устройство")]));
      renderHeader();
    }, (e) => showError(`Realtime Database: ${friendlyError(e)}`)),
  );
  startSite(uid);
}

function startSite(uid: string): void {
  stopAll(siteUnsubs);
  S.plan = null;
  S.planAt = 0;
  S.background = null;
  S.live = null;
  S.liveAt = 0;
  S.cameras = [];
  S.shown.clear();
  const site = S.site;
  const siteDoc = doc(fs, "users", uid, "sites", site);
  siteUnsubs = [
    onSnapshot(siteDoc, (snap) => {
      const d = snap.data();
      const json = typeof d?.planJSON === "string" ? d.planJSON : null;
      const at = typeof d?.updatedAt === "number" ? d.updatedAt : 0;
      // свои сохранения из редактора плана не перерисовываем — редактор уже показывает их
      if (at && at === S.planAt) return;
      S.planAt = at;
      try {
        S.plan = json ? normalizePlan(JSON.parse(json) as Partial<TwinPlan>) : null;
      } catch {
        S.plan = null;
      }
      if (S.tab !== "plan") renderBody();
    }, (e) => showError(friendlyError(e))),
    onSnapshot(doc(fs, "users", uid, "sites", site, "assets", "background"), async (snap) => {
      const b64 = snap.data()?.jpeg;
      S.background = typeof b64 === "string" && b64 ? await bitmapFromBase64(b64) : null;
    }),
    onSnapshot(collection(fs, "users", uid, "sites", site, "cameras"), (snap) => {
      S.cameras = snap.docs.map((d) => {
        const v = d.data();
        const ts = v.frameAt as { toDate?: () => Date } | undefined;
        return {
          id: d.id, name: String(v.name ?? "Камера"), kind: String(v.kind ?? ""), deviceName: String(v.deviceName ?? ""),
          width: Number(v.width ?? 0), height: Number(v.height ?? 0), frameAt: ts?.toDate ? ts.toDate() : null,
          platform: String(v.platform ?? ""),
        };
      });
      if (S.tab === "cameras") renderBody();
    }),
    onValue(ref(rtdb, `live/${uid}/${site}`), (snap) => {
      const wasDemo = isDemo();
      const hadDemoPlan = !!demoPlan();
      S.live = snap.val() as LiveDoc | null;
      S.liveAt = Date.now();
      takePeople();
      // демо включили или выключили — перерисовать план (у демо свой план)
      if (S.tab === "now" && (wasDemo !== isDemo() || hadDemoPlan !== !!demoPlan())) renderBody();
      else syncNow();
    }, (e) => showError(`Realtime Database: ${friendlyError(e)}`)),
  ];
}

async function bitmapFromBase64(b64: string): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(`data:image/jpeg;base64,${b64}`);
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- демо с телефона

let demoCache: { json: string; plan: TwinPlan } | null = null;

/** На телефоне идёт демо (придуманные прохожие). */
function isDemo(): boolean {
  return !!S.live?.meta?.demo;
}

/** План демо с телефона (разбирается один раз на каждую новую версию). */
function demoPlan(): TwinPlan | null {
  const json = isDemo() ? S.live?.demoPlan : null;
  if (!json) return null;
  if (demoCache?.json === json) return demoCache.plan;
  try {
    demoCache = { json, plan: normalizePlan(JSON.parse(json) as Partial<TwinPlan>) };
    return demoCache.plan;
  } catch {
    return null;
  }
}

/** План для вкладки «Сейчас»: в демо — план демо с телефона, иначе — план точки. */
function shownPlan(): TwinPlan | null {
  return demoPlan() ?? S.plan;
}

/** Новое положение людей: каждый плавно переезжает от того места, где он сейчас на экране. */
function takePeople(): void {
  const now = performance.now();
  const next = new Map<string, Shown>();
  for (const [id, v] of Object.entries(S.live?.plan ?? {})) {
    if (!Array.isArray(v) || v.length < 3) continue;
    const to = { x: Number(v[0]), y: Number(v[1]) };
    const old = S.shown.get(id);
    const from = old ? currentPos(old, now) : to;
    const trail = old ? [...old.trail, from].slice(-12) : [];
    next.set(id, { from, to, t0: now, state: CODE_STATE[Number(v[2])] ?? "tracked", cameras: Number(v[3] ?? 1), trail });
  }
  S.shown = next;
}

function currentPos(p: Shown, now: number): { x: number; y: number } {
  const k = Math.min(1, (now - p.t0) / 1000);
  return { x: p.from.x + (p.to.x - p.from.x) * k, y: p.from.y + (p.to.y - p.from.y) * k };
}

// ---------------------------------------------------------------- каркас

let headerEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let sideEl: HTMLElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let errorEl: HTMLElement | null = null;

function renderShell(): void {
  root.replaceChildren();
  headerEl = h("header", { class: "cab-head" });
  errorEl = h("div", { class: "cab-banner", hidden: true });
  bodyEl = h("main", { class: "cab-body" });
  root.append(headerEl, errorEl, bodyEl);
  renderHeader();
  renderBody();
}

function showError(text: string): void {
  if (!errorEl) return;
  errorEl.hidden = !text;
  errorEl.textContent = text;
}

function siteTitle(id: string): string {
  return S.sites.find((s) => s.id === id)?.name ?? (id === "main" ? "Основная точка" : id);
}

/** Выбор точки — свой список (точка, на связи ли, какое устройство), а не системный select. */
let pickOpen = false;

function sitePicker(): HTMLElement {
  const ids = [...new Set([...S.sites.map((s) => s.id), ...Object.keys(S.online), S.site])].sort((a, b) => siteTitle(a).localeCompare(siteTitle(b), "ru"));
  const dot = (id: string) => h("i", { class: `cab-pick-dot ${S.online[id]?.length ? "on" : ""}` });
  const wrap = h("div", { class: "cab-pick" });
  const menu = h("div", { class: "cab-pick-menu", role: "listbox", hidden: true });
  const close = () => {
    pickOpen = false;
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", esc, true);
  };
  const outside = (e: Event) => { if (!wrap.contains(e.target as Node)) close(); };
  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  const btn = h("button", {
    class: "cab-pick-btn", type: "button", "aria-haspopup": "listbox", "aria-expanded": "false", title: "Выбрать точку",
    onclick: () => {
      if (!menu.hidden) return close();
      menu.hidden = false;
      pickOpen = true;
      btn.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", esc, true);
    },
  }, dot(S.site), h("span", { class: "cab-pick-name", text: siteTitle(S.site) }), h("span", { class: "cab-pick-chev", "aria-hidden": "true", text: "▾" }));
  for (const id of ids) {
    const devs = S.online[id] ?? [];
    menu.append(h("button", {
      class: "cab-pick-item", type: "button", role: "option", "aria-selected": id === S.site ? "true" : "false",
      onclick: () => {
        close();
        if (id === S.site) return;
        S.site = id;
        storageSet(SITE_KEY, S.site);
        if (S.user) startSite(S.user.uid);
        renderHeader();
        renderBody();
      },
    }, dot(id), h("span", { class: "cab-pick-text" },
      h("b", { text: siteTitle(id) }),
      h("small", { text: devs.length ? `на связи · ${devs.join(", ")}` : id === siteTitle(id) ? "не на связи" : `${id} · не на связи` }))));
  }
  wrap.append(btn, menu);
  return wrap;
}

function renderHeader(): void {
  if (!headerEl || pickOpen) return; // список открыт — не перестраиваем под рукой
  const select = sitePicker();
  const tabs = h("nav", { class: "cab-tabs", "aria-label": "Разделы" });
  for (const [t, title] of [["now", "Сейчас"], ["plan", "План"], ["cameras", "Камеры"]] as [Tab, string][]) {
    tabs.append(h("button", {
      class: "cab-tab", type: "button", "aria-current": S.tab === t ? "page" : null, text: title,
      onclick: () => { S.tab = t; storageSet(TAB_KEY, t); renderHeader(); renderBody(); },
    }));
  }
  if (embedded) {
    headerEl.replaceChildren(h("span", { class: "cab-label", text: "Точка" }), select, tabs);
    return;
  }
  headerEl.replaceChildren(
    h("div", { class: "cab-brand" }, h("img", { src: "./icon-192.png", alt: "", width: 30, height: 30 }),
      h("span", {}, h("b", { text: "Mantis" }), h("small", { text: "Личный кабинет" }))),
    select,
    tabs,
    h("div", { class: "cab-user" },
      h("span", { class: "cab-muted small", text: S.user?.email ?? "" }),
      h("button", { class: "btn small ghost", type: "button", text: "Выйти", onclick: () => void signOut() })),
  );
}

function renderBody(): void {
  if (!bodyEl) return;
  canvas = null;
  sideEl = null;
  bodyEl.replaceChildren();
  if (S.tab === "now") renderNow(bodyEl);
  else if (S.tab === "plan") renderPlanEditor(bodyEl);
  else renderCameras(bodyEl);
}

// ---------------------------------------------------------------- «Сейчас»

const LAYERS: PlanLayers = { heat: false, trails: true, zones: true, cameras: true, speed: false };

let shownOn = false;
let shownWhy = "";

function renderNow(el: HTMLElement): void {
  const stage = h("section", { class: "cab-stage" });
  const link = linkState();
  shownOn = link.on;
  shownWhy = link.why;
  if (!link.on) {
    // нет трансляции — не рисуем пустой или прошлый план, а честно говорим, почему
    stage.append(h("div", { class: "cab-empty cab-nolive" },
      h("div", { class: "cab-nolive-ico", "aria-hidden": "true" }),
      h("h2", { text: "Нет трансляции" }),
      h("p", { class: "cab-muted", text: link.why }),
      h("p", { class: "cab-muted small", text: `Точка «${siteTitle(S.site)}». Как только трансляция начнётся, план с людьми появится здесь сам.` })));
  } else if (shownPlan()) {
    canvas = h("canvas", { class: "cab-canvas", "aria-label": "План точки с людьми" });
    stage.append(canvas);
  } else {
    stage.append(h("div", { class: "cab-empty" },
      h("h2", { text: "План точки ещё не нарисован" }),
      h("p", { class: "cab-muted", text: "Нарисуйте план (размеры, витрины, вход, зоны) и привяжите камеры — тогда здесь появятся люди в реальном времени. Счётчики справа работают и без плана." }),
      h("button", { class: "btn primary", type: "button", text: "Нарисовать план", onclick: () => { S.tab = "plan"; renderHeader(); renderBody(); } })));
  }
  sideEl = h("aside", { class: "cab-side" });
  // легенда — те же цвета, что на телефоне
  const legend = h("div", { class: "tw-legend cab-legend" }, ...([["tracked", "идёт"], ["passed", "прошёл"], ["slowed", "притормозил"], ["looked", "смотрит"]] as [PersonState, string][])
    .map(([st, t]) => { const d = h("i", { class: "tw-dot" }); d.style.background = personColor(st); return h("span", {}, d, t); }));
  el.append(h("div", { class: "cab-stage-col" }, stage, link.on ? legend : null), sideEl);
  renderSide();
}

function cameraMarks(plan: TwinPlan): CameraMark[] {
  const out: CameraMark[] = [];
  const ids = Object.keys(plan.calibrations);
  ids.forEach((id, i) => {
    // поставлена на плане телефона заранее (ключ «plan-…») — подпись из привязки и пометка
    const own = (plan.calibrations[id] as { name?: string }).name;
    const base = S.cameras.find((c) => c.id === id)?.name ?? S.live?.cameras?.[id]?.name ?? own ?? "Камера";
    const name = id.startsWith("plan-") ? `${base} · не привязана` : base;
    const m = cameraMark(name, i, plan.calibrations[id], plan);
    if (m) out.push(m);
  });
  return out;
}

function frame(): void {
  requestAnimationFrame(frame);
  const plan = shownPlan();
  if (!visible || !shownOn || !canvas || !plan || !canvas.isConnected) return;
  const now = performance.now();
  const people: TwinPerson[] = [];
  const occupancy: Record<string, number> = {};
  for (const [id, p] of S.shown) {
    const pos = currentPos(p, now);
    people.push({ id, pos, trail: [...p.trail, pos], state: p.state, cameras: p.cameras, speed: null });
    for (const z of plan.zones) if (z.points.length >= 3 && pointInPolygon(pos, z.points)) occupancy[z.id] = (occupancy[z.id] ?? 0) + 1;
  }
  // у примерного плана демо своей подложки нет
  const bg = demoPlan() ? null : S.background;
  paintPlan(canvas, { plan, background: bg, people, occupancy, cameras: cameraMarks(plan), layers: LAYERS });
}
requestAnimationFrame(frame);

function renderSide(): void {
  if (!sideEl) return;
  const live = S.live;
  const age = S.liveAt ? Date.now() - S.liveAt : Infinity;
  const offline = !live || live.meta?.status === "offline" || age > STALE_MS || !S.online[S.site]?.length;
  const lastTs = live?.meta?.ts ? new Date(live.meta.ts) : null;
  // нет соединения с Realtime Database дольше 8 с — честно говорим, что данные не доходят
  const noLink = !S.connected && Date.now() - S.waitingSince > 8000;
  const statusText = noLink
    ? "Нет соединения с облаком (Realtime Database) — данные точек не приходят"
    : !live
    ? "Точка ещё не передавала данные"
    : offline
      ? `Нет связи${lastTs ? ` с ${lastTs.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}` : ""}`
      : isDemo() ? `Демо${S.live?.meta?.platform === "ios" ? " с телефона" : ""} · придуманные прохожие`
        : live.meta?.status === "counting" ? "Идёт подсчёт" : "На связи · подсчёт не запущен";
  const t = live?.today ?? {};
  const cams = Object.entries(live?.cameras ?? {});
  const nowCount = Object.keys(live?.plan ?? {}).length || cams.reduce((a, [, c]) => a + (c.inFrame ?? 0), 0);

  sideEl.replaceChildren(
    h("div", { class: `cab-status ${offline ? "off" : live?.meta?.status === "counting" ? "on" : "idle"}` },
      h("i", {}), h("div", {},
        h("b", { text: statusText }),
        h("small", { class: "cab-muted", text: live?.meta?.deviceName ? `${live.meta.deviceName}${live.meta.point ? ` · ${live.meta.point}` : ""}`
          : `${siteTitle(S.site)} · аккаунт ${S.user?.email ?? ""} — на устройстве должен быть тот же аккаунт и код точки «${S.site}»` }))),
    h("div", { class: "cab-now" }, h("span", { class: "cab-big mono", text: offline ? "—" : String(nowCount) }), h("span", { class: "cab-muted", text: "людей сейчас" })),
    // телефон передаёт счётчики текущего подсчёта (обнуляются при «Старт» и «Сброс»)
    h("h3", { text: isDemo() ? "Демо с запуска" : live?.meta?.platform === "ios" ? "С запуска подсчёта" : "Сегодня" }),
    h("div", { class: "cab-stats" },
      stat("прошли", fmt(t.people), ""),
      stat("притормозили", fmt(t.slowed), pct(t.slowed, t.people), "slowed"),
      stat("посмотрели", fmt(t.looked), pct(t.looked, t.people), "looked"),
      stat("зашли", fmt(t.entered), pct(t.entered, t.people), "entered"),
      stat("развернулись", fmt(t.turned), pct(t.turned, t.people), "turned")),
    h("h3", { text: "Камеры" }),
    cams.length
      ? h("ul", { class: "cab-cams" }, ...cams.map(([id, c]) => h("li", {},
        h("i", { class: offline ? "" : c.on ? "on" : c.live ? "idle" : "off" }),
        h("div", {},
          h("b", { text: c.name ?? "Камера" }),
          h("small", { class: "cab-muted", text: [
            offline ? "нет связи" : c.on ? `считает · ${c.fps ?? 0} к/с` : c.live ? "картинка есть, не считает" : "нет картинки",
            `сегодня ${fmt(c.today?.people)}`,
            c.onPlan || shownPlan()?.calibrations[id] ? null : "не на плане",
          ].filter(Boolean).join(" · ") })),
        h("span", { class: "mono", text: offline ? "" : String(c.inFrame ?? 0) }))))
      : h("p", { class: "cab-muted small", text: "Камеры появятся, когда устройство на точке начнёт передавать данные." }),
  );
}

function stat(title: string, value: string, sub: string, cls = ""): HTMLElement {
  return h("div", { class: `cab-stat ${cls}` }, h("b", { class: "mono", text: value }), h("span", { text: title }), sub ? h("small", { text: sub }) : null);
}

// обновить «N с назад» и «нет связи», даже если данные перестали приходить
setInterval(() => { if (visible) syncNow(); }, 2000);

/** Состояние связи с точкой: идёт ли сейчас трансляция и если нет — почему. */
function linkState(): { on: boolean; offline: boolean; why: string } {
  const live = S.live;
  const age = S.liveAt ? Date.now() - S.liveAt : Infinity;
  const offline = !live || live.meta?.status === "offline" || age > STALE_MS || !S.online[S.site]?.length;
  const noLink = !S.connected && Date.now() - S.waitingSince > 8000;
  const on = !noLink && !offline && live?.meta?.status === "counting";
  const why = noLink ? "Нет соединения с облаком — проверьте интернет на этом устройстве."
    : !live ? "Точка ещё ничего не передавала. Запустите на точке мониторинг или демо — в Mantis на iPhone, Mac, Windows или в браузере, — под этим же аккаунтом."
      : offline ? "Устройство на точке не на связи: выключено, нет интернета или закрыто приложение."
        : "Устройство на связи, но подсчёт не запущен. Запустите мониторинг или демо на точке.";
  return { on, offline, why };
}

/** Трансляция появилась или пропала — перестроить «Сейчас» один раз; иначе только обновить сводку (без мигания). */
function syncNow(): void {
  if (S.tab !== "now") return;
  const l = linkState();
  if (l.on !== shownOn || (!l.on && l.why !== shownWhy)) renderBody();
  else renderSide();
}

// ---------------------------------------------------------------- «План»

function cameraRefs(): CameraRef[] {
  const list = new Map<string, string>();
  for (const c of S.cameras) list.set(c.id, c.name);
  for (const [id, c] of Object.entries(S.live?.cameras ?? {})) if (!list.has(id)) list.set(id, c.name ?? "Камера");
  return [...list].map(([id, name], i) => ({ id, name, colorIndex: i }));
}

function renderPlanEditor(el: HTMLElement): void {
  const box = h("section", { class: "cab-editor" });
  el.append(box);
  const plan = S.plan ? structuredClone(S.plan) : defaultPlan();
  mountPlanEditor(box, { plan, background: S.background, cameras: cameraRefs() }, (r) => {
    void savePlan(r.plan);
    if (r.background !== undefined) void saveBackground(r.background);
  });
}

async function savePlan(plan: TwinPlan): Promise<void> {
  if (!S.user) return;
  const at = Date.now();
  S.planAt = at;
  S.plan = structuredClone(plan);
  try {
    await setDoc(doc(fs, "users", S.user.uid, "sites", S.site),
      { planJSON: JSON.stringify(plan), updatedAt: at, name: siteTitle(S.site) }, { merge: true });
    showError("");
  } catch (e) {
    showError(`План не сохранился: ${friendlyError(e)}`);
  }
}

/** Подложка: уменьшаем до 1600 px и храним в Firestore как JPEG (документ — до 1 МБ). */
async function saveBackground(blob: Blob | null): Promise<void> {
  if (!S.user) return;
  const ref_ = doc(fs, "users", S.user.uid, "sites", S.site, "assets", "background");
  try {
    if (!blob) {
      await deleteDoc(ref_);
      S.background = null;
      return;
    }
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    const jpeg = c.toDataURL("image/jpeg", 0.8).split(",")[1] ?? "";
    if (jpeg.length > 950_000) throw new Error("картинка слишком большая — возьмите поменьше");
    await setDoc(ref_, { jpeg, at: Date.now() });
    S.background = bmp;
  } catch (e) {
    showError(`Подложка не сохранилась: ${friendlyError(e)}`);
  }
}

// ---------------------------------------------------------------- «Камеры»

const frameCache = new Map<string, { img: HTMLImageElement; at: number }>();

async function loadFrame(cam: RegCamera): Promise<HTMLImageElement | null> {
  if (!S.user) return null;
  const at = cam.frameAt?.getTime() ?? 0;
  const hit = frameCache.get(cam.id);
  if (hit && hit.at === at) return hit.img;
  const snap = await getDoc(doc(fs, "users", S.user.uid, "sites", S.site, "frames", cam.id));
  const b64 = snap.data()?.jpeg;
  if (typeof b64 !== "string" || !b64) return null;
  const img = new Image();
  img.src = `data:image/jpeg;base64,${b64}`;
  await img.decode().catch(() => undefined);
  frameCache.set(cam.id, { img, at });
  return img;
}

const KIND_TITLE: Record<string, string> = { phone: "камера телефона", usb: "камера компьютера / USB", ip: "IP-камера", demo: "демо-камера" };
/** Камеры компьютера (веб, Windows) привязываются к плану в самом приложении — кадр в облако не отправляют. */
const bindsLocally = (c: RegCamera) => c.platform === "web" || c.platform === "windows";
const hhmm = (d: Date) => d.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Кадр камеры в превью: рисуем на холсте с полями (как в окне привязки) — работает и для вертикальных кадров. */
function thumbCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const c = h("canvas", { class: "cab-thumb-img" });
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  const box = { w: 640, h: 360 };
  c.width = box.w;
  c.height = box.h;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, box.w, box.h);
  if (W > 0 && H > 0) {
    const k = Math.min(box.w / W, box.h / H);
    ctx.drawImage(img, (box.w - W * k) / 2, (box.h - H * k) / 2, W * k, H * k);
  }
  return c;
}

function renderCameras(el: HTMLElement): void {
  const page = h("section", { class: "cab-campage" });
  el.append(page);
  // как это работает — два шага, один раз сверху
  page.append(h("div", { class: "cab-cams-intro" },
    h("div", {},
      h("h2", { text: `Камеры точки «${siteTitle(S.site)}»` }),
      h("p", { class: "cab-muted", text: "Чтобы люди с камеры появлялись на плане, у камеры должны быть кадр и место на плане." })),
    h("ol", { class: "cab-steps" },
      h("li", {}, h("b", { text: "Кадр" }), h("span", { class: "cab-muted", text: "приходит с телефона: Профиль → «Цифровой двойник в облаке» → «Отправить кадр для привязки»" })),
      h("li", {}, h("b", { text: "Привязка" }), h("span", { class: "cab-muted", text: "здесь: «Привязать к плану» — где камера стоит и что видит" })))));
  if (!S.cameras.length) {
    page.append(h("div", { class: "cab-empty" },
      h("h2", { text: "Камер пока нет" }),
      h("p", { class: "cab-muted", text: "Камеры появляются здесь сами, когда Mantis на точке входит в этот аккаунт и включена передача в облако." })));
    return;
  }
  if (!S.plan) {
    page.append(h("div", { class: "cab-note" },
      h("span", { text: "Сначала нарисуйте план точки — к нему привязываются камеры." }),
      h("button", { class: "btn small primary", type: "button", text: "Нарисовать план", onclick: () => { S.tab = "plan"; storageSet(TAB_KEY, "plan"); renderHeader(); renderBody(); } })));
  }
  // по устройствам: сразу видно, какой телефон или компьютер на связи
  const online = new Set(S.online[S.site] ?? []);
  const groups = new Map<string, RegCamera[]>();
  for (const c of S.cameras) {
    const k = c.deviceName || "Устройство";
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const order = [...groups.keys()].sort((a, b) => Number(online.has(b)) - Number(online.has(a)) || a.localeCompare(b, "ru"));
  let colorIndex = 0;
  for (const dev of order) {
    const on = online.has(dev);
    page.append(h("div", { class: "cab-dev" },
      h("i", { class: `cab-pick-dot ${on ? "on" : ""}` }),
      h("b", { text: dev }),
      h("span", { class: "cab-muted small", text: on ? "на связи" : "не на связи" })));
    const grid = h("div", { class: "cab-cam-list" });
    page.append(grid);
    for (const cam of groups.get(dev)!.sort((a, b) => a.name.localeCompare(b.name, "ru"))) grid.append(cameraCard(cam, colorIndex++, on));
  }
}

function cameraCard(cam: RegCamera, colorIndex: number, online: boolean): HTMLElement {
  const calibrated = !!S.plan?.calibrations[cam.id];
  const local = bindsLocally(cam);
  const hasFrame = !!cam.frameAt;
  const state = calibrated ? "ok" : hasFrame || local ? "todo" : "wait";
  const badge = { ok: "На плане", todo: "Не привязана", wait: "Нет кадра" }[state];

  const thumb = h("div", { class: "cab-thumb" },
    h("span", { class: "cab-muted small", text: hasFrame ? "загрузка кадра…" : local ? "кадр — в приложении на компьютере" : "кадра ещё нет" }));
  if (hasFrame) {
    void loadFrame(cam).then((img) => {
      thumb.replaceChildren(img ? thumbCanvas(img) : h("span", { class: "cab-muted small", text: "кадр не загрузился" }));
      thumb.append(h("span", { class: `cab-badge ${state}`, text: badge }), h("span", { class: "cab-frame-at", text: `кадр ${hhmm(cam.frameAt!)}` }));
    });
  }
  thumb.append(h("span", { class: `cab-badge ${state}`, text: badge }));

  // шаги этой камеры: что уже есть и что сделать дальше
  const step = (done: boolean, title: string, hint: string) =>
    h("li", { class: done ? "done" : "" }, h("i", { "aria-hidden": "true", text: done ? "✓" : "" }), h("span", {}, h("b", { text: title }), !done && hint ? h("small", { class: "cab-muted", text: hint }) : null));
  const steps = local
    ? h("ul", { class: "cab-cam-steps" },
      step(calibrated, "Место на плане", "Задаётся в Mantis на компьютере: «Мониторинг» → «Камеры» → «Настроить»."))
    : h("ul", { class: "cab-cam-steps" },
      step(hasFrame, "Кадр с камеры", online ? "На телефоне: Профиль → «Цифровой двойник в облаке» → «Отправить кадр для привязки»." : "Телефон не на связи — откройте на нём Mantis и отправьте кадр."),
      step(calibrated, "Место на плане", hasFrame ? (S.plan ? "Нажмите «Привязать к плану»." : "Сначала нарисуйте план.") : "После кадра."));

  const actions = h("div", { class: "cab-row" });
  if (!local && hasFrame && S.plan) {
    actions.append(h("button", {
      class: calibrated ? "btn small" : "btn small primary", type: "button", text: calibrated ? "Изменить привязку" : "Привязать к плану",
      onclick: () => void bind(cam, colorIndex),
    }));
  }
  if (calibrated && !local) actions.append(h("button", { class: "btn small ghost", type: "button", text: "Убрать с плана", onclick: () => void unbind(cam) }));
  if (!online) {
    actions.append(h("button", {
      class: "link cab-forget", type: "button", text: "Убрать из списка", title: "Камера больше не используется — убрать её из списка точки",
      onclick: () => void forget(cam),
    }));
  }

  return h("article", { class: `cab-cam ${state}` },
    thumb,
    h("div", { class: "cab-cam-info" },
      h("b", { class: "cab-cam-name", text: cam.name }),
      h("small", { class: "cab-muted", text: [KIND_TITLE[cam.kind] ?? "камера", cam.width ? `${cam.width}×${cam.height}` : ""].filter(Boolean).join(" · ") }),
      steps,
      actions.childElementCount ? actions : null));
}

/** Убрать камеру из списка точки (реестр, кадр и привязку) — для старых телефонов и камер. */
async function forget(cam: RegCamera): Promise<void> {
  if (!S.user) return;
  if (!(await ask({ title: `Убрать «${cam.name}» из списка?`, text: `${cam.deviceName || "Устройство"} · ${KIND_TITLE[cam.kind] ?? "камера"}. Если камера снова начнёт передавать, она появится опять.`, ok: "Убрать", danger: true }))) return;
  try {
    const base = ["users", S.user.uid, "sites", S.site] as const;
    await deleteDoc(doc(fs, ...base, "cameras", cam.id));
    await deleteDoc(doc(fs, ...base, "frames", cam.id)).catch(() => undefined);
    if (S.plan?.calibrations[cam.id]) await unbind(cam);
  } catch (e) {
    showError(`Не удалось убрать камеру: ${friendlyError(e)}`);
  }
}

async function bind(cam: RegCamera, colorIndex: number): Promise<void> {
  if (!S.plan) return;
  const img = await loadFrame(cam);
  if (!img) { showError("Кадр камеры не загрузился"); return; }
  const plan = structuredClone(S.plan);
  const res = await openCalibration({
    title: `Привязка камеры «${cam.name}»`,
    plan,
    background: S.background,
    initial: plan.calibrations[cam.id] ?? null,
    colorIndex,
    canRemove: !!plan.calibrations[cam.id],
    still: () => ({ image: img, boxes: [], width: img.naturalWidth, height: img.naturalHeight }),
    message: () => "Отметьте 4 точки на полу в кадре и те же точки на плане. Если пола в кадре почти нет — выберите привязку по сектору: где камера, куда смотрит и как далеко видит.",
    markName: () => cam.name,
  });
  if (res === undefined) return;
  if (res === null) delete plan.calibrations[cam.id];
  else plan.calibrations[cam.id] = res;
  await savePlan(plan);
  renderBody();
}

async function unbind(cam: RegCamera): Promise<void> {
  if (!S.plan) return;
  const plan = structuredClone(S.plan);
  delete plan.calibrations[cam.id];
  await savePlan(plan);
  renderBody();
}

// ---------------------------------------------------------------- старт

export interface CabinetView {
  /** Кто вошёл (из Firebase Auth). */
  setUser(user: User | null): void;
  show(): void;
  hide(): void;
}

/** Показать точки в элементе: в приложении (embedded) — раздел «Точки», иначе — страница личного кабинета. */
export function mountCabinet(el: HTMLElement, o: { embedded?: boolean; openProfile?: () => void } = {}): CabinetView {
  root = el;
  embedded = !!o.embedded;
  openProfile = o.openProfile ?? null;
  root.classList.add("cab");
  if (embedded) root.classList.add("cab-embedded");
  let started = false;
  return {
    setUser(user) {
      const changed = user?.uid !== S.user?.uid || !started;
      started = true;
      S.user = user;
      if (!user) {
        stopAll(unsubs);
        stopAll(siteUnsubs);
        renderLogin();
        return;
      }
      if (changed) {
        renderShell();
        startUser(user.uid);
      }
    },
    show() {
      visible = true;
      if (S.user) renderBody();
    },
    hide() {
      visible = false;
    },
  };
}

/** Ошибка Firebase при запуске (страница кабинета). */
export function cabinetError(e: unknown): void {
  renderLogin(friendlyError(e));
}
