// Пилот на нескольких камерах (настольная версия, Windows) — порт PilotModel.swift (macOS).
// Считает без остановки часами и днями: прирост всех камер раскладывается по часам (HourlyStore →
// users/{uid}/hours), по каждой камере — в CameraHourlyStore (users/{uid}/camera_hours), раз в минуту пульс
// точки (users/{uid}/devices/{id}, platform "windows", список камер). Компьютер не засыпает, каждая камера
// сама перезапускается при сбое, после перезапуска приложения подсчёт продолжается.

import type { Account } from "../cloud/account";
import { type DeviceCamera, saveDevice } from "../cloud/firebase";
import type { Detector } from "../detector";
import { desktopShell, keepAwake, reportPilotRunning } from "../desktop";
import { prefBool } from "../settings/prefs";
import type { FrameResult } from "../engine/session";
import { type HourStat, addHours, emptyHour, hourKey, isEmptyHour } from "../pilot/hours";
import { CameraHourlyStore } from "./cameraHours";
import { Channel, type ChannelConfig, normalizeChannelConfig } from "./channel";

const KEYS = { channels: "mantis.multi.channels.v1", active: "mantis.multi.active", device: "mantis.deviceId.desktop" };

export function desktopDeviceId(): string {
  try {
    let id = localStorage.getItem(KEYS.device);
    if (!id) {
      const prefix = desktopShell === "windows" ? "win" : "desk";
      id = `${prefix}-${(crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 8)}`;
      localStorage.setItem(KEYS.device, id);
    }
    return id;
  } catch {
    return "win-anon";
  }
}

export type PilotState = "idle" | "counting" | "recovering";

/** Итоги одного запуска мониторинга — для отчёта (как saveReport в PilotModel.swift). */
export interface RunEnd {
  started: number;
  ended: number;
  /** Прирост запуска по часам (ключ 2026-10-03-14), сброс счётчиков на карточках его не трогает. */
  hours: Record<string, HourStat>;
  cameras: { id: string; name: string; entrance: boolean; stat: HourStat }[];
}

export interface MultiHooks {
  account: Account;
  getDetector: () => Promise<Detector>;
  resetDetector: () => void;
  hostname: () => string;
  onFrame: (ch: Channel, shot: ImageBitmap, fr: FrameResult | null) => void;
  /** Что-то поменялось: камеры, состояние, итоги. */
  onChange: () => void;
  /** Мониторинг запущен (запись двойника, видео). */
  onRunStart?: () => void;
  /** Мониторинг остановлен или приложение закрывается — сохранить отчёт запуска. */
  onRunEnd?: (run: RunEnd, closing: boolean) => void | Promise<void>;
}

export class MultiPilot {
  channels: Channel[] = [];
  running = false;
  startedAt: number | null = null;
  /** Итоги всех камер с запуска; seconds — время наблюдения (общее). */
  totals: HourStat = emptyHour();
  lastBeat: Date | null = null;
  readonly cameraHours: CameraHourlyStore;
  private timer = 0;
  private previewOn = false;
  private lastTick = 0;
  private lastFlush = 0;
  private lastBeatAt = 0;
  /** Данные текущего запуска для отчёта. */
  private sessionHours: Record<string, HourStat> = {};
  private sessionCams: Record<string, HourStat> = {};

  constructor(private readonly h: MultiHooks) {
    this.cameraHours = new CameraHourlyStore(desktopDeviceId);
    this.channels = this.loadConfigs().map((c) => this.makeChannel(c));
  }

  private makeChannel(c: ChannelConfig): Channel {
    return new Channel(c, {
      getDetector: this.h.getDetector,
      resetDetector: this.h.resetDetector,
      onFrame: this.h.onFrame,
      onChange: () => this.h.onChange(),
    });
  }

  // ---------------------------------------------------------------- состояние

  get state(): PilotState {
    if (!this.running) return "idle";
    return this.channels.some((c) => c.state === "recovering") ? "recovering" : "counting";
  }

  get message(): string {
    if (!this.running) return this.startedAt === null ? "Мониторинг не запущен" : "Мониторинг остановлен";
    const live = this.channels.filter((c) => c.isCounting).length;
    if (this.channels.length === 1) return live === 1 ? "Идёт подсчёт" : this.channels[0].message || "Запуск…";
    return `Идёт подсчёт · считают ${live} из ${this.channels.length} камер`;
  }

  get fps(): number {
    const live = this.channels.filter((c) => c.isCounting);
    return live.length ? live.reduce((a, c) => a + c.fps, 0) / live.length : 0;
  }

  /** Частота обработки на камеру: чем больше камер, тем реже (нагрузка на компьютер). */
  private get perCameraFps(): number {
    const n = this.channels.length;
    return n <= 2 ? 15 : n === 3 ? 10 : 8;
  }

