// Одна камера пилота: свой источник (камера компьютера / USB или IP-камера через мост), своя разметка,
// своя чувствительность, свой подсчёт и свой перезапуск при сбоях. Прирост счётчиков отдаёт пилоту раз в секунду.
// Порт PilotChannel.swift (macOS). Нейросеть общая на все камеры — кадры встают к ней в очередь.

import { type AnalyticsConfig, defaultConfig } from "../engine/config";
import type { ShowcaseDirection } from "../engine/headpose";
import { type FrameResult, type OverlayBox, Session } from "../engine/session";
import type { Detector } from "../detector";
import { type HourStat, emptyHour, liveDelta } from "../pilot/hours";
import { type IpCameraConfig, type LiveSource, openIpCamera, openWebcam } from "../sources";
import { type Markup, defaultMarkup } from "../ui/draw";
import { type DetectionFilter, FilterRuntime, applyFilterToConfig, defaultFilter, normalizeFilter, staffMinutesOf } from "./filter";

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
  /** Псевдоним — короткая метка камеры на плане и в списках, например «№1». */
  alias?: string;
  /** Цвет камеры (номер в CAMERA_COLORS): точка у названия, значок и лучи на плане. Нет — по порядку. */
  color?: number;
}

/** Номер цвета камеры: выбранный в настройке или по месту в списке. */
export function channelColorIndex(c: ChannelConfig, index: number): number {
  return c.color ?? index % 8;
}

