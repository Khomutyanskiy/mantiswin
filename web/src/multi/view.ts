// Экран «Пилот» настольной версии: несколько камер сеткой, как в Mantis для Mac.
// Сетка (Авто / Крупно / Средне / Мелко / Мини), камера на всё окно, у каждой камеры — своя разметка
// и чувствительность, итоги за сегодня по каждой камере и суммарно.

import { ask } from "../ui/confirm";
import type { Account } from "../cloud/account";
import type { Detector } from "../detector";
import { agentAutostart, agentInfo, agentQuit, desktopInfo, isDesktop, quitApp, setAutostart } from "../desktop";
import type { ShowcaseDirection } from "../engine/headpose";
import type { FrameResult } from "../engine/session";
import { listCameras } from "../pilot/runner";
import { type HourStat } from "../pilot/hours";
import { drawMarkup, drawPeople } from "../ui/draw";
import { chooseIpCamera } from "../ui/ipcam";
import { autoScanPanel } from "./autoscan";
import { stoppedManually } from "../pilot/schedule";
import { type PtzInfo, ptzMove, ptzProbe, ptzStop } from "../sources";
import type { IpCameraConfig } from "../sources";
import { type Channel, type ChannelConfig, channelColorIndex, channelLabel, newChannelConfig } from "./channel";
import { cameraColor } from "../twin/plan";
import { filterSummary } from "./filter";
import { sensitivityDialog } from "./sensitivity";
import { MultiPilot, type RunEnd } from "./model";

export interface MultiDeps {
  account: Account;
  getDetector: () => Promise<Detector>;
  resetDetector: () => void;
  toast: (text: string, error?: boolean) => void;
  openAccount: () => void;
  /** «Настроить» в блоке «Расположение камер»: где витрина и привязка к плану. */
  onSetup?: (ch: Channel) => void;
  /** Привязка камеры к плану одной строкой («на плане по полу», «не привязана к плану»). */
  bindingText?: (ch: Channel) => { text: string; ok: boolean };
  /** Запуск и конец мониторинга (запись двойника, отчёт запуска). */
  onRunStart?: () => void;
  onRunEnd?: (run: RunEnd, closing: boolean) => void | Promise<void>;
}

