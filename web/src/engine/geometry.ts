// Геометрические примитивы: линия подсчёта и зона витрины.
// Порт python/mantis/geometry.py и iOS Geometry.swift — формулы и порядок операций совпадают.

export interface Pt {
  x: number;
  y: number;
}

/** Прямоугольник x1, y1, x2, y2 в пикселях кадра (y вниз). */
export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export const pt = (x: number, y: number): Pt => ({ x, y });

/** С какой стороны от прямой AB лежит точка P: +1, -1 или 0 (на линии). */
export function sideOfLine(p: Pt, a: Pt, b: Pt): number {
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (cross > 0) return 1;
  if (cross < 0) return -1;
  return 0;
}

/** Пересекает ли отрезок движения P1→P2 отрезок линии AB (а не её продолжение). */
export function segmentsIntersect(p1: Pt, p2: Pt, a: Pt, b: Pt): boolean {
  const d1 = sideOfLine(p1, a, b);
  const d2 = sideOfLine(p2, a, b);
  const d3 = sideOfLine(a, p1, p2);
  const d4 = sideOfLine(b, p1, p2);
  return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0;
}

/** Ray casting: лежит ли точка внутри многоугольника. */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  const n = poly.length;
  if (n === 0) return false;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (yi > p.y !== yj > p.y) {
      const xCross = ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
      if (p.x < xCross) inside = !inside;
    }
    j = i;
  }
  return inside;
}

/** Площадь многоугольника (формула шнурования). */
export function polygonArea(poly: Pt[]): number {
  const n = poly.length;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** Перевод координат из долей кадра (0..1) в пиксели. */
export function toPixels(points: Pt[], width: number, height: number): Pt[] {
  return points.map((p) => pt(p.x * width, p.y * height));
}

/** IoU двух прямоугольников (как ultralytics bbox_ioa(iou=True), eps = 1e-7). */
export function iou(a: Box, b: Box): number {
  const iw = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const ih = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = iw * ih;
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return inter / (areaA + areaB - inter + 1e-7);
}

/** Медиана как в Python statistics.median. */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n % 2 === 1) return s[(n - 1) / 2];
  return (s[n / 2 - 1] + s[n / 2]) / 2;
}
