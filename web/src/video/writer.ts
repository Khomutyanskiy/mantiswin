// Запись видео с камеры во время мониторинга — порт CameraVideoWriter.swift (Mantis для Mac).
// MP4 (H.264 через WebCodecs, если есть — иначе VP9), с разметкой, рамками людей и временем на кадре, лица размыты.
//
// Два режима:
//   • «Всё время» — один файл на запуск, до 12 кадров/с;
//   • «При движении и людях» — отдельный ролик на каждое событие: событие начинается, когда кадр заметно изменился
//     (движение) или нейросеть увидела человека; в ролик попадают 5 с ДО события (предзапись) и 5 с после;
//     только движение без людей дольше 20 с — это, скорее всего, шум (свет, ИК-режим ночью): ролик закрывается,
//     и минуту движение без людей не запускает запись.
// Вне «расписания записи» кадры не пишутся.
//
// Предзапись хранится уже сжатой (ключевой кадр раз в секунду): памяти почти не нужно, ролик начинается
// с ближайшего ключевого кадра в пределах 5 с до события.

import { Muxer, StreamTarget } from "mp4-muxer";
import type { OverlayBox } from "../engine/session";
import type { ReportClip } from "../reports/store";
import { type Markup, drawMarkup, drawPeople } from "../ui/draw";

export const VIDEO_FPS = 12;
const PRE_ROLL = 5;
const TAIL = 5;
const NOISE_LIMIT = 20;
const NOISE_COOLDOWN = 60;
const EVENT_MAX = { w: 1280, h: 720 };
const ALWAYS_MAX = { w: 1920, h: 1080 };

/** Куда писать файлы ролика (мост на этом компьютере или хранилище браузера). */
export interface VideoSink {
  /** Записать кусок файла с позиции pos. */
  write(folder: string, name: string, pos: number, data: Uint8Array): Promise<void>;
  /** Расширение (mp4). */
  readonly ext: string;
}

export interface VideoOverlay {
  markup: Markup | null;
  boxes: OverlayBox[];
  /** Подпись в углу (название камеры). */
  label: string;
}

export interface WriterOptions {
  folder: string;
  baseName: string;
  mode: "always" | "events";
  blurFaces: boolean;
  sink: VideoSink;
  /** Порог движения: изменение яркости пикселя и доля изменившегося кадра (уровень 1–5). */
  motion: () => { pixel: number; fraction: number };
}

interface Coded {
  chunk: EncodedVideoChunk;
  meta?: EncodedVideoChunkMetadata;
  at: number;
  date: number;
}

