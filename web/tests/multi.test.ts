// Пилот на нескольких камерах: чувствительность камеры и пороги подсчёта (как DetectionFilter.swift на Mac).
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/engine/config";
import { channelAnalyticsConfig, newChannelConfig } from "../src/multi/channel";
import { applyFilterToConfig, defaultFilter, filterDetections, filterSummary, isDefaultFilter, minConfidence } from "../src/multi/filter";

const det = (score: number, h: number) => ({ box: { x1: 0, y1: 100, x2: 50, y2: 100 + h }, score, keypoints: [] });

describe("чувствительность камеры", () => {
  it("по умолчанию — «низкая», как на Mac: уверенность от 55%, в кадре дольше секунды", () => {
    const f = defaultFilter();
    expect(isDefaultFilter(f)).toBe(true);
    expect(filterSummary(f)).toBe("низкая (по умолчанию)");
    expect(minConfidence(f)).toBe(0.55);
    expect(minConfidence({ ...f, level: 6 })).toBe(0.9);
    const c = applyFilterToConfig(defaultConfig(), f);
    expect(c.tracking.minTrackSeconds).toBe(1.2);
    expect(c.look.minLookSeconds).toBe(defaultConfig().look.minLookSeconds);
  });

  it("уровень задаёт уверенность нейросети, рост — минимальную фигуру", () => {
    const f = { level: 3, minHeightPercent: 20, behavior: 1 };
    expect(minConfidence(f)).toBe(0.55);
    const kept = filterDetections([det(0.9, 300), det(0.5, 300), det(0.9, 100)], f, 1080);
    expect(kept).toHaveLength(1); // 0.5 < 0.55, 100 px < 20% от 1080
    expect(filterSummary(f)).toBe("рост ≥ 20%");
  });

  it("строгость поведения меняет пороги «посмотрел / притормозил»", () => {
    const strict = applyFilterToConfig(defaultConfig(), { ...defaultFilter(), behavior: 2 });
    expect(strict.look.minLookSeconds).toBe(1.0);
    expect(strict.slowdown.minSlowSeconds).toBe(1.6);
    const soft = applyFilterToConfig(defaultConfig(), { ...defaultFilter(), behavior: 0 });
    expect(soft.look.maxYaw).toBe(0.45);
  });

  it("у камеры свои разметка и сторона витрины", () => {
    const c = newChannelConfig({ direction: "left" });
    c.markup.lineEnabled = false;
    const cfg = channelAnalyticsConfig(c);
    expect(cfg.countLineEnabled).toBe(false);
    expect(cfg.look.showcaseDirection).toBe("left");
    expect(newChannelConfig().id).not.toBe(newChannelConfig().id);
  });
});

describe("живой подсчёт: склейка треков и сотрудники (как LiveCameraEngine на Mac)", () => {
  it("человек, пропавший на секунду, возвращается под старым номером", async () => {
    const { TrackReID } = await import("../src/engine/reid");
    const r = new TrackReID();
    const box = (x: number) => ({ x1: x, y1: 100, x2: x + 60, y2: 300 });
    expect(r.identities([{ trackId: 1, box: box(100) }], 0)).toEqual([1]);
    expect(r.identities([], 0.5)).toEqual([]);
    // трекер выдал новый номер 7 рядом с местом пропажи
    expect(r.identities([{ trackId: 7, box: box(115) }], 1.2)).toEqual([1]);
    expect(r.merged).toBe(1);
    // далеко и не похож — это другой человек
    expect(r.identities([{ trackId: 7, box: box(115) }, { trackId: 9, box: box(900) }], 1.3)).toEqual([1, 9]);
  });

  it("небольшое уменьшение счётчиков — сняли сотрудника — вычитается из часов", async () => {
    const { liveDelta } = await import("../src/pilot/hours");
    const a = { people: 5, looked: 2, slowed: 2, passed: 3, entered: 0, seconds: 0 };
    expect(liveDelta(a, { ...a, people: 4, looked: 1 })).toEqual({ people: -1, looked: -1, slowed: 0, passed: 0, entered: 0, seconds: 0 });
    expect(liveDelta(a, { ...a, people: 0 })).toBeNull(); // перезапуск
  });
});
