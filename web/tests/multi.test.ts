// Пилот на нескольких камерах: чувствительность камеры и пороги подсчёта (как DetectionFilter.swift на Mac).
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/engine/config";
import { channelAnalyticsConfig, newChannelConfig } from "../src/multi/channel";
import { applyFilterToConfig, defaultFilter, filterDetections, filterSummary, isDefaultFilter, minConfidence } from "../src/multi/filter";

const det = (score: number, h: number) => ({ box: { x1: 0, y1: 100, x2: 50, y2: 100 + h }, score, keypoints: [] });

describe("чувствительность камеры", () => {
  it("стандартная не меняет пороги подсчёта", () => {
    const f = defaultFilter();
    expect(isDefaultFilter(f)).toBe(true);
    expect(filterSummary(f)).toBe("стандартная");
    const c = applyFilterToConfig(defaultConfig(), f);
    expect(c.tracking.minTrackSeconds).toBe(0.5);
    expect(c.look.minLookSeconds).toBe(defaultConfig().look.minLookSeconds);
  });

  it("уровень задаёт уверенность нейросети, рост — минимальную фигуру", () => {
    const f = { level: 3, minHeightPercent: 20, behavior: 1 };
    expect(minConfidence(f)).toBe(0.55);
    const kept = filterDetections([det(0.9, 300), det(0.5, 300), det(0.9, 100)], f, 1080);
    expect(kept).toHaveLength(1); // 0.5 < 0.55, 100 px < 20% от 1080
    expect(filterSummary(f)).toBe("низкая · рост ≥ 20%");
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
