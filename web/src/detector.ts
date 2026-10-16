// Обёртка над потоком с нейросетью: кадр → детекции (Promise).

import type { RawDetection } from "./engine/bytetrack";
import { makeLetterbox } from "./engine/decoder";
import type { WorkerRequest, WorkerResponse } from "./detector.worker";

export interface DetectResult {
  detections: RawDetection[];
  maxScore: number;
  ms: number;
}

export class Detector {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: DetectResult) => void; reject: (e: Error) => void }>();
  backend = "";
  inputSize = 640;
  conf = 0.35;

  private constructor() {
    this.worker = new Worker(new URL("./detector.worker.ts", import.meta.url), { type: "module" });
  }

  /**
   * Загрузить нейросеть. Пробуем по очереди: видеокарта (WebGPU) → процессор в несколько потоков →
   * процессор в один поток. Если вариант не отвечает за отведённое время (так бывает в Safari),
   * поток с нейросетью пересоздаётся и пробуется следующий.
   */
  static async create(onStatus?: (s: string) => void): Promise<Detector> {
    const forceCpu = new URLSearchParams(location.search).has("cpu"); // ?cpu в адресе — сразу на процессоре
    const attempts: { preferGpu: boolean; threads: number }[] = [
      ...(forceCpu ? [] : [{ preferGpu: true, threads: 0 }]),
      { preferGpu: false, threads: 0 },
      { preferGpu: false, threads: 1 },
    ];
    let lastError: Error | null = null;
    for (const a of attempts) {
      const d = new Detector();
      try {
        await d.init(a.preferGpu, a.threads, onStatus);
        return d;
      } catch (e) {
        lastError = e as Error;
        console.warn("[mantis] вариант не сработал:", a, lastError.message);
        d.dispose();
      }
    }
    throw lastError ?? new Error("Нейросеть не загрузилась");
  }

  private init(preferGpu: boolean, threads: number, onStatus?: (s: string) => void): Promise<void> {
    const base = new URL(import.meta.env.BASE_URL, location.href);
    // Время на каждый этап: скачивание модели — дольше, создание сессии — меньше
    const limits = { model: 120_000, gpu: 30_000, cpu: 40_000 } as const;
    const labels = { model: "Скачиваю нейросеть…", gpu: "Запускаю на видеокарте…", cpu: "Запускаю на процессоре…" } as const;
    return new Promise<void>((resolve, reject) => {
      let timer = 0;
      const arm = (ms: number, what: string) => {
        clearTimeout(timer);
        timer = window.setTimeout(() => reject(new Error(`${what}: нет ответа`)), ms);
      };
      arm(20_000, "запуск потока");
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const m = e.data;
        if (m.type === "stage") {
          onStatus?.(labels[m.stage]);
          arm(limits[m.stage], labels[m.stage]);
        } else if (m.type === "ready") {
          clearTimeout(timer);
          this.backend = m.backend;
          this.inputSize = m.inputSize;
          this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
          resolve();
        } else if (m.type === "error") {
          clearTimeout(timer);
          reject(new Error(m.message));
        }
      };
      this.worker.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(e.message || "Ошибка потока нейросети"));
      };
      const req: WorkerRequest = { type: "init", modelUrl: new URL("models/yolo11n-pose.onnx", base).href, preferGpu, threads };
      this.worker.postMessage(req);
    });
  }

  private onMessage(m: WorkerResponse): void {
    if (m.type === "result") {
      this.pending.get(m.id)?.resolve({ detections: m.detections, maxScore: m.maxScore, ms: m.ms });
      this.pending.delete(m.id);
    } else if (m.type === "error" && m.id !== undefined) {
      this.pending.get(m.id)?.reject(new Error(m.message));
      this.pending.delete(m.id);
    }
  }

  /**
   * Снять кадр и отправить в нейросеть. Возвращается сразу после снятия кадра —
   * источник (видео) можно двигать дальше, пока считается результат.
   * source — кадр видео/камеры; width/height — его размер в пикселях (система координат результата).
   */
  async submit(source: CanvasImageSource, width: number, height: number, conf = this.conf): Promise<{ result: Promise<DetectResult> }> {
    const lb = makeLetterbox(width, height, this.inputSize);
    const bitmap = await createImageBitmap(source as ImageBitmapSource, {
      resizeWidth: lb.scaledWidth,
      resizeHeight: lb.scaledHeight,
      resizeQuality: "medium",
    });
    const id = this.nextId++;
    const result = new Promise<DetectResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const req: WorkerRequest = { type: "detect", id, bitmap, width, height, conf };
      this.worker.postMessage(req, [bitmap]);
    });
    return { result };
  }

  /** conf — порог уверенности для этого кадра (по умолчанию общий; пилот на нескольких камерах берёт свой). */
  async detect(source: CanvasImageSource, width: number, height: number, conf = this.conf): Promise<DetectResult> {
    return (await this.submit(source, width, height, conf)).result;
  }

  dispose(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error("Остановлено"));
    this.pending.clear();
  }
}
