// Сверка веб-движка с эталоном Python (tests/fixtures/golden.json — тот же файл, что в iOS-тестах).
// golden.json получен python/tools/make_golden.py: сырые детекции YOLO, треки ultralytics ByteTrack и итог Python.

import { describe, expect, it } from "vitest";
import { Analytics, type TrackedPerson } from "../src/engine/analytics";
import { ByteTracker, type RawDetection } from "../src/engine/bytetrack";
import { fromPythonConfig } from "../src/engine/config";
import { toPixels } from "../src/engine/geometry";
import type { Keypoint } from "../src/engine/headpose";
import golden from "./fixtures/golden.json";

interface GoldenFrame {
  t: number;
  raw: number[][];
  tracked: number[][];
}

const kps = (flat: number[]): Keypoint[] => {
  const out: Keypoint[] = [];
  for (let n = 0; n < 17; n++) out.push({ x: flat[3 * n], y: flat[3 * n + 1], conf: flat[3 * n + 2] });
  return out;
};

const g = golden as unknown as {
  width: number;
  height: number;
  config: Parameters<typeof fromPythonConfig>[0];
  expected: { passed: number; passed_forward: number; passed_backward: number; slowed: number; looked: number };
  expected_tracks: number;
  frames: GoldenFrame[];
};

const cfg = fromPythonConfig(g.config);
const W = g.width, H = g.height;
const newAnalytics = () =>
  new Analytics(cfg, toPixels(cfg.countLine, W, H), toPixels(cfg.showcaseZone, W, H), W, H);

const expectCounters = (a: Analytics) => {
  expect(a.counters).toEqual({
    passed: g.expected.passed,
    passedForward: g.expected.passed_forward,
    passedBackward: g.expected.passed_backward,
    slowed: g.expected.slowed,
    looked: g.expected.looked,
  });
  expect(a.finished.length).toBe(g.expected_tracks);
};

describe("эталон Python (golden.json)", () => {
  it("аналитика на треках ultralytics даёт те же счётчики", () => {
    const a = newAnalytics();
    for (const f of g.frames) {
      const people: TrackedPerson[] = f.tracked.map((r) => ({
        trackId: r[0],
        box: { x1: r[1], y1: r[2], x2: r[3], y2: r[4] },
        keypoints: kps(r.slice(5)),
      }));
      a.update(f.t, people);
    }
    a.closeAll();
    expectCounters(a);
  });

  it("ByteTrack из сырых детекций повторяет ID и рамки ultralytics", () => {
    const tracker = new ByteTracker();
    let frames = 0, idMismatch = 0, maxBoxErr = 0;
    for (const f of g.frames) {
      const raw: RawDetection[] = f.raw.map((r) => ({
        box: { x1: r[0], y1: r[1], x2: r[2], y2: r[3] },
        score: r[4],
        keypoints: kps(r.slice(5)),
      }));
      const out = tracker.update(raw, W, H).sort((a, b) => a.trackId - b.trackId);
      const exp = [...f.tracked].sort((a, b) => a[0] - b[0]);
      frames++;
      if (out.map((o) => o.trackId).join() !== exp.map((e) => e[0]).join()) {
        idMismatch++;
        continue;
      }
      out.forEach((o, i) => {
        const e = exp[i];
        maxBoxErr = Math.max(maxBoxErr, Math.abs(o.box.x1 - e[1]), Math.abs(o.box.y1 - e[2]), Math.abs(o.box.x2 - e[3]), Math.abs(o.box.y2 - e[4]));
      });
    }
    expect(frames).toBe(g.frames.length);
    expect(idMismatch).toBe(0);
    // эталон округлён до 0,1 px
    expect(maxBoxErr).toBeLessThan(0.5);
  });

  it("полный путь: сырые детекции → ByteTrack → аналитика = итог Python", () => {
    const tracker = new ByteTracker();
    const a = newAnalytics();
    for (const f of g.frames) {
      const raw: RawDetection[] = f.raw.map((r) => ({
        box: { x1: r[0], y1: r[1], x2: r[2], y2: r[3] },
        score: r[4],
        keypoints: kps(r.slice(5)),
      }));
      const out = tracker.update(raw, W, H);
      a.update(f.t, out.map((o) => ({ trackId: o.trackId, box: o.box, keypoints: raw[o.detIndex].keypoints })));
    }
    a.closeAll();
    expectCounters(a);
  });
});
