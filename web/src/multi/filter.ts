// Чувствительность камеры: что считать человеком, а что — ложным срабатыванием.
// Порт DetectionFilter.swift и отбора в LiveCameraEngine.swift (macOS): уровень, минимальный рост,
// зоны исключения, неподвижные фигуры, строгость «посмотрел / притормозил», режим проверки с причинами.
// Применяется между нейросетью и трекером (и после трекера — для неподвижных), у каждой камеры пилота — своя.

import type { RawDetection } from "../engine/bytetrack";
import type { AnalyticsConfig } from "../engine/config";
import { type Box, type Pt, iou, pointInPolygon, toPixels } from "../engine/geometry";

export interface DetectionFilter {
  /** 0 — максимальная чувствительность … 6 — очень строгая (уверенность от 90%). По умолчанию — 3, «низкая». */
  level: number;
  /** Минимальный рост фигуры в % от высоты кадра; 0 — не ограничивать. */
  minHeightPercent: number;
  /** Строгость «посмотрел / притормозил»: 0 — мягкая, 1 — обычная, 2 — строгая. */
  behavior: number;
  /** Зоны исключения (в долях кадра): всё, чей центр внутри, не считается. */
  exclusions?: Pt[][];
  /** Не считать фигуры, которые долго стоят на месте (манекены, плакаты). */
  ignoreStatic?: boolean;
  staticMinutes?: number;
  /** Сотрудники: человек в кадре дольше staffMinutes — продавец, его не считаем (и снимаем уже засчитанное). */
  excludeStaff?: boolean;
  staffMinutes?: number;
}

/** Уровень по умолчанию — «Низкая»: считаем только тех, в ком нейросеть уверена (как на Mac). */
export const DEFAULT_LEVEL = 3;
export const MAX_LEVEL = 6;

export const defaultFilter = (): DetectionFilter => ({
  level: DEFAULT_LEVEL, minHeightPercent: 0, behavior: 1, exclusions: [], ignoreStatic: false, staticMinutes: 3,
  excludeStaff: true, staffMinutes: 10,
});

/** Старые настройки (без новых полей) → полные. */
export const normalizeFilter = (f: Partial<DetectionFilter> | null | undefined): DetectionFilter => {
  const d = defaultFilter();
  const v = { ...d, ...(f ?? {}) };
  v.exclusions = Array.isArray(v.exclusions) ? v.exclusions.filter((z) => Array.isArray(z) && z.length >= 3) : [];
  v.staticMinutes = Number.isFinite(v.staticMinutes) ? Math.min(15, Math.max(1, v.staticMinutes!)) : 3;
  v.ignoreStatic = !!v.ignoreStatic;
  v.excludeStaff = v.excludeStaff !== false;
  v.staffMinutes = Number.isFinite(v.staffMinutes) ? Math.min(60, Math.max(2, v.staffMinutes!)) : 10;
  return v;
};

