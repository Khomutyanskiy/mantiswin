// Вкладка «Записи»: сохранённые цифровые двойники — план с людьми по времени, тепло до текущего момента,
// зоны, скорость, перемотка; если запись по видео — видео в плавающем окне синхронно с планом. Порт TwinPlayerView.swift.

import { ask, askText } from "../ui/confirm";
import { floatingWindow } from "./floating";
import { type PlanLayers, paintPlan } from "./paint";
import { type CameraMark, HeatCursor, Timeline, type TwinPlan, averageDwell, cameraMark, fmtClock, fmtDuration, zoneColor } from "./plan";
import { type RecordingMeta, SOURCE_TITLES, blobImage, deleteRecording, listRecordings, loadRecording, renameRecording } from "./store";
import { layerChips, loadLayers } from "./view";

export interface RecordsView {
  show(): void;
  hide(): void;
  reload(): void;
  /** Открыть запись (из отчёта). */
  select(id: string): void;
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

const ICON: Record<string, string> = { video: "▶", live: "●", demo: "✦" };

export function mountRecords(root: HTMLElement): RecordsView {
  let visible = false;
  let items: RecordingMeta[] = [];
  let selectedId: string | null = null;
  const listBox = el("aside", "rec-list");
  const playerBox = el("div", "rec-player");
  root.append(listBox, playerBox);

  // ---------------------------------------------------------------- проигрыватель
  interface Player {
    meta: RecordingMeta;
    tl: Timeline;
    plan: TwinPlan;
    background: ImageBitmap | null;
    marks: CameraMark[];
    video: HTMLVideoElement | null;
    url: string | null;
    time: number;
    playing: boolean;
    speed: number;
    heat: HeatCursor;
  }
  let player: Player | null = null;
  const layers: PlanLayers = loadLayers();
  let showVideo = true;
  let lastTs = performance.now();
  let scrubbing = false;

  const canvas = el("canvas", "tw-plan");
  const area = el("div", "tw-area");
  area.append(canvas);
  const vidWin = floatingWindow(area, { title: "Видео", icon: "▶", width: 360, height: 240, onClose: () => {
    showVideo = false;
    rerenderChips();
    sync();
  } });
  const headBox = el("div", "rec-head");
  const stats = el("div", "rec-stats");
  let chips: HTMLElement = el("div");
  const rerenderChips = () => {
    const extra: [string, () => boolean, (v: boolean) => void][] = player?.video ? [["Видео", () => showVideo, (v) => (showVideo = v)]] : [];
    const n = layerChips(layers, () => {
      sync();
      draw();
    }, "Тепло", extra);
    chips.replaceWith(n);
    chips = n;
  };
  const transport = el("div", "rec-transport");
  const playBtn = button("▶", "btn primary rec-play", () => togglePlay(), "Пауза / воспроизведение (пробел)");
  const tNow = el("span", "mono small");
  const seek = el("input", "range");
  seek.type = "range";
  seek.min = "0";
  seek.step = "0.01";
  const tDur = el("span", "mono small faint");
  const speedSeg = el("div", "seg rec-speed");
  speedSeg.style.gridTemplateColumns = "repeat(4, 1fr)";
  for (const [v, t] of [[0.5, "½×"], [1, "1×"], [2, "2×"], [4, "4×"]] as const) {
    const label = el("label");
    const input = el("input");
    input.type = "radio";
    input.name = "rec-speed";
    input.value = String(v);
    input.checked = v === 1;
    input.addEventListener("change", () => {
      if (!input.checked || !player) return;
      player.speed = v;
      if (player.video) player.video.playbackRate = v;
    });
    label.append(input, el("span", undefined, t));
    speedSeg.append(label);
  }
  transport.append(playBtn, tNow, seek, tDur, speedSeg);
  const zonesBox = el("div", "rec-zones");
  seek.addEventListener("input", () => {
    scrubbing = true;
    seekTo(Number(seek.value));
  });
  seek.addEventListener("change", () => (scrubbing = false));
  document.addEventListener("keydown", (e) => {
    if (!visible || !player || e.code !== "Space" || (e.target as HTMLElement).closest("input, textarea, select, button, dialog")) return;
    e.preventDefault();
    togglePlay();
  });
  new ResizeObserver(() => visible && draw()).observe(area);

  function duration(): number {
    return Math.max(player?.tl.duration ?? player?.meta.duration ?? 0, 0.1);
  }
  function togglePlay(): void {
    const p = player;
    if (!p) return;
    if (p.time >= duration() - 0.05) seekTo(0);
    if (p.video) {
      if (p.video.paused) {
        p.video.playbackRate = p.speed;
        void p.video.play();
      } else p.video.pause();
    } else p.playing = !p.playing;
  }
  function seekTo(t: number): void {
    const p = player;
    if (!p) return;
    p.time = Math.max(0, Math.min(duration(), t));
    if (p.video) p.video.currentTime = p.time;
    draw();
  }

  function draw(): void {
    const p = player;
    if (!visible || !p) return;
    p.heat.advance(p.tl, p.time);
    paintPlan(canvas, {
      plan: p.plan, background: p.background, stats: p.heat.stats(p.tl), heatMax: p.heat.maxValue,
      people: p.tl.people(p.time), occupancy: p.tl.occupancy(p.time), cameras: p.marks, layers,
    });
    tNow.textContent = fmtClock(p.time);
    if (!scrubbing) seek.value = String(p.time);
    playBtn.textContent = (p.video ? !p.video.paused : p.playing) ? "❚❚" : "▶";
    stats.replaceChildren(...[["сейчас", p.tl.people(p.time).length], ["людей", p.tl.stats.people], ["пик", p.tl.stats.peak]].map(([t, v]) => {
      const s = el("div", "rec-stat");
      s.append(el("b", "mono", String(v)), el("span", undefined, String(t)));
      return s;
    }));
    const occ = p.tl.occupancy(p.time);
    zonesBox.replaceChildren(...p.plan.zones.map((z) => {
      const c = el("div", "rec-zone");
      const bar = el("i", "tw-zone-bar");
      bar.style.background = zoneColor(z.color);
      const txt = el("div", "tw-zone-text");
      const avg = averageDwell(p.tl.stats, z.id);
      txt.append(el("b", undefined, z.name), el("span", "mono small faint", `заходов ${p.tl.stats.visits[z.id] ?? 0} · в ср. ${avg !== null ? fmtDuration(avg) : "—"} · макс ${p.tl.zonePeak[z.id] ?? 0}`));
      const n = el("b", "mono tw-zone-now", String(occ[z.id] ?? 0));
      n.style.color = zoneColor(z.color);
      c.append(bar, txt, n);
      return c;
    }));
    zonesBox.hidden = !p.plan.zones.length;
  }

  function sync(): void {
    vidWin.setVisible(visible && !!player?.video && showVideo);
  }

  function loop(ts: number): void {
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;
    const p = player;
    if (visible && p && !scrubbing) {
      if (p.video) {
        if (Number.isFinite(p.video.currentTime)) p.time = p.video.currentTime;
        p.playing = !p.video.paused;
        draw();
      } else if (p.playing) {
        p.time = Math.min(duration(), p.time + dt * p.speed);
        if (p.time >= duration()) p.playing = false;
        draw();
      }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  async function open(meta: RecordingMeta): Promise<void> {
    closePlayer();
    playerBox.replaceChildren(el("p", "empty", "Загружаю запись…"));
    const r = await loadRecording(meta.id).catch(() => null);
    if (selectedId !== meta.id) return;
    if (!r) {
      playerBox.replaceChildren(el("p", "empty", "Запись не открылась"));
      return;
    }
    const tl = new Timeline(r.data.plan, r.data.frames);
    let video: HTMLVideoElement | null = null, url: string | null = null;
    if (r.video) {
      url = URL.createObjectURL(r.video);
      video = el("video", "rec-video");
      video.src = url;
      video.playsInline = true;
      video.controls = false;
      video.preload = "auto";
    }
    player = {
      meta, tl, plan: r.data.plan, background: await blobImage(r.background),
      marks: r.data.cameras.flatMap((c) => {
        const cal = r.data.plan.calibrations[c.id];
        const m = cal ? cameraMark(c.name, c.colorIndex, cal, r.data.plan) : null;
        return m ? [m] : [];
      }),
      video, url, time: 0, playing: false, speed: 1, heat: new HeatCursor(),
    };
    seek.max = String(duration());
    tDur.textContent = fmtClock(duration());
    speedSeg.querySelectorAll<HTMLInputElement>("input").forEach((i) => (i.checked = i.value === "1"));
    vidWin.title.textContent = meta.name;
    vidWin.body.replaceChildren(...(video ? [video] : []));
    showVideo = true;
    const title = el("div", "rec-title");
    title.append(el("b", undefined, meta.name), el("span", "small faint", `${SOURCE_TITLES[meta.source]} · ${new Date(meta.created).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`));
    headBox.replaceChildren(title, el("span", "grow"), stats);
    rerenderChips();
    playerBox.replaceChildren(headBox, chips, area, transport, zonesBox);
    sync();
    draw();
  }

  function closePlayer(): void {
    const p = player;
    if (!p) return;
    p.video?.pause();
    if (p.url) URL.revokeObjectURL(p.url);
    p.background?.close();
    player = null;
    vidWin.setVisible(false);
  }

  // ---------------------------------------------------------------- список
  function renderList(): void {
    const nodes: Node[] = [el("p", "eyebrow", "Сохранённые двойники")];
    for (const m of items) {
      const r = el("div", "rec-item");
      if (m.id === selectedId) r.classList.add("on");
      const ic = el("span", "rec-icon", ICON[m.source] ?? "●");
      const txt = el("div", "rec-item-text");
      txt.append(el("b", undefined, m.name), el("span", "mono small faint", `${SOURCE_TITLES[m.source]} · ${fmtClock(m.duration)} · людей ${m.people}`),
        el("span", "small faint", new Date(m.created).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })));
      const ren = button("✎", "icon-btn small-icon", async () => {
        const n = await askText({ title: "Название записи", value: m.name });
        if (n === null) return;
        await renameRecording(m, n);
        reload();
      }, "Переименовать");
      const del = button("🗑", "icon-btn small-icon", async () => {
        if (!(await ask({ title: "Удалить запись?", text: `«${m.name}» удалится${m.hasVideo ? " вместе с копией видео" : ""}.`, ok: "Удалить", danger: true }))) return;
        if (selectedId === m.id) {
          selectedId = null;
          closePlayer();
        }
        await deleteRecording(m.id);
        reload();
      }, "Удалить");
      r.append(ic, txt, ren, del);
      r.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        if (selectedId === m.id) return;
        selectedId = m.id;
        renderList();
        void open(m);
      });
      nodes.push(r);
    }
    if (!items.length) nodes.push(el("p", "hint-small", "Записей пока нет."));
    listBox.replaceChildren(...nodes);
    if (!selectedId) {
      const e = el("div", "rec-empty");
      playerBox.replaceChildren(e);
      e.append(el("h2", undefined, items.length ? "Выберите запись" : "Записей пока нет"),
        el("p", "lead", items.length ? "Слева — сохранённые двойники."
          : "Двойник записывается сам на каждый запуск мониторинга (камеры, привязанные к плану). Ещё — «Сохранить двойника» после видео и «Записать двойника» в демо."));
    }
  }

  function reload(): void {
    void listRecordings().then((list) => {
      items = list;
      if (selectedId && !items.some((m) => m.id === selectedId)) {
        selectedId = null;
        closePlayer();
      }
      if (visible && !selectedId && items.length) {
        selectedId = items[0].id;
        void open(items[0]);
      } else if (visible && selectedId && player?.meta.id !== selectedId) {
        const m = items.find((x) => x.id === selectedId);
        if (m) void open(m);
      }
      renderList();
    });
  }

  return {
    show() {
      visible = true;
      root.hidden = false;
      reload();
      sync();
      draw();
    },
    hide() {
      visible = false;
      root.hidden = true;
      player?.video?.pause();
      if (player) player.playing = false;
      sync();
    },
    reload,
    select(id: string) {
      selectedId = id;
      closePlayer();
      reload();
    },
  };
}
