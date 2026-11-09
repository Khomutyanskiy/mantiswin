// «Склейка» треков — порт TrackReID.swift (macOS): трекер иногда теряет человека на секунду-другую
// (закрылся, отвернулся, нейросеть засомневалась) и потом выдаёт ему новый номер — и счётчик прибавлял лишнего.
// Если новый трек появился рядом с местом, где недавно пропал прежний, и рамка похожего размера —
// считаем, что это тот же человек, и отдаём старый номер.

import type { Box } from "./geometry";

/** Сколько секунд после пропажи человек может «вернуться» под старым номером. */
export const REID_WINDOW = 5;

export class TrackReID {
  /** Номер трекера → номер человека. */
  private alias = new Map<number, number>();
  /** Последняя рамка каждого человека, которого видели в прошлом кадре. */
  private lastBox = new Map<number, Box>();
  private lost = new Map<number, { box: Box; lostAt: number }>();
  /** Сколько раз склеили (для диагностики). */
  merged = 0;

  reset(): void {
    this.alias.clear();
    this.lastBox.clear();
    this.lost.clear();
    this.merged = 0;
  }

  /** Номер человека для каждого трека кадра (в том же порядке). */
  identities(tracks: { trackId: number; box: Box }[], t: number): number[] {
    for (const [id, l] of this.lost) if (t - l.lostAt > REID_WINDOW) this.lost.delete(id);
    const used = new Set<number>();
    const out: number[] = [];
    for (const tr of tracks) {
      const known = this.alias.get(tr.trackId);
      if (known !== undefined) {
        out.push(known);
        used.add(known);
        continue;
      }
      // новый номер трекера: ищем пропавшего рядом
      let best: { id: number; score: number } | null = null;
      for (const [id, l] of this.lost) {
        if (used.has(id)) continue;
        const s = similarity(l.box, tr.box, t - l.lostAt);
        if (s > 0 && s > (best?.score ?? 0)) best = { id, score: s };
      }
      const id = best?.id ?? tr.trackId;
      if (best) {
        this.lost.delete(id);
        this.merged += 1;
      }
      this.alias.set(tr.trackId, id);
      out.push(id);
      used.add(id);
    }
    // кто был в прошлом кадре, а сейчас нет — в пропавшие
    const now = new Map<number, Box>();
    out.forEach((id, i) => {
      if (!now.has(id)) now.set(id, tracks[i].box);
    });
    for (const [id, box] of this.lastBox) if (!now.has(id)) this.lost.set(id, { box, lostAt: t });
    this.lastBox = now;
    if (this.alias.size > 2000) {
      // долгий мониторинг: старые номера трекера не нужны
      const live = new Set(tracks.map((x) => x.trackId));
      for (const [k, v] of this.alias) if (!live.has(k) && !this.lost.has(v)) this.alias.delete(k);
    }
    return out;
  }
}

/** Похожесть пропавшей рамки и новой: близко по месту и похожего размера; 0 — не он. */
function similarity(a: Box, b: Box, gap: number): number {
  const ax = (a.x1 + a.x2) / 2, ay = (a.y1 + a.y2) / 2;
  const bx = (b.x1 + b.x2) / 2, by = (b.y1 + b.y2) / 2;
  const ah = a.y2 - a.y1, aw = a.x2 - a.x1, bh = b.y2 - b.y1;
  const size = Math.max(aw, ah, 1);
  const dist = Math.hypot(ax - bx, ay - by) / size;
  // за время пропажи человек мог сдвинуться — чем дольше пропажа, тем дальше допускаем
  const allowed = 0.6 + 0.25 * gap;
  if (dist > allowed) return 0;
  const hRatio = bh / Math.max(ah, 1);
  if (hRatio <= 0.6 || hRatio >= 1.65) return 0;
  return 1 - dist / allowed + (1 - Math.abs(1 - hRatio));
}