interface Segment {
  muxer: Muxer<StreamTarget>;
  file: string;
  start: number;
  startAt: number;
  lastAt: number;
  people: boolean;
  lastPeopleAt: number;
  queue: Promise<void>;
  pos: number;
  failed: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");
const stampText = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const fileStamp = (d: Date) => `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

/** Кодек, который умеет этот браузер, для размера w×h. */
async function pickCodec(w: number, h: number): Promise<{ codec: string; mux: "avc" | "vp9" } | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const tries: { codec: string; mux: "avc" | "vp9" }[] = [
    { codec: w * h > 1280 * 720 ? "avc1.640028" : "avc1.42001f", mux: "avc" },
    { codec: "avc1.4d0028", mux: "avc" },
    { codec: "vp09.00.40.08", mux: "vp9" },
  ];
  for (const t of tries) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec: t.codec, width: w, height: h, bitrate: bitrateFor(w, h), framerate: VIDEO_FPS });
      if (r.supported) return t;
    } catch {
      /* следующий */
    }
  }
  return null;
}

const bitrateFor = (w: number, h: number) => Math.round(Math.min(4_000_000, Math.max(600_000, w * h * VIDEO_FPS * 0.12)));

export class CameraVideoWriter {
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private encoder: VideoEncoder | null = null;
  private codec: { codec: string; mux: "avc" | "vp9" } | null = null;
  private configuring: Promise<void> | null = null;
  private size = { w: 0, h: 0 };
  private allowed = true;
  private finished = false;
  private lastFrameAt = 0;
  private frameNo = 0;
  private peopleUntil = 0;
  private motionUntil = 0;
  private motionHits = 0;
  private noiseCooldownUntil = 0;
  private lastLuma: Uint8Array | null = null;
  private small = new OffscreenCanvas(32, 18);
  private smallCtx = this.small.getContext("2d", { willReadFrequently: true })!;
  private preroll: Coded[] = [];
  private segment: Segment | null = null;
  private clips: ReportClip[] = [];
  private closing: Promise<void>[] = [];
  /** Не удалось (нет кодека, кончилось место) — причина для экрана. */
  error: string | null = null;

  constructor(private readonly o: WriterOptions) {}

  /** Расписание записи: вне часов кадры не пишутся (идущий ролик закрывается). */
  setAllowed(on: boolean): void {
    if (on === this.allowed) return;
    this.allowed = on;
    if (!on) {
      this.closeSegment();
      this.preroll = [];
    }
  }

  get recording(): boolean {
    return !!this.segment;
  }

  /** Кадр распознавания. people — в кадре есть люди. Вызывается синхронно (кадр закроют сразу после). */
  frame(shot: ImageBitmap, overlay: VideoOverlay, people: boolean): void {
    if (this.finished || !this.allowed || this.error) return;
    const now = performance.now() / 1000;
    if (people) this.peopleUntil = now + TAIL;
    if (now - this.lastFrameAt < 1 / VIDEO_FPS - 0.004) return;
    this.lastFrameAt = now;
    if (this.o.mode === "events") this.detectMotion(shot, now);
    const max = this.o.mode === "events" ? EVENT_MAX : ALWAYS_MAX;
    const k = Math.min(1, max.w / shot.width, max.h / shot.height);
    const w = Math.round(shot.width * k) & ~1, h = Math.round(shot.height * k) & ~1;
    if (!this.encoder || w !== this.size.w || h !== this.size.h) {
      if (!this.configuring) this.configuring = this.configure(w, h).finally(() => (this.configuring = null));
      return; // кодек ещё настраивается — кадр пропускаем
    }
    if (this.encoder.state !== "configured") return;
    // кадр с разметкой, размытыми лицами и временем
    const ctx = this.ctx!;
    ctx.drawImage(shot, 0, 0, w, h);
    if (this.o.blurFaces) this.blurFaces(shot, overlay.boxes, k);
    if (overlay.markup) drawMarkup(ctx as unknown as CanvasRenderingContext2D, overlay.markup);
    ctx.save();
    ctx.scale(k, k);
    drawPeople(ctx as unknown as CanvasRenderingContext2D, overlay.boxes.filter((b) => !b.staff));
    ctx.restore();
    this.drawTime(overlay.label);
    const ts = Math.round(now * 1_000_000);
    const vf = new VideoFrame(this.canvas!, { timestamp: ts, duration: Math.round(1_000_000 / VIDEO_FPS) });
    const keyEvery = this.o.mode === "events" ? VIDEO_FPS : VIDEO_FPS * 2;
    try {
      this.encoder.encode(vf, { keyFrame: this.frameNo % keyEvery === 0 });
    } finally {
      vf.close();
    }
    this.frameNo += 1;
    this.decide(now);
  }

  /** Закончить запись. В ответ — записанные ролики. */
  async finish(): Promise<ReportClip[]> {
    if (this.finished) return this.clips;
    this.finished = true;
    try {
      await this.configuring;
      if (this.encoder && this.encoder.state === "configured") await this.encoder.flush();
    } catch {
      /* кодек уже закрыт */
    }
    this.closeSegment();
    this.preroll = [];
    await Promise.allSettled(this.closing);
    try {
      this.encoder?.close();
    } catch {
      /* нет */
    }
    this.encoder = null;
    return this.clips;
  }

  // ---------------------------------------------------------------- кодек

  private async configure(w: number, h: number): Promise<void> {
    this.closeSegment();
    this.preroll = [];
    try {
      this.encoder?.close();
    } catch {
      /* нет */
    }
    this.encoder = null;
    const codec = await pickCodec(w, h);
    if (!codec) {
      this.error = "Этот браузер не умеет сжимать видео (нет WebCodecs) — запись выключена";
      return;
    }
    this.codec = codec;
    this.size = { w, h };
    this.canvas = new OffscreenCanvas(w, h);
    this.ctx = this.canvas.getContext("2d")!;
    this.frameNo = 0;
    const enc = new VideoEncoder({
      output: (chunk, meta) => this.onChunk(chunk, meta),
      error: (e) => {
        this.error = `Запись видео остановилась: ${e.message}`;
        this.closeSegment();
      },
    });
    enc.configure({
      codec: codec.codec, width: w, height: h, bitrate: bitrateFor(w, h), framerate: VIDEO_FPS, latencyMode: "realtime",
      ...(codec.mux === "avc" ? { avc: { format: "avc" } } : {}),
    } as VideoEncoderConfig);
    this.encoder = enc;
  }

  private onChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    const at = chunk.timestamp / 1_000_000;
    const c: Coded = { chunk, meta, at, date: Date.now() - (performance.now() / 1000 - at) * 1000 };
    if (this.segment) {
      this.add(this.segment, c);
      return;
    }
    if (this.o.mode === "always") {
      // «всё время»: один файл с первого ключевого кадра
      if (chunk.type === "key") {
        this.segment = this.open(c.date, at);
        if (this.segment) this.add(this.segment, c);
      }
      return;
    }
    // «по событиям»: держим сжатую предзапись
    this.preroll.push(c);
    const keepFrom = at - PRE_ROLL - 1.5;
    while (this.preroll.length && this.preroll[0].at < keepFrom) this.preroll.shift();
  }

  // ---------------------------------------------------------------- события

  private decide(now: number): void {
    if (this.o.mode !== "events") return;
    const people = now < this.peopleUntil;
    const motion = now < this.motionUntil && now >= this.noiseCooldownUntil;
    const active = people || motion;
    const seg = this.segment;
    if (seg) {
      if (people) {
        seg.people = true;
        seg.lastPeopleAt = now;
      }
      if (!active) this.closeSegment();
      else if (!people && now - seg.lastPeopleAt > NOISE_LIMIT && now - seg.startAt > NOISE_LIMIT) {
        // долго только «движение» без людей — шум: закрыть и не реагировать на одно движение минуту
        this.noiseCooldownUntil = now + NOISE_COOLDOWN;
        this.closeSegment();
      }
    } else if (active) {
      // начало ролика — с ключевого кадра в пределах предзаписи
      let i = this.preroll.findIndex((c) => c.chunk.type === "key" && c.at >= now - PRE_ROLL - 1);
      if (i < 0) i = this.preroll.findIndex((c) => c.chunk.type === "key");
      if (i < 0) return; // ключевого кадра ещё нет — начнём со следующего
      const first = this.preroll[i];
      const s = this.open(first.date, first.at);
      if (!s) return;
      s.people = people;
      if (people) s.lastPeopleAt = now;
      this.segment = s;
      for (const c of this.preroll.slice(i)) this.add(s, c);
      this.preroll = [];
    }
  }

  /** Движение: уменьшенный кадр 32×18 в оттенках серого сравниваем с прошлым. */
  private detectMotion(shot: ImageBitmap, now: number): void {
    const w = 32, h = 18;
    this.smallCtx.drawImage(shot, 0, 0, w, h);
    const px = this.smallCtx.getImageData(0, 0, w, h).data;
    const luma = new Uint8Array(w * h);
    let sum = 0;
    for (let i = 0; i < w * h; i++) {
      const y = (px[i * 4] * 3 + px[i * 4 + 1] * 6 + px[i * 4 + 2]) / 10;
      luma[i] = y;
      sum += y;
    }
    const prev = this.lastLuma;
    this.lastLuma = luma;
    if (!prev) return;
    // общее изменение яркости (включили свет, ИК-режим) — не движение: сравниваем с поправкой на среднее
    let prevSum = 0;
    for (const v of prev) prevSum += v;
    const shift = (sum - prevSum) / (w * h);
    const th = this.o.motion();
    let changed = 0;
    for (let i = 0; i < w * h; i++) if (Math.abs(luma[i] - prev[i] - shift) > th.pixel) changed++;
    const fraction = changed / (w * h);
    // слишком большое изменение всего кадра — тоже свет/камера, не движение
    if (fraction > th.fraction && fraction < 0.6) {
      this.motionHits += 1;
      if (this.motionHits >= 2) this.motionUntil = now + TAIL;
    } else this.motionHits = 0;
  }

  // ---------------------------------------------------------------- рисование

  /** Размыть лица: по точкам лица из нейросети (нос, глаза, уши), иначе — верх рамки человека. */
  private blurFaces(shot: ImageBitmap, boxes: OverlayBox[], k: number): void {
    const ctx = this.ctx!;
    for (const b of boxes) {
      const bw = b.box.x2 - b.box.x1, bh = b.box.y2 - b.box.y1;
      let x1: number, y1: number, x2: number, y2: number;
      const pts = (b.keypoints ?? []).slice(0, 5).filter((p) => p.conf > 0.3);
      if (pts.length >= 2) {
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const s = Math.max(Math.max(...xs) - Math.min(...xs), bw * 0.28, bh * 0.1) * 1.5;
        [x1, y1, x2, y2] = [cx - s / 2, cy - s * 0.65, cx + s / 2, cy + s * 0.6];
      } else {
        const head = Math.min(bh * 0.24, bw * 0.75);
        const cx = (b.box.x1 + b.box.x2) / 2;
        [x1, y1, x2, y2] = [cx - head * 0.6, b.box.y1, cx + head * 0.6, b.box.y1 + head * 1.1];
      }
      const rx = Math.max(0, x1 * k), ry = Math.max(0, y1 * k);
      const rw = Math.min(this.size.w - rx, (x2 - x1) * k), rh = Math.min(this.size.h - ry, (y2 - y1) * k);
      if (rw < 3 || rh < 3) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rx, ry, rw, rh);
      ctx.clip();
      ctx.filter = `blur(${Math.max(6, Math.round(this.size.w / 90))}px)`;
      ctx.drawImage(shot, 0, 0, this.size.w, this.size.h);
      ctx.restore();
    }
  }

  private drawTime(label: string): void {
    const ctx = this.ctx!;
    const s = Math.max(12, Math.round(this.size.h / 40));
    const text = `${stampText(new Date())}${label ? ` · ${label}` : ""}`;
    ctx.save();
    ctx.font = `600 ${s}px "JetBrains Mono", Consolas, monospace`;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(10, 18, 48, 0.72)";
    ctx.fillRect(s * 0.5, this.size.h - s * 2.1, tw + s, s * 1.6);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(text, s, this.size.h - s * 1.3);
    ctx.restore();
  }

  // ---------------------------------------------------------------- файлы

  private open(start: number, at: number): Segment | null {
    const codec = this.codec;
    if (!codec) return null;
    const file = `${this.o.baseName}${this.o.mode === "events" ? ` ${fileStamp(new Date(start))}` : ""}.${this.o.sink.ext}`;
    const seg: Segment = {
      muxer: null as unknown as Muxer<StreamTarget>, file, start, startAt: at, lastAt: at, people: false, lastPeopleAt: at,
      queue: Promise.resolve(), pos: 0, failed: false,
    };
    const target = new StreamTarget({
      chunked: true,
      chunkSize: 4 * 1024 * 1024,
      onData: (data, position) => {
        const copy = data.slice();
        seg.queue = seg.queue.then(() => this.o.sink.write(this.o.folder, file, position, copy)).catch((e) => {
          seg.failed = true;
          this.error = `Видео не записывается: ${(e as Error).message}`;
        });
      },
    });
    seg.muxer = new Muxer({
      target, fastStart: false, firstTimestampBehavior: "offset",
      video: { codec: codec.mux, width: this.size.w, height: this.size.h, frameRate: VIDEO_FPS },
    });
    return seg;
  }

  private add(seg: Segment, c: Coded): void {
    try {
      seg.muxer.addVideoChunk(c.chunk, c.meta);
      seg.lastAt = c.at;
    } catch (e) {
      seg.failed = true;
      console.warn("[mantis] кадр видео не записался:", e);
    }
  }

  private closeSegment(): void {
    const seg = this.segment;
    if (!seg) return;
    this.segment = null;
    const done = (async () => {
      try {
        seg.muxer.finalize();
      } catch {
        /* пусто */
      }
      await seg.queue;
      const seconds = Math.max(0, seg.lastAt - seg.startAt);
      if (!seg.failed && seconds >= 0.5) this.clips.push({ file: seg.file, start: seg.start, seconds, people: seg.people });
    })();
    this.closing.push(done);
  }
}
