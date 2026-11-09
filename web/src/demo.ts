// Раздел «Демо»: свой план (магазин, витрины, входы, штендеры, зоны — тот же редактор, что в мониторинге)
// и придуманные прохожие на нём. Камеры не нужны, план и итоги мониторинга не трогаются — показать клиенту, как это работает.

import { type CameraRef, mountPlanEditor } from "./twin/editors";
import { TwinModel } from "./twin/model";
import { paintPlan, personColor } from "./twin/paint";
import {
  type CameraMark, type TwinPerson, type TwinPlan, averageDwell, cameraColor, cameraMark, fmtDuration, fmtM, insideShop, peopleWord, rayInside, zoneColor,
} from "./twin/plan";
import { saveRecording } from "./twin/store";
import { newReport, reports } from "./reports/store";
import { layerChips, loadLayers } from "./twin/view";
import { ask } from "./ui/confirm";

type Step = "plan" | "run";
const STEP_KEY = "demo.step";
const STORAGE = { plan: "mantis.demo.plan.v1", stats: "mantis.demo.today.v1", bg: "demo:plan" };
const CAMS_KEY = "mantis.demo.cameras.v1";

function loadCams(): CameraRef[] {
  try {
    const v = JSON.parse(localStorage.getItem(CAMS_KEY) ?? "[]") as CameraRef[];
    return Array.isArray(v) ? v.filter((c) => c && c.id && c.name) : [];
  } catch {
    return [];
  }
}
function saveCams(c: CameraRef[]): void {
  try {
    localStorage.setItem(CAMS_KEY, JSON.stringify(c));
  } catch {
    /* нет */
  }
}

