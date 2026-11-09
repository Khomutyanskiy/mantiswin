// Отчёты — порт ReportDetailView.swift, ReportsHistoryView (ProfileView.swift) и ReportPDF.swift (Mantis для Mac):
// отчёт одного запуска (итоги, по часам, сравнение камер, оценка витрины, запись двойника, видео), список отчётов
// с фильтрами, выбор нескольких, сводный отчёт, удаление, выгрузка в Excel (CSV) и PDF (печать «Сохранить как PDF»).

import type { BusinessProfile } from "../cloud/firebase";
import { showcaseScore } from "../pilot/business";
import { type HourStat, keyDate } from "../pilot/hours";
import { ask } from "../ui/confirm";
import { download, reportsCsv, stamp } from "./csv";
import {
  type ReportCamera, type ReportStore, type ReportSummary, cameraClips, combineReports, reportPlural, reportStart, reportTotal,
} from "./store";

// ---------------------------------------------------------------- связи с остальным приложением

/** Видео отчётов на этом компьютере (запись по событиям). null — видео здесь не хранится. */
export interface VideoFiles {
  url(folder: string, file: string): Promise<string | null>;
  removeFolder(folder: string): Promise<void>;
  removeFile(folder: string, file: string): Promise<void>;
  /** Открыть папку в проводнике / Finder (только в приложении). */
  reveal?(folder: string): void;
}

export interface TwinLink {
  meta(id: string): Promise<{ duration: number; people: number; peak: number } | null>;
  open(id: string): void;
  remove(id: string): Promise<void>;
}

export interface ReportsCtx {
  store: ReportStore;
  profile: () => BusinessProfile;
  twin: TwinLink;
  video: VideoFiles | null;
  toast: (text: string, error?: boolean) => void;
  /** Показать пример данных (когда отчётов нет). */
  sample?: () => void;
}

