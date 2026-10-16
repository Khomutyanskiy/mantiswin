/// <reference lib="webworker" />
// Нейросеть YOLO11-pose в отдельном потоке: кадр → люди с рамками и 17 ключевыми точками.
// Сначала пробуем WebGPU (видеокарта), если его нет — WASM на процессоре.

import * as ort from "onnxruntime-web/webgpu";
// Рантайм WASM отдельными файлами: иначе многопоточный WASM запускает потоки из этого же скрипта и зависает
import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { decodePose, makeLetterbox } from "./engine/decoder";
import type { RawDetection } from "./engine/bytetrack";

export type WorkerRequest =
  /** threads: 0 — сколько позволит браузер, 1 — один поток (самый совместимый вариант). */
  | { type: "init"; modelUrl: string; preferGpu: boolean; threads: number }
  | {
      type: "detect";
      id: number;
      /** Кадр, уже уменьшенный до размера внутри входа сети (см. makeLetterbox().scaledWidth/Height). */
      bitmap: ImageBitmap;
      width: number;
      height: number;
      conf: number;
    };

export type WorkerResponse =
  | { type: "ready"; backend: string; inputSize: number }
  /** Этап загрузки — главный поток по нему отмеряет таймауты и показывает статус. */
  | { type: "stage"; stage: "model" | "gpu" | "cpu" }
  | { type: "result"; id: number; detections: RawDetection[]; maxScore: number; ms: number }
  | { type: "error"; id?: number; message: string };

let session: ort.InferenceSession | null = null;
let inputName = "images";
let outputName = "output0";
let inputSize = 640;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let input: Float32Array | null = null;

const post = (m: WorkerResponse, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

/** Есть ли рабочий адаптер WebGPU (у navigator.gpu он может вернуть null — например, без видеокарты). */
async function hasGpu(): Promise<boolean> {
  const gpu = (self.navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    const adapter = await Promise.race([gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 3000))]);
    return !!adapter;
  } catch {
    return false;
  }
}

async function init(modelUrl: string, preferGpu: boolean, threads: number): Promise<void> {
  ort.env.wasm.wasmPaths = { mjs: new URL(ortMjsUrl, self.location.href).href, wasm: new URL(ortWasmUrl, self.location.href).href };
  // Несколько потоков работают только при заголовках COOP/COEP (см. vite.config.ts), иначе — один
  ort.env.wasm.numThreads = threads === 1 || !self.crossOriginIsolated ? 1 : Math.min(4, self.navigator.hardwareConcurrency || 2);
  ort.env.logLevel = "error";
  post({ type: "stage", stage: "model" });
  const res = await fetch(modelUrl);
  if (!res.ok) throw new Error(`Не удалось загрузить модель (${res.status})`);
  const model = new Uint8Array(await res.arrayBuffer());

  let backend = "wasm";
  if (preferGpu && (await hasGpu())) {
    try {
      console.debug("[mantis] создаю сессию WebGPU");
      post({ type: "stage", stage: "gpu" });
      session = await ort.InferenceSession.create(model, { executionProviders: ["webgpu"], graphOptimizationLevel: "all" });
      backend = "webgpu";
    } catch (e) {
      console.warn("[mantis] WebGPU недоступен, перехожу на процессор:", e);
      session = null;
    }
  }
  if (!session) {
    console.debug(`[mantis] создаю сессию WASM, потоков: ${ort.env.wasm.numThreads}`);
    post({ type: "stage", stage: "cpu" });
    session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  }
  inputName = session.inputNames[0];
  outputName = session.outputNames[0];

  // Прогрев: первый запуск на WebGPU компилирует шейдеры
  input = new Float32Array(3 * inputSize * inputSize).fill(114 / 255);
  await session.run({ [inputName]: new ort.Tensor("float32", input, [1, 3, inputSize, inputSize]) });
  post({ type: "ready", backend: backend === "webgpu" ? "WebGPU (видеокарта)" : "WASM (процессор)", inputSize });
}

async function detect(req: Extract<WorkerRequest, { type: "detect" }>): Promise<void> {
  if (!session || !input) throw new Error("Модель не загружена");
  const started = performance.now();
  const s = inputSize;
  const lb = makeLetterbox(req.width, req.height, s);
  if (!canvas) {
    canvas = new OffscreenCanvas(s, s);
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  }
  const c = ctx!;
  // Letterbox как в ultralytics: кадр по центру на сером (114) поле
  c.fillStyle = "rgb(114,114,114)";
  c.fillRect(0, 0, s, s);
  c.drawImage(req.bitmap, lb.padX, lb.padY, lb.scaledWidth, lb.scaledHeight);
  req.bitmap.close();
  const px = c.getImageData(0, 0, s, s).data;
  const plane = s * s;
  for (let i = 0, j = 0; i < plane; i++, j += 4) {
    input[i] = px[j] / 255;
    input[plane + i] = px[j + 1] / 255;
    input[2 * plane + i] = px[j + 2] / 255;
  }
  const out = await session.run({ [inputName]: new ort.Tensor("float32", input, [1, 3, s, s]) });
  const t = out[outputName];
  const [, channels, count] = t.dims as number[];
  const values = (await t.getData()) as Float32Array;
  t.dispose();
  const { detections, maxScore } = decodePose(values, channels, count, lb, req.conf);
  post({ type: "result", id: req.id, detections, maxScore, ms: performance.now() - started });
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  try {
    if (m.type === "init") await init(m.modelUrl, m.preferGpu, m.threads);
    else if (m.type === "detect") await detect(m);
  } catch (err) {
    post({ type: "error", id: m.type === "detect" ? m.id : undefined, message: err instanceof Error ? err.message : String(err) });
  }
};
