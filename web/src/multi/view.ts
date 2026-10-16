// Экран «Пилот» настольной версии: несколько камер сеткой, как в Mantis для Mac.
// Сетка (Авто / Крупно / Средне / Мелко / Мини), камера на всё окно, у каждой камеры — своя разметка
// и чувствительность, итоги за сегодня по каждой камере и суммарно.

import type { Account } from "../cloud/account";
import type { Detector } from "../detector";
import { desktopInfo, quitApp, setAutostart } from "../desktop";
import type { ShowcaseDirection } from "../engine/headpose";
import type { FrameResult } from "../engine/session";
import { listCameras } from "../pilot/runner";
import { type HourStat } from "../pilot/hours";
import { FULL_FRAME, HORIZONTAL_LINE, type Markup, VERTICAL_LINE, drawMarkup, drawPeople, handlePoints } from "../ui/draw";
import { chooseIpCamera } from "../ui/ipcam";
import type { IpCameraConfig } from "../sources";
import { type Channel, type ChannelConfig, newChannelConfig } from "./channel";
import { BEHAVIOR_TITLES, LEVEL_HINTS, LEVEL_TITLES, defaultFilter, filterSummary } from "./filter";
import { MultiPilot } from "./model";

export interface MultiDeps {
  account: Account;
  getDetector: () => Promise<Detector>;
  resetDetector: () => void;
  toast: (text: string, error?: boolean) => void;
  openAccount: () => void;
}

