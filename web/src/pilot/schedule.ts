// Расписание мониторинга — порт MonitoringSchedule.swift: мониторинг сам запускается в часы работы точки и сам
// останавливается после закрытия (на каждый день — свой отчёт). Если остановили вручную в рабочие часы — до конца
// этих часов сам не запустится. Плюс сон компьютера: если засыпал во время мониторинга — после пробуждения
// приходит уведомление, с какого по какое время подсчёт не шёл.

import { notify } from "../desktop";
import type { MultiPilot } from "../multi/model";
import { clockText, prefBool, prefJSON, prefNum, scheduleOpen, scheduleSummary, setPref } from "../settings/prefs";

export const schedulePrefs = {
  get enabled(): boolean {
    return prefBool("schedule.enabled", false);
  },
  set enabled(v: boolean) {
    setPref("schedule.enabled", v);
    suppressedUntil = 0;
  },
  /** Минуты от полуночи. */
  get start(): number {
    return prefNum("schedule.start", 10 * 60);
  },
  set start(v: number) {
    setPref("schedule.start", v);
  },
  get end(): number {
    return prefNum("schedule.end", 22 * 60);
  },
  set end(v: number) {
    setPref("schedule.end", v);
  },
  /** 1 — понедельник … 7 — воскресенье. */
  get days(): number[] {
    return prefJSON<number[]>("schedule.days", [1, 2, 3, 4, 5, 6, 7]);
  },
  set days(v: number[]) {
    setPref("schedule.days", [...v].sort());
  },
  /** Не гасить экран во время мониторинга (иначе гаснет, но компьютер не засыпает). */
  get screenOn(): boolean {
    return prefBool("monitor.screenOn", true);
  },
  set screenOn(v: boolean) {
    setPref("monitor.screenOn", v);
  },
};

export const scheduleText = () => scheduleSummary(schedulePrefs.enabled, schedulePrefs.start, schedulePrefs.end, schedulePrefs.days);
const isOpen = (d = new Date()) => scheduleOpen(d, schedulePrefs.start, schedulePrefs.end, schedulePrefs.days);

let suppressedUntil = 0;
let startedBySchedule = false;

/** Ручная остановка в рабочие часы — не перезапускать до их конца. */
export function stoppedManually(): void {
  if (!schedulePrefs.enabled || !isOpen()) return;
  startedBySchedule = false;
  let t = Date.now();
  while (isOpen(new Date(t)) && t - Date.now() < 2 * 86400_000) t += 60_000;
  suppressedUntil = t;
}

/** Запустить расписание и сторож сна (раз в 30 с). */
export function startSchedule(pilot: MultiPilot): void {
  let lastTick = Date.now();
  const tick = () => {
    const now = Date.now();
    // сон компьютера: таймер не срабатывал дольше 2 минут
    if (pilot.running && now - lastTick > 120_000) {
      void notify("Компьютер засыпал во время мониторинга",
        `С ${clockText(new Date(lastTick).getHours() * 60 + new Date(lastTick).getMinutes())} до ${clockText(new Date().getHours() * 60 + new Date().getMinutes())} подсчёт не шёл. Чтобы компьютер не засыпал: питание от сети, в настройках электропитания — «Никогда» для сна.`);
    }
    lastTick = now;
    if (!schedulePrefs.enabled) return;
    if (suppressedUntil && now < suppressedUntil) return;
    suppressedUntil = 0;
    if (isOpen()) {
      if (!pilot.running && pilot.channels.length) {
        startedBySchedule = true;
        void pilot.start();
      }
    } else if (pilot.running && startedBySchedule) {
      startedBySchedule = false;
      void pilot.stop(); // отчёт за день сохранится сам
    }
  };
  setInterval(tick, 30_000);
  setTimeout(tick, 3000);
}
