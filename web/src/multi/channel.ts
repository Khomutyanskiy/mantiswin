// Одна камера пилота: свой источник (камера компьютера / USB или IP-камера через мост), своя разметка,
// своя чувствительность, свой подсчёт и свой перезапуск при сбоях. Прирост счётчиков отдаёт пилоту раз в секунду.
// Порт PilotChannel.swift (macOS). Нейросеть общая на все камеры — кадры встают к ней в очередь.

import { type AnalyticsConfig, defaultConfig } from "../engine/config";
import type { ShowcaseDirection } from "../engine/headpose";
import { type FrameResult, Session } from "../engine/session";
import type { Detector } from "../detector";
import { type HourStat, emptyHour, hourDelta } from "../pilot/hours";
import { type IpCameraConfig, type LiveSource, openIpCamera, openWebcam } from "../sources";
import { type Markup, defaultMarkup } from "../ui/draw";
import { type DetectionFilter, applyFilterToConfig, defaultFilter, filterDetections } from "./filter";

export interface ChannelConfig {
  id: string;
  name: string;
  kind: "webcam" | "ip";
  /** Камера компьютера (deviceId); пусто — камера по умолчанию. */
  deviceId: string;
  ip: IpCameraConfig | null;
  markup: Markup;
  direction: ShowcaseDirection;
  filter: DetectionFilter;
}

