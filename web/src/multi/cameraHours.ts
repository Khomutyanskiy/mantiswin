// Статистика по каждой камере пилота — порт CameraHourlyStore (CameraStats.swift, macOS).
// Общая статистика (сумма камер) по-прежнему лежит в HourlyStore и users/{uid}/hours — её видят iPhone, Mac и веб.
// По камерам — отдельно: localStorage этого компьютера и Firestore users/{uid}/camera_hours/{камера}_{2026-10-15}
// (документ на камеру и день: { camera, name, day, device, hours: { "14": HourStat } }) — тот же формат, что у Mac.

import { type CameraDay, loadCameraHours, saveCameraDays } from "../cloud/firebase";
import { type HourStat, addHours, emptyHour, hourKey, isEmptyHour, keyDate, mergeHours, parseHour } from "../pilot/hours";

const KEY = "mantis.cameraHours.v1";
const FIELDS = ["people", "looked", "slowed", "passed", "entered", "seconds"] as const;

interface FileData {
  hours: Record<string, Record<string, HourStat>>;
  names: Record<string, string>;
  dirty: string[];
}

export class CameraHourlyStore {
  /** камера → ключ часа (2026-10-15-14) → счётчики. */
  hours: Record<string, Record<string, HourStat>> = {};
  /** камера → название (последнее известное). */
  names: Record<string, string> = {};
  /** "камера|2026-10-15" — дни, которые надо отправить. */
  private dirtyDays = new Set<string>();
  private lastSave = 0;

  constructor(private readonly deviceId: () => string) {
    try {
      const f = JSON.parse(localStorage.getItem(KEY) ?? "null") as FileData | null;
      if (f) {
        for (const [cam, hs] of Object.entries(f.hours ?? {})) {
          const out: Record<string, HourStat> = {};
          for (const [k, v] of Object.entries(hs)) if (keyDate(k)) out[k] = parseHour(v as unknown as Record<string, unknown>);
          this.hours[cam] = out;
        }
        this.names = f.names ?? {};
        for (const d of f.dirty ?? []) this.dirtyDays.add(d);
      }
    } catch {
      /* начнём заново */
    }
  }

  get cameraIds(): string[] {
    return Object.keys(this.hours);
  }

  name(id: string): string {
    return this.names[id] || "Камера";
  }

  add(camera: string, name: string, d: HourStat, date = new Date()): void {
    if (name && this.names[camera] !== name) this.names[camera] = name;
    if (isEmptyHour(d)) return;
    const key = hourKey(date);
    const cam = (this.hours[camera] ??= {});
    cam[key] = addHours(cam[key] ?? emptyHour(), d);
    this.dirtyDays.add(`${camera}|${key.slice(0, 10)}`);
    if (Date.now() - this.lastSave > 30_000) this.saveLocal();
  }

  private saveLocal(): void {
    this.lastSave = Date.now();
    try {
      const f: FileData = { hours: this.hours, names: this.names, dirty: [...this.dirtyDays] };
      localStorage.setItem(KEY, JSON.stringify(f));
    } catch {
      /* хранилище недоступно */
    }
  }

  /** Сохранить на компьютере и отправить изменённые дни в облако. */
  async flush(uid: string | null): Promise<void> {
    this.saveLocal();
    if (!uid || this.dirtyDays.size === 0) return;
    const docs: Record<string, CameraDay> = {};
    const taken = [...this.dirtyDays];
    for (const item of taken) {
      const i = item.indexOf("|");
      if (i < 0) continue;
      const cam = item.slice(0, i), day = item.slice(i + 1);
      const byHour: Record<string, HourStat> = {};
      for (const [k, v] of Object.entries(this.hours[cam] ?? {})) if (k.startsWith(day)) byHour[k.slice(-2)] = v;
      docs[`${cam}_${day}`] = { camera: cam, name: this.names[cam] ?? "", day, hours: byHour };
    }
    this.dirtyDays.clear();
    this.saveLocal();
    try {
      // без интернета Firestore держит запись в своей очереди — долго не ждём
      await Promise.race([saveCameraDays(uid, this.deviceId(), docs), new Promise((r) => setTimeout(r, 20_000))]);
    } catch (e) {
      for (const d of taken) this.dirtyDays.add(d);
      this.saveLocal();
      console.warn("[mantis] статистика по камерам не отправилась:", e);
    }
  }

  /** После входа: объединить с облаком (максимум по полям, как у общей статистики). */
  async pull(uid: string): Promise<void> {
    const remote = await loadCameraHours(uid);
    for (const [cam, hs] of Object.entries(remote.hours)) {
      const mine = (this.hours[cam] ??= {});
      for (const [k, v] of Object.entries(hs)) {
        const local = mine[k];
        const merged = local ? mergeHours(local, v) : v;
        mine[k] = merged;
        if (local && FIELDS.some((f) => merged[f] !== v[f])) this.dirtyDays.add(`${cam}|${k.slice(0, 10)}`);
      }
    }
    for (const [cam, n] of Object.entries(remote.names)) if (!this.names[cam]) this.names[cam] = n;
    for (const [cam, hs] of Object.entries(this.hours))
      for (const k of Object.keys(hs)) if (!remote.hours[cam]?.[k]) this.dirtyDays.add(`${cam}|${k.slice(0, 10)}`);
    await this.flush(uid);
  }

  /** Сумма камеры начиная с from (null — за всё время). */
  total(camera: string, from: Date | null): HourStat {
    let t = emptyHour();
    for (const [k, v] of Object.entries(this.hours[camera] ?? {})) {
      if (from) {
        const d = keyDate(k);
        if (!d || d < from) continue;
      }
      t = addHours(t, v);
    }
    return t;
  }
}