export function newChannelConfig(p: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: crypto.randomUUID?.() ?? `cam-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    kind: "webcam",
    deviceId: "",
    ip: null,
    markup: defaultMarkup(), // линий по умолчанию нет — только зона витрины
    direction: "camera",
    filter: defaultFilter(),
    ...p,
  };
}

/** Настройки из хранилища (старые версии без новых полей) → полные. */
export function normalizeChannelConfig(c: ChannelConfig): ChannelConfig {
  return { ...c, filter: normalizeFilter(c.filter) };
}

/** Где витрина относительно камеры — от этого зависит, что считается «посмотрел». */
export const SHOWCASE_DIRECTIONS: [ShowcaseDirection, string, string][] = [
  ["camera", "Камера в витрине", "Камера в витрине или на полке: «посмотрел» — человек повернулся лицом к камере."],
  ["left", "Витрина слева", "Камера сбоку, витрина слева в кадре: засчитывается поворот головы влево, к витрине."],
  ["right", "Витрина справа", "Камера сбоку, витрина справа в кадре: засчитывается поворот головы вправо, к витрине."],
];

/** Метка для плана: псевдоним, если задан, иначе название. */
export function channelShort(c: ChannelConfig): string {
  return c.alias?.trim() || channelTitle(c);
}

/** Название со псевдонимом: «№1 · Камера MacBook». */
export function channelLabel(c: ChannelConfig): string {
  const a = c.alias?.trim();
  return a ? `${a} · ${channelTitle(c)}` : channelTitle(c);
}

export function channelTitle(c: ChannelConfig): string {
  if (c.name.trim()) return c.name.trim();
  return c.kind === "ip" ? c.ip?.title || "IP-камера" : "Камера";
}

/** Пороги подсчёта камеры: разметка, сторона витрины, чувствительность. */
export function channelAnalyticsConfig(c: ChannelConfig, filter: DetectionFilter = c.filter): AnalyticsConfig {
  const cfg = defaultConfig();
  cfg.countLineEnabled = c.markup.lineEnabled;
  cfg.countLine = c.markup.line.map((q) => ({ ...q }));
  cfg.showcaseZone = c.markup.zone.map((q) => ({ ...q }));
  cfg.look.showcaseDirection = c.direction;
  return applyFilterToConfig(cfg, filter);
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
  /** Последний посчитанный кадр (для цифрового двойника): люди и размер кадра. */
  last: { boxes: OverlayBox[]; width: number; height: number; at: number } | null = null;
  /** Отбор детекций этой камеры: неподвижные места, отброшенные рамки (режим проверки). */
  readonly filterRt = new FilterRuntime();
  /** Черновик чувствительности, пока открыто окно проверки (действует на кадре сразу). */
  tuneFilter: DetectionFilter | null = null;

  private tuning = false;
  private tuneLoopDone: Promise<void> | null = null;
  private tuneSessionKey = "";
  private source: LiveSource | null = null;
  private session: Session | null = null;
  private tuneSession: Session | null = null;
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

  /** Действующая чувствительность: черновик из окна проверки или сохранённая. */
  get filter(): DetectionFilter {
    return this.tuneFilter ?? this.config.filter;
  }

  get isTuning(): boolean {
    return this.tuning;
  }

  private set(state: ChannelState, message: string): void {
    this.state = state;
    this.message = message;
    this.hooks.onChange(this);
  }

  private open(stillWanted: () => boolean = () => true): Promise<LiveSource> {
    const c = this.config;
    if (c.kind === "ip") {
      if (!c.ip) return Promise.reject(new Error("IP-камера не настроена"));
      return openIpCamera(c.ip, (s) => this.set(this.running ? "starting" : "preview", s), 25_000, () => !stillWanted());
    }
    return openWebcam(c.deviceId || null);
  }

  /** Закрыть источник. only — закрыть только свой (циклы предпросмотра, проверки и подсчёта не трогают чужие). */
  private closeSource(only?: LiveSource | null): void {
    if (only !== undefined) {
      only?.close();
      if (only && this.source === only) this.source = null;
      return;
    }
    this.source?.close();
    this.source = null;
  }

  // ---------------------------------------------------------------- предпросмотр (пилот не идёт)

  async startPreview(): Promise<void> {
    if (this.previewing || this.running || this.tuneLoopDone) return;
    this.previewing = true;
    this.set("preview", "Подключаю камеру…");
    this.loopDone = (async () => {
      let failures = 0;
      while (this.previewing && !this.running) {
        let mine: LiveSource | null = null;
        try {
          const src = await this.open(() => this.previewing && !this.running);
          mine = src;
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
          this.closeSource(mine);
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
    await this.stopTuneLoop();
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
    this.last = null;
    this.set("idle", "");
    if (this.tuning) this.tuneLoopDone = this.tuneLoop();
  }

  // ---------------------------------------------------------------- проверка чувствительности

  /** Открыто окно «Чувствительность»: видны отброшенные рамки; если пилот не идёт — подсчёт для проверки. */
  async startTuning(f: DetectionFilter): Promise<void> {
    this.tuneFilter = structuredClone(f);
    this.filterRt.diagnostics = true;
    if (this.tuning) return;
    this.tuning = true;
    if (this.running) return;
    await this.stopPreview();
    this.tuneLoopDone = this.tuneLoop();
  }

  /** Черновик поменялся: уверенность, рост, зоны и неподвижные — сразу; уровень и строгость — новым проверочным подсчётом. */
  setTuneFilter(f: DetectionFilter): void {
    this.tuneFilter = structuredClone(f);
  }

  /** Окно закрыто. previewAfter — вернуть предпросмотр (экран пилота открыт). */
  async stopTuning(previewAfter: boolean): Promise<void> {
    if (!this.tuning) return;
    this.tuning = false;
    this.tuneFilter = null;
    this.filterRt.diagnostics = false;
    this.filterRt.rejected = [];
    if (this.running) return;
    await this.stopTuneLoop();
    if (previewAfter) void this.startPreview();
    else this.set("idle", "");
  }

  private async stopTuneLoop(): Promise<void> {
    if (!this.tuneLoopDone) return;
    const done = this.tuneLoopDone;
    this.tuneLoopDone = null;
    this.closeSource();
    await done.catch(() => undefined);
  }

  private tuneActive(): boolean {
    return this.tuning && !this.running && this.tuneLoopDone !== null;
  }

  private async tuneLoop(): Promise<void> {
    await sleep(0); // tuneLoopDone уже присвоен
    let failures = 0;
    while (this.tuneActive()) {
      try {
        await this.runOnce(15, true);
        failures = 0;
      } catch (e) {
        if (!this.tuneActive()) break;
        failures += 1;
        this.lastError = e instanceof Error ? e.message : String(e);
        this.set("preview", `Нет картинки: ${this.lastError}`);
        for (let i = 0; i < Math.min(30, 5 * failures) && this.tuneActive(); i++) await sleep(1000);
      }
    }
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
    const d = liveDelta(this.accounted, cur);
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
        if (failures >= 3) this.hooks.resetDetector();
        const wait = Math.min(60, 5 * failures);
        this.lastError = msg;
        this.set("recovering", `Сбой: ${msg}. Перезапуск через ${wait} с`);
        for (let i = 0; i < wait && this.running; i++) await sleep(1000);
      }
    }
    this.closePiece();
  }

  private async runOnce(fps: number, tuning = false): Promise<void> {
    const active = () => (tuning ? this.tuneActive() : this.running);
    this.set(tuning ? "preview" : "starting", "Подключаю камеру…");
    const src = await this.open(active);
    if (!active()) {
      src.close();
      return;
    }
    this.source = src;
    try {
      await this.countWith(src, fps, tuning, active);
    } finally {
      this.closeSource(src); // свой источник; чужой (уже следующий цикл) не трогаем
    }
  }

  private async countWith(src: LiveSource, fps: number, tuning: boolean, active: () => boolean): Promise<void> {
    this.width = src.width;
    this.height = src.height;
    this.set(tuning ? "preview" : "starting", "Загружаю нейросеть…");
    // пока грузится нейросеть — показываем картинку камеры (окна разметки, чувствительности, сетка)
    let detReady = false;
    const detP = this.hooks.getDetector().finally(() => (detReady = true));
    detP.catch(() => undefined);
    while (!detReady && active()) {
      const shot = await withTimeout(src.grab(), 30_000, "камера не присылает кадры");
      this.lastFrameAt = performance.now();
      this.hooks.onFrame(this, shot, null);
      shot.close();
      await sleep(200);
    }
    const det = await detP;
    if (!active()) return;
    const W = src.width, H = src.height;
    const newSession = () => {
      // в проверке — пороги из черновика, в пилоте — сохранённые (черновик применится после «Сохранить»)
      const cfg = channelAnalyticsConfig(this.config, tuning ? this.filter : this.config.filter);
      const f = tuning ? this.filter : this.config.filter;
      // как LiveCameraEngine на Mac: склейка повторных треков, сотрудники, «в зоне» — после minTrackSeconds
      const s = new Session(cfg, W, H, this.config.markup.entranceEnabled ? this.config.markup.entrance : null, fps, {
        reid: true, staffMinutes: staffMinutesOf(f), seenAfter: cfg.tracking.minTrackSeconds,
      });
      s.trackFilter = (people, t) => this.filterRt.dropStatic(people, this.filter, t);
      this.tuneSessionKey = `${this.filter.level}|${this.filter.behavior}`;
      return s;
    };
    const session0 = newSession();
    if (tuning) this.tuneSession = session0;
    else this.session = session0;
    this.restartRequested = false;
    this.set(tuning ? "preview" : "counting", tuning ? "" : "Идёт подсчёт");

    const interval = 1000 / fps;
    const t0 = performance.now();
    let lastTick = t0, lastPrune = t0, lastNotify = 0;
    let rate = 0, ms = 0;
    let lastFr: FrameResult | null = null;
    while (active()) {
      if (tuning && this.tuneSessionKey !== `${this.filter.level}|${this.filter.behavior}`) {
        // уровень или строгость поменялись — проверочный подсчёт с новыми порогами
        this.tuneSession = newSession();
      }
      if (!tuning && this.restartRequested) {
        // новые пороги: досчитали кусок, начинаем новый на той же камере
        this.closePiece();
        this.session = newSession();
        this.restartRequested = false;
      }
      if (src.lost()) throw new Error("камера отключилась");
      const started = performance.now();
      const shot = await withTimeout(src.grab(), 30_000, "камера не присылает кадры");
      let res;
      try {
        // пока нейросеть считает этот кадр, картинка камеры идёт дальше (с рамками прошлого кадра) — не «подвисает»
        res = await this.showWhile(src, withTimeout(det.detect(shot, W, H, 0.25), 20_000, "нейросеть не отвечает"), lastFr, active);
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

      const session = (tuning ? this.tuneSession : this.session)!;
      // чувствительность применяется сразу (порог, рост, зоны, неподвижные), строгость поведения — с нового куска
      const t = (now - t0) / 1000;
      const kept = this.filterRt.apply(res.detections, this.filter, t, W, H).kept;
      const fr = session.update(t, kept);
      if (!tuning) this.last = { boxes: fr.boxes, width: W, height: H, at: now };
      this.hooks.onFrame(this, shot, fr);
      shot.close();
      lastFr = fr;

      if (now - lastPrune > 10_000) {
        session.prune(fr.t);
        this.filterRt.keepOnly(session.analytics.tracks.keys());
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
      if (spent < interval) await this.showWhile(src, sleep(interval - spent), lastFr, active);
    }
  }

  /** Живая картинка (~12 кадр/с), пока идёт работа p: нейросеть или пауза между кадрами подсчёта. */
  private async showWhile<T>(src: LiveSource, p: Promise<T>, fr: FrameResult | null, active: () => boolean): Promise<T> {
    let done = false;
    const wrapped = p.finally(() => (done = true));
    wrapped.catch(() => undefined);
    const pump = (async () => {
      await sleep(80);
      while (!done && active() && !src.lost()) {
        const t = performance.now();
        let frame: ImageBitmap | null = null;
        try {
          const g = src.grab();
          frame = await Promise.race([g, wrapped.then(() => null, () => null)]);
          if (!frame) {
            g.then((b) => b.close(), () => undefined); // кадр пришёл, когда уже не нужен
            return;
          }
        } catch {
          return; // ошибку камеры покажет основной цикл
        }
        if (done) {
          frame.close();
          return;
        }
        this.hooks.onFrame(this, frame, fr);
        frame.close();
        const left = 80 - (performance.now() - t);
        if (left > 0) await sleep(left);
      }
    })();
    try {
      return await wrapped;
    } finally {
      await pump.catch(() => undefined);
    }
  }
}