  static get wasActive(): boolean {
    try {
      return localStorage.getItem(KEYS.active) === "1";
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- камеры

  private loadConfigs(): ChannelConfig[] {
    try {
      const list = JSON.parse(localStorage.getItem(KEYS.channels) ?? "[]") as ChannelConfig[];
      return Array.isArray(list) ? list.filter((c) => c && c.id && c.markup).map(normalizeChannelConfig) : [];
    } catch {
      return [];
    }
  }

  saveConfigs(): void {
    try {
      localStorage.setItem(KEYS.channels, JSON.stringify(this.channels.map((c) => c.config)));
    } catch {
      /* нет */
    }
  }

  /** Добавить новую камеру или изменить существующую. Источник поменялся — камера переподключится. */
  async upsert(config: ChannelConfig): Promise<void> {
    const ch = this.channels.find((c) => c.id === config.id);
    if (ch) {
      const old = ch.config;
      const sourceChanged = old.kind !== config.kind || old.deviceId !== config.deviceId || JSON.stringify(old.ip) !== JSON.stringify(config.ip);
      ch.config = config;
      if (sourceChanged) {
        if (this.running) {
          await ch.stop();
          this.collectOne(ch);
          await ch.start(this.perCameraFps);
        } else if (this.previewOn) {
          await ch.stopPreview();
          void ch.startPreview();
        }
      } else if (this.running) {
        // новые пороги — новый кусок подсчёта; одно переименование или псевдоним подсчёт не трогают
        const key = (c: ChannelConfig) => JSON.stringify([c.markup, c.direction, c.filter]);
        if (key(old) !== key(config)) ch.restart();
      }
    } else {
      const n = this.makeChannel(config);
      this.channels.push(n);
      if (this.running) await n.start(this.perCameraFps);
      else if (this.previewOn) void n.startPreview();
    }
    this.cameraHours.add(config.id, channelName(config), emptyHour());
    this.saveConfigs();
    this.h.onChange();
  }

  /** Поменять две камеры местами (перетаскивание карточек). Цвета закрепляются, чтобы не поменялись вместе с порядком. */
  swap(a: string, b: string): void {
    const i = this.channels.findIndex((c) => c.id === a), j = this.channels.findIndex((c) => c.id === b);
    if (i < 0 || j < 0 || i === j) return;
    this.channels.forEach((c, k) => {
      if (c.config.color == null) c.config = { ...c.config, color: k % 8 };
    });
    [this.channels[i], this.channels[j]] = [this.channels[j], this.channels[i]];
    this.saveConfigs();
    this.h.onChange();
  }

  async remove(id: string): Promise<void> {
    const ch = this.channels.find((c) => c.id === id);
    if (!ch) return;
    if (this.running) {
      await ch.stop();
      this.collectOne(ch);
    } else await ch.stopPreview();
    this.channels = this.channels.filter((c) => c.id !== id);
    this.saveConfigs();
    this.h.onChange();
  }

  /** Камеры компьютера, уже занятые пилотом (deviceId → название карточки). */
  webcamOwners(exceptId: string | null): Map<string, string> {
    const m = new Map<string, string>();
    for (const c of this.channels)
      if (c.id !== exceptId && c.config.kind === "webcam") m.set(c.config.deviceId, c.title);
    return m;
  }

  // ---------------------------------------------------------------- предпросмотр (экран открыт, пилот не идёт)

  setPreview(on: boolean): void {
    this.previewOn = on;
    for (const c of this.channels) {
      if (on && !this.running) void c.startPreview();
      else if (!on) void c.stopPreview();
    }
  }

  // ---------------------------------------------------------------- запуск и остановка

  async start(): Promise<void> {
    if (this.running || !this.channels.length) return;
    this.running = true;
    try {
      localStorage.setItem(KEYS.active, "1");
    } catch {
      /* нет */
    }
    reportPilotRunning(true);
    void keepAwake(true, prefBool("monitor.screenOn", true));
    this.startedAt = Date.now();
    this.totals = emptyHour();
    this.sessionHours = {};
    this.sessionCams = {};
    try {
      this.h.onRunStart?.();
    } catch (e) {
      console.warn("[mantis] запуск мониторинга:", e);
    }
    const fps = this.perCameraFps;
    for (const c of this.channels) await c.start(fps);
    this.lastTick = this.lastFlush = this.lastBeatAt = performance.now();
    this.timer = window.setInterval(() => this.tick(), 1000);
    void this.heartbeat(true);
    this.h.onChange();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    clearInterval(this.timer);
    this.running = false;
    try {
      localStorage.removeItem(KEYS.active);
    } catch {
      /* нет */
    }
    await Promise.all(this.channels.map((c) => c.stop()));
    this.collect(0);
    await this.finishRun(false);
    await this.flush();
    await this.heartbeat(false);
    void keepAwake(false);
    reportPilotRunning(false);
    if (this.previewOn) this.setPreview(true);
    this.h.onChange();
  }

  /** Закрытие окна или перезагрузка: досчитать и сохранить; флаг «пилот идёт» остаётся — продолжим при запуске. */
  prepareForUnload(): void {
    if (!this.running) return;
    this.collect(0);
    void this.finishRun(true);
    this.h.account.hours.save();
    void this.cameraHours.flush(null);
  }

  /** Итоги запуска → отчёт. После перезапуска приложения мониторинг продолжится новым запуском. */
  private async finishRun(closing: boolean): Promise<void> {
    const started = this.startedAt ?? Date.now();
    const run: RunEnd = {
      started, ended: Date.now(), hours: this.sessionHours,
      cameras: this.channels.map((c) => ({
        id: c.id, name: c.title, entrance: !!c.config.markup.entranceEnabled, stat: this.sessionCams[c.id] ?? emptyHour(),
      })),
    };
    this.sessionHours = {};
    this.sessionCams = {};
    try {
      await this.h.onRunEnd?.(run, closing);
    } catch (e) {
      console.warn("[mantis] отчёт запуска не сохранился:", e);
    }
  }

  private addSession(d: HourStat, camera?: string): void {
    if (isEmptyHour(d)) return;
    if (camera) this.sessionCams[camera] = addHours(this.sessionCams[camera] ?? emptyHour(), d);
    else {
      const k = hourKey(new Date());
      this.sessionHours[k] = addHours(this.sessionHours[k] ?? emptyHour(), d);
    }
  }

  // ---------------------------------------------------------------- цикл раз в секунду

  private tick(): void {
    const now = performance.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    // время наблюдения: большие паузы (компьютер спал) не засчитываем
    this.collect(Math.min(dt, 2));
    if (now - this.lastFlush >= 60_000) {
      this.lastFlush = now;
      void this.flush();
    }
    if (now - this.lastBeatAt >= 60_000) {
      this.lastBeatAt = now;
      void this.heartbeat(true);
    }
    this.h.onChange();
  }

  /** Забрать прирост камер: в общие часы и по камерам. sec — сколько секунд прошло. */
  private collect(sec: number): void {
    let delta = emptyHour();
    for (const c of this.channels) {
      const d = c.takeDelta() ?? emptyHour();
      delta = addHours(delta, d);
      // у каждой камеры — своё время наблюдения
      const cd = { ...d, seconds: c.isLive ? sec : 0 };
      this.cameraHours.add(c.id, c.title, cd);
      this.addSession(cd, c.id);
    }
    // общее время наблюдения идёт, пока хоть одна камера видит кадры
    if (this.channels.some((c) => c.isLive)) delta.seconds = sec;
    if (!isEmptyHour(delta)) this.h.account.hours.add(delta);
    this.addSession(delta);
    this.totals = addHours(this.totals, delta);
  }

  private collectOne(ch: Channel): void {
    const d = ch.takeDelta();
    if (!d || isEmptyHour(d)) return;
    this.h.account.hours.add(d);
    this.cameraHours.add(ch.id, ch.title, d);
    this.addSession(d, ch.id);
    this.addSession(d);
    this.totals = addHours(this.totals, d);
  }

  private async flush(): Promise<void> {
    this.h.account.hours.save();
    await Promise.all([this.h.account.upload(), this.cameraHours.flush(this.h.account.uid)]);
  }

  /** Итоги за сегодня (все камеры). */
  today(): HourStat {
    const day = hourKey(new Date()).slice(0, 10);
    let t = emptyHour();
    for (const [k, v] of Object.entries(this.h.account.hours.hours)) if (k.startsWith(day)) t = addHours(t, v);
    return t;
  }

  todayFor(cameraId: string): HourStat {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return this.cameraHours.total(cameraId, d);
  }

  private async heartbeat(counting: boolean): Promise<void> {
    const uid = this.h.account.uid;
    if (!uid) return;
    const p = this.h.account.state.profile;
    const cameras: DeviceCamera[] = this.channels.map((c) => ({
      id: c.id, name: c.title, kind: c.config.kind === "ip" ? "ip" : "usb", counting: c.isCounting,
      fps: Math.round(c.fps * 10) / 10, todayPeople: this.todayFor(c.id).people,
    }));
    try {
      await Promise.race([
        saveDevice(
          uid, desktopDeviceId(),
          {
            name: `Mantis · ${this.h.hostname() || (desktopShell ? "Windows" : "браузер")}`, point: p.point || p.name, status: counting ? "counting" : "stopped",
            fps: Math.round(this.fps * 10) / 10, startedAt: this.startedAt, today: this.today(),
          },
          { platform: desktopShell ?? "web", cameras },
        ),
        new Promise((r) => setTimeout(r, 10_000)),
      ]);
      this.lastBeat = new Date();
    } catch {
      /* пульс не критичен */
    }
  }
}

function channelName(c: ChannelConfig): string {
  return c.name.trim() || (c.kind === "ip" ? c.ip?.title || "IP-камера" : "Камера");
}