export interface MultiView {
  readonly model: MultiPilot;
  show(): void;
  hide(): void;
  /** Пилот шёл до перезапуска приложения — продолжить. */
  resume(): Promise<void>;
  /** Подписка на кадры всех камер (цифровой двойник). */
  onFrame(cb: (ch: Channel, shot: ImageBitmap, fr: FrameResult | null) => void): () => void;
  /** Запустить или остановить пилот (как кнопка на экране пилота). */
  setRunning(on: boolean): Promise<void>;
  /** Открыть окно добавления камеры. */
  addCamera(): void;
  /** Камера на всё окно. */
  focus(id: string): void;
  /** Блок «Аккаунт / Приложение» (показывается на шаге «Мониторинг»). */
  readonly foot: HTMLElement;
  /** Перерисовать (поменялась привязка камер). */
  refresh(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function button(text: string, cls = "btn small", onClick?: (e: MouseEvent) => void): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

type GridSize = "auto" | "large" | "medium" | "small" | "mini";
const GRID_TITLES: [GridSize, string][] = [["auto", "Авто"], ["large", "Крупно"], ["medium", "Средне"], ["small", "Мелко"], ["mini", "Мини"]];
const GRID_KEY = "mantis.multi.grid";

interface TileRefs {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  msg: HTMLElement;
  name: HTMLElement;
  kind: HTMLElement;
  meta: HTMLElement;
  stats: HTMLElement;
  bindText: HTMLElement;
  dot: HTMLElement;
  filter: HTMLElement;
}

/** Сегмент-переключатель (как .seg в остальном интерфейсе). */
function segmented<T extends string>(name: string, items: [T, string][], value: T, onPick: (v: T) => void, cls = "seg"): HTMLElement {
  const seg = el("div", cls);
  seg.setAttribute("role", "radiogroup");
  seg.style.gridTemplateColumns = `repeat(${items.length}, 1fr)`;
  for (const [v, t] of items) {
    const label = el("label");
    const input = el("input");
    input.type = "radio";
    input.name = name;
    input.value = v;
    input.checked = v === value;
    input.addEventListener("change", () => input.checked && onPick(v));
    label.append(input, el("span", undefined, t));
    seg.append(label);
  }
  return seg;
}

export function mountMulti(root: HTMLElement, deps: MultiDeps): MultiView {
  let visible = false;
  let hostname = "";
  const tiles = new Map<string, TileRefs>();
  let tileOrder = "";
  let dragId: string | null = null;
  let focusId: string | null = null;
  let gridSize: GridSize = (() => {
    try {
      return (localStorage.getItem(GRID_KEY) as GridSize) || "auto";
    } catch {
      return "auto";
    }
  })();

  // ---------------------------------------------------------------- модель
  const model = new MultiPilot({
    account: deps.account,
    getDetector: deps.getDetector,
    resetDetector: deps.resetDetector,
    hostname: () => hostname,
    onFrame: (ch, shot, fr) => drawFrame(ch, shot, fr),
    onChange: () => scheduleUpdate(),
    onRunStart: () => deps.onRunStart?.(),
    onRunEnd: (run, closing) => deps.onRunEnd?.(run, closing),
  });

  // ---------------------------------------------------------------- каркас
  const head = el("div", "multi-head");
  const stateBox = el("div", "pilot-state");
  stateBox.dataset.state = "stopped";
  const stateText = el("span", undefined, "Мониторинг не запущен");
  stateBox.append(el("span", "dot"), stateText);
  const metaText = el("p", "mono small faint");
  const headLeft = el("div", "multi-title");
  headLeft.append(stateBox, metaText);

  const btnAdd = button("Добавить камеру", "btn small", () => openCameraDialog(null));
  const btnStart = button("Запустить мониторинг", "btn primary", async () => {
    if (model.running && !(await ask({
      title: "Остановить мониторинг?",
      text: "Подсчёт на всех камерах остановится, статистика сохранится.",
      ok: "Остановить", danger: true,
    }))) return;
    void toggleRun();
  });
  const btnFull = button("Во весь экран", "btn small", () => toggleKiosk());
  const gridSeg = segmented("multi-grid", GRID_TITLES, gridSize, (v) => {
    gridSize = v;
    try {
      localStorage.setItem(GRID_KEY, v);
    } catch {
      /* нет */
    }
    applyGrid();
  }, "seg compact");
  const headRight = el("div", "multi-controls");
  headRight.append(gridSeg, btnAdd, btnFull, btnStart);
  head.append(headLeft, headRight);

  const today = el("dl", "multi-today");
  const todayCells = {
    people: cell("Людей в зоне"), passed: cell("Прошли мимо"), looked: cell("Посмотрели"), slowed: cell("Притормозили"), entered: cell("Зашли"),
  };
  function cell(title: string): { dd: HTMLElement; note: HTMLElement; box: HTMLElement } {
    const box = el("div", "counter");
    const dd = el("dd", "mono", "0");
    const note = el("span", "rate mono");
    box.append(el("dt", undefined, title), dd, note);
    today.append(box);
    return { dd, note, box };
  }

  const grid = el("div", "cam-grid");
  const empty = el("div", "multi-empty");
  empty.append(
    el("h1", undefined, "Мониторинг на нескольких камерах"),
    el("p", "lead", "Компьютер у витрины считает людей круглосуточно сразу с нескольких камер: встроенной, USB и IP-камер в сети магазина. У каждой камеры — своя разметка и своя статистика, итоги по часам уходят в облако и видны на iPhone, Mac и в браузере."),
    (() => {
      const ol = el("ol", "intro-steps");
      for (const t of [
        "Войдите в аккаунт Mantis («Профиль» в меню слева) — иначе статистика останется только на этом компьютере.",
        "Добавьте камеры и разметьте кадр каждой: зона витрины, линия прохода, вход.",
        isDesktop
          ? "Нажмите «Запустить мониторинг». Окно можно свернуть или закрыть в трей — подсчёт продолжится."
          : "Нажмите «Запустить мониторинг». Держите вкладку открытой на экране, компьютер — на зарядке.",
      ]) ol.append(el("li", undefined, t));
      return ol;
    })(),
    button("Добавить камеру", "btn primary", () => openCameraDialog(null)),
  );

  const foot = el("div", "multi-foot");
  const accountBox = el("div", "account-box");
  const syncLine = el("p", "mono small faint");
  const appBox = el("div", "agent-box");
  const autostartInput = el("input");
  autostartInput.type = "checkbox";
  autostartInput.className = "switch";
  autostartInput.id = "multi-autostart";
  const autoRow = el("label", "toggle-row");
  autoRow.htmlFor = "multi-autostart";
  const autoText = el("div", "toggle-text");
  const autoTitle = el("b", undefined, "Запускать при входе в Windows");
  autoText.append(autoTitle, el("small", undefined, "После перезагрузки компьютера мониторинг продолжится сам"));
  autoRow.append(autoText, autostartInput);
  const versionLine = el("p", "mono small faint");
  let viaAgent = false;
  const quitBtn = button("Выйти из Mantis", "link", async () => {
    if (model.running) {
      deps.toast("Сначала остановите мониторинг", true);
      return;
    }
    if (!viaAgent) return quitApp();
    await agentQuit();
    document.body.replaceChildren(Object.assign(document.createElement("p"), {
      className: "empty",
      textContent: "Агент выключен. Чтобы продолжить, запустите Mantis Agent снова.",
    }));
  });
  appBox.append(el("p", "eyebrow", "Приложение"), autoRow, quitBtn, versionLine);
  const footLeft = el("div", "multi-foot-col");
  footLeft.append(el("p", "eyebrow", "Аккаунт"), accountBox, syncLine);
  foot.append(footLeft, appBox);

  // шаг «Камеры»: заголовок со стрелкой сворачивает сетку; запуск, итоги и аккаунт — на шаге «Мониторинг»
  const GRID_COLLAPSE = "collapse.cams.grid", BIND_COLLAPSE = "collapse.cams.binding";
  const isCollapsed = (k: string) => {
    try {
      return localStorage.getItem(k) === "1";
    } catch {
      return false;
    }
  };
  const setCollapsed = (k: string, v: boolean) => {
    try {
      if (v) localStorage.setItem(k, "1");
      else localStorage.removeItem(k);
    } catch {
      /* нет */
    }
  };
  const collapseHead = (title: string, key: string, onToggle: () => void) => {
    const b = el("button", "collapse-head");
    b.type = "button";
    const arrow = el("span", "collapse-arrow", "▾");
    const t = el("span", "collapse-title", title);
    const n = el("span", "collapse-count");
    b.append(arrow, t, n);
    b.addEventListener("click", () => {
      setCollapsed(key, !isCollapsed(key));
      onToggle();
    });
    return { b, n, sync: () => b.classList.toggle("collapsed", isCollapsed(key)) };
  };
  const gridHead = collapseHead("Камеры", GRID_COLLAPSE, () => update());
  headLeft.replaceChildren(gridHead.b);
  today.hidden = true;
  btnStart.hidden = true;
  btnFull.hidden = true;

  const bindBox = el("section", "bind-card");
  const bindHead = collapseHead("Расположение камер", BIND_COLLAPSE, () => update());
  const bindTop = el("div", "bind-top");
  const bindList = el("div", "bind-list");
  bindTop.append(bindHead.b);
  bindBox.append(bindTop, bindList);
  root.append(head, grid, empty, bindBox);

  autostartInput.addEventListener("change", async () => {
    if (viaAgent) {
      try {
        autostartInput.checked = await agentAutostart(autostartInput.checked);
        deps.toast(autostartInput.checked ? "Агент будет запускаться при входе в систему" : "Автозапуск выключен");
      } catch (e) {
        autostartInput.checked = !autostartInput.checked;
        deps.toast(`Автозапуск: ${(e as Error).message}`, true);
      }
      return;
    }
    const r = await setAutostart(autostartInput.checked);
    if (r === null) {
      autostartInput.checked = !autostartInput.checked;
      deps.toast("Автозапуск недоступен", true);
      return;
    }
    autostartInput.checked = r;
    deps.toast(r ? "Mantis будет запускаться при входе в Windows" : "Автозапуск выключен");
  });
  appBox.hidden = true;
  void desktopInfo().then(async (info) => {
    if (!info) {
      // в браузере: если страницу отдаёт Mantis Агент — его автозапуск и выключение
      const a = await agentInfo();
      if (!a) return;
      viaAgent = true;
      appBox.hidden = false;
      autoTitle.textContent = "Запускать при входе в систему";
      autostartInput.checked = a.autostart;
      quitBtn.textContent = "Выключить агента";
      versionLine.textContent = `Mantis Агент ${a.version}`;
      hostname = a.platform === "darwin" ? "Mac" : a.platform === "win32" ? "Windows" : "";
      return;
    }
    appBox.hidden = false;
    hostname = info.hostname;
    autostartInput.checked = info.autostart;
    versionLine.textContent = `Mantis для Windows ${info.version}`;
  });

  // ---------------------------------------------------------------- камера на всё окно
  const focus = el("div", "cam-focus");
  focus.hidden = true;
  const focusCanvas = el("canvas");
  const focusTitle = el("b");
  const focusMeta = el("span", "mono small faint");
  const focusStats = el("div", "cam-focus-stats mono");
  const focusHead = el("div", "cam-focus-head");
  const focusClose = button("Закрыть", "btn small", () => setFocus(null));
  const focusTitleBox = el("div", "multi-title");
  focusTitleBox.append(focusTitle, focusMeta);
  focusHead.append(focusTitleBox, focusStats, focusClose);
  const focusView = el("div", "cam-focus-view");
  focusView.append(focusCanvas);
  focus.append(focusHead, focusView);
  document.body.append(focus);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && focusId) setFocus(null);
  });

  function setFocus(id: string | null): void {
    focusId = id;
    focus.hidden = !id;
    document.body.classList.toggle("cam-focused", !!id);
    update();
  }

  // ---------------------------------------------------------------- рисование кадров
  const frameListeners = new Set<(ch: Channel, shot: ImageBitmap, fr: FrameResult | null) => void>();
  function drawFrame(ch: Channel, shot: ImageBitmap, fr: FrameResult | null): void {
    for (const cb of frameListeners) cb(ch, shot, fr);
    if (sens.channelId === ch.id) sens.frame(ch, shot, fr);
    // камера на всё окно открывается и с шага «Мониторинг» (сетка камер при этом скрыта)
    if (!visible && focusId !== ch.id) return;
    const targets: HTMLCanvasElement[] = [];
    const t = tiles.get(ch.id);
    if (t && !focusId && visible) targets.push(t.canvas);
    if (focusId === ch.id) targets.push(focusCanvas);
    for (const c of targets) {
      if (c.width !== shot.width || c.height !== shot.height) {
        c.width = shot.width;
        c.height = shot.height;
      }
      const ctx = c.getContext("2d")!;
      ctx.drawImage(shot, 0, 0);
      // на кадре — только зона витрины (линия и вход не рисуются: их больше не настраивают)
      drawMarkup(ctx, { ...ch.config.markup, lineEnabled: false, entranceEnabled: false });
      if (fr) drawPeople(ctx, fr.boxes);
    }
    if (t) t.msg.hidden = true;
  }

  // ---------------------------------------------------------------- плитки
  // ---------------------------------------------------------------- поворот IP-камеры (PTZPad.swift)
  const ptzInfo = new Map<string, { url: string; info: PtzInfo | null | "pending" }>();
  let ptzUnlocked = false;

  /** Стрелки поворота поверх видео: держите — камера поворачивается, отпустили — стоп. */
  function ptzPad(ch: Channel): HTMLElement {
    const box = el("div", "ptz-pad");
    box.hidden = true;
    box.addEventListener("click", (e) => e.stopPropagation());
    const ip = ch.config.ip!;
    const known = ptzInfo.get(ch.id);
    const render = (info: PtzInfo) => {
      box.hidden = false;
      box.replaceChildren();
      if (model.running && !ptzUnlocked) {
        box.append(button("🔒 Поворот", "ptz-key wide", async () => {
          const ok = await ask({
            title: "Повернуть камеру во время мониторинга?", ok: "Повернуть",
            text: "После поворота привязка к плану и разметка (зона, линия, вход) перестанут совпадать с кадром — люди на плане окажутся не там. Верните камеру обратно или привяжите её заново.",
          });
          if (ok) {
            ptzUnlocked = true;
            render(info);
          }
        }));
        return;
      }
      const key = (label: string, pan: number, tilt: number, zoom: number, title: string) => {
        const b = button(label, "ptz-key");
        b.title = `${title} — держите`;
        let on = false;
        const stop = () => {
          if (!on) return;
          on = false;
          b.classList.remove("on");
          void ptzStop(info);
        };
        b.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          b.setPointerCapture(e.pointerId);
          on = true;
          b.classList.add("on");
          void ptzMove(info, pan, tilt, zoom);
        });
        b.addEventListener("pointerup", stop);
        b.addEventListener("pointercancel", stop);
        b.addEventListener("lostpointercapture", stop);
        return b;
      };
      const v = 0.5;
      const cross = el("div", "ptz-cross");
      cross.append(el("i"), key("▲", 0, v, 0, "Вверх"), el("i"), key("◀", -v, 0, 0, "Влево"), el("i"), key("▶", v, 0, 0, "Вправо"), el("i"), key("▼", 0, -v, 0, "Вниз"), el("i"));
      box.append(cross);
      if (info.zoom) {
        const z = el("div", "ptz-zoom");
        z.append(key("+", 0, 0, v, "Приблизить"), key("−", 0, 0, -v, "Отдалить"));
        box.append(z);
      }
    };
    if (known && known.url === ip.url && known.info !== "pending") {
      if (known.info) render(known.info);
    } else if (!known || known.url !== ip.url) {
      ptzInfo.set(ch.id, { url: ip.url, info: "pending" });
      void ptzProbe(ip).then((info) => {
        ptzInfo.set(ch.id, { url: ip.url, info });
        if (info && box.isConnected) render(info);
      });
    }
    return box;
  }

  /** Плитки пересобираются, когда меняются камеры, их источники или запуск (замок поворота). */
  const tileKey = () => `${model.running ? 1 : 0}|${model.channels.map((c) => `${c.id}:${c.config.kind}:${c.config.ip?.url ?? ""}`).join("|")}`;
  function rebuildTiles(): void {
    if (!model.running) ptzUnlocked = false;
    grid.replaceChildren();
    tiles.clear();
    for (const ch of model.channels) {
      const root = el("article", "cam-tile");
      const view = el("div", "cam-view");
      const canvas = el("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const msg = el("div", "cam-msg", "Нет картинки");
      view.append(canvas, msg);
      if (ch.config.kind === "ip" && ch.config.ip) view.append(ptzPad(ch));
      view.title = "Открыть на всё окно";
      view.addEventListener("click", () => setFocus(ch.id));
      const headEl = el("header", "cam-head");
      const name = el("b");
      const kind = el("span", "cam-kind");
      const meta = el("span", "mono cam-meta");
      const dot = el("span", "dot");
      headEl.append(dot, name, kind, meta);
      // где витрина и привязка к плану + «Настроить» (раньше — отдельный блок «Расположение камер»)
      const stats = el("div", "cam-bind");
      const bindText = el("span", "bind-sum");
      stats.append(bindText);
      const filter = el("div", "cam-filter");
      const actions = el("div", "cam-actions");
      const del = button("Удалить", "btn small danger-outline");
      let armed = 0;
      del.addEventListener("click", async () => {
        if (!armed) {
          del.textContent = "Точно удалить?";
          armed = window.setTimeout(() => {
            armed = 0;
            del.textContent = "Удалить";
          }, 4000);
          return;
        }
        clearTimeout(armed);
        await model.remove(ch.id);
        deps.toast(`Камера «${ch.title}» удалена. Её статистика осталась.`);
      });
      actions.append(
        button("Настроить", "btn small", () => {
          const c = model.channels.find((x) => x.id === ch.id);
          if (c) deps.onSetup?.(c);
        }),
        button("Чувствительность", "btn small", () => openFilterDialog(ch.id)),
        el("span", "grow"),
        del,
      );
      root.append(view, headEl, stats, filter, actions);
      grid.append(root);
      // перетаскивание карточек: бросили на другую — меняются местами
      root.draggable = true;
      root.addEventListener("dragstart", (e) => {
        dragId = ch.id;
        root.classList.add("dragging");
        e.dataTransfer?.setData("text/plain", ch.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      root.addEventListener("dragend", () => {
        dragId = null;
        root.classList.remove("dragging");
        grid.querySelectorAll(".drop-target").forEach((x) => x.classList.remove("drop-target"));
      });
      root.addEventListener("dragover", (e) => {
        if (!dragId || dragId === ch.id) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        root.classList.add("drop-target");
      });
      root.addEventListener("dragleave", (e) => {
        if (!root.contains(e.relatedTarget as Node | null)) root.classList.remove("drop-target");
      });
      root.addEventListener("drop", (e) => {
        e.preventDefault();
        root.classList.remove("drop-target");
        const from = dragId;
        dragId = null;
        if (from && from !== ch.id) model.swap(from, ch.id);
      });
      tiles.set(ch.id, { root, canvas, msg, name, kind, meta, stats, bindText, dot, filter });
    }
    tileOrder = tileKey();
    applyGrid();
  }

  function applyGrid(): void {
    const n = Math.max(1, model.channels.length);
    grid.dataset.size = gridSize;
    if (gridSize === "auto") {
      const cols = n === 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
      grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    } else {
      const min = { large: 560, medium: 400, small: 300, mini: 220 }[gridSize];
      grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${min}px, 1fr))`;
    }
  }

  const statLine = (s: HourStat, entrance: boolean) =>
    `сегодня: людей ${s.people} · прошли ${s.passed} · посмотрели ${s.looked} (${pct(s.looked, s.people)}) · притормозили ${s.slowed}${entrance ? ` · зашли ${s.entered}` : ""}`;

  // ---------------------------------------------------------------- обновление (не чаще раза в 250 мс)
  let updateQueued = false;
  function scheduleUpdate(): void {
    if (updateQueued) return;
    updateQueued = true;
    setTimeout(() => {
      updateQueued = false;
      update();
    }, 250);
  }

  const DIRS: Record<ShowcaseDirection, string> = { camera: "Камера в витрине", left: "Витрина слева", right: "Витрина справа" };
  function renderBinding(): void {
    bindHead.sync();
    bindList.hidden = isCollapsed(BIND_COLLAPSE);
    bindBox.hidden = true; // перенесено в карточку камеры
    bindList.replaceChildren(...model.channels.map((ch, i) => {
      const r = el("div", "bind-row");
      const dot = el("i", "tw-dot");
      dot.style.background = ["#47d7f0", "#ff6fae", "#7cf2c8", "#ff9f40", "#b18cff", "#ffd23f", "#3fc9b4", "#7a86ff"][i % 8];
      const b = deps.bindingText?.(ch) ?? { text: "", ok: true };
      const sum = el("span", "bind-sum");
      sum.append(document.createTextNode(`${DIRS[ch.config.direction] ?? DIRS.camera} · `));
      const bt = el("span", b.ok ? "" : "tw-st-warn", b.text);
      sum.append(bt);
      r.append(dot, el("b", undefined, channelLabel(ch.config)), el("span", "cam-kind", ch.config.kind === "ip" ? "IP" : "USB"), sum, el("span", "grow"),
        button("Настроить", "btn small", () => deps.onSetup?.(ch)));
      return r;
    }));
  }

  function update(): void {
    if (tileKey() !== tileOrder) rebuildTiles();
    const has = model.channels.length > 0;
    empty.hidden = has;
    gridHead.sync();
    gridHead.n.textContent = String(model.channels.length);
    renderBinding();
    grid.hidden = !has || isCollapsed(GRID_COLLAPSE);
    today.hidden = true;
    gridSeg.hidden = model.channels.length < 2 || isCollapsed(GRID_COLLAPSE);
    btnStart.hidden = true;
    btnAdd.hidden = !has; // пока камер нет — большая кнопка в приглашении
    btnFull.hidden = true;

    stateBox.dataset.state = model.running ? (model.state === "counting" ? "counting" : "recovering") : "stopped";
    stateText.textContent = model.message;
    if (model.running && model.startedAt) {
      const since = new Date(model.startedAt);
      const same = since.toDateString() === new Date().toDateString();
      const t = since.toLocaleString("ru-RU", same ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      metaText.textContent = `с ${t} · ${model.fps.toFixed(1)} кадр/с на камеру`;
    } else metaText.textContent = has ? `${model.channels.length} ${plural(model.channels.length, "камера", "камеры", "камер")}` : "";
    btnStart.textContent = model.running ? "Остановить мониторинг" : "Запустить мониторинг";
    btnStart.className = model.running ? "btn" : "btn primary";

    const d = model.today();
    const anyEntrance = model.channels.some((c) => c.config.markup.entranceEnabled) || d.entered > 0;
    todayCells.people.dd.textContent = String(d.people);
    todayCells.passed.dd.textContent = String(d.passed);
    todayCells.looked.dd.textContent = String(d.looked);
    todayCells.looked.note.textContent = pct(d.looked, d.people);
    todayCells.slowed.dd.textContent = String(d.slowed);
    todayCells.slowed.note.textContent = pct(d.slowed, d.people);
    todayCells.entered.dd.textContent = String(d.entered);
    todayCells.entered.note.textContent = pct(d.entered, d.people);
    todayCells.entered.box.hidden = !anyEntrance;

    model.channels.forEach((ch, idx) => {
      const t = tiles.get(ch.id);
      if (!t) return;
      t.dot.style.background = cameraColor(channelColorIndex(ch.config, idx));
      t.root.dataset.state = ch.state;
      t.name.textContent = channelLabel(ch.config);
      t.kind.textContent = ch.config.kind === "ip" ? "IP" : "USB";
      t.meta.textContent = ch.state === "counting" ? `${ch.fps.toFixed(1)} кадр/с · ${Math.round(ch.msPerFrame)} мс` : stateTitle(ch);
      const b = deps.bindingText?.(ch) ?? { text: "", ok: true };
      t.bindText.replaceChildren(document.createTextNode(`${DIRS[ch.config.direction] ?? DIRS.camera} · `), el("span", b.ok ? "" : "tw-st-warn", b.text));
      t.filter.textContent = `Чувствительность: ${filterSummary(ch.config.filter)}`;
      if (ch.message && ch.state !== "counting") {
        t.msg.hidden = false;
        t.msg.textContent = ch.message;
      } else if (ch.state === "idle") {
        t.msg.hidden = false;
        t.msg.textContent = "Мониторинг не запущен";
      }
    });

    if (focusId) {
      const ch = model.channels.find((c) => c.id === focusId);
      if (!ch) setFocus(null);
      else {
        focusTitle.textContent = channelLabel(ch.config);
        focusMeta.textContent = ch.state === "counting" ? `${ch.fps.toFixed(1)} кадр/с` : stateTitle(ch);
        focusStats.textContent = statLine(model.todayFor(ch.id), ch.config.markup.entranceEnabled);
      }
    }
    renderAccount();
  }

  function stateTitle(ch: Channel): string {
    switch (ch.state) {
      case "preview": return "предпросмотр";
      case "starting": return "запуск";
      case "recovering": return "перезапуск";
      case "counting": return "считает";
      default: return "не запущена";
    }
  }

  function renderAccount(): void {
    const st = deps.account.state;
    accountBox.replaceChildren();
    if (st.user) {
      const r = el("div", "row");
      r.append(el("span", undefined, "Статистика сохраняется в облаке"), el("b", undefined, st.profile.point || "точка без названия"));
      accountBox.append(r, el("div", "row", st.user.email ?? ""));
    } else {
      accountBox.append(el("div", "row", "Вы не вошли. Подсчёт будет храниться только на этом компьютере."));
      accountBox.append(button("Войти или зарегистрироваться", "btn small", deps.openAccount));
    }
    const pending = deps.account.hours.pending;
    if (!st.user) syncLine.textContent = `Только на этом компьютере · не отправлено часов: ${pending}`;
    else if (st.error) syncLine.textContent = st.error;
    else if (st.lastSync) syncLine.textContent = `В облаке · синхронизировано в ${st.lastSync.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
    else syncLine.textContent = "В облаке · первая отправка через минуту";
  }
  let pulledFor: string | null = null;
  deps.account.subscribe((st) => {
    renderAccount();
    // после входа — объединить статистику по камерам с облаком (один раз на аккаунт)
    const uid = st.user?.uid ?? null;
    if (uid && uid !== pulledFor) {
      pulledFor = uid;
      void model.cameraHours.pull(uid).catch(() => undefined);
    }
    if (!uid) pulledFor = null;
  });

  // ---------------------------------------------------------------- запуск / остановка
  async function toggleRun(): Promise<void> {
    btnStart.disabled = true;
    try {
      if (model.running) {
        stoppedManually(); // по расписанию сам не запустится до конца рабочих часов
        await model.stop();
        exitKiosk();
        deps.toast("Мониторинг остановлен. Статистика — в разделе «Статистика».");
      } else {
        if (!model.channels.length) return openCameraDialog(null);
        await model.start();
        deps.getDetector().catch((e) => deps.toast(`Не удалось загрузить нейросеть: ${(e as Error).message}`, true));
      }
    } finally {
      btnStart.disabled = false;
      update();
    }
  }

  function toggleKiosk(): void {
    if (document.body.classList.contains("kiosk-multi")) return exitKiosk();
    document.body.classList.add("kiosk-multi");
    btnFull.textContent = "Выйти из полноэкранного";
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }
  function exitKiosk(): void {
    document.body.classList.remove("kiosk-multi");
    btnFull.textContent = "Во весь экран";
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && document.body.classList.contains("kiosk-multi")) exitKiosk();
  });

  // ================================================================ окно «Камера»
  const camDialog = el("dialog", "dialog wide-dialog");
  document.body.append(camDialog);

  async function openCameraDialog(id: string | null): Promise<void> {
    const existing = id ? model.channels.find((c) => c.id === id) : null;
    const cfg: ChannelConfig = existing ? structuredClone(existing.config) : newChannelConfig();
    let ip: IpCameraConfig | null = cfg.ip;

    const form = el("form", "dialog-inner");
    form.method = "dialog";
    form.noValidate = true;
    form.addEventListener("submit", (e) => e.preventDefault()); // Enter в поле не закрывает окно
    const h = el("div", "dialog-head");
    h.append(el("h2", undefined, existing ? "Камера" : "Новая камера"), button("✕", "icon-btn", () => camDialog.close()));
    const nameLabel = el("label", "field-label", "Название");
    const nameInput = el("input", "input");
    nameInput.placeholder = "Например: Витрина слева";
    nameInput.value = cfg.name;
    let kind = cfg.kind;
    const kindSeg = segmented("cam-kind", [["webcam", "Камера компьютера или USB"], ["ip", "IP-камера"]], kind, (v) => {
      kind = v;
      sync();
    });
    kindSeg.style.marginTop = "14px";
    const direction: ShowcaseDirection = cfg.direction; // задаётся в «Настроить»

    const webBox = el("div", "ip-section");
    const camSelect = el("select", "select");
    const camHint = el("p", "hint-small");
    webBox.append(el("label", "field-label", "Камера"), camSelect, camHint);

    const ipBox = el("div", "ip-section");
    const ipLine = el("p", "hint-small");
    const manualIp = async () => {
      const r = await chooseIpCamera();
      if (!r) return;
      r.source.close(); // подключится сама камера пилота
      ip = r.cfg;
      if (!nameInput.value.trim()) nameInput.placeholder = r.cfg.title;
      sync();
    };
    const ipBtn = button("Найти или подключить IP-камеру", "btn small", () => void manualIp());
    // новая IP-камера — сразу ищем в сети и подключаем сами (как на Mac); вручную — по ссылке внизу
    const auto = existing ? null : autoScanPanel({
      known: () => model.channels.flatMap((c) => (c.config.kind === "ip" && c.config.ip?.user ? [[c.config.ip.user, c.config.ip.password] as [string, string]] : [])),
      added: () => new Set(model.channels.flatMap((c) => {
        try {
          return c.config.kind === "ip" && c.config.ip ? [new URL(c.config.ip.url).hostname] : [];
        } catch {
          return [];
        }
      })),
      manual: () => void manualIp(),
      onChange: () => sync(),
    });
    ipBox.append(ipLine, ipBtn);
    if (auto) ipBox.append(auto.root);

    const err = el("p", "form-error");
    err.hidden = true;
    const actions = el("div", "actions");
    const save = button(existing ? "Сохранить" : "Добавить и разметить", "btn primary wide");
    actions.append(save, button("Отмена", "btn ghost wide", () => camDialog.close()));
    form.append(h, nameLabel, nameInput, kindSeg, webBox, ipBox, err, actions);
    camDialog.replaceChildren(form);

    function sync(): void {
      webBox.hidden = kind !== "webcam";
      ipBox.hidden = kind !== "ip";
      ipLine.textContent = ip ? `Подключена: ${ip.title}` : "IP-камера не выбрана. Mantis найдёт камеры в сети (ONVIF) или подключится по адресу rtsp://.";
      ipBtn.textContent = ip ? "Выбрать" : "Найти или подключить IP-камеру";
      if (auto) {
        // новая: список найденных — главный путь; строка «вручную» — когда ввели адрес сами
        ipLine.hidden = !ip;
        ipBtn.hidden = true;
        if (kind === "ip") auto.start();
        const n = auto.selected().length;
        save.textContent = kind === "ip" && !ip ? (n > 1 ? `Добавить камеры (${n})` : "Добавить и настроить") : "Добавить и настроить";
        save.disabled = kind === "ip" && !ip && n === 0;
      }
    }
    sync();
    camDialog.showModal();

    // список камер компьютера: названия видны после разрешения на камеру
    let cams = await listCameras().catch(() => [] as MediaDeviceInfo[]);
    if (cams.length && cams.every((c) => !c.label)) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true });
        s.getTracks().forEach((t) => t.stop());
        cams = await listCameras();
      } catch {
        /* без названий */
      }
    }
    const owners = model.webcamOwners(existing?.id ?? null);
    camSelect.replaceChildren(
      ...cams.map((c, i) => {
        const o = el("option", undefined, c.label || `Камера ${i + 1}`);
        o.value = c.deviceId;
        const owner = owners.get(c.deviceId);
        if (owner) {
          o.textContent += ` — уже в «${owner}»`;
          o.disabled = true;
        }
        return o;
      }),
    );
    if (!cams.length) {
      const o = el("option", undefined, "Камера не найдена");
      o.value = "";
      camSelect.append(o);
    }
    const firstFree = cams.find((c) => !owners.has(c.deviceId));
    camSelect.value = cfg.deviceId && cams.some((c) => c.deviceId === cfg.deviceId) ? cfg.deviceId : firstFree?.deviceId ?? "";
    camHint.textContent = cams.length > 1 ? "Одну камеру можно добавить только один раз." : "Подключите USB-камеру — она появится в списке.";

    save.onclick = async (e) => {
      e.preventDefault();
      err.hidden = true;
      // отмеченные найденные камеры — все сразу
      const picked = auto && kind === "ip" && !ip ? auto.selected() : [];
      if (picked.length) {
        save.disabled = true;
        const first = model.channels.length;
        for (const [i, p] of picked.entries()) {
          await model.upsert(newChannelConfig({
            ...(picked.length === 1 && nameInput.value.trim() ? { name: nameInput.value.trim() } : { name: `Камера ${first + i + 1}` }),
            kind: "ip", ip: p.cfg, direction,
          }));
        }
        auto!.markAdded();
        camDialog.close();
        deps.toast(picked.length > 1 ? `Добавлено камер: ${picked.length}` : "Камера добавлена");
        if (picked.length === 1) {
          const added = model.channels[model.channels.length - 1];
          if (added) deps.onSetup?.(added);
        }
        return;
      }
      if (kind === "ip" && !ip) {
        err.textContent = "Выберите IP-камеру";
        err.hidden = false;
        return;
      }
      if (kind === "webcam" && !camSelect.value && cams.length) {
        err.textContent = "Выберите камеру";
        err.hidden = false;
        return;
      }
      const next: ChannelConfig = {
        ...cfg,
        name: nameInput.value.trim(),
        kind,
        deviceId: kind === "webcam" ? camSelect.value : "",
        ip: kind === "ip" ? ip : null,
        direction,
      };
      if (!next.name) next.name = kind === "ip" ? ip?.title ?? "IP-камера" : camSelect.selectedOptions[0]?.textContent?.replace(/ — уже в.*$/, "") || "Камера";
      save.disabled = true;
      await model.upsert(next);
      camDialog.close();
      if (!existing) {
        // новая камера — сразу в настройку: зона витрины, где витрина, место на плане, цвет
        const added = model.channels.find((c) => c.id === next.id);
        if (added) deps.onSetup?.(added);
      }
    };
  }

  // ================================================================ окно «Чувствительность»
  const sens = sensitivityDialog({
    save: async (ch, f) => model.upsert({ ...ch.config, filter: f }),
    toast: deps.toast,
    running: () => model.running,
    previewAfter: () => visible && !model.running,
  });
  function openFilterDialog(id: string): void {
    const ch = model.channels.find((c) => c.id === id);
    if (ch) sens.open(ch);
  }

  // ---------------------------------------------------------------- показать / спрятать
  rebuildTiles();
  update();

  return {
    model,
    show() {
      visible = true;
      root.hidden = false;
      if (!model.running) model.setPreview(true);
      update();
    },
    hide() {
      visible = false;
      root.hidden = true;
      if (!model.running && !sens.channelId) model.setPreview(false);
      setFocus(null);
    },
    async resume() {
      if (model.running || !model.channels.length) return;
      await model.start();
      deps.toast("Мониторинг возобновлён после перезапуска");
      update();
    },
    onFrame(cb) {
      frameListeners.add(cb);
      return () => frameListeners.delete(cb);
    },
    async setRunning(on) {
      if (on !== model.running) await toggleRun();
    },
    focus(id) {
      setFocus(id);
    },
    foot,
    refresh() {
      update();
    },
    addCamera() {
      void openCameraDialog(null);
    },
  };
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