export function newChannelConfig(p: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: crypto.randomUUID?.() ?? `cam-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    kind: "webcam",
    deviceId: "",
    ip: null,
    markup: defaultMarkup(),
    direction: "camera",
    filter: defaultFilter(),
    ...p,
  };
}

export function channelTitle(c: ChannelConfig): string {
  if (c.name.trim()) return c.name.trim();
  return c.kind === "ip" ? c.ip?.title || "IP-камера" : "Камера";
}

/** Пороги подсчёта камеры: разметка, сторона витрины, чувствительность. */
export function channelAnalyticsConfig(c: ChannelConfig): AnalyticsConfig {
  const cfg = defaultConfig();
  cfg.countLineEnabled = c.markup.lineEnabled;
  cfg.countLine = c.markup.line.map((q) => ({ ...q }));
  cfg.showcaseZone = c.markup.zone.map((q) => ({ ...q }));
  cfg.look.showcaseDirection = c.direction;
  return applyFilterToConfig(cfg, c.filter);
}

export type ChannelState = "idle" | "preview" | "starting" | "counting" | "recovering";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

export interface ChannelHooks {
  getDetector: () => Promise<Detector>;
  resetDetector: () => void;
  /** Кадр с результатом подсчёта (fr = null — просто картинка, предпросмотр). */
  onFrame: (ch: Channel, shot: ImageBitmap, fr: FrameResult | null) => void;
  onChange: (ch: Channel) => void;
}

export class Channel {
  state: ChannelState = "idle";
  message = "";
  lastError: string | null = null;
  fps = 0;
  msPerFrame = 0;
  width = 0;
  height = 0;

  private source: LiveSource | null = null;
  private session: Session | null = null;
  private running = false;
  private previewing = false;
  private loopDone: Promise<void> | null = null;
  /** Итоги прошлых кусков (до перезапуска камеры). */
  private base: HourStat = emptyHour();
  /** Итоги, уже отданные пилоту. */
  private accounted: HourStat = emptyHour();
  private lastFrameAt = 0;
  private restartRequested = false;

  constructor(
    public config: ChannelConfig,
    private readonly hooks: ChannelHooks,
  ) {}

  get id(): string {
    return this.config.id;
  }

  get title(): string {
    return channelTitle(this.config);
  }

  get isCounting(): boolean {
    return this.state === "counting";
  }

  /** Кадры идут (для времени наблюдения). */
  get isLive(): boolean {
    return this.state === "counting" && performance.now() - this.lastFrameAt < 5000;
  }

  private set(state: ChannelState, message: string): void {
    this.state = state;
    this.message = message;
    this.hooks.onChange(this);
  }

  private open(): Promise<LiveSource> {
    const c = this.config;
    if (c.kind === "ip") {
      if (!c.ip) return Promise.reject(new Error("IP-камера не настроена"));
      return openIpCamera(c.ip, (s) => this.set(this.running ? "starting" : "preview", s));
    }
    return openWebcam(c.deviceId || null);
  }

  private closeSource(): void {
    this.source?.close();
    this.source = null;
  }

  // ---------------------------------------------------------------- предпросмотр (пилот не идёт)

  async startPreview(): Promise<void> {
    if (this.previewing || this.running) return;
    this.previewing = true;
    this.set("preview", "Подключаю камеру…");
    this.loopDone = (async () => {
      let failures = 0;
      while (this.previewing && !this.running) {
        try {
          const src = await this.open();
          if (!this.previewing || this.running) {
            src.close();
            break;
          }
          this.source = src;
          this.width = src.width;
          this.height = src.height;
          this.set("preview", "");
          failures = 0;
          while (this.previewing && !this.running) {
            if (src.lost()) throw new Error("камера отключилась");
            const shot = await withTimeout(src.grab(), 30_000, "камера не присылает кадры");
            this.lastFrameAt = performance.now();
            this.hooks.onFrame(this, shot, null);
            shot.close();
            await sleep(200);
          }
        } catch (e) {
          if (!this.previewing) break;
          failures += 1;
          this.lastError = e instanceof Error ? e.message : String(e);
          this.set("preview", `Нет картинки: ${this.lastError}`);
          for (let i = 0; i < Math.min(30, 5 * failures) && this.previewing; i++) await sleep(1000);
        } finally {
          this.closeSource();
        }
      }
    })();
  }

  async stopPreview(): Promise<void> {
    if (!this.previewing) return;
    this.previewing = false;
    this.closeSource();
    await this.loopDone?.catch(() => undefined);
    this.loopDone = null;
    if (!this.running) this.set("idle", "");
  }

  // ---------------------------------------------------------------- подсчёт

  async start(fps: number): Promise<void> {
    await this.stopPreview();
    if (this.running) return;
    this.running = true;
    this.base = emptyHour();
    this.accounted = emptyHour();
    this.session = null;
    this.lastError = null;
    this.loopDone = this.loop(fps);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.closeSource();
    await this.loopDone?.catch(() => undefined);
    this.loopDone = null;
    this.set("idle", "");
  }

  /** Разметка или чувствительность поменялись во время пилота: начать новый кусок с новыми порогами. */
  restart(): void {
    if (this.running) this.restartRequested = true;
  }

  /** Итоги этой камеры с запуска пилота (без секунд). */
  totals(): HourStat {
    const s = this.session;
    const c = s?.analytics.counters;
    return {
      people: this.base.people + (s?.seen ?? 0),
      looked: this.base.looked + (c?.looked ?? 0),
      slowed: this.base.slowed + (c?.slowed ?? 0),
      passed: this.base.passed + (c?.passed ?? 0),
      entered: this.base.entered + (s?.enteredCount ?? 0),
      seconds: 0,
    };
  }

  /** Прирост с прошлого раза (раз в секунду забирает пилот). */
  takeDelta(): HourStat | null {
    const cur = this.totals();
    const d = hourDelta(this.accounted, cur);
    this.accounted = cur;
    return d;
  }

  /** Закончить кусок сессии: счётчики переходят в базу, чтобы не обнулились. */
  private closePiece(): void {
    this.base = this.totals();
    this.session = null;
  }

  private async loop(fps: number): Promise<void> {
    let failures = 0;
    while (this.running) {
      try {
        await this.runOnce(fps);
        failures = 0;
      } catch (e) {
        if (!this.running) break;
        failures += 1;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[mantis] камера «${this.title}»: сбой, перезапуск`, msg);
        this.closePiece();
        this.closeSource();
        if (failures >= 3) this.hooks.resetDetector();
        const wait = Math.min(60, 5 * failures);
        this.lastError = msg;
        this.set("recovering", `Сбой: ${msg}. Перезапуск через ${wait} с`);
        for (let i = 0; i < wait && this.running; i++) await sleep(1000);
      }
    }
    this.closePiece();
  }

  private async runOnce(fps: number): Promise<void> {
    this.set("starting", "Подключаю камеру…");
    const src = await this.open();
    if (!this.running) {
      src.close();
      return;
    }
    this.source = src;
    this.width = src.width;
    this.height = src.height;
    this.set("starting", "Загружаю нейросеть…");
    const det = await this.hooks.getDetector();
    const W = src.width, H = src.height;
    const entrance = this.config.markup.entranceEnabled ? this.config.markup.entrance : null;
    this.session = new Session(channelAnalyticsConfig(this.config), W, H, entrance, fps);
    this.restartRequested = false;
    this.set("counting", "Идёт подсчёт");

    const interval = 1000 / fps;
    const t0 = performance.now();
    let lastTick = t0, lastPrune = t0, lastNotify = 0;
    let rate = 0, ms = 0;
    while (this.running) {
      if (this.restartRequested) {
        // новые пороги: досчитали кусок, начинаем новый на той же камере
        this.closePiece();
        this.session = new Session(channelAnalyticsConfig(this.config), W, H,
          this.config.markup.entranceEnabled ? this.config.markup.entrance : null, fps);
        this.restartRequested = false;
      }
      if (src.lost()) throw new Error("камера отключилась");
      const started = performance.now();
      const shot = await withTimeout(src.grab(), 30_000, "камера не присылает кадры");
      let res;
      try {
        res = await withTimeout(det.detect(shot, W, H, 0.25), 20_000, "нейросеть не отвечает");
      } catch (e) {
        shot.close();
        throw e;
      }
      const now = performance.now();
      const dt = (now - lastTick) / 1000;
      lastTick = now;
      this.lastFrameAt = now;
      rate = rate ? rate * 0.9 + (1 / Math.max(dt, 1e-3)) * 0.1 : 1 / Math.max(dt, 1e-3);
      ms = ms ? ms * 0.9 + res.ms * 0.1 : res.ms;

      const session = this.session!;
      // чувствительность применяется сразу (порог и рост), строгость поведения — с нового куска
      const fr = session.update((now - t0) / 1000, filterDetections(res.detections, this.config.filter, H));
      this.hooks.onFrame(this, shot, fr);
      shot.close();

      if (now - lastPrune > 10_000) {
        session.prune(fr.t);
        lastPrune = now;
      }
      if (now - lastNotify > 1000) {
        this.fps = rate;
        this.msPerFrame = ms;
        lastNotify = now;
        this.hooks.onChange(this);
      }
      // не чаще заданной частоты: несколько камер делят одну нейросеть
      const spent = performance.now() - started;
      if (spent < interval) await sleep(interval - spent);
    }
  }
}
