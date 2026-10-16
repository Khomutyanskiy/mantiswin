// Параметры подсчёта. Значения по умолчанию совпадают с python/config.example.yaml и iOS AnalyticsConfig.

import type { Pt } from "./geometry";
import type { ShowcaseDirection } from "./headpose";

export interface AnalyticsConfig {
  /** Считать ли проходы через линию. */
  countLineEnabled: boolean;
  /** Линия подсчёта в долях кадра (0..1). */
  countLine: Pt[];
  /** Зона перед витриной в долях кадра (0..1). */
  showcaseZone: Pt[];
  slowdown: {
    /** Скорость в «ростах человека в секунду», ниже которой человек «тормозит». */
    speedThreshold: number;
    /** Столько секунд суммарно медленно в зоне => «притормозил». */
    minSlowSeconds: number;
    /** Или столько секунд в зоне в целом => тоже «притормозил». */
    dwellSeconds: number;
    smoothingSeconds: number;
    /** Фокусное в долях длинной стороны кадра — для учёта движения к камере. */
    focalRatio: number;
    depthWindowSeconds: number;
    /** Правило «долго в зоне» — только если зона нарисована (не весь кадр). */
    dwellOnlyWithZone: boolean;
  };
  look: {
    showcaseDirection: ShowcaseDirection;
    maxYaw: number;
    minSideYaw: number;
    minLookSeconds: number;
    minKeypointConf: number;
  };
  tracking: {
    lostTimeoutSeconds: number;
    minTrackSeconds: number;
  };
}

export function defaultConfig(): AnalyticsConfig {
  return {
    countLineEnabled: true,
    countLine: [{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }],
    showcaseZone: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    slowdown: {
      speedThreshold: 0.3,
      minSlowSeconds: 1.0,
      dwellSeconds: 8.0,
      smoothingSeconds: 0.5,
      focalRatio: 0.8,
      depthWindowSeconds: 1.0,
      dwellOnlyWithZone: true,
    },
    look: { showcaseDirection: "camera", maxYaw: 0.35, minSideYaw: 0.35, minLookSeconds: 0.6, minKeypointConf: 0.5 },
    tracking: { lostTimeoutSeconds: 2.0, minTrackSeconds: 0.5 },
  };
}

type Pair = [number, number];

/** Конфиг в формате Python/golden.json (snake_case, точки как [x, y]) → AnalyticsConfig. */
export function fromPythonConfig(c: {
  count_line?: Pair[];
  showcase_zone?: Pair[];
  slowdown?: Record<string, number | boolean>;
  look?: Record<string, number | string>;
  tracking?: Record<string, number>;
}): AnalyticsConfig {
  const d = defaultConfig();
  const pts = (a?: Pair[]) => a?.map(([x, y]) => ({ x, y }));
  const sd = c.slowdown ?? {}, lk = c.look ?? {}, tr = c.tracking ?? {};
  return {
    countLineEnabled: true,
    countLine: pts(c.count_line) ?? d.countLine,
    showcaseZone: pts(c.showcase_zone) ?? d.showcaseZone,
    slowdown: {
      speedThreshold: (sd.speed_threshold as number) ?? d.slowdown.speedThreshold,
      minSlowSeconds: (sd.min_slow_seconds as number) ?? d.slowdown.minSlowSeconds,
      dwellSeconds: (sd.dwell_seconds as number) ?? d.slowdown.dwellSeconds,
      smoothingSeconds: (sd.smoothing_seconds as number) ?? d.slowdown.smoothingSeconds,
      focalRatio: (sd.focal_ratio as number) ?? d.slowdown.focalRatio,
      depthWindowSeconds: (sd.depth_window_seconds as number) ?? d.slowdown.depthWindowSeconds,
      dwellOnlyWithZone: (sd.dwell_only_with_zone as boolean) ?? d.slowdown.dwellOnlyWithZone,
    },
    look: {
      showcaseDirection: (lk.showcase_direction as ShowcaseDirection) ?? d.look.showcaseDirection,
      maxYaw: (lk.max_yaw as number) ?? d.look.maxYaw,
      minSideYaw: (lk.min_side_yaw as number) ?? d.look.minSideYaw,
      minLookSeconds: (lk.min_look_seconds as number) ?? d.look.minLookSeconds,
      minKeypointConf: (lk.min_keypoint_conf as number) ?? d.look.minKeypointConf,
    },
    tracking: {
      lostTimeoutSeconds: tr.lost_timeout_seconds ?? d.tracking.lostTimeoutSeconds,
      minTrackSeconds: tr.min_track_seconds ?? d.tracking.minTrackSeconds,
    },
  };
}
