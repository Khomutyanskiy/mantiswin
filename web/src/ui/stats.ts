// Экран «Статистика»: итоги за период, час пик, лучший день, графики по часам, дням недели и датам, деньги.

import type { BusinessProfile, RemoteDevice } from "../cloud/firebase";
import {
  type Bar, METRICS, type Metric, dayBars, daysObserved, hourBars, money, rowsFor, rubles, showcaseScore, total, weekdayBars,
} from "../pilot/business";
import type { HourStat } from "../pilot/hours";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const num = (v: number, d = 0) => v.toLocaleString("ru-RU", { maximumFractionDigits: d, minimumFractionDigits: 0 });
const pctOf = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "");

/** Столбчатая диаграмма в SVG: общая шкала, подписи по оси, выделенный максимум. */
export function barChart(bars: Bar[], color: string, opts: { width: number; height?: number; labelEvery?: number; highlightMax?: boolean }): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  // Ширина — реальная ширина карточки в CSS-пикселях: подписи не растягиваются и не сжимаются
  const W = Math.max(240, Math.round(opts.width)), H = opts.height ?? 200, left = 34, right = 8, top = 12, bottom = 22;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "chart");
  svg.setAttribute("role", "img");
  svg.style.setProperty("--bar", color);
  const max = Math.max(0, ...bars.map((b) => b.value));
  // «Красивый» верх шкалы
  const niceMax = (() => {
    if (max <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(max)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
    return 10 * p;
  })();
  const y = (v: number) => top + (H - top - bottom) * (1 - v / niceMax);
  for (let i = 0; i <= 4; i++) {
    const v = (niceMax / 4) * i;
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", String(left));
    line.setAttribute("x2", String(W - right));
    line.setAttribute("y1", String(y(v)));
    line.setAttribute("y2", String(y(v)));
    line.setAttribute("class", "grid");
    svg.append(line);
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", String(left - 6));
    t.setAttribute("y", String(y(v) + 3));
    t.setAttribute("text-anchor", "end");
    t.textContent = num(v, niceMax < 4 ? 1 : 0);
    svg.append(t);
  }
  const n = Math.max(1, bars.length);
  const slot = (W - left - right) / n;
  const bw = Math.max(2, Math.min(36, slot * 0.7));
  const peakIdx = opts.highlightMax && max > 0 ? bars.findIndex((b) => b.value === max) : -1;
  // подписи не чаще, чем раз в ~36 px
  const every = Math.max(opts.labelEvery ?? 1, Math.ceil(n / Math.max(1, Math.floor((W - left - right) / 36))));
  bars.forEach((b, i) => {
    const cx = left + slot * (i + 0.5);
    if (b.value > 0) {
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", String(cx - bw / 2));
      r.setAttribute("y", String(y(b.value)));
      r.setAttribute("width", String(bw));
      r.setAttribute("height", String(Math.max(1, y(0) - y(b.value))));
      r.setAttribute("rx", "2");
      r.setAttribute("class", i === peakIdx ? "bar peak" : "bar");
      const title = document.createElementNS(NS, "title");
      title.textContent = `${b.label}: ${num(b.value, 1)}`;
      r.append(title);
      svg.append(r);
    }
    if (i % every === 0) {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", String(cx));
      t.setAttribute("y", String(H - 6));
      t.setAttribute("text-anchor", "middle");
      t.textContent = b.label;
      svg.append(t);
    }
  });
  return svg;
}

export function card(title: string, sub: string, body: Node, wide = false): HTMLElement {
  const c = el("div", wide ? "card wide" : "card");
  c.append(el("h3", undefined, title), el("p", "sub", sub), body);
  return c;
}

export interface StatsInput {
  hours: Record<string, HourStat>;
  profile: BusinessProfile;
  days: number;
  metric: Metric;
  signedIn: boolean;
  devices: RemoteDevice[];
}

