// Видео одного запуска мониторинга — как startVideo / finishVideo / checkVideoSpace в PilotModel.swift:
// на запуск — своя папка, у каждой камеры — свой писатель; раз в 10 с — расписание записи, раз в минуту — место
// на диске (кончается — видео останавливается, подсчёт идёт дальше; лишнее старое — удаляется).

import type { FrameResult } from "../engine/session";
import type { Channel } from "../multi/channel";
import type { ReportClip } from "../reports/store";
import { MIN_FREE_TO_START_GB, MIN_FREE_WHILE_RECORDING_GB, type VideoStorage, motionThresholds, recordingAllowed, runFolderName, videoPrefs } from "./storage";
import { CameraVideoWriter } from "./writer";

export class VideoRun {
  folder: string | null = null;
  private writers = new Map<string, CameraVideoWriter>();
  /** Видео, которое пришлось остановить раньше (кончилось место). */
  private early = new Map<string, ReportClip[]>();
  private timer = 0;
  private tick = 0;

  constructor(private readonly storage: VideoStorage, private readonly onNote: (note: string | null) => void) {}

  get active(): boolean {
    return this.writers.size > 0;
  }

  async start(channels: Channel[]): Promise<void> {
    await this.finish();
    this.folder = runFolderName();
    this.early.clear();
    this.storage.note = null;
    this.onNote(null);
    if (videoPrefs.mode === "off") return;
    const folder = this.folder;
    // сначала — место: старое видео убираем, без свободного места запись не начинаем
    await this.storage.cleanup(folder);
    const free = await this.storage.freeGB();
    if (free !== null && free < MIN_FREE_TO_START_GB) {
      this.setNote(`Видео не пишется: на диске свободно меньше ${MIN_FREE_TO_START_GB} ГБ`);
      return;
    }
    if (this.folder !== folder) return; // успели остановить
    const sink = await this.storage.sink();
    channels.forEach((ch, i) => {
      const name = `${i + 1} ${ch.title}`.replace(/[/\\:*?"<>|]/g, "-");
      const w = new CameraVideoWriter({
        folder, baseName: name, mode: videoPrefs.events ? "events" : "always", blurFaces: videoPrefs.blurFaces, sink,
        motion: motionThresholds,
      });
      w.setAllowed(recordingAllowed());
      this.writers.set(ch.id, w);
    });
    this.timer = window.setInterval(() => void this.every10s(), 10_000);
  }

  /** Кадр камеры (из подсчёта). Кадр закроют сразу после — писатель рисует его синхронно. */
  frame(ch: Channel, shot: ImageBitmap, fr: FrameResult | null): void {
    const w = this.writers.get(ch.id);
    if (!w || !fr) return;
    const boxes = fr.boxes;
    w.frame(shot, { markup: ch.config.markup, boxes, label: ch.title }, boxes.some((b) => !b.staff));
    if (w.error && !this.storage.note) this.setNote(w.error);
  }

  private async every10s(): Promise<void> {
    const on = recordingAllowed();
    for (const w of this.writers.values()) w.setAllowed(on);
    this.tick += 1;
    if (this.tick % 6 !== 0) return;
    const free = await this.storage.freeGB();
    if (free !== null && free < MIN_FREE_WHILE_RECORDING_GB) {
      for (const [id, w] of this.writers) {
        const clips = await w.finish();
        if (clips.length) this.early.set(id, [...(this.early.get(id) ?? []), ...clips]);
      }
      this.writers.clear();
      clearInterval(this.timer);
      this.setNote(`Видео остановлено: на диске осталось меньше ${MIN_FREE_WHILE_RECORDING_GB} ГБ. Подсчёт идёт дальше.`);
    } else await this.storage.cleanup(this.folder);
  }

  private setNote(n: string | null): void {
    this.storage.note = n;
    this.onNote(n);
  }

  /** Дописать видео всех камер. Камера → ролики. */
  async finish(): Promise<{ folder: string | null; clips: Map<string, ReportClip[]> }> {
    clearInterval(this.timer);
    const out = new Map(this.early);
    this.early.clear();
    const all = [...this.writers.entries()];
    this.writers.clear();
    await Promise.all(all.map(async ([id, w]) => {
      const clips = await w.finish();
      if (clips.length) out.set(id, [...(out.get(id) ?? []), ...clips].sort((a, b) => a.start - b.start));
    }));
    const folder = this.folder;
    this.folder = null;
    return { folder, clips: out };
  }
}
