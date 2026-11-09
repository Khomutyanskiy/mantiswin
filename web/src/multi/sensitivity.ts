// Окно «Чувствительность» камеры пилота — порт SensitivityView.swift (macOS).
// Живой кадр с принятыми и отброшенными рамками (причина подписана), неподвижные места, зоны исключения
// (углы тянутся прямо на кадре), уровень, минимальный рост, неподвижные фигуры, строгость поведения.
// Изменения видны на кадре сразу, сохраняются кнопкой «Сохранить».

import type { Pt } from "../engine/geometry";
import type { FrameResult } from "../engine/session";
import { stateColor } from "../ui/draw";
import type { Channel } from "./channel";
import {
  BEHAVIOR_HINTS, BEHAVIOR_TITLES, DEFAULT_LEVEL, type DetectionFilter, LEVEL_HINTS, MAX_LEVEL, LEVEL_TITLES, defaultFilter, filterSummary,
  isDefaultFilter, minConfidence, minTrackSeconds, normalizeFilter, spotsToExclusions,
} from "./filter";

export interface SensitivityDeps {
  save: (ch: Channel, f: DetectionFilter) => Promise<void>;
  toast: (text: string, error?: boolean) => void;
  running: () => boolean;
  /** Экран пилота открыт — после закрытия окна вернуть предпросмотр. */
  previewAfter: () => boolean;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
function button(text: string, cls: string, onClick?: (e: MouseEvent) => void): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

export interface SensitivityDialog {
  /** Кадр камеры (из общего обработчика кадров пилота). */
  frame(ch: Channel, shot: ImageBitmap, fr: FrameResult | null): void;
  open(ch: Channel): void;
  readonly channelId: string | null;
}

export function sensitivityDialog(deps: SensitivityDeps): SensitivityDialog {
  const dialog = el("dialog", "dialog sens-dialog");
  document.body.append(dialog);

  let ch: Channel | null = null;
  let f: DetectionFilter = defaultFilter();
  let original = "";
  let selectedZone: number | null = null;
  let dragging: number | null = null;
  const frameCanvas = el("canvas"); // последний кадр
  let hasFrame = false;
  let lastFr: FrameResult | null = null;
  const view = el("canvas");
  const viewMsg = el("div", "cam-msg", "Подключаю камеру…");
  const legendLine = el("p", "mono small faint");
  let onChange: () => void = () => undefined;

  let msgTimer = 0;
  dialog.addEventListener("close", () => {
    clearInterval(msgTimer);
    const c = ch;
    ch = null;
    hasFrame = false;
    lastFr = null;
    if (c) void c.stopTuning(deps.previewAfter());
  });

  // ---------------------------------------------------------------- рисование
  function redraw(): void {
    const W = hasFrame ? frameCanvas.width : 1280, H = hasFrame ? frameCanvas.height : 720;
    if (view.width !== W || view.height !== H) {
      view.width = W;
      view.height = H;
    }
    const ctx = view.getContext("2d")!;
    const r = view.getBoundingClientRect();
    const u = r.width > 0 ? W / r.width : 2;
    if (hasFrame) ctx.drawImage(frameCanvas, 0, 0);
    else {
      ctx.fillStyle = "#0e1839";
      ctx.fillRect(0, 0, W, H);
    }
    const label = (text: string, x: number, y: number, color: string) => {
      ctx.font = `600 ${Math.round(10 * u)}px "JetBrains Mono", ui-monospace, monospace`;
      const tw = ctx.measureText(text).width;
      const lh = 15 * u;
      const ly = Math.max(lh, y);
      ctx.fillStyle = color;
      ctx.fillRect(x, ly - lh, tw + 8 * u, lh);
      ctx.fillStyle = "#000";
      ctx.textBaseline = "bottom";
      ctx.fillText(text, x + 4 * u, ly - 2 * u);
    };
    // зоны исключения
    (f.exclusions ?? []).forEach((z, i) => {
      if (z.length < 3) return;
      ctx.beginPath();
      z.forEach((p, j) => (j ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)));
      ctx.closePath();
      ctx.fillStyle = `rgba(255, 70, 70, ${selectedZone === i ? 0.28 : 0.18})`;
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 70, 70, 0.9)";
      ctx.lineWidth = (selectedZone === i ? 2.5 : 1.5) * u;
      ctx.stroke();
      label(`исключение ${i + 1}`, z[0].x * W, z[0].y * H, "rgba(255, 90, 90, 0.9)");
    });
    // порог роста — голубая метка слева
    if (f.minHeightPercent > 0) {
      const h = (H * f.minHeightPercent) / 100;
      ctx.fillStyle = "rgba(71, 215, 240, 0.85)";
      ctx.fillRect(6 * u, H - h - 6 * u, 5 * u, h);
    }
    if (ch) {
      // неподвижные места
      ctx.setLineDash([6 * u, 4 * u]);
      ctx.strokeStyle = "#ff9f40";
      ctx.lineWidth = 2 * u;
      for (const b of ch.filterRt.staticSpots) ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
      // отброшенные
      ctx.lineWidth = 1.5 * u;
      ctx.setLineDash([4 * u, 3 * u]);
      for (const rj of ch.filterRt.rejected) {
        const color = rj.reason === "неподвижна" ? "#ff9f40" : "#9aa3b5";
        ctx.strokeStyle = color;
        ctx.strokeRect(rj.box.x1, rj.box.y1, rj.box.x2 - rj.box.x1, rj.box.y2 - rj.box.y1);
        label(rj.reason, rj.box.x1, rj.box.y1, color);
      }
      ctx.setLineDash([]);
      // принятые
      ctx.lineWidth = 2 * u;
      for (const b of lastFr?.boxes ?? []) {
        ctx.strokeStyle = b.inZone ? stateColor(b.state) : "rgba(91, 217, 127, 0.7)";
        ctx.strokeRect(b.box.x1, b.box.y1, b.box.x2 - b.box.x1, b.box.y2 - b.box.y1);
      }
    }
    // углы выбранной зоны
    const z = selectedZone !== null ? f.exclusions?.[selectedZone] : undefined;
    if (z) {
      for (const p of z) {
        ctx.beginPath();
        ctx.arc(p.x * W, p.y * H, 8 * u, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.strokeStyle = "#ff4646";
        ctx.lineWidth = 2 * u;
        ctx.stroke();
      }
    }
    const accepted = lastFr?.boxes.length ?? 0;
    legendLine.textContent = ch && (hasFrame || lastFr)
      ? `Сейчас в кадре: принято ${ch.filterRt.acceptedNow || accepted}, отброшено ${ch.filterRt.rejected.length}`
      : "Подключаю камеру…";
  }