export interface MultiView {
  readonly model: MultiPilot;
  show(): void;
  hide(): void;
  /** Пилот шёл до перезапуска приложения — продолжить. */
  resume(): Promise<void>;
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
  });

  // ---------------------------------------------------------------- каркас
  const head = el("div", "multi-head");
  const stateBox = el("div", "pilot-state");
  stateBox.dataset.state = "stopped";
  const stateText = el("span", undefined, "Пилот не запущен");
  stateBox.append(el("span", "dot"), stateText);
  const metaText = el("p", "mono small faint");
  const headLeft = el("div", "multi-title");
  headLeft.append(stateBox, metaText);

  const btnAdd = button("Добавить камеру", "btn small", () => openCameraDialog(null));
  const btnStart = button("Запустить пилот", "btn primary", () => void toggleRun());
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
    el("h1", undefined, "Пилот на нескольких камерах"),
    el("p", "lead", "Компьютер у витрины считает людей круглосуточно сразу с нескольких камер: встроенной, USB и IP-камер в сети магазина. У каждой камеры — своя разметка и своя статистика, итоги по часам уходят в облако и видны на iPhone, Mac и в браузере."),
    (() => {
      const ol = el("ol", "intro-steps");
      for (const t of [
        "Войдите в аккаунт Mantis (кнопка справа вверху) — иначе статистика останется только на этом компьютере.",
        "Добавьте камеры и разметьте кадр каждой: зона витрины, линия прохода, вход.",
        "Нажмите «Запустить пилот». Окно можно свернуть или закрыть в трей — подсчёт продолжится.",
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
  autoText.append(el("b", undefined, "Запускать при входе в Windows"), el("small", undefined, "После перезагрузки компьютера пилот продолжится сам"));
  autoRow.append(autoText, autostartInput);
  const versionLine = el("p", "mono small faint");
  const quitBtn = button("Выйти из Mantis", "link", async () => {
    if (model.running) {
      deps.toast("Сначала остановите пилот", true);
      return;
    }
    await quitApp();
  });
  appBox.append(el("p", "eyebrow", "Приложение"), autoRow, quitBtn, versionLine);
  const footLeft = el("div", "multi-foot-col");
  footLeft.append(el("p", "eyebrow", "Аккаунт"), accountBox, syncLine);
  foot.append(footLeft, appBox);

  root.append(head, today, grid, empty, foot);

  autostartInput.addEventListener("change", async () => {
    const r = await setAutostart(autostartInput.checked);
    if (r === null) {
      autostartInput.checked = !autostartInput.checked;
      deps.toast("Автозапуск недоступен", true);
      return;
    }
    autostartInput.checked = r;
    deps.toast(r ? "Mantis будет запускаться при входе в Windows" : "Автозапуск выключен");
  });
  void desktopInfo().then((info) => {
    if (!info) {
      appBox.hidden = true;
      return;
    }
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
  function drawFrame(ch: Channel, shot: ImageBitmap, fr: FrameResult | null): void {
    if (editor.channelId === ch.id) editorFrame(shot);
    if (!visible) return;
    const targets: HTMLCanvasElement[] = [];
    const t = tiles.get(ch.id);
    if (t && !focusId) targets.push(t.canvas);
    if (focusId === ch.id) targets.push(focusCanvas);
    for (const c of targets) {
      if (c.width !== shot.width || c.height !== shot.height) {
        c.width = shot.width;
        c.height = shot.height;
      }
      const ctx = c.getContext("2d")!;
      ctx.drawImage(shot, 0, 0);
      drawMarkup(ctx, ch.config.markup);
      if (fr) drawPeople(ctx, fr.boxes);
    }
    if (t) t.msg.hidden = true;
  }

  // ---------------------------------------------------------------- плитки
  function rebuildTiles(): void {
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
      view.title = "Открыть на всё окно";
      view.addEventListener("click", () => setFocus(ch.id));
      const headEl = el("header", "cam-head");
      const name = el("b");
      const kind = el("span", "cam-kind");
      const meta = el("span", "mono cam-meta");
      headEl.append(el("span", "dot"), name, kind, meta);
      const stats = el("div", "cam-stats mono");
      const filter = el("div", "cam-filter");
      const actions = el("div", "cam-actions");
      const del = button("Удалить", "link danger");
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
        button("Разметка", "chip", () => openEditor(ch.id)),
        button("Чувствительность", "chip", () => openFilterDialog(ch.id)),
        button("Изменить", "chip", () => openCameraDialog(ch.id)),
        del,
      );
      root.append(view, headEl, stats, filter, actions);
      grid.append(root);
      tiles.set(ch.id, { root, canvas, msg, name, kind, meta, stats, filter });
    }
    tileOrder = model.channels.map((c) => c.id).join("|");
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

  function update(): void {
    if (model.channels.map((c) => c.id).join("|") !== tileOrder) rebuildTiles();
    const has = model.channels.length > 0;
    empty.hidden = has;
    grid.hidden = !has;
    today.hidden = !has;
    gridSeg.hidden = model.channels.length < 2;
    btnStart.hidden = !has;
    btnAdd.hidden = !has; // пока камер нет — большая кнопка в приглашении
    btnFull.hidden = !has;

    stateBox.dataset.state = model.running ? (model.state === "counting" ? "counting" : "recovering") : "stopped";
    stateText.textContent = model.message;
    if (model.running && model.startedAt) {
      const since = new Date(model.startedAt);
      const same = since.toDateString() === new Date().toDateString();
      const t = since.toLocaleString("ru-RU", same ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      metaText.textContent = `с ${t} · ${model.fps.toFixed(1)} кадр/с на камеру`;
    } else metaText.textContent = has ? `${model.channels.length} ${plural(model.channels.length, "камера", "камеры", "камер")}` : "";
    btnStart.textContent = model.running ? "Остановить пилот" : "Запустить пилот";
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

    for (const ch of model.channels) {
      const t = tiles.get(ch.id);
      if (!t) continue;
      t.root.dataset.state = ch.state;
      t.name.textContent = ch.title;
      t.kind.textContent = ch.config.kind === "ip" ? "IP" : "USB";
      t.meta.textContent = ch.state === "counting" ? `${ch.fps.toFixed(1)} кадр/с · ${Math.round(ch.msPerFrame)} мс` : stateTitle(ch);
      t.stats.textContent = statLine(model.todayFor(ch.id), ch.config.markup.entranceEnabled);
      t.filter.textContent = `Чувствительность: ${filterSummary(ch.config.filter)}`;
      if (ch.message && ch.state !== "counting") {
        t.msg.hidden = false;
        t.msg.textContent = ch.message;
      } else if (ch.state === "idle") {
        t.msg.hidden = false;
        t.msg.textContent = "Пилот не запущен";
      }
    }

    if (focusId) {
      const ch = model.channels.find((c) => c.id === focusId);
      if (!ch) setFocus(null);
      else {
        focusTitle.textContent = ch.title;
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
        await model.stop();
        exitKiosk();
        deps.toast("Пилот остановлен. Статистика — на вкладке «Статистика».");
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

    const webBox = el("div", "ip-section");
    const camSelect = el("select", "select");
    const camHint = el("p", "hint-small");
    webBox.append(el("label", "field-label", "Камера"), camSelect, camHint);

    const ipBox = el("div", "ip-section");
    const ipLine = el("p", "hint-small");
    const ipBtn = button("Найти или подключить IP-камеру", "btn small", async () => {
      const r = await chooseIpCamera();
      if (!r) return;
      r.source.close(); // подключится сама камера пилота
      ip = r.cfg;
      if (!nameInput.value.trim()) nameInput.placeholder = r.cfg.title;
      sync();
    });
    ipBox.append(ipLine, ipBtn);

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
      ipBtn.textContent = ip ? "Выбрать другую" : "Найти или подключить IP-камеру";
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
    camHint.textContent = cams.length > 1 ? "Одну камеру можно добавить в пилот один раз." : "Подключите USB-камеру — она появится в списке.";

    save.onclick = async (e) => {
      e.preventDefault();
      err.hidden = true;
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
      };
      if (!next.name) next.name = kind === "ip" ? ip?.title ?? "IP-камера" : camSelect.selectedOptions[0]?.textContent?.replace(/ — уже в.*$/, "") || "Камера";
      save.disabled = true;
      await model.upsert(next);
      camDialog.close();
      if (!existing) openEditor(next.id);
    };
  }

  // ================================================================ окно «Разметка»
  const editDialog = el("dialog", "dialog markup-dialog");
  document.body.append(editDialog);
  const editor = {
    channelId: null as string | null,
    markup: null as Markup | null,
    canvas: el("canvas"),
    frame: el("canvas"),
    dragging: null as string | null,
    hasFrame: false,
    msg: el("div", "cam-msg"),
  };
  editDialog.addEventListener("close", () => {
    editor.channelId = null;
    editor.markup = null;
    editor.hasFrame = false;
  });

  function editorFrame(shot: ImageBitmap): void {
    if (editor.dragging) return; // не дёргаем картинку под пальцем
    const f = editor.frame;
    if (f.width !== shot.width || f.height !== shot.height) {
      f.width = shot.width;
      f.height = shot.height;
    }
    f.getContext("2d")!.drawImage(shot, 0, 0);
    editor.hasFrame = true;
    editor.msg.hidden = true;
    redrawEditor();
  }

  function redrawEditor(): void {
    const c = editor.canvas, m = editor.markup;
    if (!m) return;
    const w = editor.hasFrame ? editor.frame.width : 1280, hgt = editor.hasFrame ? editor.frame.height : 720;
    if (c.width !== w || c.height !== hgt) {
      c.width = w;
      c.height = hgt;
    }
    const ctx = c.getContext("2d")!;
    if (editor.hasFrame) ctx.drawImage(editor.frame, 0, 0);
    else {
      ctx.fillStyle = "#0e1839";
      ctx.fillRect(0, 0, c.width, c.height);
    }
    drawMarkup(ctx, m, { handles: true, active: editor.dragging });
  }

  const toNorm = (e: PointerEvent) => {
    const r = editor.canvas.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  editor.canvas.addEventListener("pointerdown", (e) => {
    if (!editor.markup) return;
    const p = toNorm(e);
    const r = editor.canvas.getBoundingClientRect();
    let best: string | null = null, bestD = 28;
    for (const [id, hp] of handlePoints(editor.markup)) {
      const d = Math.hypot((hp.x - p.x) * r.width, (hp.y - p.y) * r.height);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    if (!best) return;
    editor.dragging = best;
    editor.canvas.setPointerCapture(e.pointerId);
    redrawEditor();
  });
  editor.canvas.addEventListener("pointermove", (e) => {
    if (!editor.dragging || !editor.markup) return;
    const m = /^(zone|line|entrance)(\d)$/.exec(editor.dragging)!;
    editor.markup[m[1] as "zone" | "line" | "entrance"][Number(m[2])] = toNorm(e);
    redrawEditor();
  });
  const endDrag = () => {
    editor.dragging = null;
    redrawEditor();
  };
  editor.canvas.addEventListener("pointerup", endDrag);
  editor.canvas.addEventListener("pointercancel", endDrag);

  function openEditor(id: string): void {
    const ch = model.channels.find((c) => c.id === id);
    if (!ch) return;
    const m: Markup = structuredClone(ch.config.markup);
    let dir: ShowcaseDirection = ch.config.direction;
    editor.channelId = id;
    editor.markup = m;
    editor.hasFrame = false;
    editor.msg.hidden = false;
    editor.msg.textContent = ch.state === "idle" ? "Подключаю камеру…" : "Жду кадр…";
    if (!model.running) model.setPreview(true); // нужна живая картинка

    const form = el("form", "dialog-inner");
    form.method = "dialog";
    form.noValidate = true;
    form.addEventListener("submit", (e) => e.preventDefault()); // Enter в поле не закрывает окно
    const h = el("div", "dialog-head");
    h.append(el("h2", undefined, `Разметка · ${ch.title}`), button("✕", "icon-btn", () => editDialog.close()));
    const body = el("div", "markup-body");
    const view = el("div", "markup-view");
    view.append(editor.canvas, editor.msg);
    const side = el("div", "markup-side");

    const dirSeg = segmented("mk-dir", [["camera", "Камера в витрине"], ["left", "Слева в кадре"], ["right", "Справа в кадре"]], dir, (v) => (dir = v));
    const fs = el("fieldset", "field");
    fs.append(el("legend", undefined, "Где витрина"), dirSeg);

    const toggles = el("div", "toggles");
    const zoneRow = el("div", "toggle-row");
    const zt = el("div", "toggle-text");
    zt.append(el("b", undefined, "Зона витрины"), el("small", undefined, "Тормозил и смотрел считаются только внутри"));
    zoneRow.append(el("span", "key cyan"), zt, button("Весь кадр", "link", () => {
      m.zone = FULL_FRAME.map((p) => ({ ...p }));
      redrawEditor();
    }));
    const lineSw = el("input", "switch");
    lineSw.type = "checkbox";
    lineSw.checked = m.lineEnabled;
    const lineRow = el("label", "toggle-row");
    const lt = el("div", "toggle-text");
    lt.append(el("b", undefined, "Линия подсчёта"), el("small", undefined, "Пересёк — значит прошёл мимо"));
    lineRow.append(el("span", "key red"), lt, lineSw);
    const lineActs = el("div", "sub-actions");
    lineActs.append(
      button("Вертикальная", "chip", () => ((m.line = VERTICAL_LINE.map((p) => ({ ...p }))), redrawEditor())),
      button("Горизонтальная", "chip", () => ((m.line = HORIZONTAL_LINE.map((p) => ({ ...p }))), redrawEditor())),
    );
    lineSw.addEventListener("change", () => {
      m.lineEnabled = lineSw.checked;
      lineActs.hidden = !m.lineEnabled;
      redrawEditor();
    });
    lineActs.hidden = !m.lineEnabled;
    const enSw = el("input", "switch");
    enSw.type = "checkbox";
    enSw.checked = m.entranceEnabled;
    const enRow = el("label", "toggle-row");
    const et = el("div", "toggle-text");
    et.append(el("b", undefined, "Вход в магазин"), el("small", undefined, "Линия по порогу двери"));
    enRow.append(el("span", "key green dashed"), et, enSw);
    enSw.addEventListener("change", () => {
      m.entranceEnabled = enSw.checked;
      redrawEditor();
    });
    toggles.append(zoneRow, lineRow, lineActs, enRow);

    const actions = el("div", "actions");
    const save = button(model.running ? "Сохранить — применится сразу" : "Сохранить", "btn primary wide", async (e) => {
      e.preventDefault();
      await model.upsert({ ...ch.config, markup: m, direction: dir });
      editDialog.close();
      deps.toast(`Разметка «${ch.title}» сохранена`);
    });
    actions.append(save, button("Отмена", "btn ghost wide", () => editDialog.close()));
    side.append(el("p", "hint-small", "Перетаскивайте точки прямо на кадре."), fs, toggles, actions);
    body.append(view, side);
    form.append(h, body);
    editDialog.replaceChildren(form);
    editDialog.showModal();
    redrawEditor();
  }

  // ================================================================ окно «Чувствительность»
  const filterDialog = el("dialog", "dialog");
  document.body.append(filterDialog);

  function openFilterDialog(id: string): void {
    const ch = model.channels.find((c) => c.id === id);
    if (!ch) return;
    const f = { ...defaultFilter(), ...ch.config.filter };
    const form = el("form", "dialog-inner");
    form.method = "dialog";
    form.noValidate = true;
    form.addEventListener("submit", (e) => e.preventDefault()); // Enter в поле не закрывает окно
    const h = el("div", "dialog-head");
    h.append(el("h2", undefined, `Чувствительность · ${ch.title}`), button("✕", "icon-btn", () => filterDialog.close()));
    const hint = el("p", "hint-small", LEVEL_HINTS[f.level]);
    const levelSeg = segmented("flt-level", LEVEL_TITLES.map((t, i) => [String(i), t] as [string, string]), String(f.level), (v) => {
      f.level = Number(v);
      hint.textContent = LEVEL_HINTS[f.level];
    }, "seg five");
    const lvl = el("fieldset", "field");
    lvl.append(el("legend", undefined, "Что считать человеком"), levelSeg);
    const hLabel = el("label", "field-label", "Минимальный рост фигуры, % высоты кадра (0 — не ограничивать)");
    const hInput = el("input", "input");
    hInput.type = "number";
    hInput.min = "0";
    hInput.max = "80";
    hInput.step = "1";
    hInput.value = String(f.minHeightPercent || 0);
    const bSeg = segmented("flt-beh", BEHAVIOR_TITLES.map((t, i) => [String(i), t] as [string, string]), String(f.behavior), (v) => (f.behavior = Number(v)));
    const beh = el("fieldset", "field");
    beh.style.marginTop = "14px";
    beh.append(el("legend", undefined, "Строгость «посмотрел / притормозил»"), bSeg);
    const note = el("p", "hint-small faint", "Уровень и рост применяются сразу; строгость — с новым куском подсчёта (счётчики сохраняются).");
    note.style.marginTop = "12px";
    const actions = el("div", "actions");
    actions.append(
      button("Сохранить", "btn primary wide", async (e) => {
        e.preventDefault();
        const v = parseFloat(hInput.value.replace(",", "."));
        f.minHeightPercent = isFinite(v) ? Math.min(80, Math.max(0, v)) : 0;
        await model.upsert({ ...ch.config, filter: f });
        filterDialog.close();
        deps.toast(`Чувствительность «${ch.title}»: ${filterSummary(f)}`);
      }),
      button("Стандартная", "btn ghost wide", async (e) => {
        e.preventDefault();
        await model.upsert({ ...ch.config, filter: defaultFilter() });
        filterDialog.close();
      }),
    );
    form.append(h, lvl, hint, hLabel, hInput, beh, note, actions);
    filterDialog.replaceChildren(form);
    filterDialog.showModal();
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
      if (!model.running && !editor.channelId) model.setPreview(false);
      setFocus(null);
    },
    async resume() {
      if (model.running || !model.channels.length) return;
      await model.start();
      deps.toast("Пилот возобновлён после перезапуска");
      update();
    },
  };
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

