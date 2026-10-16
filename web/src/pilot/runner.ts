// Пилот: непрерывный подсчёт с камеры на месте (ноутбук или мини-ПК с USB-камерой).
// Работает часами и днями: память не растёт, прирост счётчиков раскладывается по часам,
// экран не гаснет, при сбоях камера и нейросеть перезапускаются сами.

import type { Account } from "../cloud/account";
import { saveDevice } from "../cloud/firebase";
import type { AnalyticsConfig } from "../engine/config";
import type { Pt } from "../engine/geometry";
import { type FrameResult, Session } from "../engine/session";
import type { Detector } from "../detector";
import { type Totals, emptyHour, hourDelta, hourKey } from "./hours";
import type { LiveSource } from "../sources";

export interface PilotOptions {
  cfg: AnalyticsConfig;
  entrance: Pt[] | null;
  /** Открыть источник кадров (камера компьютера или IP-камера через мост). */
  openSource: () => Promise<LiveSource>;
  getDetector: () => Promise<Detector>;
  /** Сбросить нейросеть (после ошибки) — следующий getDetector создаст новую. */
  resetDetector: () => void;
  account: Account;
  onFrame: (fr: FrameResult, shot: ImageBitmap) => void;
  onStatus: (s: PilotStatus) => void;
}

export interface PilotStatus {
  state: "starting" | "counting" | "recovering" | "stopped";
  message: string;
  startedAt: number;
  fps: number;
  msPerFrame: number;
  /** Итог сессии (с запуска). */
  totals: Totals;
  /** Последний сбой. */
  lastError: string | null;
  hidden: boolean;
}

export const PILOT_FLAG = "mantis.pilot.active";