// ---------------------------------------------------------------- мелочи

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
const pad = (n: number) => String(n).padStart(2, "0");
/** 1:05:09 / 5:09 — как ResultView.formatTime на Mac (минуты:секунды), с часами для долгих запусков. */
export function fmtDuration(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
const MONTHS = ["янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."];
const full = (ms: number) => {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} г., ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const time = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** «8 нояб. 2026 г., 09:48 – 18:10 · работал 8:22:00». */
export function reportPeriod(r: ReportSummary): string {
  if (r.started !== undefined && r.ended !== undefined) return `${full(r.started)} – ${full(r.ended)} · всего ${fmtDuration(r.duration)}`;
  if (r.started !== undefined) {
    const end = r.started + r.duration * 1000;
    return `${full(r.started)} – ${sameDay(r.started, end) ? time(end) : full(end)} · работал ${fmtDuration(r.duration)}`;
  }
  return `${full(r.date)} · ${fmtDuration(r.duration)}`;
}

export type ReportKind = "monitoring" | "video" | "quick" | "demo" | "summary";
export const KIND_TITLES: Record<ReportKind | "all", string> = {
  all: "Все", monitoring: "Мониторинг", video: "Анализ видео", quick: "Быстрый показ", demo: "Демо", summary: "Сводные",
};
export function kindOf(r: ReportSummary): ReportKind {
  if (r.source === "video") return "video";
  if (r.source === "summary") return "summary";
  if (r.source === "demo") return "demo";
  return r.started !== undefined || r.title.startsWith("Мониторинг") || r.title.startsWith("Пилот") ? "monitoring" : "quick";
}

const pctOf = (v: number, of: number) => (of > 0 ? `${Math.round((v / of) * 100)}%` : "");

function hourRows(r: ReportSummary): { date: Date; stat: HourStat }[] {
  return Object.entries(r.hours ?? {})
    .map(([k, v]) => ({ date: keyDate(k), stat: v }))
    .filter((x): x is { date: Date; stat: HourStat } => !!x.date)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

// ---------------------------------------------------------------- данные отчёта (как в «Статистике»)

const COLORS = { people: "#c9d4ea", slowed: "#5bd97f", looked: "#ffd23f", entered: "#7ee6c4", passed: "#47d7f0" };

/** Столбцы по часам: люди, притормозили, посмотрели — рядом. */
function hourChart(rows: { date: Date; stat: HourStat }[], width: number): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const W = Math.max(320, Math.round(width)), H = 200, left = 34, right = 8, top = 12, bottom = 24;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "chart");
  const max = Math.max(1, ...rows.map((r) => Math.max(r.stat.people, r.stat.slowed, r.stat.looked)));
  const p = Math.pow(10, Math.floor(Math.log10(max)));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= max) ?? 10 * p;
  const y = (v: number) => top + (H - top - bottom) * (1 - v / nice);
  const add = (tag: string, attrs: Record<string, string | number>, text?: string) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text !== undefined) e.textContent = text;
    svg.append(e);
    return e;
  };
  for (let i = 0; i <= 4; i++) {
    const v = (nice / 4) * i;
    add("line", { x1: left, x2: W - right, y1: y(v), y2: y(v), class: "grid" });
    add("text", { x: left - 6, y: y(v) + 3, "text-anchor": "end" }, String(Math.round(v * 10) / 10));
  }
  const multiDay = new Set(rows.map((r) => r.date.toDateString())).size > 1;
  const slot = (W - left - right) / Math.max(1, rows.length);
  const bw = Math.max(2, Math.min(14, (slot * 0.8) / 3));
  const every = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor((W - left - right) / 42))));
  rows.forEach((r, i) => {
    const cx = left + slot * (i + 0.5);
    ([["people", r.stat.people], ["slowed", r.stat.slowed], ["looked", r.stat.looked]] as const).forEach(([k, v], j) => {
      if (v <= 0) return;
      const rect = add("rect", { x: cx + (j - 1.5) * bw, y: y(v), width: bw - 1, height: Math.max(1, y(0) - y(v)), rx: 2 });
      rect.setAttribute("fill", COLORS[k]);
      const t = document.createElementNS(NS, "title");
      t.textContent = `${pad(r.date.getHours())}:00 · ${k === "people" ? "людей" : k === "slowed" ? "притормозили" : "посмотрели"}: ${v}`;
      rect.append(t);
    });
    if (i % every === 0) add("text", { x: cx, y: H - 7, "text-anchor": "middle" }, multiDay ? `${r.date.getDate()}, ${r.date.getHours()}` : `${r.date.getHours()}:00`);
  });
  return svg;
}

function legend(): HTMLElement {
  const l = el("div", "rp-legend");
  for (const [k, t] of [["people", "Людей"], ["slowed", "Притормозили"], ["looked", "Посмотрели"]] as const) {
    const s = el("span");
    const i = el("i");
    i.style.background = COLORS[k];
    s.append(i, document.createTextNode(t));
    l.append(s);
  }
  return l;
}

function cameraTable(cams: ReportCamera[], showEntered: boolean): HTMLElement {
  const total = cams.reduce((a, c) => a + c.people, 0);
  const maxP = Math.max(1, ...cams.map((c) => c.people));
  const table = el("table", "cam-table");
  const head = el("tr");
  for (const h of ["Камера", "Людей", "Прошли", "Притормоз.", "Посмотр.", "% посм.", ...(showEntered ? ["Зашли"] : []), "Часов"]) head.append(el("th", undefined, h));
  const thead = el("thead");
  thead.append(head);
  const tbody = el("tbody");
  const line = (c: ReportCamera, bold: boolean) => {
    const tr = el("tr", bold ? "total" : undefined);
    const first = el("td");
    const nm = el("div", "cam-name");
    nm.append(el("span", undefined, c.name));
    if (!bold && total > 0) nm.append(el("span", "share", pctOf(c.people, total)));
    first.append(nm);
    if (!bold) {
      const bar = el("div", "share-bar");
      const fill = el("i");
      fill.style.width = `${Math.max(2, (c.people / maxP) * 100)}%`;
      bar.append(fill);
      first.append(bar);
    }
    tr.append(first);
    for (const v of [c.people, c.passed, c.slowed, c.looked]) tr.append(el("td", "mono", String(v)));
    tr.append(el("td", "mono faint", c.people > 0 ? pctOf(c.looked, c.people) : "—"));
    if (showEntered) tr.append(el("td", "mono", String(c.entered ?? 0)));
    tr.append(el("td", "mono faint", ((c.seconds ?? 0) / 3600).toFixed(1).replace(".", ",")));
    tbody.append(tr);
  };
  for (const c of cams) line(c, false);
  if (cams.length > 1) {
    const sum = cams.reduce<ReportCamera>((a, c) => ({
      name: "", people: a.people + c.people, passed: a.passed + c.passed, slowed: a.slowed + c.slowed, looked: a.looked + c.looked,
      entered: (a.entered ?? 0) + (c.entered ?? 0), seconds: (a.seconds ?? 0) + (c.seconds ?? 0),
    }), { name: "", people: 0, passed: 0, slowed: 0, looked: 0 });
    sum.name = `Итого · ${cams.length} ${cams.length < 5 ? "камеры" : "камер"}`;
    line(sum, true);
  }
  table.append(thead, tbody);
  const wrap = el("div", "table-scroll");
  wrap.append(table);
  return wrap;
}

