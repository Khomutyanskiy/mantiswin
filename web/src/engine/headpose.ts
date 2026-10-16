// Оценка поворота головы по ключевым точкам COCO (нос, глаза, уши, плечи).
// Порт python/mantis/headpose.py и iOS HeadPose.swift.
//
// yaw — нормированное смещение носа относительно центра головы:
//   0 — лицо смотрит прямо в камеру; < 0 — нос смещён влево по кадру; > 0 — вправо;
//   null — лица не видно (человек спиной / точки ненадёжны).

/** Ключевая точка: x, y в пикселях кадра и уверенность (видимость) 0..1. */
export interface Keypoint {
  x: number;
  y: number;
  conf: number;
}

export type ShowcaseDirection = "camera" | "left" | "right";

export interface HeadPose {
  faceVisible: boolean;
  bothEyes: boolean;
  yaw: number | null;
}

const NOSE = 0, L_EYE = 1, R_EYE = 2, L_EAR = 3, R_EAR = 4, L_SHOULDER = 5, R_SHOULDER = 6;

export function estimateHeadPose(k: Keypoint[] | null | undefined, minConf = 0.5): HeadPose {
  if (!k || k.length < 7) return { faceVisible: false, bothEyes: false, yaw: null };
  const ok = (i: number) => k[i].conf >= minConf;

  if (!ok(NOSE)) return { faceVisible: false, bothEyes: false, yaw: null };
  const noseX = k[NOSE].x;
  const bothEyes = ok(L_EYE) && ok(R_EYE);

  // Центр и полуширина головы: уши надёжнее всего, затем глаза, затем плечи.
  let center: number | null = null;
  let halfW: number | null = null;
  if (ok(L_EAR) && ok(R_EAR)) {
    center = (k[L_EAR].x + k[R_EAR].x) / 2;
    halfW = Math.abs(k[L_EAR].x - k[R_EAR].x) / 2;
  } else if (bothEyes) {
    center = (k[L_EYE].x + k[R_EYE].x) / 2;
    halfW = Math.abs(k[L_EYE].x - k[R_EYE].x); // межглазное ~ половина ширины головы
  } else if (ok(L_SHOULDER) && ok(R_SHOULDER)) {
    center = (k[L_SHOULDER].x + k[R_SHOULDER].x) / 2;
    halfW = Math.abs(k[L_SHOULDER].x - k[R_SHOULDER].x) / 4;
  }

  if (center === null || halfW === null || halfW < 1e-3) {
    // Видно нос и одно ухо => голова в профиль. Направление — по тому, с какой стороны ухо.
    const ear = ok(L_EAR) ? L_EAR : ok(R_EAR) ? R_EAR : null;
    if (ear === null) return { faceVisible: true, bothEyes, yaw: null };
    return { faceVisible: true, bothEyes, yaw: noseX > k[ear].x ? 1 : -1 };
  }

  const yaw = Math.max(-1, Math.min(1, (noseX - center) / halfW));
  return { faceVisible: true, bothEyes, yaw };
}

/** Смотрит ли человек в сторону витрины. */
export function isLooking(pose: HeadPose, direction: ShowcaseDirection, maxYaw: number, minSideYaw: number): boolean {
  if (!pose.faceVisible || pose.yaw === null) return false;
  switch (direction) {
    case "camera":
      return pose.bothEyes && Math.abs(pose.yaw) <= maxYaw;
    case "left":
      return pose.yaw <= -minSideYaw;
    case "right":
      return pose.yaw >= minSideYaw;
  }
}