export function renderMetricChips(root: HTMLElement, current: Metric, onPick: (m: Metric) => void): void {
  root.replaceChildren(
    ...METRICS.map((m) => {
      const b = el("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(m.id === current));
      const dot = el("i");
      dot.style.background = m.color;
      b.append(dot, document.createTextNode(m.title));
      b.addEventListener("click", () => onPick(m.id));
      return b;
    }),
  );
}

export function renderDevices(root: HTMLElement, devices: RemoteDevice[]): void {
  const now = Date.now();
  root.replaceChildren(
    ...devices
      .sort((a, b) => (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0))
      .slice(0, 6)
      .map((d) => {
        const ago = d.lastSeen ? Math.round((now - d.lastSeen.getTime()) / 60000) : null;
        const online = d.status === "counting" && ago !== null && ago <= 3;
        const row = el("div", online ? "device online" : "device");
        const what = d.platform === "windows" ? "Windows" : d.platform === "mac" ? "Mac" : d.platform === "android" ? "Android" : null;
        const extra = [what && !d.name.includes(what) ? what : null, d.cameraCount > 1 ? `${d.cameraCount} камер${d.cameraCount < 5 ? "ы" : ""}` : null]
          .filter(Boolean).join(" · ");
        row.append(el("span", "dot"), el("b", undefined, d.point || "Точка без названия"), el("span", undefined, extra ? `${d.name} · ${extra}` : d.name));
        const state = online
          ? `считает · ${num(d.fps, 1)} кадр/с · сегодня ${d.today.people} чел.`
          : ago === null ? "нет сигнала" : `не считает · последний сигнал ${ago < 60 ? `${ago} мин` : ago < 1440 ? `${Math.round(ago / 60)} ч` : `${Math.round(ago / 1440)} дн.`} назад`;
        row.append(el("span", "mono", state));
        return row;
      }),
  );
}

export function renderStats(root: HTMLElement, sub: HTMLElement, s: StatsInput): void {
  const rows = rowsFor(s.hours, s.days);
  const meta = METRICS.find((m) => m.id === s.metric)!;
  if (!rows.length) {
    sub.textContent = s.signedIn ? "" : "Вы не вошли: показана только статистика этого браузера";
    const e = el("div", "empty");
    e.append(
      el("h3", undefined, "Данных пока нет"),
      el("p", undefined, "Запустите мониторинг в разделе «Мониторинг» — статистика копится по часам автоматически. Если вы считали в приложении на iPhone, войдите в тот же аккаунт."),
    );
    root.replaceChildren(e);
    return;
  }
  const t = total(rows);
  const hours = t.seconds / 3600;
  const days = daysObserved(rows);
  sub.textContent = `Наблюдали ${num(hours, 1)} ч за ${days} дн.${s.signedIn ? "" : " · только этот браузер — войдите, чтобы видеть облако"}`;

  const hb = hourBars(rows, s.metric), wb = weekdayBars(rows, s.metric), db = dayBars(rows, s.metric);
  const peak = hb.reduce((a, b) => (b.value > a.value ? b : a), hb[0]);
  const best = wb.reduce((a, b) => (b.value > a.value ? b : a), wb[0]);

  // Итоги
  const totals = el("div", "metrics");
  const item = (l: string, v: string, sNote: string) => {
    const d = el("div", "metric");
    d.append(el("span", "l", l), el("span", "v", v), el("span", "s", sNote));
    return d;
  };
  totals.append(
    item("Людей в зоне", num(t.people), hours > 0 ? `${num(t.people / hours)} в час` : ""),
    item("Прошли мимо", num(t.passed), "пересекли линию"),
    item("Посмотрели", num(t.looked), pctOf(t.looked, t.people) + " от людей в зоне"),
    item("Притормозили", num(t.slowed), pctOf(t.slowed, t.people) + " от людей в зоне"),
  );
  if (t.entered > 0) totals.append(item("Вошли", num(t.entered), pctOf(t.entered, t.people) + " от людей в зоне"));
  if (peak.value > 0) totals.append(item("Час пик", `${peak.label}:00`, `${meta.title.toLowerCase()}: ${num(peak.value, 1)} в среднем`));
  if (best.value > 0) totals.append(item("Лучший день недели", best.label, `${meta.title.toLowerCase()}: ${num(best.value)} в среднем`));

  const full = root.clientWidth || root.parentElement?.clientWidth || 1200;
  const stacked = window.innerWidth <= 980;
  const wideW = full - 38;
  const halfW = stacked ? wideW : (full - 16) / 2 - 38;
  const grid = el("div", "stats-grid");
  grid.append(
    card("По часам", `${meta.title.toLowerCase()} в среднем за день, оранжевым — час пик`, barChart(hb, meta.color, { width: wideW, height: 220, labelEvery: 3, highlightMax: true }), true),
    card("По дням недели", `${meta.title.toLowerCase()} в среднем за день, оранжевым — лучший день`, barChart(wb, meta.color, { width: halfW, height: 180, labelEvery: 1, highlightMax: true })),
    card("По датам", `${meta.title.toLowerCase()} за день`, barChart(db, meta.color, { width: halfW, height: 180 })),
  );

  // Оценка и деньги
  const sc = showcaseScore(t.people, t.looked, t.slowed, 0, 0, t.entered > 0 ? t.entered : null);
  const mo = money(s.profile, t.people, t.looked, t.entered > 0 ? t.entered : null, t.seconds);
  const scoreBody = el("div", "money");
  if (sc) {
    scoreBody.append(el("span", "big", `${sc.value} из 100`), el("span", "hint-small", sc.grade));
    for (const p of sc.parts.filter((p) => p.title !== "Остановились" && p.title !== "Подошли ближе"))
      scoreBody.append(el("span", "hint-small", `${p.title}: ${Math.round(p.rate * 100)}% (хорошо — от ${Math.round(p.target * 100)}%)`));
  } else {
    scoreBody.append(el("span", "hint-small", "Нужно хотя бы 3 человека в зоне"));
  }
  const moneyBody = el("div", "money");
  moneyBody.append(
    el("span", "big", mo.perMonth !== null ? `${rubles(mo.perMonth)} в месяц` : rubles(mo.revenue)),
    el("span", "hint-small", `${num(mo.basis)} ${mo.basisTitle} × ${num(mo.conversion, 1)}% покупают × средний чек ${rubles(s.profile.avgCheck)} = ${rubles(mo.revenue)} за период`),
  );
  if (mo.upliftPerMonth !== null) moneyBody.append(el("span", "hint-small", `Если витрина зацепит ещё 10% прохожих: +${rubles(mo.upliftPerMonth)} в месяц`));
  moneyBody.append(el("span", "hint-small faint", "Средний чек и конверсии — в профиле точки («Профиль» в меню слева)."));
  grid.append(
    card("Оценка витрины", "без остановок и «подошли ближе» — они не копятся по часам", scoreBody),
    card("В деньгах", "оценка по профилю точки", moneyBody),
  );

  root.replaceChildren(totals, grid);
}

// ---------------------------------------------------------------- по камерам (пилот на нескольких камерах: Mac, Windows)

export interface CameraSeries {
  id: string;
  name: string;
  hours: Record<string, HourStat>;
  /** Камера сейчас считает (на этом компьютере); null — неизвестно. */
  live: boolean | null;
}

/** Сравнение камер за период: строка на камеру, доля людей — полоской, внизу итог. Пусто — блок скрыт. */
export function renderCameraTable(root: HTMLElement, cams: CameraSeries[], days: number): void {
  const rows = cams
    .map((c) => ({ ...c, stat: total(rowsFor(c.hours, days)) }))
    .filter((r) => r.stat.people > 0 || r.stat.seconds > 0 || r.live);
  if (rows.length < 2 && !rows.some((r) => r.live)) {
    root.replaceChildren();
    root.hidden = true;
    return;
  }
  root.hidden = false;
  const t = rows.reduce((a, r) => {
    for (const k of Object.keys(a) as (keyof HourStat)[]) a[k] += r.stat[k];
    return a;
  }, { people: 0, looked: 0, slowed: 0, passed: 0, entered: 0, seconds: 0 } as HourStat);
  const maxPeople = Math.max(1, ...rows.map((r) => r.stat.people));
  const showEntered = t.entered > 0;
  const table = el("table", "cam-table");
  const head = el("tr");
  for (const h of ["Камера", "Людей", "Прошли", "Притормоз.", "Посмотр.", "% посм.", ...(showEntered ? ["Зашли"] : []), "Часов"]) head.append(el("th", undefined, h));
  const thead = el("thead");
  thead.append(head);
  const tbody = el("tbody");
  const line = (name: string, s: HourStat, share: number | null, live: boolean | null, bold: boolean) => {
    const tr = el("tr", bold ? "total" : undefined);
    const first = el("td");
    const nm = el("div", "cam-name");
    if (live !== null) nm.append(el("span", live ? "dot on" : "dot"));
    nm.append(el("span", undefined, name));
    if (!bold && t.people > 0) nm.append(el("span", "share", pctOf(s.people, t.people)));
    first.append(nm);
    if (share !== null) {
      const bar = el("div", "share-bar");
      const fill = el("i");
      fill.style.width = `${Math.max(2, share * 100)}%`;
      bar.append(fill);
      first.append(bar);
    }
    tr.append(first);
    for (const v of [s.people, s.passed, s.slowed, s.looked]) tr.append(el("td", "mono", num(v)));
    tr.append(el("td", "mono faint", s.people > 0 ? pctOf(s.looked, s.people) : "—"));
    if (showEntered) tr.append(el("td", "mono", num(s.entered)));
    tr.append(el("td", "mono faint", num(s.seconds / 3600, 1)));
    tbody.append(tr);
  };
  for (const r of rows.sort((a, b) => b.stat.people - a.stat.people)) line(r.name, r.stat, r.stat.people / maxPeople, r.live, false);
  const n = rows.length;
  line(`Итого · ${n} ${n % 10 === 1 && n % 100 !== 11 ? "камера" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "камеры" : "камер"}`, t, null, null, true);
  table.append(thead, tbody);
  const wrap = el("div", "table-scroll");
  wrap.append(table);
  root.replaceChildren(card("По камерам", "за выбранный период; часы — сколько камера видела кадры", wrap, true));
}