function scoreBlock(r: ReportSummary, t: HourStat): HTMLElement {
  const box = el("div", "rp-card");
  box.append(el("h3", undefined, "Оценка витрины"), el("p", "sub", "насколько витрина цепляет прохожих"));
  const sc = showcaseScore(t.people, t.looked, t.slowed, r.stopped, r.approached, r.entered !== undefined ? t.entered : null);
  if (!sc) {
    box.append(el("p", "hint-small", "Нужно хотя бы 3 человека в зоне."));
    return box;
  }
  const color = sc.value >= 70 ? "#5bd97f" : sc.value >= 40 ? "#ffd23f" : "#ff7a66";
  const top = el("div", "rp-score");
  const ring = el("div", "rp-ring");
  ring.style.setProperty("--v", String(sc.value));
  ring.style.setProperty("--c", color);
  ring.append(el("b", undefined, String(sc.value)));
  const txt = el("div");
  const g = el("b", "rp-grade", sc.grade[0].toUpperCase() + sc.grade.slice(1));
  g.style.color = color;
  txt.append(g, el("p", "hint-small", `по ${t.people} людям в зоне`), el("p", "hint-small faint", "70+ — сильная, 40–69 — средняя, ниже 40 — слабая"));
  top.append(ring, txt);
  box.append(top);
  for (const p of sc.parts) {
    const row = el("div", "rp-part");
    const head = el("div", "row-between");
    head.append(el("span", undefined, p.title), el("span", "mono small faint", `${Math.round(p.rate * 100)}% · цель ${Math.round(p.target * 100)}%`));
    const bar = el("div", "share-bar wide");
    const fill = el("i");
    fill.style.width = `${Math.max(3, Math.min(1, p.rate / p.target) * 100)}%`;
    fill.style.background = color;
    bar.append(fill);
    row.append(head, bar);
    box.append(row);
  }
  return box;
}

/** Блоки отчёта: итоги, по часам, сравнение камер, оценка витрины. */
export function reportStats(r: ReportSummary, width = 860): HTMLElement {
  const t = reportTotal(r);
  const rows = hourRows(r);
  const root = el("div", "rp-stats");
  const hours = t.seconds / 3600;
  const peak = rows.reduce<{ date: Date; stat: HourStat } | null>((a, x) => (!a || x.stat.people > a.stat.people ? x : a), null);
  const m = el("div", "metrics");
  const item = (l: string, v: string, s = "") => {
    const d = el("div", "metric");
    d.append(el("span", "l", l), el("span", "v", v), el("span", "s", s));
    m.append(d);
  };
  item("Наблюдали", fmtDuration(t.seconds));
  item("Людей", String(t.people), hours > 0.05 ? `${Math.round(t.people / hours)} в час` : "");
  item("Притормозили", String(t.slowed), pctOf(t.slowed, t.people));
  item("Посмотрели", String(t.looked), pctOf(t.looked, t.people));
  if (r.entered !== undefined) item("Вошли", String(t.entered), pctOf(t.entered, t.people));
  if (peak && peak.stat.people > 0 && rows.length > 1) item("Час пик", `${pad(peak.date.getHours())}:00`, `людей: ${peak.stat.people}`);
  root.append(m);
  // по часам — только если запуск шёл хотя бы полчаса
  if (rows.length && r.duration >= 1800) {
    const c = el("div", "rp-card");
    c.append(el("h3", undefined, "По часам"), el("p", "sub", "за этот запуск"), hourChart(rows, width - 40), legend());
    root.append(c);
  }
  if (r.cameras?.length) {
    const c = el("div", "rp-card");
    c.append(el("h3", undefined, "Сравнение камер"), el("p", "sub", "за этот запуск"), cameraTable(r.cameras, r.entered !== undefined));
    root.append(c);
  }
  root.append(scoreBlock(r, t));
  return root;
}

