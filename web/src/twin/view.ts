// Шаг «3 · Мониторинг»: запуск, камеры над планом, живой план точки (люди, следы, тепло дня, зоны), итоги,
// демо-режим. Камеры привязываются к плану в окне «Настроить» (где витрина + привязка); готовое видео можно
// разобрать прямо здесь и смотреть синхронно с планом. Порт TwinView.swift + части VideoTwin.swift (macOS).

import { SHOWCASE_DIRECTIONS, channelColorIndex, channelLabel, channelShort, channelTitle } from "../multi/channel";
import { ask } from "../ui/confirm";
import type { ShowcaseDirection } from "../engine/headpose";
import type { AnalyticsConfig } from "../engine/config";
import type { Pt } from "../engine/geometry";
import type { FrameResult } from "../engine/session";
import type { Detector } from "../detector";
import type { Channel } from "../multi/channel";
import type { MultiView } from "../multi/view";
import { drawPeople } from "../ui/draw";
import { type StillFrame, openCalibration } from "./editors";
import { floatingWindow } from "./floating";
import { TwinModel } from "./model";
import { type PlanLayers, paintPlan, personColor } from "./paint";
import {
  CAMERA_COLORS, type CameraCalibration, type CameraMark, CameraProjector, HeatCursor, type RecCameraRef, type RecFrame, Timeline, averageDwell,
  calibrationUsable, calibrationValid, cameraColor, floorPointsUntouched, cameraMark, newDayStats, fmtClock, fmtDuration, fmtM, peopleWord, zoneColor,
} from "./plan";
import { saveRecording } from "./store";
import { type AnalyzedFrame, VideoTwinBuilder, analyzeVideo, buildVideoTimeline, grabStill, loadVideo } from "./video";

export interface TwinDeps {
  multi: MultiView;
  getDetector: () => Promise<Detector>;
  toast: (text: string, error?: boolean) => void;
  /** Пороги анализа видео (разметка вкладки «Анализ», зона — весь кадр). */
  videoConfig: () => { cfg: AnalyticsConfig; entrance: Pt[] | null; fps: number };
  /** Перейти на шаг «Камеры» / «План» или в «Статистику». */
  goCameras: () => void;
  goPlan: () => void;
  goStats: () => void;
  /** Запись сохранена — обновить раздел «Записи». */
  onSaved: () => void;
  /** Вошёл ли пользователь (для строки «в облаке»). */
  signedIn: () => boolean;
}

