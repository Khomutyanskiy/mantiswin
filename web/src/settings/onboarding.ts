// «Первые шаги» в «Мониторинге» — порт OnboardingChecklist.swift: четыре шага от камеры до первого отчёта,
// с отметками что уже сделано. Открывается кнопкой «Первые шаги» в шапке «Мониторинга».

import { reports } from "../reports/store";
import { prefBool, setPref } from "./prefs";

export const ONBOARDING_KEY = "onboarding.shown";

export interface OnboardingDeps {
  hasCamera: () => boolean;
  hasPlan: () => boolean;
  bound: () => boolean;
  running: () => boolean;
  addCamera: () => void;
  goPlan: () => void;
  goCameras: () => void;
  start: () => void;
}

export function mountOnboarding(host: HTMLElement, d: OnboardingDeps): { render(): void; toggle(): void } {
  const render = () => {
    host.replaceChildren();
    const shown = prefBool(ONBOARDING_KEY, false);
    const started = d.running() || reports.items.some((r) => r.source === "camera" && r.started !== undefined && !r.id.startsWith("sample-"));
    const steps = [
      { title: "Камера", hint: "Добавьте веб-камеру, USB, телефон или IP-камеру", done: d.hasCamera(), act: () => (d.goCameras(), d.addCamera()) },
      { title: "План", hint: "Нарисуйте магазин, витрины и вход", done: d.hasPlan(), act: d.goPlan },
      { title: "Привязка", hint: "На карточке камеры — «Привязать»: где она на плане", done: d.bound(), act: d.goCameras },
      { title: "Запуск", hint: "«Запустить мониторинг» — отчёт сохранится при остановке", done: started, act: d.start },
    ];
    const current = steps.findIndex((s) => !s.done);
    host.hidden = !shown;
    if (!shown) return;
    host.className = "onboarding";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tip-x";
    close.textContent = "×";
    close.title = "Скрыть (открыть снова — кнопка «Первые шаги» в шапке)";
    close.addEventListener("click", () => {
      setPref(ONBOARDING_KEY, false);
      render();
    });
    if (current < 0) {
      const t = document.createElement("b");
      t.className = "ob-done";
      t.textContent = "✓ Все первые шаги сделаны — мониторинг настроен.";
      host.append(t, close);
      return;
    }
    const body = document.createElement("div");
    body.className = "ob-body";
    const title = document.createElement("div");
    title.className = "ob-title";
    title.innerHTML = `<b>Первые шаги</b> <small>${steps.filter((s) => s.done).length} из ${steps.length}</small>`;
    const line = document.createElement("div");
    line.className = "ob-steps";
    steps.forEach((s, i) => {
      const st = document.createElement("span");
      st.className = `ob-step${s.done ? " done" : ""}${i === current ? " current" : ""}`;
      const n = document.createElement("i");
      n.textContent = s.done ? "✓" : String(i + 1);
      st.append(n, document.createTextNode(s.title));
      line.append(st);
      if (i < steps.length - 1) {
        const bar = document.createElement("em");
        if (s.done) bar.className = "done";
        line.append(bar);
      }
    });
    const hint = document.createElement("small");
    hint.textContent = steps[current].hint;
    body.append(title, line, hint);
    const go = document.createElement("button");
    go.type = "button";
    go.className = "btn small primary";
    go.textContent = current === steps.length - 1 ? "Запустить" : "Сделать";
    go.addEventListener("click", () => {
      steps[current].act();
      setTimeout(render, 300);
    });
    host.append(body, go, close);
  };
  reports.subscribe(render);
  return {
    render,
    toggle() {
      setPref(ONBOARDING_KEY, !prefBool(ONBOARDING_KEY, false));
      render();
    },
  };
}
