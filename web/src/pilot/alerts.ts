// Уведомления во время мониторинга — порт CameraAlerts.swift и FreezeProbe.swift (Mantis для Mac):
// камера не присылает кадры дольше N минут (и когда снова на связи), картинка застыла (зависла камера, закрыт
// объектив), много людей в зоне одной камеры, человек долго в зоне (очередь, ждёт продавца).
// Уведомления Windows (в приложении) или браузера — видно, даже если окно свёрнуто.

import { askNotifications, notify } from "../desktop";
import type { OverlayBox } from "../engine/session";
import type { Channel } from "../multi/channel";
import { prefBool, prefNum, setPref } from "../settings/prefs";

export const alertPrefs = {
  get enabled(): boolean {
    return prefBool("alerts.enabled", true);
  },
  set enabled(v: boolean) {
    setPref("alerts.enabled", v);
  },
  get minutes(): number {
    return Math.max(1, prefNum("alerts.minutes", 5));
  },
  set minutes(v: number) {
    setPref("alerts.minutes", Math.min(60, Math.max(1, Math.round(v))));
  },
  get freezeOn(): boolean {
    return prefBool("alerts.freeze", true);
  },
  set freezeOn(v: boolean) {
    setPref("alerts.freeze", v);
  },
  get crowdOn(): boolean {
    return prefBool("alerts.crowd", false);
  },
  set crowdOn(v: boolean) {
    setPref("alerts.crowd", v);
  },
  get crowdLimit(): number {
    return Math.max(2, prefNum("alerts.crowd.limit", 5));
  },
  set crowdLimit(v: number) {
    setPref("alerts.crowd.limit", Math.min(50, Math.max(2, Math.round(v))));
  },
  get waitOn(): boolean {
    return prefBool("alerts.wait", false);
  },
  set waitOn(v: boolean) {
    setPref("alerts.wait", v);
  },
  get waitMinutes(): number {
    return Math.max(1, prefNum("alerts.wait.minutes", 3));
  },
  set waitMinutes(v: number) {
    setPref("alerts.wait.minutes", Math.min(30, Math.max(1, Math.round(v))));
  },
};

/** Не повторять одно и то же пороговое уведомление чаще, чем раз в 10 минут. */
const COOLDOWN = 600_000;

/** «Застывшая» картинка: раз в 5 секунд сравниваем крошечную копию кадра с прошлой. */
class FreezeProbe {
  private last: Uint8Array | null = null;
  private lastSampleAt = 0;
  private lastChangeAt = performance.now();
  private c = new OffscreenCanvas(16, 9);
  private ctx = this.c.getContext("2d", { willReadFrequently: true })!;

  get frozenSeconds(): number {
    return this.last ? Math.max(0, (performance.now() - this.lastChangeAt) / 1000) : 0;
  }

  feed(shot: ImageBitmap): void {
    const now = performance.now();
    if (now - this.lastSampleAt < 5000) return;
    this.lastSampleAt = now;
    this.ctx.drawImage(shot, 0, 0, 16, 9);
    const px = this.ctx.getImageData(0, 0, 16, 9).data;
    const luma = new Uint8Array(144);
    for (let i = 0; i < 144; i++) luma[i] = (px[i * 4] * 3 + px[i * 4 + 1] * 6 + px[i * 4 + 2]) / 10;
    if (this.last) {
      let diff = 0;
      for (let i = 0; i < 144; i++) diff += Math.abs(luma[i] - this.last[i]);
      // шум матрицы живой камеры даёт хоть немного разницы; ровно ноль — картинка застыла
      if (diff / 144 > 0.6) this.lastChangeAt = now;
    } else this.lastChangeAt = now;
    this.last = luma;
  }
}

export class CameraAlerts {
  private freeze = new Map<string, FreezeProbe>();
  private boxes = new Map<string, OverlayBox[]>();
  private frozen = new Set<string>();
  private crowdSince = new Map<string, number>();
  private lastSent = new Map<string, number>();
  private firstSeen = new Map<string, Map<number, number>>();
  private offlineSince = new Map<string, number>();
  private notified = new Set<string>();