export interface TwinView {
  readonly model: TwinModel;
  show(): void;
  hide(): void;
  /** Открыть готовое видео (из «Анализа» — уже разобранное). */
  openVideo(file: File, analyzed?: { width: number; height: number; frames: AnalyzedFrame[] }): Promise<void>;
  /** «Настроить» камеру: где витрина + привязка к плану. */
  setupCamera(ch: Channel): Promise<void>;
  /** План поменялся на шаге «План» — пересчитать видео и перерисовать. */
  planChanged(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
function button(text: string, cls: string, onClick?: () => void, title?: string): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  if (title) b.title = title;
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

const store = {
  get(k: string, d: string): string {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* нет */
    }
  },
};

const LAYERS_KEY = "mantis.twin.layers";
export function loadLayers(): PlanLayers {
  try {
    return { heat: true, trails: true, zones: true, cameras: true, speed: false, ...JSON.parse(localStorage.getItem(LAYERS_KEY) ?? "{}") };
  } catch {
    return { heat: true, trails: true, zones: true, cameras: true, speed: false };
  }
}
export function saveLayers(l: PlanLayers): void {
  store.set(LAYERS_KEY, JSON.stringify(l));
}

/** Кнопки слоёв, собранные по смыслу: «Магазин» — тепло, зоны, камеры; «Люди» — следы и скорость. */
export function layerChips(layers: PlanLayers, onChange: () => void, heatTitle = "Тепло за день", extra: [string, () => boolean, (v: boolean) => void][] = []): HTMLElement {
  const bar = el("div", "tw-layers");
  const groups: [string, [keyof PlanLayers, string][]][] = [
    ["Магазин", [["heat", heatTitle], ["zones", "Зоны"], ["cameras", "Камеры"]]],
    ["Люди", [["trails", "Следы"], ["speed", "Скорость"]]],
  ];
  const render = () => {
    bar.replaceChildren();
    for (const [title, items] of groups) {
      const g = el("div", "tw-chip-group");
      g.append(el("span", "tw-chip-group-title", title));
      for (const [k, t] of items) {
        const b = button(t, "chip tw-chip", () => {
          layers[k] = !layers[k];
          saveLayers(layers);
          render();
          onChange();
        });
        b.setAttribute("aria-pressed", String(layers[k]));
        g.append(b);
      }
      bar.append(g);
    }
    for (const [t, get, set] of extra) {
      const b = button(t, "chip tw-chip", () => {
        set(!get());
        render();
        onChange();
      });
      b.setAttribute("aria-pressed", String(get()));
      bar.append(b);
    }
  };
  render();
  return bar;
}

export function legendRow(right: HTMLElement): HTMLElement {
  const lg = el("div", "tw-legend");
  for (const [c, t] of [[personColor("tracked"), "идёт"], [personColor("passed"), "прошёл"], [personColor("slowed"), "притормозил"], [personColor("looked"), "смотрит"]]) {
    const s = el("span");
    const d = el("i", "tw-dot");
    d.style.background = c;
    s.append(d, document.createTextNode(t));
    lg.append(s);
  }
  const multi = el("span");
  multi.append(el("i", "tw-dot dashed"), document.createTextNode("виден несколькими камерами"));
  lg.append(multi, el("span", "grow"), right);
  return lg;
}

/** Блок с заголовком-кнопкой: щелчок сворачивает и разворачивает (состояние запоминается). */
export function collapsible(title: string, key: string, ...nodes: Node[]): HTMLElement {
  const k = `collapse.${key}`;
  const sec = el("section", "tw-card-wrap");
  const head = button("", "collapse-head");
  head.append(el("span", "collapse-arrow", "▾"), el("span", "collapse-title", title));
  const body = el("div", "tw-card");
  body.append(...nodes);
  const sync = () => {
    const c = store.get(k, "0") === "1";
    head.classList.toggle("collapsed", c);
    body.hidden = c;
  };
  head.addEventListener("click", () => {
    store.set(k, store.get(k, "0") === "1" ? "0" : "1");
    sync();
  });
  sync();
  sec.append(head, body);
  return sec;
}

interface VideoSession {
  file: File;
  url: string;
  title: string;
  key: string;
  video: HTMLVideoElement;
  phase: "calibrating" | "analyzing" | "ready" | "failed";
  error: string;
  progress: number;
  width: number;
  height: number;
  frames: AnalyzedFrame[];
  tl: Timeline | null;
  heat: HeatCursor;
  still: ImageBitmap | null;
  cancelled: boolean;
  /** Кадр видео в окне (с рамками). */
  canvas: HTMLCanvasElement;
}


const pad2 = (n: number) => String(n).padStart(2, "0");
function uptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d} д ${h} ч` : h > 0 ? `${h} ч ${pad2(m)} мин` : `${m} мин ${pad2(s % 60)} с`;
}

export function mountTwin(root: HTMLElement, deps: TwinDeps): TwinView {
  const pilot = deps.multi.model;
  const model = new TwinModel(() => pilot.channels.map((c) => ({ id: c.id, title: c.title, isLive: c.isLive, last: c.last })));
  model.start();
  const layers = loadLayers();
  let visible = false;
  let video: VideoSession | null = null;
  let savedNote = "";

  // ---------------------------------------------------------------- каркас
  const main = el("div", "tw-main");
  const side = el("aside", "tw-side");

  // камеры над планом
  const CAMS_SHOW = "monitor.cams.show", CAMS_SIZE = "monitor.cams.size";
  const camsBox = el("section", "tw-cams");
  const camsHead = el("div", "tw-block-head");
  const camsToggle = button("", "collapse-head");
  const camsCount = el("span", "collapse-count");
  camsToggle.append(el("span", "collapse-arrow", "▾"), el("span", "collapse-title", "Камеры"), camsCount);
  const camsHint = el("span", "small faint", "Нажмите на камеру — откроется на весь экран");
  const sizeSeg = el("div", "seg compact tw-size");
  sizeSeg.style.gridTemplateColumns = "repeat(3, 1fr)";
  ["Мелко", "Средне", "Крупно"].forEach((t, i) => {
    const label = el("label");
    const input = el("input");
    input.type = "radio";
    input.name = "tw-cams-size";
    input.checked = Number(store.get(CAMS_SIZE, "1")) === i;
    input.addEventListener("change", () => {
      if (!input.checked) return;
      store.set(CAMS_SIZE, String(i));
      syncCams();
    });
    label.append(input, el("span", undefined, t));
    label.title = "Размер блока камер";
    sizeSeg.append(label);
  });
  camsHead.append(camsToggle, el("span", "grow"), camsHint, sizeSeg);
  const camsStrip = el("div", "tw-cams-strip");
  camsBox.append(camsHead, camsStrip);
  camsToggle.addEventListener("click", () => {
    store.set(CAMS_SHOW, store.get(CAMS_SHOW, "1") === "1" ? "0" : "1");
    syncCams();
  });
  const camTiles = new Map<string, { root: HTMLElement; canvas: HTMLCanvasElement; count: HTMLElement; msg: HTMLElement }>();
  let camOrder = "";

  // план: заголовок со стрелкой, кнопки слоёв, план, обозначения
  const planBox = el("section", "tw-planbox");
  const planHead = el("div", "tw-block-head");
  const planToggle = button("", "collapse-head");
  const planTitle = el("span", "collapse-title", "План");
  planToggle.append(el("span", "collapse-arrow", "▾"), planTitle);
  const demoTag = el("span", "tw-demo-tag", "Демо: синтетические прохожие");
  const layersBar = layerChips(layers, () => draw(), "Тепло за день");
  planHead.append(planToggle, layersBar, el("span", "grow"), demoTag,
    button("Видео…", "btn small", () => pickVideo(), "Загрузить готовое видео и построить по нему двойник на этом плане"));
  const area = el("div", "tw-area");
  const canvas = el("canvas", "tw-plan");
  area.append(canvas);
  const planSize = el("span", "mono small faint");
  const legend = legendRow(planSize);
  planBox.append(planHead, area, legend);
  planToggle.addEventListener("click", () => {
    store.set("collapse.twin.plan", store.get("collapse.twin.plan", "0") === "1" ? "0" : "1");
    syncPlan();
  });
  function syncPlan(): void {
    const c = store.get("collapse.twin.plan", "0") === "1";
    planToggle.classList.toggle("collapsed", c);
    area.hidden = c;
    legend.hidden = c;
    layersBar.hidden = c;
    planBox.classList.toggle("collapsed", c);
    if (!c) draw();
  }
  main.append(camsBox, planBox);
  root.append(main, side);
  new ResizeObserver(() => visible && draw()).observe(area);

  // окно с видео (плавающее, двигается по всему окну приложения)
  const vidWin = floatingWindow(area, { title: "Видео", icon: "▶", width: 400, height: 260, onClose: () => closeVideo() });
  const vidPlay = button("⏯", "tw-float-btn", () => {
    const v = video?.video;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, "Пауза / воспроизведение");
  vidWin.accessory.append(vidPlay);
  const vidMsg = el("div", "tw-float-msg");
  vidWin.body.append(vidMsg);
  function syncWindows(): void {
    vidWin.setVisible(visible && !!video);
  }

  // последние кадры камер (для блока камер и привязки)
  const lastShots = new Map<string, { canvas: HTMLCanvasElement; fr: FrameResult | null }>();
  deps.multi.onFrame((ch, shot, fr) => {
    let s = lastShots.get(ch.id);
    if (!s) {
      s = { canvas: document.createElement("canvas"), fr: null };
      lastShots.set(ch.id, s);
    }
    if (s.canvas.width !== shot.width || s.canvas.height !== shot.height) {
      s.canvas.width = shot.width;
      s.canvas.height = shot.height;
    }
    s.canvas.getContext("2d")!.drawImage(shot, 0, 0);
    s.fr = fr;
    if (!visible || camsStrip.hidden) return;
    const t = camTiles.get(ch.id);
    if (!t) return;
    const c = t.canvas;
    if (c.width !== shot.width || c.height !== shot.height) {
      c.width = shot.width;
      c.height = shot.height;
    }
    const ctx = c.getContext("2d")!;
    ctx.drawImage(shot, 0, 0);
    if (fr) drawPeople(ctx, fr.boxes);
    t.msg.hidden = true;
    t.count.textContent = fr ? String(fr.boxes.length) : "";
  });

  function syncCams(): void {
    const chs = pilot.channels;
    camsBox.hidden = !chs.length || !!video;
    camsCount.textContent = String(chs.length);
    const show = store.get(CAMS_SHOW, "1") === "1";
    camsToggle.classList.toggle("collapsed", !show);
    camsStrip.hidden = !show;
    camsHint.hidden = !show;
    sizeSeg.hidden = !show;
    camsBox.dataset.size = store.get(CAMS_SIZE, "1");
    const order = chs.map((c) => `${c.id}:${channelLabel(c.config)}`).join("|");
    if (order !== camOrder) {
      camOrder = order;
      camTiles.clear();
      camsStrip.replaceChildren(...chs.map((ch, i) => {
        const r = button("", "tw-cam-tile", () => deps.multi.focus(ch.id), "Открыть камеру на весь экран");
        const c = el("canvas");
        const msg = el("span", "tw-cam-msg", "Нет картинки");
        const lab = el("span", "tw-cam-label");
        const dot = el("i", "tw-dot");
        dot.style.background = cameraColor(i);
        const count = el("b", "tw-cam-count");
        lab.append(dot, el("span", undefined, channelLabel(ch.config)), count);
        r.append(c, msg, lab, el("span", "tw-cam-expand", "⤢"));
        const s = lastShots.get(ch.id);
        if (s?.canvas.width) {
          c.width = s.canvas.width;
          c.height = s.canvas.height;
          c.getContext("2d")!.drawImage(s.canvas, 0, 0);
          msg.hidden = true;
        }
        camTiles.set(ch.id, { root: r, canvas: c, count, msg });
        return r;
      }));
    }
  }

  // ---------------------------------------------------------------- рисование плана
  const marks = (): CameraMark[] =>
    pilot.channels.flatMap((ch, i) => {
      const c = model.plan.calibrations[ch.id];
      const m = c ? cameraMark(channelShort(ch.config), channelColorIndex(ch.config, i), c, model.plan) : null;
      return m ? [m] : [];
    });

  function draw(): void {
    if (!visible || area.hidden) return;
    demoTag.hidden = !model.demo;
    planTitle.textContent = video ? "План · видео" : "План";
    planSize.textContent = `План ${fmtM(model.plan.widthM)} × ${fmtM(model.plan.depthM)} м`;
    if (video) {
      const v = video;
      const ready = v.phase === "ready";
      const t = timeOf(v);
      const cal = model.plan.calibrations[v.key];
      const mk = cal ? cameraMark("видео", 7, cal, model.plan) : null; // камера ролика
      if (v.tl && ready) v.heat.advance(v.tl, t);
      paintPlan(canvas, {
        plan: model.plan, background: model.background,
        stats: v.tl && ready ? v.heat.stats(v.tl) : null, heatMax: v.heat.maxValue,
        // пока видео разбирается — план пустой; дальше люди строго по времени видео
        people: v.tl && ready ? v.tl.people(t) : [], occupancy: v.tl && ready ? v.tl.occupancy(t) : null,
        cameras: mk ? [mk] : [], layers,
      });
      return;
    }
    paintPlan(canvas, {
      plan: model.plan, background: model.background, stats: model.stats, heatMax: model.heatMax,
      people: model.people, occupancy: model.occupancy, cameras: marks(), layers,
    });
  }

  // ---------------------------------------------------------------- боковая панель
  function tile(title: string, value: string, color?: string): HTMLElement {
    const t = el("div", "tw-tile");
    const b = el("b", "mono", value);
    if (color) b.style.color = color;
    t.append(b, el("span", undefined, title));
    return t;
  }

  let sideKey = "";
  function renderSide(force = false): void {
    if (!visible) return;
    // перестраиваем, только когда что-то поменялось (иначе мигают кнопки)
    const vt = video ? timeOf(video) : 0;
    const tot = pilot.totals, day = pilot.today();
    const k = JSON.stringify([
      model.people.length, model.stats.peak, model.stats.people, model.demo, pilot.running, pilot.state, pilot.channels.map((c) => [c.id, channelLabel(c.config)]),
      Object.keys(model.plan.calibrations), [...model.liveCameras], model.occupancy, model.stats.visits, model.plan.zones.map((z) => [z.id, z.name, z.color]),
      model.recorder ? Math.floor((performance.now() - model.recorder.started) / 1000) : -1, savedNote, tot, day,
      pilot.startedAt && pilot.running ? Math.floor((Date.now() - pilot.startedAt) / 1000) : 0, deps.signedIn(), pilot.lastBeat?.getTime() ?? 0,
      video ? [video.phase, Math.round(video.progress * 100), video.tl?.stats.people, video.tl?.people(vt).length, video.tl?.occupancy(vt)] : null,
      Math.round(Object.values(model.stats.dwell).reduce((a, b) => a + b, 0)),
    ]);
    if (!force && k === sideKey) return;
    sideKey = k;
    const nodes: Node[] = [];
    if (video) nodes.push(videoCard(video));

    // сейчас
    const now = el("div", "tw-now");
    now.append(el("b", "mono", String(model.people.length)), el("span", undefined, `${peopleWord(model.people.length)} на плане`));
    const tiles = el("div", "tw-tiles");
    tiles.append(tile("Пик за день", String(model.stats.peak)), tile("Людей за день", String(model.stats.people)));
    const nowNodes: Node[] = [now, tiles, el("p", "hint-small", sourceText())];
    if (!pilot.running) {
      const b = button("▶ Запустить мониторинг", "btn primary wide", () => void deps.multi.setRunning(true));
      b.disabled = !pilot.channels.length;
      nowNodes.push(b);
    } else {
      nowNodes.push(button("■ Остановить мониторинг", "btn danger wide", async () => {
        if (!(await ask({
          title: "Остановить мониторинг?",
          text: "Подсчёт на всех камерах остановится, статистика сохранится. Отчёт запуска и запись двойника — в «Статистике».",
          ok: "Остановить", danger: true,
        }))) return;
        void deps.multi.setRunning(false);
      }));
    }
    if (model.recorder) {
      nowNodes.push(button(`■ Остановить запись · ${fmtClock((performance.now() - model.recorder.started) / 1000)}`, "btn wide tw-rec-on", () => void stopRecording()));
    } else {
      const b = button("● Записать двойника", "btn wide", () => {
        savedNote = "";
        model.startRecording(liveCameraRefs());
        renderSide(true);
      }, "Запись людей на плане — потом смотреть в разделе «Записи»");
      b.disabled = !(pilot.running || model.demo) || !!video;
      nowNodes.push(b);
    }
    if (savedNote && !video) nowNodes.push(el("p", "tw-saved", savedNote));
    nodes.push(collapsible(video ? "Живые камеры" : "Сейчас", "twin.now", ...nowNodes));

    if (!video) {
      // итоги мониторинга
      const rNodes: Node[] = [];
      if (pilot.running && pilot.startedAt) rNodes.push(el("p", "mono small faint", `Работает ${uptime((Date.now() - pilot.startedAt) / 1000)} · ${pilot.fps.toFixed(1)} кадр/с на камеру`));
      const errs = pilot.channels.filter((c) => c.state === "recovering").map((c) => `${c.title}: ${c.lastError ?? "сбой"}`);
      if (errs.length) rNodes.push(el("p", "tw-warn", errs.join(" · ")));
      const t1 = el("div", "tw-tiles three");
      t1.append(tile("Люди", String(tot.people)), tile("Притормозили", String(tot.slowed), personColor("slowed")), tile("Посмотрели", String(tot.looked), personColor("looked")));
      rNodes.push(t1);
      if (tot.passed > 0 || tot.entered > 0) {
        const t2 = el("div", "tw-tiles");
        if (tot.passed > 0) t2.append(tile("Прошли", String(tot.passed), "#47d7f0"));
        if (tot.entered > 0) t2.append(tile("Зашли", String(tot.entered), "#7cf2c8"));
        rNodes.push(t2);
      }
      rNodes.push(el("p", "mono small faint", `Сегодня: ${day.people} чел. · посмотрели ${day.looked} · притормозили ${day.slowed} · ${(day.seconds / 3600).toFixed(1).replace(".", ",")} ч`));
      rNodes.push(el("p", "small faint", deps.signedIn()
        ? (pilot.lastBeat ? `☁ В облаке · сигнал ${pilot.lastBeat.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}` : "☁ Статистика уходит в облако")
        : "Без входа — статистика только в этом браузере"));
      rNodes.push(deps.multi.foot);
      rNodes.push(button("Статистика по часам и дням", "btn small wide", () => deps.goStats()));
      nodes.push(collapsible(pilot.running ? "С запуска мониторинга" : "Последний запуск", "twin.results", ...rNodes));
    }

    // зоны
    const zNodes: Node[] = [];
    if (!model.plan.zones.length) {
      zNodes.push(el("p", "hint-small", "Зон пока нет. Выделите на плане вход, витрину, кассу, стеллажи — и увидите, сколько людей туда заходит и сколько там остаётся."),
        button("Открыть план…", "btn small", () => deps.goPlan()));
    } else {
      const vReady = video?.phase === "ready";
      const vtl = vReady ? video?.tl : null;
      const occ = video ? (vtl ? vtl.occupancy(vt) : {}) : model.occupancy;
      const st = video ? (vtl ? vtl.stats : newDayStats("video", model.plan)) : model.stats;
      for (const z of model.plan.zones) {
        const r = el("div", "tw-zone");
        const bar = el("i", "tw-zone-bar");
        bar.style.background = zoneColor(z.color);
        const txt = el("div", "tw-zone-text");
        const avg = averageDwell(st, z.id);
        txt.append(el("b", undefined, z.name), el("span", "mono small faint", `заходов ${st.visits[z.id] ?? 0} · в среднем ${avg !== null ? fmtDuration(avg) : "—"}`));
        const n = occ[z.id] ?? 0;
        const cnt = el("b", "mono tw-zone-now", String(n));
        cnt.title = "Сейчас в зоне";
        if (n > 0) cnt.style.color = zoneColor(z.color);
        r.append(bar, txt, cnt);
        zNodes.push(r);
      }
      zNodes.push(el("p", "hint-small faint", video ? "Заходы и среднее время — за весь ролик." : "Заходы и среднее время — за сегодня."));
    }
    nodes.push(collapsible("Зоны", "twin.zones", ...zNodes));

    // камеры
    const cNodes: Node[] = [];
    if (!pilot.channels.length) {
      cNodes.push(el("p", "hint-small", "Камер нет — добавьте их на шаге «Камеры»."), button("Добавить камеру", "btn small", () => {
        deps.goCameras();
        deps.multi.addCamera();
      }));
    } else {
      pilot.channels.forEach((ch, i) => {
        const cal = model.plan.calibrations[ch.id];
        const bound = !!cal && calibrationUsable(cal);
        const live = model.liveCameras.has(ch.id);
        const r = el("div", "tw-camrow");
        const d = el("i", "tw-dot");
        d.style.background = cameraColor(i);
        const untouched = !!cal && floorPointsUntouched(cal);
        const st = el("span", `small ${bound ? (live ? "tw-st-ok" : "faint") : "tw-st-warn"}`,
          bound ? (live ? "привязана · передаёт на план" : "привязана")
            : untouched ? "по полу: точки не расставлены — на план не выводится" : "не привязана");
        const txt = el("div", "tw-zone-text");
        txt.append(el("b", undefined, channelLabel(ch.config)), st);
        r.append(d, txt, button(bound ? "Изменить" : "Привязать", "btn small", () => void setupCamera(ch)));
        cNodes.push(r);
      });
    }
    cNodes.push(el("p", "hint-small faint", "Привязка: 4 точки на полу в кадре и те же точки на плане (или сектор обзора, если пола не видно). Камеры добавляются на шаге «Камеры»."));
    nodes.push(collapsible("Камеры", "twin.cameras", ...cNodes));

    const reset = button("Сбросить статистику дня", "btn small wide", async () => {
      if (await ask({ title: "Сбросить статистику дня?", text: "Тепловая карта и заходы в зоны за сегодня начнутся заново.", ok: "Сбросить", danger: true })) model.resetHeat();
    });
    reset.disabled = model.demo;
    nodes.push(reset);
    side.replaceChildren(...nodes);
  }

  function sourceText(): string {
    if (model.demo) return "Демо-режим: точки придуманы, камеры не используются.";
    const bound = pilot.channels.filter((c) => {
      const cal = model.plan.calibrations[c.id];
      return cal && calibrationValid(cal);
    }).length;
    if (!pilot.channels.length) return "Нет камер — добавьте их на шаге «Камеры».";
    if (!bound) return "Ни одна камера не привязана к плану — нажмите «Привязать» ниже.";
    if (!pilot.running) return "Мониторинг не запущен — люди появятся на плане после запуска.";
    return `На план передают ${model.liveCameras.size} из ${bound} привязанных камер.`;
  }

  const liveCameraRefs = (): RecCameraRef[] =>
    pilot.channels.flatMap((ch, i) => (model.plan.calibrations[ch.id] ? [{ id: ch.id, name: channelShort(ch.config), colorIndex: channelColorIndex(ch.config, i) }] : []));

  async function stopRecording(): Promise<void> {
    const r = model.stopRecording();
    if (!r) return;
    const name = `${r.demo ? "Демо" : "Мониторинг"} ${new Date().toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
    const m = await saveRecording(name, r.demo ? "demo" : "live", r.data, null, model.backgroundBlob);
    savedNote = m ? `Сохранено в «Записи»: ${name}` : "Не удалось сохранить";
    if (m) deps.onSaved();
    renderSide(true);
  }

  // ---------------------------------------------------------------- настройка камеры: где витрина + привязка
  async function setupCamera(ch: Channel): Promise<void> {
    const index = Math.max(0, pilot.channels.indexOf(ch));
    // нужна живая картинка: если мониторинг не идёт — включаем предпросмотр камеры на время настройки
    const preview = !pilot.running && ch.state === "idle";
    if (preview) void ch.startPreview();
    const still = (): StillFrame => {
      const s = lastShots.get(ch.id);
      return {
        image: s?.canvas.width ? s.canvas : null,
        boxes: s?.fr?.boxes.map((b) => b.box) ?? [],
        width: s?.canvas.width ?? 0,
        height: s?.canvas.height ?? 0,
      };
    };
    // псевдоним камеры и «Где витрина» (от этого зависит, что считается «посмотрел»)
    let dir: ShowcaseDirection = ch.config.direction;
    const top = el("div", "tw-setup-top");
    const nameRow = el("div", "tw-setup-row");
    const aliasIn = el("input", "input tw-alias");
    aliasIn.placeholder = "например, №1";
    aliasIn.maxLength = 24;
    aliasIn.value = ch.config.alias ?? "";
    const aliasBox = el("label", "tw-setup-field");
    aliasBox.append(el("span", "small faint", "Псевдоним на плане"), aliasIn);
    const nameIn = el("input", "input");
    nameIn.value = ch.config.name.trim() || channelTitle(ch.config);
    nameIn.maxLength = 60;
    const nameBox = el("label", "tw-setup-field tw-name");
    nameBox.append(el("span", "small faint", "Название"), nameIn);
    // цвет камеры: точка у названия, значок и лучи на плане
    let color = channelColorIndex(ch.config, index);
    const colorBox = el("div", "tw-setup-field");
    const swatches = el("div", "tw-swatches");
    const paintSw = () => swatches.querySelectorAll("button").forEach((b, k) => b.classList.toggle("on", k === color));
    CAMERA_COLORS.forEach((c, k) => {
      const b = el("button", "tw-swatch");
      b.type = "button";
      b.style.background = c;
      b.title = "Цвет камеры";
      b.addEventListener("click", () => {
        color = k;
        paintSw();
      });
      swatches.append(b);
    });
    paintSw();
    colorBox.append(el("span", "small faint", "Цвет"), swatches);
    nameRow.append(nameBox, aliasBox, colorBox);
    // зона витрины (4 угла на кадре) — раньше было отдельное окно «Разметка»
    const zone = ch.config.markup.zone.map((p) => ({ ...p }));
    const dirRow = el("div", "tw-setup-row tw-setup-dir");
    const dirSeg = el("div", "seg tw-dir");
    dirSeg.style.gridTemplateColumns = "repeat(3, 1fr)";
    for (const [v, t] of SHOWCASE_DIRECTIONS) {
      const label = el("label");
      const input = el("input");
      input.type = "radio";
      input.name = "tw-setup-dir";
      input.checked = v === dir;
      input.addEventListener("change", () => input.checked && (dir = v));
      label.append(input, el("span", undefined, t));
      dirSeg.append(label);
    }
    dirRow.append(el("span", "eyebrow", "Где витрина"), dirSeg);
    top.append(nameRow, dirRow);
    const r = await openCalibration({
      title: `Настройка камеры · ${channelLabel(ch.config)}`, plan: model.plan, background: model.background,
      initial: model.calibration(ch.id), colorIndex: index, canRemove: !!model.calibration(ch.id), still,
      message: () => ch.lastError ?? (ch.message || "Подключаю камеру…"), top,
      markName: () => aliasIn.value.trim() || nameIn.value.trim() || ch.title,
      colorOf: () => color, zone,
    });
    if (preview && !pilot.running && !visible) void ch.stopPreview();
    if (r === undefined) return;
    model.setCalibration(r, ch.id);
    const alias = aliasIn.value.trim();
    const name = nameIn.value.trim() || ch.config.name;
    const next = { ...ch.config, name, direction: dir, alias: alias || undefined, color, markup: { ...ch.config.markup, zone } };
    // мониторинг идёт — при новой зоне или стороне витрины камера начнёт новый кусок подсчёта (счётчики сохраняются)
    if (JSON.stringify(next) !== JSON.stringify(ch.config)) await pilot.upsert(next);
    deps.multi.refresh();
    renderSide(true);
    draw();
  }

  // ---------------------------------------------------------------- видео
  const timeOf = (v: VideoSession) => (v.phase === "ready" ? v.video.currentTime : v.tl?.duration ?? 0);

  function pickVideo(): void {
    const input = el("input");
    input.type = "file";
    input.accept = "video/*,.mov,.mp4,.m4v,.webm";
    input.addEventListener("change", () => {
      const f = input.files?.[0];
      if (f) void openVideo(f);
    });
    input.click();
  }

  async function openVideo(file: File, analyzed?: { width: number; height: number; frames: AnalyzedFrame[] }): Promise<void> {
    closeVideo();
    savedNote = "";
    const url = URL.createObjectURL(file);
    let v: HTMLVideoElement;
    try {
      v = await loadVideo(url);
    } catch (e) {
      URL.revokeObjectURL(url);
      deps.toast((e as Error).message, true);
      return;
    }
    const canvasV = el("canvas", "tw-video");
    const s: VideoSession = {
      file, url, title: file.name.replace(/\.[^.]+$/, ""), key: `video:${file.name}`, video: v, phase: "calibrating", error: "", progress: 0,
      width: analyzed?.width ?? v.videoWidth, height: analyzed?.height ?? v.videoHeight, frames: analyzed?.frames ?? [], tl: null,
      heat: new HeatCursor(), still: null, cancelled: false, canvas: canvasV,
    };
    video = s;
    vidWin.title.textContent = s.title;
    vidMsg.textContent = "Привяжите видео к плану";
    vidWin.body.replaceChildren(vidMsg);
    syncWindows();
    renderSide(true);
    draw();
    // кадр для привязки: середина ролика (там обычно есть люди) или ~5 с от начала
    const stillT = analyzed ? v.duration / 2 : v.duration > 2 ? Math.min(v.duration / 3, 5) : 0;
    try {
      s.still = await grabStill(v, stillT);
    } catch {
      s.still = null;
    }
    if (video !== s) return;
    await calibrateVideo(analyzed ? stillT : null);
  }

  async function calibrateVideo(stillT: number | null): Promise<void> {
    const s = video;
    if (!s) return;
    const c = model.plan.calibrations;
    const initial = c[s.key] ?? c["video:last"] ?? pilot.channels.map((ch) => c[ch.id]).find(Boolean) ?? null;
    const frameAt = (t: number) => {
      let best: AnalyzedFrame | null = null;
      for (const f of s.frames) if (Math.abs(f.t - t) < Math.abs((best?.t ?? 1e9) - t)) best = f;
      return best;
    };
    const boxes = stillT !== null ? frameAt(stillT)?.boxes.map((b) => b.box) ?? [] : [];
    const r = await openCalibration({
      title: `Привязка видео к плану · ${s.title}`, plan: model.plan, background: model.background, initial, colorIndex: 7, canRemove: false,
      still: () => ({ image: s.still, boxes, width: s.width, height: s.height }), message: () => "Беру кадр из видео…",
    });
    if (video !== s) return;
    if (!r) {
      if (s.phase === "calibrating") closeVideo();
      return;
    }
    model.setCalibration(r, s.key);
    model.setCalibration(r, "video:last");
    startVideo(r);
  }

  function startVideo(cal: CameraCalibration): void {
    const s = video;
    if (!s) return;
    if (s.phase === "ready" || s.frames.length) {
      // уже разобрано — только пересчитать двойник под новую привязку
      s.tl = buildVideoTimeline(s.frames, s.width, s.height, model.plan, cal);
      s.heat = new HeatCursor();
      if (s.phase !== "ready") ready(s);
      renderSide(true);
      draw();
      return;
    }
    s.phase = "analyzing";
    s.progress = 0;
    const proj = CameraProjector.create(cal, model.plan);
    if (!proj) return;
    const { cfg, entrance, fps } = deps.videoConfig();
    vidMsg.textContent = "Загружаю нейросеть…";
    renderSide(true);
    void (async () => {
      try {
        const det = await deps.getDetector();
        s.tl = null;
        const builder = new VideoTwinBuilder(proj, model.plan, s.video.videoWidth, s.video.videoHeight, new Timeline(model.plan));
        s.tl = builder.tl;
        let lastDraw = 0;
        const res = await analyzeVideo(s.video, det, cfg, entrance, fps, (f, p) => {
          builder.add(f);
          s.progress = p;
          const now = performance.now();
          if (now - lastDraw > 150) {
            lastDraw = now;
            vidMsg.textContent = `Анализ видео… ${Math.round(p * 100)}%. Когда анализ закончится, видео пойдёт с начала, а двойник на плане — синхронно с ним.`;
            draw();
            renderSide();
          }
        }, () => s.cancelled || video !== s);
        s.frames = res.frames;
        s.width = res.width;
        s.height = res.height;
        ready(s);
      } catch (e) {
        if (video !== s || s.cancelled) return;
        s.phase = "failed";
        s.error = (e as Error).message;
        vidMsg.textContent = `Анализ прервался: ${s.error}`;
        renderSide(true);
      }
    })();
  }

  function ready(s: VideoSession): void {
    s.phase = "ready";
    s.heat = new HeatCursor();
    s.canvas.width = s.width;
    s.canvas.height = s.height;
    vidWin.body.replaceChildren(s.canvas);
    s.video.currentTime = 0;
    s.video.loop = false;
    void s.video.play().catch(() => undefined);
    renderSide(true);
    draw();
  }

  /** План поменялся (зоны, магазин) — пересчитать двойник видео. */
  function replanVideo(): void {
    const s = video;
    const cal = s ? model.plan.calibrations[s.key] : null;
    if (!s || !cal || !s.frames.length) return;
    s.tl = buildVideoTimeline(s.frames, s.width, s.height, model.plan, cal);
    s.heat = new HeatCursor();
  }

  function closeVideo(): void {
    const s = video;
    if (!s) return;
    s.cancelled = true;
    s.video.pause();
    s.video.removeAttribute("src");
    s.video.load();
    URL.revokeObjectURL(s.url);
    s.still?.close();
    video = null;
    savedNote = "";
    syncWindows();
    renderSide(true);
    draw();
  }

  async function saveVideoTwin(s: VideoSession): Promise<void> {
    const tl = s.tl;
    if (!tl) return;
    const frames: RecFrame[] = tl.times.map((t, i) => ({ t, p: tl.points[i] }));
    const m = await saveRecording(s.title, "video", {
      plan: structuredClone(model.plan), cameras: [{ id: s.key, name: "видео", colorIndex: 7 }], frames,
    }, s.file, model.backgroundBlob);
    savedNote = m ? "Сохранено в «Записи»" : "Не удалось сохранить (мало места в браузере?)";
    if (m) deps.onSaved();
    renderSide(true);
  }

  function videoCard(s: VideoSession): HTMLElement {
    const nodes: Node[] = [el("p", "tw-video-title", s.title)];
    if (s.phase === "calibrating") nodes.push(el("p", "hint-small", "Привяжите видео к плану — 4 точки на полу."));
    if (s.phase === "analyzing") {
      const bar = el("div", "progress");
      const i = el("i");
      i.style.width = `${(s.progress * 100).toFixed(1)}%`;
      bar.append(i);
      nodes.push(bar, el("p", "hint-small", `Анализ ${Math.round(s.progress * 100)}%. Двойник появится вместе с видео и пойдёт синхронно с ним.`));
    }
    if (s.phase === "ready") nodes.push(el("p", "hint-small", "Видео и план идут синхронно. Окно с видео можно двигать, менять размер и разворачивать."));
    if (s.phase === "failed") nodes.push(el("p", "tw-warn", s.error));
    if (s.phase === "ready" && s.tl) {
      const n = s.tl.people(timeOf(s)).length;
      const now = el("div", "tw-now");
      now.append(el("b", "mono", String(n)), el("span", undefined, `${peopleWord(n)} на плане`));
      const tiles = el("div", "tw-tiles");
      tiles.append(tile("Людей в ролике", String(s.tl.stats.people)), tile("Пик", String(s.tl.stats.peak)));
      nodes.push(now, tiles, button("Сохранить двойника", "btn primary wide", () => void saveVideoTwin(s)));
    }
    if (savedNote) nodes.push(el("p", "tw-saved", savedNote));
    const row = el("div", "tw-row");
    row.append(button("Привязка", "btn small", () => void calibrateVideo(s.frames.length ? s.video.duration / 2 : null)),
      button("Другое видео", "btn small", () => pickVideo()), el("span", "grow"), button("Закрыть", "btn small", () => closeVideo()));
    nodes.push(row);
    return collapsible("Видео", "twin.video", ...nodes);
  }

  /** Кадр видео с рамками людей (в окне видео). */
  function drawVideoFrame(): void {
    const s = video;
    if (!s || s.phase !== "ready" || vidWin.root.hidden) return;
    const ctx = s.canvas.getContext("2d")!;
    ctx.drawImage(s.video, 0, 0, s.canvas.width, s.canvas.height);
    const t = s.video.currentTime;
    let lo = 0, hi = s.frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s.frames[mid].t <= t + 1e-3) lo = mid;
      else hi = mid - 1;
    }
    const f = s.frames[lo];
    if (f && Math.abs(f.t - t) < 0.2) drawPeople(ctx, f.boxes);
  }

  // ---------------------------------------------------------------- цикл
  model.subscribe(() => {
    if (!visible || video) return;
    draw();
    renderSide();
    syncCams();
  });
  function frameLoop(): void {
    if (visible && video?.phase === "ready") {
      drawVideoFrame();
      draw();
      renderSide();
      vidPlay.textContent = video.video.paused ? "▶" : "❚❚";
    }
    requestAnimationFrame(frameLoop);
  }
  requestAnimationFrame(frameLoop);

  return {
    model,
    show() {
      visible = true;
      root.hidden = false;
      // камеры над планом показывают картинку и без мониторинга
      if (!pilot.running) pilot.setPreview(true);
      syncWindows();
      syncCams();
      syncPlan();
      renderSide(true);
      draw();
    },
    hide() {
      visible = false;
      root.hidden = true;
      video?.video.pause();
      if (!pilot.running) pilot.setPreview(false);
      syncWindows();
    },
    openVideo,
    setupCamera,
    planChanged() {
      replanVideo();
      draw();
      renderSide(true);
    },
  };
}
