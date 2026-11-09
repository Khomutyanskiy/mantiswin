// Настройки приложения в localStorage (как UserDefaults на Mac): маленькие значения с ключами Mac-версии.

export function prefNum(key: string, def: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return localStorage.getItem(key) !== null && Number.isFinite(v) ? v : def;
  } catch {
    return def;
  }
}

export function prefBool(key: string, def: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? def : v === "1" || v === "true";
  } catch {
    return def;
  }
}

export function prefStr(key: string, def: string): string {
  try {
    return localStorage.getItem(key) ?? def;
  } catch {
    return def;
  }
}

export function prefJSON<T>(key: string, def: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? def : (JSON.parse(v) as T);
  } catch {
    return def;
  }
}

export function setPref(key: string, v: string | number | boolean | object): void {
  try {
    localStorage.setItem(key, typeof v === "object" ? JSON.stringify(v) : typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  } catch {
    /* хранилище недоступно */
  }
  for (const fn of listeners) fn(key);
}

const listeners = new Set<(key: string) => void>();
export function onPref(fn: (key: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------- расписание (MonitoringSchedule.isOpen)

export const WEEKDAY_TITLES = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
export const clockText = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Рабочие часы? days: 1 — понедельник … 7 — воскресенье. Поддерживает «ночные» часы через полночь (20:00–02:00). */
export function scheduleOpen(date: Date, start: number, end: number, days: number[]): boolean {
  const m = date.getHours() * 60 + date.getMinutes();
  const wd = ((date.getDay() + 6) % 7) + 1;
  const prevWd = ((wd + 5) % 7) + 1;
  if (start <= end) return days.includes(wd) && m >= start && m < end;
  return (days.includes(wd) && m >= start) || (days.includes(prevWd) && m < end);
}

export function scheduleSummary(on: boolean, start: number, end: number, days: number[]): string {
  if (!on) return "выключено";
  const d = days.length === 7 ? "каждый день" : [...days].sort().map((x) => WEEKDAY_TITLES[x - 1]).join(", ");
  return `${clockText(start)}–${clockText(end)}, ${d}`;
}