export const LEVEL_TITLES = ["Максимальная", "Стандартная", "Сниженная", "Низкая", "Минимальная", "Строгая", "Очень строгая"];
export const LEVEL_HINTS = [
  "Ловит всех, даже плохо видимых. Возможны ложные срабатывания.",
  "Ловит почти всех; бывают срабатывания на отражения и плакаты.",
  "Нужна уверенность нейросети выше, фигура должна продержаться дольше.",
  "По умолчанию: только те, в ком нейросеть уверена, и кто пробыл в кадре больше секунды. Отражения, плакаты и мелькания у края кадра не считаются.",
  "Только чётко видимые люди, которые пробыли в кадре 2 секунды и дольше.",
  "Нейросеть почти уверена (от 75%). Для сцен с манекенами, плакатами и зеркалами; далёких и закрытых людей может пропускать.",
  "Только когда нейросеть уверена от 90% — человек виден целиком и чётко. Ложных почти нет, но часть людей не засчитается.",
];
export const BEHAVIOR_TITLES = ["Мягкая", "Обычная", "Строгая"];
export const BEHAVIOR_HINTS = [
  "Засчитывает короткий взгляд (0,4 с) и лёгкое замедление.",
  "Взгляд от 0,6 с, замедление от 1 с — как по умолчанию.",
  "Только явный взгляд (от 1 с, голова прямо к витрине) и заметная остановка.",
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
const lv = (f: DetectionFilter) => clamp(f.level ?? DEFAULT_LEVEL, 0, MAX_LEVEL);
const bh = (f: DetectionFilter) => clamp(f.behavior ?? 1, 0, 2);

/** Минимальная уверенность нейросети. */
export const minConfidence = (f: DetectionFilter) => [0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.9][lv(f)];
/** Сколько секунд фигура должна пробыть в зоне, чтобы её посчитали. */
export const minTrackSeconds = (f: DetectionFilter) => [0.3, 0.5, 0.8, 1.2, 2.0, 2.0, 2.0][lv(f)];

/** Минуты «сотрудника» или null, если сотрудников считаем. */
export const staffMinutesOf = (f: DetectionFilter): number | null => (f.excludeStaff === false ? null : f.staffMinutes ?? 10);

export function isDefaultFilter(f: DetectionFilter): boolean {
  return lv(f) === DEFAULT_LEVEL && !(f.minHeightPercent > 0) && bh(f) === 1 && !(f.exclusions?.length) && !f.ignoreStatic
    && f.excludeStaff !== false && (f.staffMinutes ?? 10) === 10;
}

/** Короткое описание для карточки камеры. */
export function filterSummary(f: DetectionFilter): string {
  const parts: string[] = [];
  if (lv(f) !== DEFAULT_LEVEL) parts.push(LEVEL_TITLES[lv(f)].toLowerCase());
  if (f.minHeightPercent > 0) parts.push(`рост ≥ ${Math.round(f.minHeightPercent)}%`);
  if (f.exclusions?.length) parts.push(`исключений: ${f.exclusions.length}`);
  if (f.ignoreStatic) parts.push("без неподвижных");
  if (f.excludeStaff === false) parts.push("сотрудники считаются");
  if (bh(f) !== 1) parts.push(`поведение: ${BEHAVIOR_TITLES[bh(f)].toLowerCase()}`);
  return parts.length ? parts.join(" · ") : "низкая (по умолчанию)";
}

/** Пороги подсчёта с учётом строгости поведения и уровня. */
export function applyFilterToConfig(cfg: AnalyticsConfig, f: DetectionFilter): AnalyticsConfig {
  const c: AnalyticsConfig = structuredClone(cfg);
  c.tracking.minTrackSeconds = minTrackSeconds(f);
  if (bh(f) === 0) {
    c.look.minLookSeconds = 0.4;
    c.look.maxYaw = 0.45;
    c.slowdown.minSlowSeconds = 0.6;
    c.slowdown.speedThreshold = 0.35;
  } else if (bh(f) === 2) {
    c.look.minLookSeconds = 1.0;
    c.look.maxYaw = 0.25;
    c.slowdown.minSlowSeconds = 1.6;
    c.slowdown.speedThreshold = 0.24;
  }
  return c;
}

/** Отбросить детекции ниже порога уверенности, слишком маленькие фигуры и всё в зонах исключения. */
export function filterDetections(dets: RawDetection[], f: DetectionFilter, frameHeight: number, frameWidth = 0): RawDetection[] {
  return new FilterRuntime().apply(dets, f, 0, frameWidth, frameHeight).kept;
}

/** Отброшенная детекция — для режима проверки. */
export interface RejectedBox {
  box: Box;
  reason: string;
}

/** Человек после трекера (минимум, нужный для отбора неподвижных). */
interface TrackedLike {
  trackId: number;
  box: Box;
}

/**
 * Состояние отбора у одной камеры: где стоят неподвижные фигуры, что отброшено на последнем кадре.
 * Как applyFilter / dropStatic в LiveCameraEngine.swift.
 */
export class FilterRuntime {
  /** Отброшенные на последнем кадре (только в режиме проверки). */
  rejected: RejectedBox[] = [];
  acceptedNow = 0;
  diagnostics = false;
  private anchors = new Map<number, { c: Pt; h: number; t: number }>();
  private staticTracks = new Set<number>();
  private spots: { box: Box; lastT: number }[] = [];
  private key = "";

  /** Места неподвижных фигур (пиксели кадра). */
  get staticSpots(): Box[] {
    return this.spots.map((s) => s.box);
  }

  /** Включили/выключили неподвижные или поменяли время — начать заново. */
  private sync(f: DetectionFilter): void {
    const k = `${!!f.ignoreStatic}|${f.staticMinutes ?? 3}`;
    if (k !== this.key) {
      this.key = k;
      this.reset();
    }
  }

  reset(): void {
    this.anchors.clear();
    this.staticTracks.clear();
    this.spots = [];
  }

  apply(raw: RawDetection[], f: DetectionFilter, t: number, W: number, H: number): { kept: RawDetection[]; rejected: RejectedBox[] } {
    this.sync(f);
    const kept: RawDetection[] = [];
    const rejected: RejectedBox[] = [];
    const minConf = minConfidence(f);
    const minH = f.minHeightPercent > 0 ? (f.minHeightPercent / 100) * H : 0;
    const zones = W > 0 ? (f.exclusions ?? []).filter((z) => z.length >= 3).map((z) => toPixels(z, W, H)) : [];
    this.spots = this.spots.filter((s) => t - s.lastT <= 600); // место пустует 10 минут — снова считаем
    for (const d of raw) {
      const b = d.box;
      const center = { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 };
      let spot: { box: Box; lastT: number } | undefined;
      if (d.score < minConf) rejected.push({ box: b, reason: `уверенность ${Math.round(d.score * 100)}%` });
      else if (minH > 0 && b.y2 - b.y1 < minH) rejected.push({ box: b, reason: "мала" });
      else if (zones.some((z) => pointInPolygon(center, z))) rejected.push({ box: b, reason: "зона исключения" });
      else if (f.ignoreStatic && (spot = this.spots.find((s) => iou(s.box, b) > 0.5))) {
        spot.lastT = t;
        rejected.push({ box: b, reason: "неподвижна" });
      } else kept.push(d);
    }
    this.rejected = this.diagnostics ? rejected : [];
    this.acceptedNow = kept.length;
    return { kept, rejected };
  }

  /**
   * Неподвижные фигуры: трек, который стоит на месте дольше staticMinutes, больше не учитывается,
   * а его место запоминается — следующие детекции там отбрасываются.
   */
  dropStatic<P extends TrackedLike>(people: P[], f: DetectionFilter, t: number): P[] {
    this.sync(f);
    if (!f.ignoreStatic) return people;
    const limit = (f.staticMinutes ?? 3) * 60;
    const out: P[] = [];
    for (const p of people) {
      if (this.staticTracks.has(p.trackId)) continue;
      const c = { x: (p.box.x1 + p.box.x2) / 2, y: (p.box.y1 + p.box.y2) / 2 };
      const h = Math.max(1, p.box.y2 - p.box.y1);
      const a = this.anchors.get(p.trackId);
      if (a && Math.hypot(c.x - a.c.x, c.y - a.c.y) <= 0.15 * a.h && Math.abs(h - a.h) <= 0.2 * a.h) {
        if (t - a.t >= limit) {
          this.staticTracks.add(p.trackId);
          this.spots.push({ box: p.box, lastT: t });
          continue;
        }
      } else this.anchors.set(p.trackId, { c, h, t });
      out.push(p);
    }
    return out;
  }

  /** Забыть ушедшие треки (память не растёт при долгой работе). */
  keepOnly(active: Iterable<number>): void {
    const keep = new Set(active);
    for (const id of [...this.anchors.keys()]) if (!keep.has(id)) this.anchors.delete(id);
    for (const id of [...this.staticTracks]) if (!keep.has(id)) this.staticTracks.delete(id);
  }
}

/** Неподвижные места → прямоугольные зоны исключения (в долях кадра, с запасом 10%). */
export function spotsToExclusions(spots: Box[], W: number, H: number): Pt[][] {
  return spots.map((b) => {
    const bw = b.x2 - b.x1, bh2 = b.y2 - b.y1, pad = 0.1;
    const x1 = Math.max(0, (b.x1 - pad * bw) / W), x2 = Math.min(1, (b.x2 + pad * bw) / W);
    const y1 = Math.max(0, (b.y1 - pad * bh2) / H), y2 = Math.min(1, (b.y2 + pad * bh2) / H);
    return [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
  });
}