// ---------------------------------------------------------------- PDF (печать в PDF)

/** Отчёт в PDF: страница A4 со светлым оформлением, окно печати — «Сохранить как PDF». */
export function printReport(r: ReportSummary): void {
  const frame = el("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.append(frame);
  const doc = frame.contentDocument!;
  const css = `
    @page { size: A4; margin: 14mm; }
    body { font: 12px/1.45 "Segoe UI", "Onest Variable", system-ui, sans-serif; color: #1a2340; margin: 0; }
    h1 { font-size: 20px; margin: 0 0 2px; } .period { color: #5a6788; margin: 0 0 14px; }
    .brand { color: #5a6788; font-size: 11px; margin-bottom: 12px; display: flex; justify-content: space-between; }
    .metrics { display: flex; flex-wrap: wrap; gap: 0; border: 1px solid #d5dbea; border-radius: 8px; overflow: hidden; margin-bottom: 14px; }
    .metric { flex: 1 1 110px; padding: 8px 10px; border-right: 1px solid #d5dbea; display: flex; flex-direction: column; }
    .metric:last-child { border-right: 0; } .metric .l { color: #5a6788; font-size: 11px; } .metric .v { font-size: 18px; font-weight: 700; }
    .metric .s { color: #8a95b3; font-size: 10px; }
    .rp-card { border: 1px solid #d5dbea; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; break-inside: avoid; }
    .rp-card h3 { margin: 0; font-size: 13px; } .sub { color: #8a95b3; margin: 0 0 8px; font-size: 10px; }
    table { border-collapse: collapse; width: 100%; } th, td { text-align: right; padding: 4px 6px; border-bottom: 1px solid #e3e7f1; white-space: nowrap; }
    th:first-child, td:first-child { text-align: left; } th { color: #5a6788; font-weight: 600; font-size: 10px; } tr.total td { font-weight: 700; }
    .share, .share-bar, .rp-ring { display: none; } .chart text { fill: #5a6788; font-size: 9px; } .chart .grid { stroke: #e3e7f1; }
    .rp-legend { display: flex; gap: 14px; font-size: 10px; color: #5a6788; } .rp-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; }
    .rp-score b.rp-grade { font-size: 15px; } .hint-small { margin: 2px 0; color: #5a6788; } .faint { color: #8a95b3; }
    .rp-part { margin: 6px 0; } .row-between { display: flex; justify-content: space-between; } .mono { font-variant-numeric: tabular-nums; }
    .foot { color: #8a95b3; font-size: 10px; margin-top: 16px; }
  `;
  doc.open();
  doc.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Отчёт Mantis ${stamp(new Date(reportStart(r)))}</title><style>${css}</style></head><body></body></html>`);
  doc.close();
  const body = doc.body;
  const brand = doc.createElement("div");
  brand.className = "brand";
  brand.innerHTML = "<span>Mantis — аналитика витрины</span>";
  const made = doc.createElement("span");
  made.textContent = `Сформирован ${full(Date.now())}`;
  brand.append(made);
  const h = doc.createElement("h1");
  h.textContent = r.title || "Отчёт";
  const per = doc.createElement("p");
  per.className = "period";
  per.textContent = reportPeriod(r);
  const stats = reportStats(r, 680);
  const foot = doc.createElement("p");
  foot.className = "foot";
  foot.textContent = "Лица не распознаются и не сохраняются. «Посмотрели» — голова повёрнута к витрине; «притормозили» — замедлились или постояли в зоне витрины. © РСМ АйТи";
  body.append(brand, h, per, doc.importNode(stats, true), foot);
  setTimeout(() => {
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    setTimeout(() => frame.remove(), 60_000);
  }, 120);
}

// ---------------------------------------------------------------- удаление

export async function deleteReportVideos(r: ReportSummary, ctx: ReportsCtx): Promise<ReportSummary> {
  if (r.videoFolder && ctx.video) await ctx.video.removeFolder(r.videoFolder).catch(() => undefined);
  const out: ReportSummary = {
    ...r, videoFolder: undefined,
    cameras: r.cameras?.map((c) => ({ ...c, video: undefined, videoSeconds: undefined, clips: undefined })),
  };
  ctx.store.update(out);
  return out;
}

export async function deleteReportTwin(r: ReportSummary, ctx: ReportsCtx): Promise<ReportSummary> {
  if (r.twinID) await ctx.twin.remove(r.twinID).catch(() => undefined);
  const out = { ...r, twinID: undefined };
  ctx.store.update(out);
  return out;
}

export async function deleteReport(r: ReportSummary, ctx: ReportsCtx): Promise<void> {
  if (r.videoFolder && ctx.video) await ctx.video.removeFolder(r.videoFolder).catch(() => undefined);
  if (r.twinID) await ctx.twin.remove(r.twinID).catch(() => undefined);
  ctx.store.delete(r.id);
}

// ---------------------------------------------------------------- отчёт целиком

export interface DetailOptions {
  /** Сводка, ещё не сохранённая: вместо «Удалить» — «Сохранить в отчёты». */
  draft?: boolean;
  /** Открыт из списка — сверху «Все отчёты». */
  back?: () => void;
  onDeleted?: () => void;
}

export function renderReportDetail(root: HTMLElement, report: ReportSummary, ctx: ReportsCtx, o: DetailOptions = {}): void {
  let r = report;
  let playerUrl: string | null = null;
  const wrap = el("div", "rp-detail");
  root.replaceChildren(wrap);

  async function render(): Promise<void> {
    const nodes: Node[] = [];
    if (o.back) nodes.push(button("‹ Все отчёты", "btn small rp-back", o.back));
    const head = el("div", "rp-head");
    const tt = el("div");
    tt.append(el("h2", undefined, r.title || "Отчёт"), el("p", "report-sub", reportPeriod(r)));
    head.append(tt, button("Скачать PDF", "btn small", () => printReport(r)));
    nodes.push(head, reportStats(r, Math.min(880, wrap.clientWidth || 880)));

    // цифровой двойник
    const tm = r.twinID ? await ctx.twin.meta(r.twinID) : null;
    if (r.twinID && tm) {
      const c = el("div", "rp-card rp-line");
      const txt = el("div");
      txt.append(el("b", undefined, "Цифровой двойник: люди на плане за этот запуск"),
        el("p", "hint-small", `${fmtDuration(tm.duration)} · людей ${tm.people} · одновременно до ${tm.peak}`));
      c.append(txt, button("Смотреть", "btn small", () => ctx.twin.open(r.twinID!)), button("Удалить", "link danger", async () => {
        if (await ask({ title: "Удалить запись двойника?", text: "Отчёт и цифры останутся.", ok: "Удалить двойника", danger: true })) {
          r = await deleteReportTwin(r, ctx);
          void render();
        }
      }));
      nodes.push(c);
    }

    // видео
    const vids = (r.cameras ?? []).map((c, i) => ({ c, i, clips: cameraClips(c) })).filter((x) => x.clips.length);
    if (vids.length && r.videoFolder) {
      const c = el("div", "rp-card");
      const h = el("div", "row-between");
      h.append(el("h3", undefined, "Видео"));
      const acts = el("div", "rp-acts");
      if (ctx.video?.reveal) acts.append(button("Показать в папке", "link", () => ctx.video!.reveal!(r.videoFolder!)));
      acts.append(button("Удалить всё видео", "link danger", async () => {
        if (await ask({ title: "Удалить всё видео этого отчёта?", text: "Отчёт и цифры останутся.", ok: "Удалить видео", danger: true })) {
          r = await deleteReportVideos(r, ctx);
          playerUrl = null;
          void render();
        }
      }));
      h.append(acts);
      c.append(h);
      const player = el("video", "rp-player");
      player.controls = true;
      player.hidden = !playerUrl;
      if (playerUrl) player.src = playerUrl;
      c.append(player);
      for (const v of vids) {
        const row = el("div", "rp-video");
        const total = v.clips.reduce((a, x) => a + x.seconds, 0);
        const txt = el("div");
        txt.append(el("b", undefined, v.c.name),
          el("p", "hint-small", v.clips.length > 1 ? `${v.clips.length} событий · всего ${fmtDuration(total)}` : `${fmtDuration(total)} · с разметкой и временем`));
        row.append(txt);
        const list = el("div", "rp-clips");
        for (const clip of v.clips) {
          const b = button(`${clip.start ? time(clip.start) + ":" + pad(new Date(clip.start).getSeconds()) : "—"} · ${fmtDuration(clip.seconds)} · ${clip.people ? "люди" : "движение"}`, "chip");
          b.addEventListener("click", async () => {
            const url = ctx.video ? await ctx.video.url(r.videoFolder!, clip.file) : null;
            if (!url) {
              ctx.toast("Файл видео не найден на этом компьютере", true);
              return;
            }
            playerUrl = url;
            player.hidden = false;
            player.src = url;
            void player.play().catch(() => undefined);
          });
          list.append(b);
        }
        row.append(list, button("Удалить", "link danger", async () => {
          if (!ctx.video || !r.videoFolder) return;
          for (const clip of v.clips) await ctx.video.removeFile(r.videoFolder, clip.file).catch(() => undefined);
          const cams = (r.cameras ?? []).map((x, j) => (j === v.i ? { ...x, video: undefined, videoSeconds: undefined, clips: undefined } : x));
          r = { ...r, cameras: cams };
          if (!cams.some((x) => cameraClips(x).length)) r = await deleteReportVideos(r, ctx);
          else ctx.store.update(r);
          void render();
        }));
        c.append(row);
      }
      nodes.push(c);
    }

    // сохранить / удалить
    const foot = el("div", "rp-foot");
    if (o.draft) {
      const b = button("Сохранить в отчёты", "btn", () => {
        ctx.store.add(r);
        b.textContent = "Сохранено в «Отчётах»";
        b.disabled = true;
      });
      foot.append(b);
    } else {
      foot.append(button(`Удалить отчёт${r.videoFolder || r.twinID ? " с записями" : ""}`, "btn danger-outline", async () => {
        const ok = await ask({
          title: "Удалить отчёт?", ok: "Удалить", danger: true,
          text: r.videoFolder || r.twinID ? "Видео и запись двойника этого запуска тоже удалятся." : "Статистика по часам и дням останется.",
        });
        if (!ok) return;
        await deleteReport(r, ctx);
        o.onDeleted?.();
      }));
    }
    nodes.push(foot);
    wrap.replaceChildren(...nodes);
  }
  void render();
}

// ---------------------------------------------------------------- список отчётов

type Period = "all" | "today" | "week" | "month";
const PERIODS: [Period, string][] = [["all", "Все"], ["today", "Сегодня"], ["week", "7 дней"], ["month", "30 дней"]];
const periodFrom = (p: Period): number | null => {
  const now = new Date();
  if (p === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (p === "week") return now.getTime() - 7 * 86400_000;
  if (p === "month") return now.getTime() - 30 * 86400_000;
  return null;
};

function chips<T extends string>(items: [T, string][], value: T, onPick: (v: T) => void): HTMLElement {
  const row = el("div", "chips");
  for (const [v, t] of items) {
    const b = button(t, "");
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(v === value));
    b.addEventListener("click", () => onPick(v));
    row.append(b);
  }
  return row;
}

export interface ReportsList {
  render(): void;
}

/** Список отчётов: фильтры (период, тип, с видео, с двойником, были люди), выбор, сводка, Excel. */
export function mountReportsList(root: HTMLElement, ctx: ReportsCtx, open: (r: ReportSummary, opts?: DetailOptions) => void): ReportsList {
  const saved = (k: string, d: string) => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  };
  const remember = (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* нет */
    }
  };
  let period = saved("reports.period", "all") as Period;
  let kind = saved("reports.kind", "all") as ReportKind | "all";
  let onlyVideo = false, onlyTwin = false, onlyPeople = false;
  let selecting = false;
  const selected = new Set<string>();

  /** Номер отчёта: по порядку создания, первый — самый старый (не меняется от фильтров). */
  const number = (r: ReportSummary) => ctx.store.items.length - ctx.store.items.findIndex((x) => x.id === r.id);

  function filtered(): ReportSummary[] {
    const from = periodFrom(period);
    return ctx.store.items.filter((r) => {
      if (from !== null && reportStart(r) < from) return false;
      if (kind !== "all" && kindOf(r) !== kind) return false;
      if (onlyVideo && !r.videoFolder) return false;
      if (onlyTwin && !r.twinID) return false;
      if (onlyPeople && r.people === 0) return false;
      return true;
    });
  }

  function render(): void {
    const items = filtered();
    const all = ctx.store.items;
    const nodes: Node[] = [];
    const bar = el("div", "rp-filters");
    bar.append(
      chips(PERIODS, period, (v) => ((period = v), remember("reports.period", v), render())),
      chips(Object.entries(KIND_TITLES) as [ReportKind | "all", string][], kind, (v) => ((kind = v), remember("reports.kind", v), render())),
    );
    const row2 = el("div", "rp-filters-2");
    const check = (title: string, on: boolean, set: (v: boolean) => void) => {
      const l = el("label", "rp-check");
      const i = el("input");
      i.type = "checkbox";
      i.checked = on;
      i.addEventListener("change", () => (set(i.checked), render()));
      l.append(i, document.createTextNode(title));
      return l;
    };
    row2.append(check("с видео", onlyVideo, (v) => (onlyVideo = v)), check("с двойником", onlyTwin, (v) => (onlyTwin = v)),
      check("были люди", onlyPeople, (v) => (onlyPeople = v)));
    if (period !== "all" || kind !== "all" || onlyVideo || onlyTwin || onlyPeople) {
      row2.append(button("Сбросить фильтры", "link", () => {
        period = "all";
        kind = "all";
        onlyVideo = onlyTwin = onlyPeople = false;
        remember("reports.period", "all");
        remember("reports.kind", "all");
        render();
      }));
    }
    row2.append(el("span", "grow"), el("span", "mono small faint", `${items.length} из ${all.length}`));
    const xls = button("В Excel", "btn small", () => download(reportsCsv(items, number, (r) => KIND_TITLES[kindOf(r)]), `Отчёты Mantis ${stamp()}.csv`));
    xls.disabled = !items.length;
    xls.title = "Выгрузить отчёты из списка (с учётом фильтров) в Excel — файл CSV";
    const sel = button(selecting ? "Готово" : "Выбрать", "btn small", () => {
      selecting = !selecting;
      if (!selecting) selected.clear();
      render();
    });
    row2.append(xls, sel);
    bar.append(row2);
    if (selecting) {
      const sb = el("div", "rp-select");
      const ids = items.map((r) => r.id);
      const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
      sb.append(
        button(allOn ? "Снять все" : `Выбрать все (${items.length})`, "link", () => {
          for (const id of ids) allOn ? selected.delete(id) : selected.add(id);
          render();
        }),
        el("span", "small faint", `Выбрано: ${selected.size}`), el("span", "grow"),
      );
      const sum = button(`Сводка (${selected.size})`, "btn small", () => {
        open(combineReports(all.filter((r) => selected.has(r.id))), { draft: true });
      });
      sum.disabled = selected.size < 2;
      sum.title = "Сложить выбранные отчёты в один: итоги, по часам, по камерам, оценка — смотреть и скачать PDF";
      const dv = button("Удалить видео и двойников", "btn small", async () => {
        if (!(await ask({ title: `Удалить видео и двойников у ${selected.size} ${reportPlural(selected.size)}?`, text: "Отчёты и цифры останутся.", ok: "Удалить", danger: true }))) return;
        for (const r of all.filter((x) => selected.has(x.id))) {
          let r2 = r;
          if (r2.videoFolder) r2 = await deleteReportVideos(r2, ctx);
          if (r2.twinID) await deleteReportTwin(r2, ctx);
        }
        render();
      });
      dv.disabled = !selected.size;
      const dr = button("Удалить отчёты", "btn small danger-outline", async () => {
        if (!(await ask({
          title: `Удалить ${selected.size} ${reportPlural(selected.size)}?`, ok: "Удалить отчёты", danger: true,
          text: "Видео и записи двойника этих отчётов тоже удалятся. Статистика по часам и дням останется.",
        }))) return;
        for (const r of all.filter((x) => selected.has(x.id))) await deleteReport(r, ctx);
        selected.clear();
        render();
      });
      dr.disabled = !selected.size;
      sb.append(sum, dv, dr);
      bar.append(sb);
    }
    nodes.push(bar);

    if (!all.length) {
      const e = el("div", "empty");
      e.append(el("h3", undefined, "Пока пусто"), el("p", undefined, "Здесь появятся отчёты мониторинга, демо, анализа видео и быстрого показа."));
      if (ctx.sample) e.append(button("Показать пример", "btn", ctx.sample));
      nodes.push(e);
    } else if (!items.length) {
      const e = el("div", "empty");
      e.append(el("h3", undefined, "Ничего не найдено"), el("p", undefined, "Под фильтры не подходит ни один отчёт."));
      nodes.push(e);
    } else {
      const list = el("div", "rp-list");
      for (const r of items) list.append(rowFor(r));
      nodes.push(list);
    }
    root.replaceChildren(...nodes);
  }

  function rowFor(r: ReportSummary): HTMLElement {
    const k = kindOf(r);
    const on = selected.has(r.id);
    const row = el("div", `rp-row${k === "demo" ? " demo" : ""}${on ? " on" : ""}`);
    row.tabIndex = 0;
    row.append(el("span", "rp-num mono", String(number(r))));
    if (selecting) row.append(el("span", `rp-tick${on ? " on" : ""}`, on ? "✓" : ""));
    const main = el("div", "rp-main");
    const t = el("div", "rp-title");
    t.append(el("b", undefined, r.title || (r.source === "camera" ? "Камера" : "Видео")), el("span", "rp-kind", KIND_TITLES[k]));
    const meta = el("div", "mono small faint", `${full(reportStart(r))} · ${fmtDuration(r.duration)}`);
    main.append(t, meta);
    const marks = el("div", "rp-marks");
    if (r.videoFolder) marks.append(el("span", undefined, "▶ видео"));
    if (r.twinID) marks.append(el("span", undefined, "◎ двойник"));
    if (marks.childElementCount) main.append(marks);
    row.append(main);
    const nums = el("div", "rp-nums");
    const stat = (v: number, title: string, color: string) => {
      const s = el("div");
      const b = el("b", "mono", String(v));
      b.style.color = color;
      s.append(b, el("span", undefined, title));
      nums.append(s);
    };
    stat(r.people, "людей", "var(--fg)");
    stat(r.slowed, "притормозили", COLORS.slowed);
    stat(r.looked, "посмотрели", COLORS.looked);
    if (r.entered !== undefined) stat(r.entered, "вошли", COLORS.entered);
    row.append(nums);
    if (r.score !== undefined) row.append(el("span", "rp-score-pill mono", String(r.score)));
    const go = () => {
      if (selecting) {
        on ? selected.delete(r.id) : selected.add(r.id);
        render();
      } else open(r);
    };
    row.addEventListener("click", go);
    row.addEventListener("keydown", (e) => e.key === "Enter" && go());
    return row;
  }

  ctx.store.subscribe(() => root.isConnected && !root.closest("[hidden]") && render());
  render();
  return { render };
}

/** Отчёт последнего запуска мониторинга (если мониторинга ещё не было — самый новый отчёт). */
export function lastReport(store: ReportStore): ReportSummary | undefined {
  return store.items.find((r) => r.source === "camera" && r.started !== undefined) ?? store.items.find((r) => r.source !== "summary");
}

export { combineReports };
