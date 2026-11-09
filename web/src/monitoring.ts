// Раздел «Мониторинг»: три шага в порядке работы — 1 · Камеры → 2 · План → 3 · Мониторинг (запуск, камеры над планом,
// живой план, итоги). Плюс «Быстрый показ» — одна камера без плана. Как MonitoringView.swift в Mantis для Mac.

import { channelColorIndex, channelShort } from "./multi/channel";
import type { MultiView } from "./multi/view";
import { mountPlanEditor } from "./twin/editors";
import type { TwinView } from "./twin/view";
import { mountOnboarding } from "./settings/onboarding";
import { hasShop } from "./twin/plan";
import { type HelpTopic, helpButton } from "./ui/help";

export type MonitoringStep = "cameras" | "plan" | "monitor";

const STEPS: [MonitoringStep, string, HelpTopic][] = [
  ["cameras", "1 · Камеры", "cameras"],
  ["plan", "2 · План", "plan"],
  ["monitor", "3 · Мониторинг", "monitoring"],
];
const STEP_KEY = "monitoring.step";

export interface MonitoringView {
  show(): void;
  hide(): void;
  go(step: MonitoringStep): void;
  current(): MonitoringStep;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
function uptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d} д ${h} ч` : h > 0 ? `${h} ч ${pad2(m)} мин` : `${m} мин ${pad2(s % 60)} с`;
}

export function mountMonitoring(o: {
  root: HTMLElement;
  head: HTMLElement;
  planRoot: HTMLElement;
  multiRoot: HTMLElement;
  multi: MultiView;
  twin: TwinView;
  /** «Быстрый показ»: одна камера без плана (вкладка «Анализ» с камерой). */
  quickShow: () => void;
}): MonitoringView {
  const { multi, twin } = o;
  const pilot = multi.model;
  let visible = false;
  let step: MonitoringStep = (() => {
    try {
      const s = localStorage.getItem(STEP_KEY) as MonitoringStep | null;
      return s && STEPS.some((x) => x[0] === s) ? s : "cameras";
    } catch {
      return "cameras";
    }
  })();

  // ---------------------------------------------------------------- шапка
  const seg = document.createElement("div");
  seg.className = "seg mon-steps";
  seg.setAttribute("role", "radiogroup");
  seg.style.gridTemplateColumns = "repeat(3, 1fr)";
  const radios = new Map<MonitoringStep, HTMLInputElement>();
  for (const [v, t] of STEPS) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "mon-step";
    input.value = v;
    input.addEventListener("change", () => input.checked && go(v));
    const span = document.createElement("span");
    span.textContent = t;
    label.append(input, span);
    seg.append(label);
    radios.set(v, input);
  }
  const grow = document.createElement("span");
  grow.className = "grow";
  const status = document.createElement("button");
  status.type = "button";
  status.className = "mon-status";
  status.addEventListener("click", () => pilot.running && go("monitor"));
  const quick = document.createElement("button");
  quick.type = "button";
  quick.className = "btn small";
  quick.textContent = "Быстрый показ";
  quick.title = "Одна камера без плана — сразу показать клиенту подсчёт";
  quick.addEventListener("click", () => o.quickShow());
  const firstSteps = document.createElement("button");
  firstSteps.type = "button";
  firstSteps.className = "btn small ghost";
  firstSteps.textContent = "Первые шаги";
  firstSteps.title = "Четыре шага от камеры до первого отчёта";
  const helpSlot = document.createElement("span");
  o.head.append(seg, grow, status, firstSteps, quick, helpSlot);
  const obHost = document.createElement("div");
  obHost.hidden = true;
  o.head.after(obHost);
  const onboarding = mountOnboarding(obHost, {
    hasCamera: () => pilot.channels.length > 0,
    hasPlan: () => hasShop(twin.model.plan) || twin.model.plan.zones.length > 0,
    bound: () => pilot.channels.some((c) => !!twin.model.plan.calibrations[c.id]),
    running: () => pilot.running,
    addCamera: () => multi.addCamera(),
    goPlan: () => go("plan"),
    goCameras: () => go("cameras"),
    start: () => void multi.setRunning(true).then(() => go("monitor")),
  });
  firstSteps.addEventListener("click", () => onboarding.toggle());
  setInterval(() => visible && !obHost.hidden && onboarding.render(), 3000);

  function renderStatus(): void {
    if (pilot.running) {
      status.dataset.state = pilot.state === "recovering" ? "recovering" : "on";
      status.textContent = pilot.startedAt ? `Мониторинг идёт · ${uptime((Date.now() - pilot.startedAt) / 1000)}` : "Мониторинг идёт";
      status.disabled = false;
    } else {
      status.dataset.state = "off";
      status.textContent = pilot.channels.length ? "Мониторинг остановлен" : "Нет камер";
      status.disabled = true;
    }
  }
  setInterval(() => visible && renderStatus(), 1000);

  // ---------------------------------------------------------------- шаги
  function showPlan(): void {
    const cams = pilot.channels.map((ch, i) => ({ id: ch.id, name: channelShort(ch.config), colorIndex: channelColorIndex(ch.config, i) }));
    mountPlanEditor(o.planRoot, { plan: twin.model.plan, background: twin.model.background, cameras: cams }, (r) => {
      void twin.model.savePlan(r.plan, r.background).then(() => twin.planChanged());
    });
  }

  function apply(): void {
    for (const [v, , topic] of STEPS) {
      radios.get(v)!.checked = v === step;
      if (v === step) helpSlot.replaceChildren(helpButton(topic));
    }
    // спрятать всё, затем показать нужный шаг
    multi.hide();
    twin.hide();
    if (step !== "plan") o.planRoot.replaceChildren(); // встроенный редактор сам сохранит несохранённое
    o.planRoot.hidden = step !== "plan";
    if (!visible) return;
    if (step === "cameras") multi.show();
    else if (step === "plan") showPlan();
    else twin.show();
    renderStatus();
  }

  function go(s: MonitoringStep): void {
    step = s;
    try {
      localStorage.setItem(STEP_KEY, s);
    } catch {
      /* нет */
    }
    apply();
    window.dispatchEvent(new CustomEvent("mantis:step", { detail: s }));
  }

  return {
    show() {
      visible = true;
      o.head.parentElement!.hidden = false;
      if (pilot.running) step = "monitor";
      apply();
      onboarding.render();
    },
    hide() {
      visible = false;
      o.head.parentElement!.hidden = true;
      multi.hide();
      twin.hide();
      o.planRoot.replaceChildren();
      o.planRoot.hidden = true;
    },
    go,
    current: () => step,
  };
}
