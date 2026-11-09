// Экран не гаснет, пока идёт работа (мониторинг, демо, подсчёт с камеры) — важно на планшете у витрины.
// Screen Wake Lock API (Chrome/Android, Safari 16.4+, Edge). Браузер снимает блокировку, когда вкладку
// свернули, — при возвращении берём её снова. Где API нет (старый Safari), — запасной вариант: беззвучное
// видео из холста, которое играет по кругу (так экран тоже не засыпает).

type Sentinel = { released: boolean; release: () => Promise<void>; addEventListener: (t: "release", f: () => void) => void };

let want = false;
let lock: Sentinel | null = null;
let pending = false;
let fallback: { video: HTMLVideoElement; timer: number } | null = null;

const api = (): { request: (t: "screen") => Promise<Sentinel> } | null =>
  (navigator as unknown as { wakeLock?: { request: (t: "screen") => Promise<Sentinel> } }).wakeLock ?? null;

async function acquire(): Promise<void> {
  if (!want || document.visibilityState !== "visible" || pending) return;
  const wl = api();
  if (wl) {
    if (lock && !lock.released) return;
    pending = true;
    try {
      lock = await wl.request("screen");
      lock.addEventListener("release", () => {
        lock = null;
        // отпустили не мы (например, свернули вкладку) — возьмём снова, когда станет видно
        if (want) setTimeout(() => void acquire(), 1000);
      });
      if (!want) await release();
    } catch {
      // нет разрешения (не HTTPS, режим энергосбережения) — пробуем видео
      startFallback();
    } finally {
      pending = false;
    }
    return;
  }
  startFallback();
}

function startFallback(): void {
  if (fallback || !want) return;
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 2;
    const ctx = c.getContext("2d")!;
    const stream = (c as HTMLCanvasElement & { captureStream?: (fps: number) => MediaStream }).captureStream?.(1);
    if (!stream) return;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("aria-hidden", "true");
    video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;left:0;bottom:0;";
    video.srcObject = stream;
    document.body.append(video);
    let k = 0;
    const timer = window.setInterval(() => {
      ctx.fillStyle = k++ % 2 ? "#000" : "#010101"; // кадр меняется — видео «живое»
      ctx.fillRect(0, 0, 2, 2);
      if (video.paused) void video.play().catch(() => undefined);
    }, 1000);
    void video.play().catch(() => undefined);
    fallback = { video, timer };
  } catch {
    /* не вышло — экран будет гаснуть по настройкам устройства */
  }
}

async function release(): Promise<void> {
  const l = lock;
  lock = null;
  if (l && !l.released) await l.release().catch(() => undefined);
  if (fallback) {
    clearInterval(fallback.timer);
    fallback.video.srcObject = null;
    fallback.video.remove();
    fallback = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void acquire();
});
// на iOS видео-запасной вариант запускается только после касания
for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, () => want && void acquire(), { passive: true });

/** Не давать экрану гаснуть (true) или вернуть обычное поведение (false). */
export function keepAwake(on: boolean): void {
  if (on === want) return;
  want = on;
  if (on) void acquire();
  else void release();
}

/** Сейчас экран удерживается (для подсказки в интерфейсе). */
export const isKeptAwake = () => want && ((!!lock && !lock.released) || !!fallback);
