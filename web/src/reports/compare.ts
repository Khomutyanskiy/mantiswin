// «Сравнение периодов» в статистике — порт ComparePeriodsCard.swift: сегодня / вчера, 7 / 7, 30 / 30 или свои даты
// («до и после смены витрины»). Рост и падение в процентах; «в час» — честнее, если наблюдали разное время.

import { type HourStat, addHours, emptyHour, keyDate } from "../pilot/hours";

type Preset = "day" | "week" | "month" | "custom";
const PRESETS: [Preset, string][] = [["day", "Сегодня / вчера"], ["week", "7 дней / 7 до них"], ["month", "30 дней / 30 до них"], ["custom", "Свои даты"]];
const KEY = "compare.preset";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromIso = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** Сумма часов в полуинтервале [from, to). */
export function periodTotal(hours: Record<string, HourStat>, from: Date, to: Date): HourStat {
  let t = emptyHour();
  for (const [k, v] of Object.entries(hours)) {
    const d = keyDate(k);
    if (d && d >= from && d < to) t = addHours(t, v);
  }
  return t;
}

const custom = {
  aFrom: addDays(new Date(), -14), aTo: addDays(new Date(), -8), bFrom: addDays(new Date(), -7), bTo: new Date(),
};

export function renderCompare(root: HTMLElement, hours: Record<string, HourStat>, scope: string, rerender: () => void): void {
  let preset: Preset = "week";
  try {
    preset = (localStorage.getItem(KEY) as Preset) || "week";
  } catch {
    /* нет */
  }
  const today = dayStart(new Date()), tomorrow = addDays(today, 1);
  let a: [Date, Date], b: [Date, Date], aT: string, bT: string;
  if (preset === "day") [a, b, aT, bT] = [[addDays(today, -1), today], [today, tomorrow], "Вчера", "Сегодня"];
  else if (preset === "month") [a, b, aT, bT] = [[addDays(tomorrow, -60), addDays(tomorrow, -30)], [addDays(tomorrow, -30), tomorrow], "30 дней до", "Последние 30 дней"];
  else if (preset === "custom") {
    a = [dayStart(custom.aFrom), addDays(dayStart(custom.aTo), 1)];
    b = [dayStart(custom.bFrom), addDays(dayStart(custom.bTo), 1)];
    aT = "Период А";
    bT = "Период Б";
  } else [a, b, aT, bT] = [[addDays(tomorrow, -14), addDays(tomorrow, -7)], [addDays(tomorrow, -7), tomorrow], "7 дней до", "Последние 7 дней"];
  const A = periodTotal(hours, a[0], a[1]), B = periodTotal(hours, b[0], b[1]);

  const card = el("div", "card wide");
  card.append(el("h3", undefined, "Сравнение периодов"), el("p", "sub", scope));
  const ch = el("div", "chips");
  for (const [v, t] of PRESETS) {
    const btn = el("button", undefined, t);
    btn.type = "button";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(v === preset));
    btn.addEventListener("click", () => {
      try {
        localStorage.setItem(KEY, v);
      } catch {
        /* нет */
      }
      rerender();
    });
    ch.append(btn);
  }
  card.append(ch);
  if (preset === "custom") {
    const row = el("div", "cmp-dates");
    const pair = (title: string, f: "aFrom" | "bFrom", t: "aTo" | "bTo") => {
      const s = el("span", "cmp-pair");
      const mk = (k: keyof typeof custom) => {
        const i = el("input", "input");
        i.type = "date";
        i.value = iso(custom[k]);
        i.addEventListener("change", () => {
          if (i.value) custom[k] = fromIso(i.value);
          rerender();
        });
        return i;
      };
      s.append(el("b", undefined, title), mk(f), el("span", "faint", "–"), mk(t));
      return s;
    };
    row.append(pair("А", "aFrom", "aTo"), pair("Б", "bFrom", "bTo"));
    card.append(row);
  }
  if (A.seconds === 0 && B.seconds === 0) {
    card.append(el("p", "hint-small", "За эти периоды данных нет."));
    root.replaceChildren(card);
    return;
  }
  const ah = A.seconds / 3600, bh = B.seconds / 3600;
  const perHour = (v: number, h: number) => (h > 0.05 ? v / h : null);
  const share = (v: number, p: number) => (p > 0 ? (v / p) * 100 : null);
  const int = (v: number) => String(Math.round(v));
  const one = (v: number) => (Math.round(v * 10) / 10).toLocaleString("ru-RU");
  const pc = (v: number) => `${Math.round(v)}%`;
  const rows: [string, string, number | null, number | null, (v: number) => string][] = [
    ["p", "Людей", A.people, B.people, int],
    ["ph", "Людей в час", perHour(A.people, ah), perHour(B.people, bh), one],
    ["s", "Притормозили", A.slowed, B.slowed, int],
    ["l", "Посмотрели", A.looked, B.looked, int],
    ["lp", "Доля посмотревших", share(A.looked, A.people), share(B.looked, B.people), pc],
  ];
  if (A.entered + B.entered > 0) {
    rows.push(["e", "Вошли", A.entered, B.entered, int], ["ep", "Доля вошедших", share(A.entered, A.people), share(B.entered, B.people), pc]);
  }
  rows.push(["h", "Наблюдали, ч", ah, bh, one]);
  const table = el("table", "cam-table cmp-table");
  const head = el("tr");
  for (const h of ["", aT, bT, "Изменение"]) head.append(el("th", undefined, h));
  const thead = el("thead");
  thead.append(head);
  const tbody = el("tbody");
  for (const [id, title, va, vb, fmt] of rows) {
    const tr = el("tr");
    tr.append(el("td", undefined, title), el("td", "mono faint", va !== null ? fmt(va) : "–"), el("td", "mono", vb !== null ? fmt(vb) : "–"));
    const d = el("td", "mono");
    if (va !== null && vb !== null && va > 0) {
      const p = ((vb - va) / va) * 100;
      const up = p >= 0.5, down = p <= -0.5;
      d.textContent = `${up ? "↗" : down ? "↘" : "="} ${p > 0 ? "+" : ""}${Math.round(p)}%`;
      d.className = `mono ${id === "h" ? "faint" : up ? "cmp-up" : down ? "cmp-down" : "faint"}`;
    } else d.textContent = "–";
    tr.append(d);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  const w = el("div", "table-scroll");
  w.append(table);
  card.append(w, el("p", "hint-small faint", "«В час» — честнее сравнивать, если камеры работали разное время. Зелёным — стало лучше."));
  root.replaceChildren(card);
}