  /** Запуск мониторинга: начать с чистого листа (и спросить разрешение на уведомления). */
  begin(): void {
    this.freeze.clear();
    this.boxes.clear();
    this.frozen.clear();
    this.crowdSince.clear();
    this.lastSent.clear();
    this.firstSeen.clear();
    this.offlineSince.clear();
    this.notified.clear();
    if (alertPrefs.enabled || alertPrefs.freezeOn || alertPrefs.crowdOn || alertPrefs.waitOn) askNotifications();
  }

  /** Кадр камеры с результатом подсчёта. */
  frame(ch: Channel, shot: ImageBitmap, boxes: OverlayBox[] | null): void {
    let f = this.freeze.get(ch.id);
    if (!f) this.freeze.set(ch.id, (f = new FreezeProbe()));
    f.feed(shot);
    if (boxes) this.boxes.set(ch.id, boxes.filter((b) => b.inZone && !b.staff));
  }

  /** Раз в 10 секунд из цикла мониторинга. */
  check(channels: Channel[]): void {
    const now = Date.now();
    for (const ch of channels.filter((c) => c.isLive)) this.thresholds(ch, now);
    if (!alertPrefs.enabled) return;
    const minutes = alertPrefs.minutes;
    for (const ch of channels) {
      if (ch.isLive) {
        this.offlineSince.delete(ch.id);
        if (this.notified.delete(ch.id)) void notify("Камера снова на связи", `«${ch.title}» снова считает.`);
      } else {
        const since = this.offlineSince.get(ch.id) ?? now;
        this.offlineSince.set(ch.id, since);
        if (now - since >= minutes * 60_000 && !this.notified.has(ch.id)) {
          this.notified.add(ch.id);
          void notify("Камера не отвечает", `«${ch.title}» не присылает кадры ${minutes} мин. Подсчёт с неё не идёт.`);
        }
      }
    }
  }

  private thresholds(ch: Channel, now: number): void {
    const name = ch.title;
    if (alertPrefs.freezeOn) {
      const sec = this.freeze.get(ch.id)?.frozenSeconds ?? 0;
      if (sec >= alertPrefs.minutes * 60 && !this.frozen.has(ch.id)) {
        this.frozen.add(ch.id);
        void notify("Картинка камеры застыла", `«${name}»: изображение не меняется ${Math.floor(sec / 60)} мин. Возможно, камера зависла или закрыт объектив.`);
      } else if (sec < 10 && this.frozen.delete(ch.id)) {
        void notify("Картинка снова идёт", `«${name}» снова показывает живое изображение.`);
      }
    }
    const boxes = this.boxes.get(ch.id) ?? [];
    if (alertPrefs.crowdOn) {
      if (boxes.length >= alertPrefs.crowdLimit) {
        const since = this.crowdSince.get(ch.id) ?? now;
        this.crowdSince.set(ch.id, since);
        if (now - since >= 20_000 && this.fresh(`crowd.${ch.id}`, now)) {
          void notify(`Много людей: ${boxes.length}`, `«${name}»: в зоне ${boxes.length} чел. (порог ${alertPrefs.crowdLimit}).`);
        }
      } else this.crowdSince.delete(ch.id);
    }
    if (alertPrefs.waitOn) {
      const seen = this.firstSeen.get(ch.id) ?? new Map<number, number>();
      const ids = new Set(boxes.map((b) => b.trackId));
      for (const id of [...seen.keys()]) if (!ids.has(id)) seen.delete(id);
      for (const id of ids) if (!seen.has(id)) seen.set(id, now);
      this.firstSeen.set(ch.id, seen);
      const longest = Math.min(...seen.values());
      if (seen.size && now - longest >= alertPrefs.waitMinutes * 60_000 && this.fresh(`wait.${ch.id}`, now)) {
        void notify(`Человек ждёт больше ${alertPrefs.waitMinutes} мин`, `«${name}»: посетитель в зоне уже ${Math.floor((now - longest) / 60_000)} мин. Возможно, нужна помощь.`);
      }
    }
  }

  private fresh(key: string, now: number): boolean {
    const t = this.lastSent.get(key);
    if (t && now - t < COOLDOWN) return false;
    this.lastSent.set(key, now);
    return true;
  }
}