/** Человек в секторе камеры: ближе дальности, в пределах угла обзора и не за краем плана. */
function sees(m: CameraMark, p: { x: number; y: number }): boolean {
  const dx = p.x - m.position.x, dy = p.y - m.position.y;
  const d = Math.hypot(dx, dy);
  if (d > m.range || d < 0.05) return false;
  let a = Math.atan2(dy, dx) - m.angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return Math.abs(a) <= m.fov / 2 && d <= rayInside(m, Math.atan2(dy, dx)) + 1e-6;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
function button(text: string, cls: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

export interface DemoView {
  show(): void;
  hide(): void;
  /** Демо идёт (прохожие ходят). */
  isRunning(): boolean;
  /** Снимок демо для облака (как демо на iPhone): план, прохожие, камеры, счётчики с запуска. null — демо не идёт. */
  snapshot(): DemoSnapshot | null;
}

export interface DemoSnapshot {
  plan: TwinPlan;
  people: TwinPerson[];
  cameras: { id: string; name: string; inFrame: number }[];
  counts: { passed: number; slowed: number; looked: number; entered: number };
}

export function mountDemo(root: HTMLElement, deps: {
  /** План мониторинга — чтобы взять его за основу. */
  livePlan: () => { plan: import("./twin/plan").TwinPlan; background: Blob | null };
  onSaved: () => void;
  toast: (t: string, err?: boolean) => void;
}): DemoView {
  const firstTime = (() => {
    try {
      return localStorage.getItem(STORAGE.plan) === null;
    } catch {
      return false;
    }
  })();
  const model = new TwinModel(() => [], STORAGE);
  // в первый раз план демо — копия плана мониторинга (при первом открытии раздела: к этому времени оба плана загружены)
  let needCopy = firstTime;
  let visible = false;
  let running = false;
  let step: Step = (() => {
    try {
      return localStorage.getItem(STEP_KEY) === "run" ? "run" : "plan";
    } catch {
      return "plan";
    }
  })();
  let savedNote = "";
  let startedAt = 0;
  let cams = loadCams();
  /** Кого каждая камера видела за запуск (id прохожих). */
  let seen = new Map<string, Set<string>>();
  /** Счётчики с запуска: кто притормозил, посмотрел, зашёл в магазин. */
  let counted = { slowed: new Set<string>(), looked: new Set<string>(), entered: new Set<string>() };
  /** Значки камер по порядку списка (null — камера без места на плане). */
  const camMarks = (): (CameraMark | null)[] =>
    cams.map((c) => {
      const cal = model.plan.calibrations[c.id];
      return cal ? cameraMark(c.name, c.colorIndex, cal, model.plan) : null;
    });
  const marks = (): CameraMark[] => camMarks().filter((m): m is CameraMark => !!m);
  /** План мониторинга за основу; придуманные камеры демо остаются на своих местах. */
  const fromLive = (): Promise<void> => {
    const lp = deps.livePlan();
    const keep = Object.fromEntries(cams.flatMap((c) => (model.plan.calibrations[c.id] ? [[c.id, model.plan.calibrations[c.id]]] : [])));
    return model.savePlan({ ...structuredClone(lp.plan), calibrations: structuredClone(keep) }, lp.background);
  };

  // ---------------------------------------------------------------- шапка
  const head = el("div", "mon-head");
  const seg = el("div", "seg mon-steps");
  seg.style.gridTemplateColumns = "repeat(2, 1fr)";
  const radios = new Map<Step, HTMLInputElement>();
  for (const [v, t] of [["plan", "1 · План"], ["run", "2 · Демо"]] as [Step, string][]) {
    const label = el("label");
    const input = el("input");
    input.type = "radio";
    input.name = "demo-step";
    input.addEventListener("change", () => input.checked && go(v));
    label.append(input, el("span", undefined, t));
    seg.append(label);
    radios.set(v, input);
  }
  const copyBtn = button("Взять план мониторинга", "btn small", async () => {
    if (!(await ask({ title: "Заменить план демо?", text: "План демо станет копией плана из «Мониторинга». Текущий план демо пропадёт.", ok: "Заменить" }))) return;
    await fromLive();
    resetRun();
    apply();
    deps.toast("План демо — копия плана мониторинга");
  }, "План магазина из раздела «Мониторинг» — за основу");
  head.append(seg, el("span", "grow"), copyBtn);

  const planRoot = el("section", "plan-step");
  const runRoot = el("section", "twin");
  root.append(head, planRoot, runRoot);

  // ---------------------------------------------------------------- демо: план и панель
  const main = el("div", "tw-main");
  const layers = loadLayers();
  const layersBar = layerChips(layers, () => draw(), "Тепло за демо");
  const area = el("div", "tw-area");
  const canvas = el("canvas", "tw-plan");
  area.append(canvas);
  const planHead = el("div", "tw-row");
  planHead.append(layersBar);
  const legend = el("div", "tw-legend");
  for (const [st, t] of [["tracked", "идёт"], ["passed", "прошёл"], ["slowed", "притормозил"], ["looked", "смотрит"]] as const) {
    const s = el("span");
    const d = el("i", "tw-dot");
    d.style.background = personColor(st);
    s.append(d, document.createTextNode(t));
    legend.append(s);
  }
  main.append(planHead, area, legend);
  const side = el("aside", "tw-side");
  runRoot.append(main, side);

  function draw(): void {
    if (!visible || step !== "run") return;
    paintPlan(canvas, {
      plan: model.plan, background: model.background, stats: model.stats, heatMax: model.heatMax,
      people: model.people, occupancy: model.occupancy, cameras: marks(), layers,
    });
  }

  function tile(title: string, value: string): HTMLElement {
    const t = el("div", "tw-tile");
    t.append(el("b", "mono", value), el("span", undefined, title));
    return t;
  }

  let sideKey = "";
  function renderSide(force = false): void {
    if (!visible || step !== "run") return;
    const rec = model.recorder ? Math.floor((performance.now() - model.recorder.started) / 1000) : -1;
    const ms = camMarks();
    const nowSeen = ms.map((m) => (m ? model.people.filter((p) => sees(m, p.pos)).length : 0));
    const k = JSON.stringify([running, nowSeen, [...seen.values()].map((s) => s.size), model.people.length, model.stats.peak, model.stats.people, model.occupancy, model.stats.visits, rec, savedNote,
      Math.round(Object.values(model.stats.dwell).reduce((a, b) => a + b, 0))]);
    if (!force && k === sideKey) return;
    sideKey = k;
    const nodes: Node[] = [];
    const now = el("div", "tw-now");
    now.append(el("b", "mono", String(model.people.length)), el("span", undefined, `${peopleWord(model.people.length)} на плане`));
    const tiles = el("div", "tw-tiles");
    tiles.append(tile("Пик", String(model.stats.peak)), tile("Всего прохожих", String(model.stats.people)));
    nodes.push(now, tiles);
    if (!running) {
      nodes.push(button("▶ Запустить демо", "btn primary wide", () => {
        resetRun();
        seen = new Map();
        counted = { slowed: new Set(), looked: new Set(), entered: new Set() };
        running = true;
        startedAt = Date.now();
        model.setDemo(true);
        model.start();
        // цифровой двойник демо пишется сам и попадает в отчёт (как DemoView.swift на Mac)
        if (!model.recorder) model.startRecording(cams.map((c) => ({ id: c.id, name: c.name, colorIndex: c.colorIndex })));
        renderSide(true);
      }));
      nodes.push(el("p", "hint-small", "Придуманные прохожие идут по улице, останавливаются у штендеров и витрины, заходят в магазин через вход. Камеры не нужны."));
    } else {
      nodes.push(button("■ Остановить демо", "btn danger wide", () => void stopRun()));
      if (model.recorder) {
        nodes.push(button(`■ Остановить запись · ${Math.floor(rec / 60)}:${String(rec % 60).padStart(2, "0")}`, "btn wide tw-rec-on", () => void stopRecording()));
      } else {
        nodes.push(button("● Записать демо", "btn wide", () => {
          savedNote = "";
          model.startRecording([]);
          renderSide(true);
        }, "Потом можно пересмотреть в разделе «Записи»"));
      }
    }
    if (savedNote) nodes.push(el("p", "tw-saved", savedNote));

    // придуманные камеры
    if (cams.length) {
      nodes.push(el("p", "eyebrow", "Камеры"));
      cams.forEach((c, i) => {
        const r = el("div", "tw-zone");
        const bar = el("i", "tw-zone-bar");
        bar.style.background = cameraColor(c.colorIndex);
        const txt = el("div", "tw-zone-text");
        txt.append(el("b", undefined, c.name), el("span", "mono small faint", `видела за демо: ${seen.get(c.id)?.size ?? 0}`));
        const cnt = el("b", "mono tw-zone-now", String(nowSeen[i] ?? 0));
        cnt.title = "Сейчас в кадре";
        if (nowSeen[i]) cnt.style.color = cameraColor(c.colorIndex);
        r.append(bar, txt, cnt);
        nodes.push(r);
      });
    } else nodes.push(el("p", "hint-small", "Камеры можно поставить на шаге «1 · План» — «Добавить камеру»."));

    // зоны
    if (model.plan.zones.length) {
      nodes.push(el("p", "eyebrow", "Зоны"));
      for (const z of model.plan.zones) {
        const r = el("div", "tw-zone");
        const bar = el("i", "tw-zone-bar");
        bar.style.background = zoneColor(z.color);
        const txt = el("div", "tw-zone-text");
        const avg = averageDwell(model.stats, z.id);
        txt.append(el("b", undefined, z.name), el("span", "mono small faint", `заходов ${model.stats.visits[z.id] ?? 0} · в среднем ${avg !== null ? fmtDuration(avg) : "—"}`));
        const n = model.occupancy[z.id] ?? 0;
        const cnt = el("b", "mono tw-zone-now", String(n));
        if (n > 0) cnt.style.color = zoneColor(z.color);
        r.append(bar, txt, cnt);
        nodes.push(r);
      }
    } else nodes.push(el("p", "hint-small", "Зоны (витрина, вход, касса) рисуются на шаге «1 · План» — тогда здесь будет видно, сколько людей туда заходит."));
    nodes.push(el("p", "mono small faint", `План ${fmtM(model.plan.widthM)} × ${fmtM(model.plan.depthM)} м`));
    side.replaceChildren(...nodes);
  }

  model.subscribe(() => {
    if (running) {
      const ms = camMarks();
      cams.forEach((c, i) => {
        const m = ms[i];
        if (!m) return;
        let s = seen.get(c.id);
        if (!s) seen.set(c.id, (s = new Set()));
        for (const p of model.people) if (sees(m, p.pos)) s.add(p.id);
      });
      for (const p of model.people) {
        if (p.state === "slowed" || p.state === "looked") counted.slowed.add(p.id);
        if (p.state === "looked") counted.looked.add(p.id);
        if (insideShop(model.plan, p.pos)) counted.entered.add(p.id);
      }
    }
    draw();
    renderSide();
  });
  new ResizeObserver(() => draw()).observe(area);

  async function stopRecording(): Promise<string | null> {
    const r = model.stopRecording();
    if (!r) return null;
    const name = `Демо ${new Date().toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
    const m = await saveRecording(name, "demo", r.data, null, model.backgroundBlob);
    savedNote = m ? `Сохранено в «Записи»: ${name}` : "Не удалось сохранить";
    if (m) deps.onSaved();
    renderSide(true);
    return m?.id ?? null;
  }

  async function stopRun(): Promise<void> {
    const twinID = model.recorder ? await stopRecording() : null;
    const wasRunning = running;
    running = false;
    model.stop();
    // отчёт запуска демо — в «Статистика → Отчёты» с пометкой «Демо»
    const duration = (Date.now() - startedAt) / 1000;
    if (wasRunning && startedAt && duration >= 5) {
      const hasDoors = model.plan.doors.length > 0;
      const r = newReport({
        source: "demo", title: cams.length > 1 ? `Демо · ${cams.length} камеры` : "Демо", duration, started: startedAt,
        people: model.stats.people, slowed: counted.slowed.size, looked: counted.looked.size,
        entered: hasDoors ? counted.entered.size : undefined, twinID: twinID ?? undefined,
        cameras: cams.length ? cams.map((c) => ({ name: c.name, people: seen.get(c.id)?.size ?? 0, passed: 0, slowed: 0, looked: 0, seconds: duration })) : undefined,
      });
      reports.add(r);
      deps.toast?.("Отчёт демо сохранён — «Статистика» → «Отчёты»");
    }
    renderSide(true);
    draw();
  }

  /** Новый запуск — с чистой тепловой картой и счётчиками. */
  function resetRun(): void {
    if (running) {
      model.stop();
      running = false;
    }
    model.setDemo(false);
  }

  // ---------------------------------------------------------------- шаги
  function apply(): void {
    for (const [v, r] of radios) r.checked = v === step;
    planRoot.hidden = step !== "plan";
    runRoot.hidden = step !== "run";
    if (step !== "plan" || !visible) planRoot.replaceChildren(); // встроенный редактор сам сохранит несохранённое
    if (!visible) return;
    if (step === "plan") {
      mountPlanEditor(planRoot, {
        plan: model.plan, background: model.background, cameras: cams,
        editCameras: (c) => saveCams((cams = c)),
      }, (r) => {
        void model.savePlan(r.plan, r.background);
      });
    } else {
      renderSide(true);
      requestAnimationFrame(draw);
    }
  }

  function go(s: Step): void {
    // план поменяли во время демо — прохожие начинают заново
    if (s === "plan" && running) void stopRun();
    step = s;
    try {
      localStorage.setItem(STEP_KEY, s);
    } catch {
      /* нет */
    }
    apply();
  }

  root.hidden = true;
  return {
    isRunning: () => running,
    snapshot() {
      if (!running) return null;
      const ms = camMarks();
      return {
        plan: model.plan,
        people: model.people,
        cameras: cams.flatMap((c, i) => {
          const m = ms[i];
          return m ? [{ id: c.id, name: c.name, inFrame: model.people.filter((p) => sees(m, p.pos)).length }] : [];
        }),
        counts: { passed: model.stats.people, slowed: counted.slowed.size, looked: counted.looked.size, entered: counted.entered.size },
      };
    },
    show() {
      visible = true;
      root.hidden = false;
      if (needCopy) {
        needCopy = false;
        void fromLive().then(() => apply());
        return;
      }
      apply();
    },
    hide() {
      visible = false;
      root.hidden = true;
      apply();
    },
  };
}
