// Почасовая статистика пилота. Формат и правила — как в iOS (Business.swift: HourStat, HourKey, HourlyStore),
// чтобы данные из браузера и с iPhone лежали в одном месте Firestore: users/{uid}/hours/{2026-10-03-14}.

export interface HourStat {
  people: number;
  looked: number;
  slowed: number;
  passed: number;
  entered: number;
  /** Сколько секунд в этом часе шёл подсчёт. */
  seconds: number;
}

export const emptyHour = (): HourStat => ({ people: 0, looked: 0, slowed: 0, passed: 0, entered: 0, seconds: 0 });

const FIELDS = ["people", "looked", "slowed", "passed", "entered", "seconds"] as const;

export const addHours = (a: HourStat, b: HourStat): HourStat => {
  const o = emptyHour();
  for (const f of FIELDS) o[f] = a[f] + b[f];
  return o;
};

/** Слияние двух копий одного часа (браузер и облако): по каждому полю — максимум, как в iOS. */
export const mergeHours = (a: HourStat, b: HourStat): HourStat => {
  const o = emptyHour();
  for (const f of FIELDS) o[f] = Math.max(a[f], b[f]);
  return o;
};

export const isEmptyHour = (h: HourStat): boolean => FIELDS.every((f) => h[f] === 0);

/** Мягкое чтение документа: недостающие поля — нули. */
export function parseHour(d: Record<string, unknown> | undefined): HourStat {
  const o = emptyHour();
  if (!d) return o;
  for (const f of FIELDS) {
    const v = d[f];
    o[f] = typeof v === "number" && isFinite(v) ? v : 0;
  }
  return o;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Ключ часа «2026-10-03-14» в местном времени. */
export function hourKey(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}`;
}

export function keyDate(key: string): Date | null {
  const p = key.split("-").map(Number);
  if (p.length !== 4 || p.some((v) => !Number.isInteger(v))) return null;
  return new Date(p[0], p[1] - 1, p[2], p[3]);
}

/** Итоги подсчёта с начала сессии — из них считается прирост за час. */
export type Totals = HourStat;

/**
 * Прирост между двумя снимками итогов. Если счётчики уменьшились (сессию перезапустили),
 * прироста нет — новая база (как accountHour в iOS CameraView).
 */
export function hourDelta(prev: Totals, cur: Totals): HourStat | null {
  for (const f of FIELDS) if (cur[f] < prev[f]) return null;
  const d = emptyHour();
  for (const f of FIELDS) d[f] = cur[f] - prev[f];
  return d;
}

/**
 * Прирост живого подсчёта (как account() в PilotChannel.swift): небольшое уменьшение людей, «посмотрели»
 * и «притормозили» (до 2) — сняли сотрудника, вычитаем и из статистики по часам; большое — перезапуск счётчиков,
 * прироста нет. «Прошли» и «зашли» не уменьшаются.
 */
export function liveDelta(prev: Totals, cur: Totals): HourStat | null {
  const staffFix = cur.people >= prev.people - 2 && cur.looked >= prev.looked - 2 && cur.slowed >= prev.slowed - 2
    && cur.passed >= prev.passed && cur.entered >= prev.entered
    && (cur.people < prev.people || cur.looked < prev.looked || cur.slowed < prev.slowed);
  if (!staffFix) return hourDelta(prev, cur);
  const d = emptyHour();
  for (const f of FIELDS) d[f] = cur[f] - prev[f];
  return d;
}

/** Хранилище часов в браузере (localStorage) + список изменённых часов для отправки в облако. */
export class HourlyStore {
  hours: Record<string, HourStat> = {};
  private dirty = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(private readonly storageKey = "mantis.hours.v1") {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, Record<string, unknown>>;
        for (const [k, v] of Object.entries(obj)) if (keyDate(k)) this.hours[k] = parseHour(v);
      }
      const d = localStorage.getItem(storageKey + ".dirty");
      if (d) for (const k of JSON.parse(d) as string[]) this.dirty.add(k);
    } catch {
      /* пусто — начнём заново */
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Прибавить к часу, в который попадает date. */
  add(d: HourStat, date = new Date()): void {
    if (isEmptyHour(d)) return;
    const key = hourKey(date);
    this.hours[key] = addHours(this.hours[key] ?? emptyHour(), d);
    this.dirty.add(key);
    this.emit();
  }

  /** После входа: объединить с облаком (максимум по полям), всё объединённое — к отправке. */
  merge(remote: Record<string, HourStat>): void {
    for (const [k, v] of Object.entries(remote)) {
      const local = this.hours[k];
      const merged = local ? mergeHours(local, v) : v;
      this.hours[k] = merged;
      if (local && FIELDS.some((f) => merged[f] !== v[f])) this.dirty.add(k);
    }
    for (const k of Object.keys(this.hours)) if (!(k in remote)) this.dirty.add(k);
    this.save();
    this.emit();
  }

  /** Забрать изменённые часы для отправки. Если отправка не удалась — вернуть через markDirty. */
  takeDirty(): Record<string, HourStat> {
    const out: Record<string, HourStat> = {};
    for (const k of this.dirty) if (this.hours[k]) out[k] = { ...this.hours[k] };
    this.dirty.clear();
    this.save();
    return out;
  }

  markDirty(keys: string[]): void {
    for (const k of keys) this.dirty.add(k);
    this.save();
  }

  get pending(): number {
    return this.dirty.size;
  }

  save(): void {
    try {
      // Другая вкладка могла записать свои часы — не затираем их (значения только растут, берём максимум)
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, Record<string, unknown>>)) {
          if (!keyDate(k)) continue;
          const theirs = parseHour(v);
          this.hours[k] = this.hours[k] ? mergeHours(this.hours[k], theirs) : theirs;
        }
      }
      localStorage.setItem(this.storageKey, JSON.stringify(this.hours));
      localStorage.setItem(this.storageKey + ".dirty", JSON.stringify([...this.dirty]));
    } catch {
      /* хранилище недоступно */
    }
  }

  clear(): void {
    this.hours = {};
    this.dirty.clear();
    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      /* нет */
    }
    this.save();
    this.emit();
  }
}
