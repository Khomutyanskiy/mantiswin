// Разбор сырого выхода YOLO11-pose ([1, 56, N]: cx, cy, w, h, conf, 17×(x, y, v)) в детекции людей:
// порог уверенности → NMS → пересчёт из координат входа сети (letterbox) в пиксели кадра.
// Повторяет ultralytics non_max_suppression + scale_boxes / scale_coords (через iOS PoseDecoder.swift).

import type { RawDetection } from "./bytetrack";
import { type Box, iou } from "./geometry";
import type { Keypoint } from "./headpose";

/** Параметры letterbox: как кадр был вписан во вход сети. */
export interface Letterbox {
  gain: number; // масштаб кадр → вход
  padX: number; // отступ слева, пикселей входа
  padY: number; // отступ сверху, пикселей входа
  imageWidth: number;
  imageHeight: number;
  scaledWidth: number;
  scaledHeight: number;
}

/** Округление как Swift .rounded() / Python round-half-away (для положительных чисел). */
const round = (v: number) => Math.sign(v) * Math.round(Math.abs(v));

/** Как ultralytics LetterBox(center=True) для квадратного входа size×size. */
export function makeLetterbox(w: number, h: number, s: number): Letterbox {
  const r = Math.min(s / h, s / w);
  const newW = round(w * r), newH = round(h * r);
  const dw = (s - newW) / 2, dh = (s - newH) / 2;
  return { gain: r, padX: round(dw - 0.1), padY: round(dh - 0.1), imageWidth: w, imageHeight: h, scaledWidth: newW, scaledHeight: newH };
}

export const NUM_KEYPOINTS = 17;

/** values — выход сети подряд (канал-major): values[c * count + i]. */
export function decodePose(
  values: Float32Array,
  channels: number,
  count: number,
  lb: Letterbox,
  confThreshold = 0.35,
  iouThreshold = 0.7,
  maxDetections = 300,
): { detections: RawDetection[]; maxScore: number } {
  if (channels < 5 + NUM_KEYPOINTS * 3) throw new Error(`Неожиданный выход модели: ${channels} каналов`);
  // 1. Кандидаты выше порога
  let candidates: { score: number; i: number }[] = [];
  let maxScore = 0;
  for (let i = 0; i < count; i++) {
    const s = values[4 * count + i];
    if (s > maxScore) maxScore = s;
    if (s > confThreshold) candidates.push({ score: s, i });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length > 30000) candidates = candidates.slice(0, 30000);

  // 2. Рамки в координатах входа сети
  const box = (i: number): Box => {
    const cx = values[i], cy = values[count + i], w = values[2 * count + i], h = values[3 * count + i];
    return { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
  };

  // 3. NMS (жадный, как torchvision.ops.nms)
  const kept: { score: number; i: number; box: Box }[] = [];
  for (const c of candidates) {
    const b = box(c.i);
    if (kept.some((k) => iou(k.box, b) > iouThreshold)) continue;
    kept.push({ score: c.score, i: c.i, box: b });
    if (kept.length >= maxDetections) break;
  }

  // 4. Обратно в пиксели кадра, с обрезкой по кадру
  const W = lb.imageWidth, H = lb.imageHeight;
  const cx = (v: number) => Math.min(Math.max(v, 0), W);
  const cy = (v: number) => Math.min(Math.max(v, 0), H);
  const detections = kept.map((k) => {
    const b = k.box;
    const ob: Box = {
      x1: cx((b.x1 - lb.padX) / lb.gain), y1: cy((b.y1 - lb.padY) / lb.gain),
      x2: cx((b.x2 - lb.padX) / lb.gain), y2: cy((b.y2 - lb.padY) / lb.gain),
    };
    const kps: Keypoint[] = [];
    for (let n = 0; n < NUM_KEYPOINTS; n++) {
      const base = 5 + n * 3;
      kps.push({
        x: cx((values[base * count + k.i] - lb.padX) / lb.gain),
        y: cy((values[(base + 1) * count + k.i] - lb.padY) / lb.gain),
        conf: values[(base + 2) * count + k.i],
      });
    }
    return { box: ob, score: k.score, keypoints: kps };
  });
  return { detections, maxScore };
}
