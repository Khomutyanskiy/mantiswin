// «Настройки» — порт AppSettingsView.swift (+ MonitoringSettingsCard, SystemCards, Theme):
// хранение видео, расписание и уведомления мониторинга, состояние системы, резервная копия настроек,
// пример данных и оформление.

import { agentAutostart, agentInfo, askNotifications, desktopInfo, setAutostart } from "../desktop";
import { alertPrefs } from "../pilot/alerts";
import { schedulePrefs, scheduleText } from "../pilot/schedule";
import { type VideoStorage, gbText, videoPrefs } from "../video/storage";
import { WEEKDAY_TITLES, clockText, prefStr, scheduleSummary, setPref } from "./prefs";
import { sample } from "./sample";
import { resetTips } from "./tips";

export interface SettingsDeps {
  video: VideoStorage;
  toast: (t: string, err?: boolean) => void;
  /** Камеры мониторинга — для «Состояния системы». */
  cameras: () => { title: string; counting: boolean; fps?: number }[];
  backend: () => string;
  running: () => boolean;
}

// ---------------------------------------------------------------- оформление

export type Appearance = "dark" | "light" | "system";
export const appearance = (): Appearance => (prefStr("appAppearance", "dark") as Appearance);

export function applyAppearance(a: Appearance = appearance()): void {
  const light = a === "light" || (a === "system" && matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", light ? "light" : "dark");
}
matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => applyAppearance());

// ---------------------------------------------------------------- мелкие элементы

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function card(title: string, sub: string): { box: HTMLElement; body: HTMLElement } {
  const box = el("section", "card set-card");
  box.append(el("h3", "", title), el("p", "sub", sub));
  const body = el("div", "set-body");
  box.append(body);
  return { box, body };
}

function row(title: string, hint: string, control: HTMLElement): HTMLElement {
  const r = el("label", "set-row");
  const t = el("span", "set-text");
  t.append(el("b", "", title));
  if (hint) t.append(el("small", "", hint));
  r.append(t, control);
  return r;
}

function toggle(get: () => boolean, set: (v: boolean) => void, onChange?: () => void): HTMLInputElement {
  const i = el("input", "switch");
  i.type = "checkbox";
  i.checked = get();
  i.addEventListener("change", () => {
    set(i.checked);
    onChange?.();
  });
  return i;
}

function stepper(get: () => number, set: (v: number) => void, min: number, max: number, unit: (n: number) => string, step = 1): HTMLElement {
  const w = el("span", "set-stepper");
  const minus = el("button", "btn small", "−");
  const plus = el("button", "btn small", "+");
  const val = el("span", "mono", "");
  minus.type = plus.type = "button";
  const draw = () => {
    val.textContent = unit(get());
    minus.disabled = get() <= min;
    plus.disabled = get() >= max;
  };
  minus.addEventListener("click", (e) => {
    e.preventDefault();
    set(Math.max(min, get() - step));
    draw();
  });
  plus.addEventListener("click", (e) => {
    e.preventDefault();
    set(Math.min(max, get() + step));
    draw();
  });
  draw();
  w.append(minus, val, plus);
  return w;
}

function segmented<T extends string>(options: [T, string][], get: () => T, set: (v: T) => void): HTMLElement {
  const w = el("span", "set-seg");
  const draw = () => w.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === get())));
  for (const [v, t] of options) {
    const b = el("button", "chip", t);
    b.type = "button";
    b.dataset.v = v;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      set(v);
      draw();
    });
    w.append(b);
  }
  draw();
  return w;
}

const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many;
const daysText = (n: number) => `${n} ${plural(n, "день", "дня", "дней")}`;