export function deviceId(): string {
  try {
    let id = localStorage.getItem("mantis.deviceId");
    if (!id) {
      id = `web-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem("mantis.deviceId", id);
    }
    return id;
  } catch {
    return "web-anon";
  }
}

export function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "Браузер";
  const os = /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "videoinput");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class PilotRunner {
  private stopped = false;
  private wakeLock: { release(): Promise<void> } | null = null;
  private source: LiveSource | null = null;
  private status: PilotStatus;
  private session: Session | null = null;
  /** Итоги, уже разнесённые по часам. */
  private accounted: Totals = emptyHour();
  /** Итоги прошлых кусков сессии (до перезапуска камеры). */
  private base: Totals = emptyHour();
  private countedSeconds = 0;
  private done: Promise<void> | null = null;

  constructor(private readonly o: PilotOptions) {
    this.status = {
      state: "starting", message: "Запускаю камеру…", startedAt: Date.now(), fps: 0, msPerFrame: 0,
      totals: emptyHour(), lastError: null, hidden: document.hidden,
    };
  }

  start(): void {
    try {
      localStorage.setItem(PILOT_FLAG, "1");
    } catch {
      /* нет */
    }
    document.addEventListener("visibilitychange", this.onVisibility);
    this.done = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      localStorage.removeItem(PILOT_FLAG);
    } catch {
      /* нет */
    }
    document.removeEventListener("visibilitychange", this.onVisibility);
    await this.done?.catch(() => undefined);
    this.account(true);
    await this.o.account.upload();
    await this.heartbeat("stopped");
    this.releaseCamera();
    void this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
    this.emit({ state: "stopped", message: "Пилот остановлен" });
  }

  private onVisibility = () => {
    this.emit({ hidden: document.hidden });
    if (!document.hidden) void this.lockScreen();
  };

  private emit(p: Partial<PilotStatus>): void {
    this.status = { ...this.status, ...p };
    this.o.onStatus(this.status);
  }

  private async lockScreen(): Promise<void> {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (!wl || this.stopped) return;
    try {
      this.wakeLock = await wl.request("screen");
    } catch {
      /* браузер не дал — экран может погаснуть, предупреждаем в интерфейсе */
    }
  }

  private releaseCamera(): void {
    this.source?.close();
    this.source = null;
  }

  /** Итоги с запуска пилота: прошлые куски + текущая сессия. */
  private totals(): Totals {
    const s = this.session;
    const c = s?.analytics.counters;
    return {
      people: this.base.people + (s?.seen ?? 0),
      looked: this.base.looked + (c?.looked ?? 0),
      slowed: this.base.slowed + (c?.slowed ?? 0),
      passed: this.base.passed + (c?.passed ?? 0),
      entered: this.base.entered + (s?.enteredCount ?? 0),
      seconds: this.countedSeconds,
    };
  }

  /** Разнести прирост с прошлого раза по текущему часу (как accountHour в iOS). */
  private account(force = false): void {
    const cur = this.totals();
    const d = hourDelta(this.accounted, cur);
    if (d) {
      this.o.account.hours.add(d);
      if (force) this.o.account.hours.save();
    }
    this.accounted = cur;
  }

  private async heartbeat(state: "counting" | "stopped"): Promise<void> {
    const uid = this.o.account.uid;
    if (!uid) return;
    const today = Object.entries(this.o.account.hours.hours)
      .filter(([k]) => k.startsWith(hourKey(new Date()).slice(0, 10)))
      .reduce((acc, [, v]) => {
        for (const f of Object.keys(acc) as (keyof Totals)[]) acc[f] += v[f];
        return acc;
      }, emptyHour());
    try {
      await Promise.race([
        saveDevice(uid, deviceId(), {
          name: deviceName(), point: this.o.account.state.profile.point || this.o.account.state.profile.name,
          status: state, fps: Math.round(this.status.fps * 10) / 10, startedAt: this.status.startedAt, today,
        }),
        sleep(10_000),
      ]);
    } catch {
      /* пульс не критичен */
    }
  }

  private async loop(): Promise<void> {
    await this.lockScreen();
    let failures = 0;
    while (!this.stopped) {
      try {
        await this.runOnce();
        failures = 0;
      } catch (e) {
        if (this.stopped) break;
        failures += 1;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[mantis] пилот: сбой, перезапуск", msg);
        // текущий кусок сессии в базу, чтобы счётчики не обнулились
        this.account();
        this.base = { ...this.totals() };
        this.session = null;
        this.releaseCamera();
        if (failures >= 2) this.o.resetDetector();
        const wait = Math.min(60, 5 * failures);
        this.emit({ state: "recovering", message: `Сбой: ${msg}. Перезапуск через ${wait} с`, lastError: msg });
        for (let i = 0; i < wait && !this.stopped; i++) await sleep(1000);
      }
    }
  }

  private async runOnce(): Promise<void> {
    this.emit({ state: "starting", message: "Подключаю камеру…" });
    const src = await this.o.openSource();
    this.source = src;

    this.emit({ message: "Загружаю нейросеть…" });
    const det = await this.o.getDetector();
    const W = src.width, H = src.height;
    this.session = new Session(this.o.cfg, W, H, this.o.entrance, 15);
    this.emit({ state: "counting", message: "Идёт подсчёт" });

    const t0 = performance.now();
    let lastTick = performance.now();
    let lastAccount = 0, lastUpload = performance.now(), lastBeat = 0, lastPrune = 0;
    let fps = 0, ms = 0;
    while (!this.stopped) {
      if (src.lost()) throw new Error("камера отключилась");
      const shot = await withTimeout(src.grab(), 30_000, "камера не присылает кадры");
      const res = await withTimeout(det.detect(shot, W, H), 15_000, "нейросеть не отвечает");
      const now = performance.now();
      const dt = (now - lastTick) / 1000;
      lastTick = now;
      // секунды подсчёта: большие паузы (вкладка спала) не засчитываем
      this.countedSeconds += Math.min(dt, 2);
      fps = fps ? fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05 : 1 / Math.max(dt, 1e-3);
      ms = ms ? ms * 0.9 + res.ms * 0.1 : res.ms;

      const fr = this.session.update((now - t0) / 1000, res.detections);
      this.o.onFrame(fr, shot);
      shot.close();

      if (now - lastAccount > 1000) {
        this.account();
        lastAccount = now;
        this.emit({ fps, msPerFrame: ms, totals: this.totals() });
      }
      if (now - lastPrune > 10_000) {
        this.session.prune(fr.t);
        lastPrune = now;
      }
      if (now - lastUpload > 60_000) {
        this.o.account.hours.save();
        void this.o.account.upload();
        lastUpload = now;
      }
      if (now - lastBeat > 60_000) {
        void this.heartbeat("counting");
        lastBeat = now;
      }
    }
    this.account();
    this.base = { ...this.totals() };
    this.session = null;
  }
}
