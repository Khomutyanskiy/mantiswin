// Итоги анализа: карточки метрик, таблица событий, выгрузка файлов.

import type { AnalyticsEvent } from "../engine/analytics";
import type { SessionReport } from "../engine/session";

export const fmtTime = (s: number): string => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

const fmtNum = (v: number | null | undefined, digits = 1, unit = ""): string =>
  v === null || v === undefined || !isFinite(v) ? "—" : `${v.toFixed(digits).replace(".", ",")}${unit}`;

export const pct = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "");

export function eventTitle(e: AnalyticsEvent): string {
  switch (e.kind) {
    case "passed":
      return e.direction === "forward" ? "прошёл →" : "прошёл ←";
    case "slowed":
      return "притормозил";
    case "looked":
      return "посмотрел";
    case "entered":
      return "зашёл";
  }
}

export interface ReportContext {
  report: SessionReport;
  sourceName: string;
  processingSeconds: number;
  backend: string;
  fps: number;
  live: boolean;
  numberOf: (id: number) => number;
}

export function renderReport(root: HTMLElement, ctx: ReportContext): void {
  const { report: r } = ctx;
  const c = r.counters, m = r.metrics;
  const sub = root.querySelector<HTMLElement>("#report-sub")!;
  sub.textContent = [
    ctx.sourceName,
    `${r.width}×${r.height}`,
    `${fmtTime(r.seconds)} видео`,
    ctx.live ? `${r.frames} кадров` : `${r.frames} кадров по ${ctx.fps} в секунду`,
    `обработка ${fmtTime(ctx.processingSeconds)}`,
    ctx.backend,
  ].join(" · ");

  const base = c.passed;
  const baseNote = base > 0 ? "от прошедших мимо" : "линия выключена или никто не пересёк";
  const items: [string, string, string][] = [
    ["Прошли мимо", String(c.passed), `→ ${c.passedForward} · ← ${c.passedBackward}`],
    ["Притормозили", String(c.slowed), base ? `${pct(c.slowed, base)} ${baseNote}` : baseNote],
    ["Посмотрели", String(c.looked), base ? `${pct(c.looked, base)} ${baseNote}` : baseNote],
  ];
  if (r.entered !== null) items.push(["Зашли в магазин", String(r.entered), base ? `${pct(r.entered, base)} ${baseNote}` : "по линии входа"]);
  items.push(
    ["Людей в зоне", String(m.people), `максимум одновременно ${m.maxSimultaneous}`],
    ["Средняя скорость", fmtNum(m.avgSpeed, 1, " м/с"), "у идущих, оценка по росту 1,7 м"],
    ["Остановились", String(m.stopped), m.avgStopSeconds !== null ? `на ${fmtNum(m.avgStopSeconds)} с в среднем` : "стояли 2 с и дольше"],
    ["Время взгляда", fmtNum(m.medianLookSeconds, 1, " с"), m.lookers ? `медиана, всего ${fmtNum(m.totalLookSeconds)} с` : "никто не посмотрел"],
    ["Оглянулись", String(m.lookedBack), "смотрели на витрину уже после прохода"],
    ["Подошли ближе", String(m.approached), "подошли к камере вплотную"],
    ["Группы", String(m.groups), `в группах ${m.peopleInGroups} чел., одиночек ${m.singles}`],
    ["Направление", `${m.leftToRight} → · ${m.rightToLeft} ←`, `к камере ${m.towardCamera}, от камеры ${m.awayFromCamera}`],
  );

  const grid = root.querySelector<HTMLElement>("#metrics")!;
  grid.replaceChildren(
    ...items.map(([l, v, s]) => {
      const d = document.createElement("div");
      d.className = "metric";
      const lv = document.createElement("span");
      lv.className = "l";
      lv.textContent = l;
      const vv = document.createElement("span");
      vv.className = "v";
      vv.textContent = v;
      const sv = document.createElement("span");
      sv.className = "s";
      sv.textContent = s;
      d.append(lv, vv, sv);
      return d;
    }),
  );

  const body = root.querySelector<HTMLElement>("#events-body")!;
  const evs = [...r.events].sort((a, b) => a.t - b.t);
  root.querySelector<HTMLElement>("#events-count")!.textContent = `(${evs.length})`;
  body.replaceChildren(
    ...evs.map((e) => {
      const tr = document.createElement("tr");
      for (const v of [fmtTime(e.t), `№ ${ctx.numberOf(e.trackId)}`, eventTitle(e)]) {
        const td = document.createElement("td");
        td.textContent = v;
        tr.append(td);
      }
      return tr;
    }),
  );
}

// ---- Выгрузка

function download(name: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const csv = (rows: (string | number)[][]): string =>
  "﻿" + rows.map((r) => r.map((v) => (typeof v === "string" && /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v))).join(";")).join("\n");

const r2 = (v: number) => Math.round(v * 100) / 100;

export function exportSummary(ctx: ReportContext, stamp: string): void {
  const r = ctx.report, c = r.counters;
  const json = {
    source: ctx.sourceName,
    width: r.width,
    height: r.height,
    seconds: r2(r.seconds),
    frames: r.frames,
    passed: c.passed,
    passed_forward: c.passedForward,
    passed_backward: c.passedBackward,
    slowed: c.slowed,
    looked: c.looked,
    entered: r.entered,
    slowed_rate: c.passed ? Math.round((c.slowed / c.passed) * 1000) / 1000 : null,
    looked_rate: c.passed ? Math.round((c.looked / c.passed) * 1000) / 1000 : null,
    metrics: r.metrics,
  };
  download(`mantis_summary_${stamp}.json`, JSON.stringify(json, null, 2), "application/json");
}

export function exportEvents(ctx: ReportContext, stamp: string): void {
  const rows: (string | number)[][] = [["t", "track_id", "event", "direction"]];
  for (const e of [...ctx.report.events].sort((a, b) => a.t - b.t)) rows.push([r2(e.t), e.trackId, e.kind, e.direction]);
  download(`mantis_events_${stamp}.csv`, csv(rows), "text/csv");
}

export function exportTracks(ctx: ReportContext, stamp: string): void {
  const rows: (string | number)[][] = [
    ["track_id", "first_t", "last_t", "duration", "passed", "direction", "slowed", "looked", "zone_time", "slow_time", "look_time", "min_speed"],
  ];
  for (const t of ctx.report.tracks.filter((t) => t.everInZone)) {
    rows.push([
      t.trackId, r2(t.firstT), r2(t.lastT), r2(t.lastT - t.firstT), Number(t.passed), t.direction, Number(t.slowed), Number(t.looked),
      r2(t.zoneTime), r2(t.slowTime), r2(t.lookTime), t.minSpeed === null ? "" : Math.round(t.minSpeed * 1000) / 1000,
    ]);
  }
  download(`mantis_tracks_${stamp}.csv`, csv(rows), "text/csv");
}