/** Часы работы + дни недели (как ScheduleEditor). */
function scheduleEditor(s: { start: number; end: number; days: number[] }, save: (v: { start: number; end: number; days: number[] }) => void): HTMLElement {
  const w = el("div", "set-schedule");
  const time = (m: number) => {
    const i = el("input", "set-time");
    i.type = "time";
    i.step = "900";
    i.value = clockText(m);
    return i;
  };
  const from = time(s.start), to = time(s.end);
  const parse = (v: string) => {
    const [h, m] = v.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const days = el("span", "set-days");
  const cur = { ...s, days: [...s.days] };
  WEEKDAY_TITLES.forEach((t, i) => {
    const d = i + 1;
    const b = el("button", "chip", t);
    b.type = "button";
    b.setAttribute("aria-pressed", String(cur.days.includes(d)));
    b.addEventListener("click", (e) => {
      e.preventDefault();
      cur.days = cur.days.includes(d) ? cur.days.filter((x) => x !== d) : [...cur.days, d];
      if (!cur.days.length) cur.days = [d];
      days.querySelectorAll("button").forEach((x, j) => x.setAttribute("aria-pressed", String(cur.days.includes(j + 1))));
      save(cur);
    });
    days.append(b);
  });
  for (const [i, k] of [[from, "start"], [to, "end"]] as const) {
    i.addEventListener("change", () => {
      cur[k] = parse(i.value);
      save(cur);
    });
  }
  const times = el("span", "set-times");
  times.append(el("span", "", "с"), from, el("span", "", "до"), to);
  w.append(times, days);
  return w;
}

// ---------------------------------------------------------------- экран

export function mountSettings(root: HTMLElement, deps: SettingsDeps): { show(): void; hide(): void } {
  root.classList.add("settings");
  const head = el("div", "set-head");
  head.append(el("h2", "", "Настройки"), el("p", "", "Видео, расписание мониторинга, уведомления и оформление."));
  const grid = el("div", "set-grid");
  root.append(head, grid);
  let timer = 0;

  // ---- Хранение видео
  const video = card("Хранение видео", "Видео с камер во время мониторинга — на этом компьютере. В облако не уходит.");
  const videoBody = el("div", "set-sub");
  const usage = el("div", "set-tiles");
  const drawVideo = () => {
    videoBody.hidden = videoPrefs.mode === "off";
    schedBox.hidden = !videoPrefs.scheduleOn;
  };
  const schedBox = scheduleEditor(
    { start: videoPrefs.start, end: videoPrefs.end, days: videoPrefs.days },
    (v) => {
      videoPrefs.start = v.start;
      videoPrefs.end = v.end;
      videoPrefs.days = v.days;
    },
  );
  const MOTION = ["только заметное", "ниже среднего", "обычная", "выше среднего", "малейшее"];
  const motion = el("span", "set-range");
  const mr = el("input");
  mr.type = "range";
  mr.min = "1";
  mr.max = "5";
  mr.value = String(videoPrefs.motionLevel);
  const ml = el("small", "", MOTION[videoPrefs.motionLevel - 1]);
  mr.addEventListener("input", () => {
    videoPrefs.motionLevel = Number(mr.value);
    ml.textContent = MOTION[videoPrefs.motionLevel - 1];
  });
  motion.append(mr, ml);
  const motionRow = row("Движение", "Насколько заметное движение включает запись", motion);
  const howSeg = segmented<"events" | "always">([["events", "По событиям"], ["always", "Всё подряд"]],
    () => (videoPrefs.events ? "events" : "always"), (v) => {
      videoPrefs.events = v === "events";
      motionRow.hidden = !videoPrefs.events;
    });
  motionRow.hidden = !videoPrefs.events;
  const actions = el("div", "set-actions");
  const clean = el("button", "btn small", "Убрать лишнее сейчас");
  const reveal = el("button", "btn small ghost", "Показать папку видео");
  clean.type = reveal.type = "button";
  clean.addEventListener("click", async () => {
    await deps.video.cleanup(null);
    deps.toast("Старое видео убрано");
    void drawUsage();
  });
  reveal.addEventListener("click", () => deps.video.files().reveal?.(""));
  actions.append(clean, reveal);
  videoBody.append(
    row("Размывать лица", "Лица покупателей в видео — размытые", toggle(() => videoPrefs.blurFaces, (v) => (videoPrefs.blurFaces = v))),
    row("Как писать", "По событиям — только когда в кадре люди или движение (+5 с до)", howSeg),
    motionRow,
    row("Писать по расписанию", "Только в эти часы и дни", toggle(() => videoPrefs.scheduleOn, (v) => (videoPrefs.scheduleOn = v), drawVideo)),
    schedBox,
    row("Хранить", "Старше — удаляется само", stepper(() => videoPrefs.keepDays, (v) => (videoPrefs.keepDays = v), 1, 90, daysText)),
    row("Не больше", "Всё видео вместе; сверх — удаляется самое старое", stepper(() => videoPrefs.maxGB, (v) => (videoPrefs.maxGB = v), 5, 500, (n) => `${n} ГБ`, 5)),
    usage,
    actions,
  );
  video.body.append(
    row("Сохранять видео", "Каждая камера — свой файл MP4 в папке запуска", toggle(() => videoPrefs.mode !== "off", (v) => (videoPrefs.mode = v ? "always" : "off"), drawVideo)),
    videoBody,
  );
  const drawUsage = async () => {
    const i = await deps.video.info();
    usage.replaceChildren();
    const tile = (t: string, v: string) => {
      const d = el("div", "set-tile");
      d.append(el("small", "", t), el("b", "mono", v));
      return d;
    };
    usage.append(tile("Занято видео", gbText(i.usedBytes)), tile("Свободно на диске", i.freeBytes === null ? "—" : gbText(i.freeBytes)));
    if (i.root) usage.append(el("small", "set-path mono", i.root));
    else usage.append(el("small", "set-path", "Видео хранится в браузере. В приложении для Windows — в папке на диске."));
    reveal.hidden = !i.onDisk;
  };
  drawVideo();

  // ---- Мониторинг
  const mon = card("Мониторинг", "Расписание по часам работы точки и уведомления о камерах.");
  const schedEditor = scheduleEditor(
    { start: schedulePrefs.start, end: schedulePrefs.end, days: schedulePrefs.days },
    (v) => {
      schedulePrefs.start = v.start;
      schedulePrefs.end = v.end;
      schedulePrefs.days = v.days;
      schedNote.textContent = scheduleText();
    },
  );
  const schedNote = el("small", "set-note", scheduleText());
  const drawMon = () => {
    schedEditor.hidden = !schedulePrefs.enabled;
    alertsBox.hidden = !alertPrefs.enabled;
    crowdRow.hidden = !alertPrefs.crowdOn;
    waitRow.hidden = !alertPrefs.waitOn;
    schedNote.textContent = scheduleSummary(schedulePrefs.enabled, schedulePrefs.start, schedulePrefs.end, schedulePrefs.days);
  };
  const alertsBox = el("div", "set-sub");
  const crowdRow = row("Порог", "Людей в кадре одновременно", stepper(() => alertPrefs.crowdLimit, (v) => (alertPrefs.crowdLimit = v), 2, 50, (n) => `${n} чел.`));
  const waitRow = row("Порог ожидания", "Человек стоит у витрины дольше", stepper(() => alertPrefs.waitMinutes, (v) => (alertPrefs.waitMinutes = v), 1, 30, (n) => `${n} мин`));
  alertsBox.append(
    row("Камера пропала", "Не отдаёт кадры дольше", stepper(() => alertPrefs.minutes, (v) => (alertPrefs.minutes = v), 1, 60, (n) => `${n} мин`)),
    row("Картинка застыла", "Кадры идут, но изображение не меняется", toggle(() => alertPrefs.freezeOn, (v) => (alertPrefs.freezeOn = v))),
    row("Много людей", "Уведомить, когда в кадре толпа", toggle(() => alertPrefs.crowdOn, (v) => (alertPrefs.crowdOn = v), drawMon)),
    crowdRow,
    row("Долгое ожидание", "Покупатель ждёт — подойти", toggle(() => alertPrefs.waitOn, (v) => (alertPrefs.waitOn = v), drawMon)),
    waitRow,
  );
  const autoInput = el("input", "switch");
  autoInput.type = "checkbox";
  const autoRow = row("Запускать при входе в систему", "Вместе с расписанием — мониторинг без участия человека", autoInput);
  autoRow.hidden = true;
  let viaAgent = false;
  void desktopInfo().then(async (info) => {
    if (info) {
      autoRow.hidden = false;
      autoInput.checked = info.autostart;
      return;
    }
    const a = await agentInfo();
    if (!a) return;
    viaAgent = true;
    autoRow.hidden = false;
    autoInput.checked = a.autostart;
  });
  autoInput.addEventListener("change", async () => {
    try {
      const r = viaAgent ? await agentAutostart(autoInput.checked) : await setAutostart(autoInput.checked);
      if (r === null) throw new Error("недоступен");
      autoInput.checked = r;
      deps.toast(r ? "Mantis будет запускаться при входе в систему" : "Автозапуск выключен");
    } catch (e) {
      autoInput.checked = !autoInput.checked;
      deps.toast(`Автозапуск: ${(e as Error).message}`, true);
    }
  });
  mon.body.append(
    row("По расписанию", "Сам запускается в часы работы и останавливается после — на каждый день свой отчёт",
      toggle(() => schedulePrefs.enabled, (v) => (schedulePrefs.enabled = v), drawMon)),
    schedEditor,
    schedNote,
    row("Уведомления о камерах", "Если камера пропала или картинка застыла", toggle(() => alertPrefs.enabled, (v) => {
      alertPrefs.enabled = v;
      if (v) askNotifications();
    }, drawMon)),
    alertsBox,
    row("Не гасить экран", "Во время мониторинга. Выключено — экран гаснет, но компьютер считает дальше",
      toggle(() => schedulePrefs.screenOn, (v) => (schedulePrefs.screenOn = v))),
    autoRow,
  );
  drawMon();

  // ---- Состояние системы
  const sys = card("Состояние системы", "Как компьютер справляется с камерами.");
  const sysBody = el("div", "set-tiles");
  sys.body.append(sysBody);
  const camList = el("div", "set-cams");
  sys.body.append(camList);
  const drawSys = async () => {
    const tile = (t: string, v: string, warn = false) => {
      const d = el("div", warn ? "set-tile warn" : "set-tile");
      d.append(el("small", "", t), el("b", "mono", v));
      return d;
    };
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    const i = await deps.video.info();
    const freeGB = i.freeBytes === null ? null : i.freeBytes / 1024 ** 3;
    sysBody.replaceChildren(
      tile("Ядер процессора", String(navigator.hardwareConcurrency || "—")),
      tile("Память страницы", mem ? `${Math.round(mem.usedJSHeapSize / 1024 ** 2)} из ${Math.round(mem.jsHeapSizeLimit / 1024 ** 2)} МБ` : "—",
        !!mem && mem.usedJSHeapSize / mem.jsHeapSizeLimit > 0.8),
      tile("Свободно на диске", freeGB === null ? "—" : gbText(i.freeBytes!), freeGB !== null && freeGB < 5),
      tile("Распознавание", deps.backend()),
    );
    const cams = deps.cameras();
    camList.replaceChildren();
    if (!cams.length) camList.append(el("small", "set-note", "Камер пока нет — добавьте их в «Мониторинге»."));
    for (const c of cams) {
      const r = el("div", "set-cam");
      r.append(el("i", c.counting ? "dot on" : "dot"), el("span", "", c.title),
        el("small", "mono", c.counting ? (c.fps ? `${c.fps.toFixed(1)} кадр/с` : "считает") : deps.running() ? "нет кадров" : "не запущена"));
      camList.append(r);
    }
  };

  // ---- Резервная копия
  const bak = card("Резервная копия", "Все настройки, камеры, разметка и план — одним файлом. Перенести на другой компьютер или вернуть.");
  const bakActions = el("div", "set-actions");
  const exp = el("button", "btn small", "Сохранить в файл");
  const imp = el("button", "btn small ghost", "Восстановить из файла");
  exp.type = imp.type = "button";
  const SKIP = /^(firebase|mantis\.reports|mantis\.hours|_)/;
  exp.addEventListener("click", () => {
    const data: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (!SKIP.test(k)) data[k] = localStorage.getItem(k) ?? "";
    }
    const blob = new Blob([JSON.stringify({ app: "Mantis", version: 1, saved: new Date().toISOString(), data }, null, 2)], { type: "application/json" });
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    const d = new Date();
    a.download = `Mantis настройки ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.json`;
    document.body.append(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 10_000);
  });
  imp.addEventListener("click", () => {
    if (deps.running()) return deps.toast("Остановите мониторинг перед восстановлением", true);
    const f = el("input");
    f.type = "file";
    f.accept = "application/json,.json";
    f.addEventListener("change", async () => {
      const file = f.files?.[0];
      if (!file) return;
      try {
        const j = JSON.parse(await file.text()) as { app?: string; data?: Record<string, string> };
        if (j.app !== "Mantis" || !j.data) throw new Error("это не файл настроек Mantis");
        if (!confirm(`Восстановить настройки из «${file.name}»? Текущие настройки заменятся, страница перезагрузится.`)) return;
        for (const [k, v] of Object.entries(j.data)) if (!SKIP.test(k)) localStorage.setItem(k, v);
        location.reload();
      } catch (e) {
        deps.toast(`Не удалось восстановить: ${(e as Error).message}`, true);
      }
    });
    f.click();
  });
  bakActions.append(exp, imp);
  bak.body.append(bakActions);

  // ---- Пример данных
  const smp = card("Пример данных", "2 недели статистики по двум камерам и 5 отчётов — посмотреть графики и отчёты без камер.");
  const smpBtn = el("button", "btn small", "");
  smpBtn.type = "button";
  const smpNote = el("small", "set-note", "Только на этом компьютере, в облако не уходит. Настоящие данные не трогает.");
  const drawSample = () => (smpBtn.textContent = sample.on ? "Убрать пример" : "Показать пример");
  smpBtn.addEventListener("click", () => {
    if (sample.on) sample.hide();
    else {
      sample.show();
      deps.toast("Пример добавлен — смотрите «Статистику»");
    }
    drawSample();
  });
  drawSample();
  sample.subscribe(drawSample);
  smp.body.append(smpBtn, smpNote);

  // ---- Оформление
  const look = card("Оформление", "Тема и подсказки на экранах.");
  const tipsBtn = el("button", "btn small ghost", "Показать скрытые подсказки");
  tipsBtn.type = "button";
  tipsBtn.addEventListener("click", () => {
    resetTips();
    deps.toast("Подсказки снова видны");
  });
  look.body.append(
    row("Тема", "", segmented<Appearance>([["dark", "Тёмная"], ["light", "Светлая"], ["system", "Как в системе"]], appearance, (v) => {
      setPref("appAppearance", v);
      applyAppearance(v);
    })),
    tipsBtn,
  );

  grid.append(video.box, mon.box, sys.box, bak.box, smp.box, look.box);

  return {
    show() {
      root.hidden = false;
      void drawUsage();
      void drawSys();
      clearInterval(timer);
      timer = window.setInterval(() => void drawSys(), 3000);
    },
    hide() {
      root.hidden = true;
      clearInterval(timer);
    },
  };
}