  // ---------------------------------------------------------------- перетаскивание углов зоны
  const norm = (e: PointerEvent): Pt => {
    const r = view.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  view.addEventListener("pointerdown", (e) => {
    const z = selectedZone !== null ? f.exclusions?.[selectedZone] : undefined;
    const p = norm(e);
    const r = view.getBoundingClientRect();
    if (z) {
      let best = -1, bestD = 22;
      z.forEach((q, i) => {
        const d = Math.hypot((q.x - p.x) * r.width, (q.y - p.y) * r.height);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best >= 0) {
        dragging = best;
        view.setPointerCapture(e.pointerId);
        return;
      }
    }
    // нажатие внутри зоны — выбрать её
    const W = 1, H = 1;
    const hit = (f.exclusions ?? []).findIndex((zz) => inside(p, zz.map((q) => ({ x: q.x * W, y: q.y * H }))));
    if (hit >= 0) {
      selectedZone = hit;
      onChange();
    }
  });
  view.addEventListener("pointermove", (e) => {
    if (dragging === null || selectedZone === null) return;
    const z = f.exclusions?.[selectedZone];
    if (!z) return;
    z[dragging] = norm(e);
    redraw();
    push();
  });
  const end = () => {
    dragging = null;
  };
  view.addEventListener("pointerup", end);
  view.addEventListener("pointercancel", end);

  function inside(p: Pt, poly: Pt[]): boolean {
    let r = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r;
    }
    return r;
  }

  /** Черновик → камере (видно на кадре сразу). */
  function push(): void {
    ch?.setTuneFilter(f);
  }

  // ---------------------------------------------------------------- окно
  function open(channel: Channel): void {
    ch = channel;
    f = normalizeFilter(structuredClone(channel.config.filter));
    original = JSON.stringify(f);
    selectedZone = null;
    hasFrame = false;
    lastFr = null;
    viewMsg.hidden = false;
    viewMsg.textContent = "Подключаю камеру…";
    void channel.startTuning(f);
    // пока нет кадра — что происходит с камерой («Загружаю нейросеть…», ошибка)
    clearInterval(msgTimer);
    msgTimer = window.setInterval(() => {
      if (!hasFrame && ch) viewMsg.textContent = ch.message || "Подключаю камеру…";
    }, 400);

    const form = el("form", "dialog-inner");
    form.method = "dialog";
    form.noValidate = true;
    form.addEventListener("submit", (e) => e.preventDefault());
    const head = el("div", "dialog-head");
    head.append(el("h2", undefined, `Чувствительность · ${channel.title}`), button("✕", "icon-btn", () => dialog.close()));

    const body = el("div", "sens-body");
    const left = el("div", "sens-left");
    const stage = el("div", "markup-view");
    stage.append(view, viewMsg);
    const legend = el("div", "sens-legend");
    const item = (cls: string, t: string) => {
      const s = el("span", "sens-key");
      s.append(el("i", cls), document.createTextNode(t));
      return s;
    };
    legend.append(item("k-ok", "считается"), item("k-rej", "отброшено — причина подписана"), item("k-static", "неподвижная фигура"), item("k-excl", "зона исключения"));
    const runNote = el("p", "hint-small faint",
      "Мониторинг идёт: уверенность, рост, зоны и неподвижные фигуры применятся сразу после «Сохранить». Строгость поведения и время в зоне — с нового куска подсчёта (счётчики сохраняются).");
    runNote.hidden = !deps.running();
    left.append(stage, legend, legendLine, runNote);

    const side = el("div", "sens-side");

    // уровень
    const lvlTitle = el("b");
    const lvlMeta = el("span", "mono small faint");
    const lvlHead = el("div", "sens-row");
    lvlHead.append(lvlTitle, lvlMeta);
    const lvl = el("input", "range");
    lvl.type = "range";
    lvl.min = "0";
    lvl.max = String(MAX_LEVEL);
    lvl.step = "1";
    lvl.value = String(f.level);
    const lvlEnds = el("div", "sens-row small faint");
    lvlEnds.append(el("span", undefined, "больше людей"), el("span", undefined, "меньше ложных"));
    const lvlHint = el("p", "hint-small");
    lvl.addEventListener("input", () => {
      f.level = Number(lvl.value);
      sync();
      push();
    });

    // рост
    const hTitle = el("b");
    const hRange = el("input", "range");
    hRange.type = "range";
    hRange.min = "0";
    hRange.max = "50";
    hRange.step = "1";
    hRange.value = String(Math.round(f.minHeightPercent || 0));
    hRange.addEventListener("input", () => {
      f.minHeightPercent = Number(hRange.value);
      sync();
      push();
    });

    // зоны исключения
    const zoneList = el("div", "sens-zones");
    const addZone = button("Добавить зону", "btn small", () => {
      (f.exclusions ??= []).push([{ x: 0.35, y: 0.3 }, { x: 0.65, y: 0.3 }, { x: 0.65, y: 0.7 }, { x: 0.35, y: 0.7 }]);
      selectedZone = f.exclusions.length - 1;
      sync();
      push();
    });

    // неподвижные
    const stSw = el("input", "switch");
    stSw.type = "checkbox";
    stSw.checked = !!f.ignoreStatic;
    const stRow = el("label", "toggle-row");
    const stText = el("div", "toggle-text");
    stText.append(el("b", undefined, "Не считать тех, кто стоит без движения"));
    stRow.append(stText, stSw);
    const stMin = el("input", "range");
    stMin.type = "range";
    stMin.min = "1";
    stMin.max = "15";
    stMin.step = "1";
    stMin.value = String(f.staticMinutes ?? 3);
    const stMinLabel = el("span", "mono small");
    const stMinRow = el("div", "sens-row");
    stMinRow.append(el("span", "small faint", "дольше"), stMin, stMinLabel);
    const spotsBtn = button("", "btn small", () => {
      if (!ch) return;
      const spots = ch.filterRt.staticSpots;
      if (!spots.length) return;
      (f.exclusions ??= []).push(...spotsToExclusions(spots, ch.width || frameCanvas.width, ch.height || frameCanvas.height));
      sync();
      push();
    });
    stSw.addEventListener("change", () => {
      f.ignoreStatic = stSw.checked;
      sync();
      push();
    });
    stMin.addEventListener("input", () => {
      f.staticMinutes = Number(stMin.value);
      sync();
      push();
    });

    // сотрудники
    const sfSw = el("input", "switch");
    sfSw.type = "checkbox";
    sfSw.checked = f.excludeStaff !== false;
    const sfRow = el("label", "toggle-row");
    const sfText = el("div", "toggle-text");
    sfText.append(el("b", undefined, "Не считать сотрудников"));
    sfRow.append(sfText, sfSw);
    const sfMin = el("input", "range");
    sfMin.type = "range";
    sfMin.min = "2";
    sfMin.max = "60";
    sfMin.step = "1";
    sfMin.value = String(f.staffMinutes ?? 10);
    const sfMinLabel = el("span", "mono small");
    const sfMinRow = el("div", "sens-row");
    sfMinRow.append(el("span", "small faint", "дольше"), sfMin, sfMinLabel);
    sfSw.addEventListener("change", () => {
      f.excludeStaff = sfSw.checked;
      sync();
      push();
    });
    sfMin.addEventListener("input", () => {
      f.staffMinutes = Number(sfMin.value);
      sync();
      push();
    });

    // строгость
    const behSeg = el("div", "seg");
    behSeg.style.gridTemplateColumns = "repeat(3, 1fr)";
    BEHAVIOR_TITLES.forEach((t, i) => {
      const label = el("label");
      const input = el("input");
      input.type = "radio";
      input.name = "sens-beh";
      input.value = String(i);
      input.checked = f.behavior === i;
      input.addEventListener("change", () => {
        if (!input.checked) return;
        f.behavior = i;
        sync();
        push();
      });
      label.append(input, el("span", undefined, t));
      behSeg.append(label);
    });
    const behHint = el("p", "hint-small");

    const resetBtn = button("Сбросить к стандартным", "link", () => {
      f = defaultFilter();
      selectedZone = null;
      lvl.value = String(DEFAULT_LEVEL);
      sfSw.checked = true;
      sfMin.value = "10";
      hRange.value = "0";
      stSw.checked = false;
      stMin.value = "3";
      behSeg.querySelectorAll<HTMLInputElement>("input").forEach((x) => (x.checked = x.value === "1"));
      sync();
      push();
    });

    const section = (title: string, ...nodes: Node[]) => {
      const s = el("section", "sens-section");
      s.append(el("p", "eyebrow", title), ...nodes);
      return s;
    };
    const hHint = el("p", "hint-small", "Отсекает мелкие фигуры далеко на улице и в отражениях. Голубая метка слева на кадре показывает порог.");
    const zHint = el("p", "hint-small", "Обведите манекен, плакат, зеркало или телевизор — всё внутри не считается. Углы выбранной зоны тянутся прямо на кадре.");
    const sHint = el("p", "hint-small", "Манекены и люди на плакатах стоят на месте — их место запоминается и больше не считается. Продавец за кассой тоже перестанет считаться.");
    side.append(
      section("Чувствительность", lvlHead, lvl, lvlEnds, lvlHint),
      section("Минимальный рост человека", hTitle, hRange, hHint),
      section("Зоны исключения", zoneList, addZone, zHint),
      section("Неподвижные фигуры", stRow, stMinRow, spotsBtn, sHint),
      section("Сотрудники", sfRow, sfMinRow, el("p", "hint-small", "Продавец, охранник, промоутер стоят в кадре часами. Кто в кадре дольше заданного — сотрудник: его не считаем и снимаем уже засчитанное.")),
      section("Строгость «посмотрел / притормозил»", behSeg, behHint),
      resetBtn,
    );
    body.append(left, side);

    const actions = el("div", "actions");
    const saveBtn = button("Сохранить", "btn primary wide", async (e) => {
      e.preventDefault();
      const c = ch;
      if (!c) return;
      saveBtn.disabled = true;
      const out = normalizeFilter(f);
      await deps.save(c, isDefaultFilter(out) ? defaultFilter() : out);
      dialog.close();
      deps.toast(`Чувствительность «${c.title}»: ${filterSummary(out)}`);
    });
    actions.append(saveBtn, button("Отмена", "btn ghost wide", () => dialog.close()));
    form.append(head, body, actions);
    dialog.replaceChildren(form);

    function sync(): void {
      lvlTitle.textContent = LEVEL_TITLES[f.level];
      lvlMeta.textContent = `уверенность ≥ ${Math.round(minConfidence(f) * 100)}% · ≥ ${minTrackSeconds(f).toFixed(1).replace(".", ",")} с`;
      lvlHint.textContent = LEVEL_HINTS[f.level];
      hTitle.textContent = f.minHeightPercent > 0 ? `${Math.round(f.minHeightPercent)}% высоты кадра` : "не ограничен";
      zoneList.replaceChildren(
        ...(f.exclusions ?? []).map((_, i) => {
          const row = el("div", "sens-zone");
          if (selectedZone === i) row.classList.add("on");
          row.append(el("i", "dot-red"), el("span", undefined, `Зона ${i + 1}`));
          const edit = button(selectedZone === i ? "Готово" : "Углы", "link", () => {
            selectedZone = selectedZone === i ? null : i;
            sync();
          });
          const del = button("Удалить", "link danger", () => {
            f.exclusions!.splice(i, 1);
            selectedZone = null;
            sync();
            push();
          });
          row.append(edit, del);
          return row;
        }),
      );
      stMinRow.hidden = !f.ignoreStatic;
      sfMinRow.hidden = f.excludeStaff === false;
      sfMinLabel.textContent = `${f.staffMinutes ?? 10} мин в кадре`;
      stMinLabel.textContent = `${f.staticMinutes ?? 3} мин`;
      const spots = ch?.filterRt.staticSpots.length ?? 0;
      spotsBtn.hidden = !f.ignoreStatic || spots === 0;
      spotsBtn.textContent = `Сделать найденные (${spots}) зонами исключения`;
      behHint.textContent = BEHAVIOR_HINTS[f.behavior];
      resetBtn.disabled = isDefaultFilter(f);
      saveBtn.disabled = JSON.stringify(f) === original;
      redraw();
    }
    onChange = sync;
    sync();
    dialog.showModal();
  }

  let lastSync = 0;
  return {
    get channelId() {
      return ch?.id ?? null;
    },
    open,
    frame(c, shot, fr) {
      if (c !== ch) return;
      if (dragging === null) {
        if (frameCanvas.width !== shot.width || frameCanvas.height !== shot.height) {
          frameCanvas.width = shot.width;
          frameCanvas.height = shot.height;
        }
        frameCanvas.getContext("2d")!.drawImage(shot, 0, 0);
        hasFrame = true;
        viewMsg.hidden = true;
      }
      if (fr) lastFr = fr;
      redraw();
      // кнопка «неподвижные → зоны» и счётчики — раз в секунду
      const now = performance.now();
      if (now - lastSync > 1000) {
        lastSync = now;
        onChange();
      }
    },
  };
}
