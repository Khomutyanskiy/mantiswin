// Mantis web: выбор видео или камеры → разметка → анализ с наложением → итоги.

import "@fontsource-variable/onest";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "./styles.css";

import { type AnalyticsEvent } from "./engine/analytics";
import { type AnalyticsConfig, defaultConfig } from "./engine/config";
import type { ShowcaseDirection } from "./engine/headpose";
import { type FrameResult, type OverlayBox, Session, type SessionReport } from "./engine/session";
import { Detector } from "./detector";
import {
  FULL_FRAME, HORIZONTAL_LINE, type Markup, VERTICAL_LINE, defaultMarkup, drawMarkup, drawPeople, handlePoints,
} from "./ui/draw";
import { type ReportContext, eventTitle, exportEvents, exportSummary, exportTracks, fmtTime, pct, renderReport } from "./ui/report";
import { Account } from "./cloud/account";
import { friendlyError, loadCameraHours, loadDevices, resetPassword, signIn, signOut, signUp } from "./cloud/firebase";
import { PILOT_FLAG, PilotRunner, type PilotStatus, listCameras } from "./pilot/runner";
import { type HourStat, addHours, emptyHour, hourKey } from "./pilot/hours";
import type { Metric } from "./pilot/business";
import { type CameraSeries, renderCameraTable, renderDevices, renderMetricChips, renderStats } from "./ui/stats";
import { type LiveSource, loadIpCamera, openIpCamera, openWebcam, saveIpCamera } from "./sources";
import { chooseIpCamera } from "./ui/ipcam";
import { desktopShell, isDesktop } from "./desktop";
import { MultiPilot } from "./multi/model";
import { newChannelConfig } from "./multi/channel";
import { type TwinView, mountTwin } from "./twin/view";
import { mountRecords } from "./twin/records";
import { mountMonitoring } from "./monitoring";
import { mountDemo } from "./demo";
import { mountCabinet } from "./cabinet/view";
import { keepAwake } from "./ui/wakelock";
import { TwinPublisher } from "./cloud/twinPublisher";
import { mountHelp, setNavigator } from "./ui/help";
import { mountAbout } from "./ui/about";
import { calibrationValid, floorPointsUntouched } from "./twin/plan";
import { type MultiView, mountMulti } from "./multi/view";
import { reports } from "./reports/store";
import { type DetailOptions, type ReportsCtx, lastReport as lastRunReport, mountReportsList, renderReportDetail } from "./reports/view";
import { renderCompare } from "./reports/compare";
import { download, hoursCsv, stamp as dayStamp } from "./reports/csv";
import { rowsFor, showcaseScore } from "./pilot/business";
import { deleteRecording, listRecordings, saveRecording } from "./twin/store";
import { channelColorIndex, channelShort } from "./multi/channel";
import type { RunEnd } from "./multi/model";
import { newReport, type ReportSummary as RunReport } from "./reports/store";
import { VideoStorage } from "./video/storage";
import { VideoRun } from "./video/run";
import { CameraAlerts } from "./pilot/alerts";
import { scheduleText, startSchedule, stoppedManually, schedulePrefs } from "./pilot/schedule";
import { onTrayCommand, trayStatus } from "./desktop";
import { applyAppearance, mountSettings } from "./settings/view";
import { openHeatmap } from "./video/heatmap";
import { mountTipBar } from "./settings/tips";
import { SAMPLE_CAMERAS, sample } from "./settings/sample";

applyAppearance();

// ---------------------------------------------------------------- элементы
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const stage = $("#stage");
const drop = $("#drop");
const canvas = $<HTMLCanvasElement>("#canvas");
const ctx = canvas.getContext("2d")!;
const stageMsg = $("#stage-msg");
const fileInput = $<HTMLInputElement>("#file");
const engine = $("#engine");
const engineText = $("#engine-text");
const timeline = $("#timeline");
const seek = $<HTMLInputElement>("#seek");
const timeLabel = $("#time");
const btnPlay = $<HTMLButtonElement>("#btn-play");
const legend = $("#legend");
const reportEl = $("#report");
const toastEl = $("#toast");
const cameraSelect = $<HTMLSelectElement>("#camera-select");
const layoutEl = $(".layout");
const statsEl = $("#stats");
const pilotIntro = $("#pilot-intro");

type Step = "source" | "markup" | "run" | "pilot";
function showStep(step: Step): void {
  document.querySelectorAll<HTMLElement>(".step").forEach((el) => (el.hidden = el.dataset.step !== step));
}

let toastTimer = 0;
function toast(text: string, error = false): void {
  toastEl.textContent = text;
  toastEl.classList.toggle("error", error);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), error ? 7000 : 3500);
}

function message(text: string | null): void {
  stageMsg.hidden = !text;
  stageMsg.textContent = text ?? "";
}

// ---------------------------------------------------------------- сохранённые настройки
// У проверки видео и у пилота своя разметка: это разные кадры
type Mode = "check" | "pilot";
const STORE_KEYS: Record<Mode, string> = { check: "mantis.web.v1", pilot: "mantis.pilot.v1" };
interface Saved {
  markup: Markup;
  direction: ShowcaseDirection;
  params: Record<string, number>;
  cameraId?: string;
}
let mode: Mode = "check";
function loadSaved(m: Mode = mode): Partial<Saved> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEYS[m]) ?? "{}") as Partial<Saved>;
  } catch {
    return {};
  }
}
function save(): void {
  try {
    const s: Saved = { markup, direction: direction(), params: readParams(), cameraId: cameraSelect.value || undefined };
    localStorage.setItem(STORE_KEYS[mode], JSON.stringify(s));
  } catch {
    /* хранилище недоступно — не страшно */
  }
}
/** Подставить сохранённые разметку и пороги режима в форму. */
function applySaved(m: Mode): void {
  const s = loadSaved(m);
  markup = s.markup?.zone?.length === 4 && s.markup.line?.length === 2 && s.markup.entrance?.length === 2 ? s.markup : defaultMarkup();
  const r = document.querySelector<HTMLInputElement>(`#direction input[value="${s.direction ?? "camera"}"]`);
  if (r) r.checked = true;
  const defaults: Record<string, number> = { speed: 0.3, slow: 1, dwell: 8, look: 0.6, yaw: 0.35, fps: 15 };
  const ids: Record<string, string> = { speed: "#p-speed", slow: "#p-slow", dwell: "#p-dwell", look: "#p-look", yaw: "#p-yaw", fps: "#p-fps" };
  for (const [k, id] of Object.entries(ids)) $<HTMLInputElement>(id).value = String(s.params?.[k] ?? defaults[k]);
}

// ---------------------------------------------------------------- состояние
type Source = { kind: "file"; video: HTMLVideoElement; name: string; url: string; file: File } | { kind: "live"; live: LiveSource };
/** Значение в списке камер пилота, означающее сохранённую IP-камеру. */
const IP_OPTION = "ip";
let source: Source | null = null;
let markup: Markup = defaultMarkup();
let detector: Detector | null = null;
let detectorLoading: Promise<Detector> | null = null;
let running = false;
let stopRequested = false;
let previewRaf = 0;
type Tab = "help" | "check" | "monitoring" | "demo" | "sites" | "stats" | "records" | "about" | "settings";
let currentTab: Tab = "check";
let pilot: PilotRunner | null = null;
let pilotStatus: PilotStatus | null = null;

/** Результаты по кадрам — для просмотра после анализа. */
interface StoredFrame {
  t: number;
  boxes: OverlayBox[];
}
let frames: StoredFrame[] = [];
let lastReport: ReportContext | null = null;
const numbers = new Map<number, number>();
const numberOf = (id: number) => numbers.get(id) ?? id;

// ---------------------------------------------------------------- нейросеть
function ensureDetector(): Promise<Detector> {
  if (detector) return Promise.resolve(detector);
  if (!detectorLoading) {
    engine.dataset.state = "loading";
    engineText.textContent = "Загружаю нейросеть…";
    detectorLoading = Detector.create((st) => {
      engineText.textContent = st;
      if (!stageMsg.hidden) message(st);
    })
      .then((d) => {
        detector = d;
        engine.dataset.state = "ready";
        engineText.textContent = `Нейросеть готова · ${d.backend}`;
        return d;
      })
      .catch((e: Error) => {
        detectorLoading = null;
        engine.dataset.state = "error";
        engineText.textContent = "Нейросеть не загрузилась";
        throw e;
      });
  }
  return detectorLoading;
}

/** Сбросить нейросеть (после сбоев) — следующий ensureDetector создаст новую. */
function resetDetector(): void {
  detector?.dispose();
  detector = null;
  detectorLoading = null;
}

// ---------------------------------------------------------------- источник: файл
async function openFile(file: File): Promise<void> {
  if (!file.type.startsWith("video/") && !/\.(mov|mp4|m4v|webm|mkv|avi)$/i.test(file.name)) {
    toast("Это не похоже на видео. Выберите файл MP4, MOV или WebM.", true);
    return;
  }
  closeSource();
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const url = URL.createObjectURL(file);
  video.src = url;
  message("Открываю видео…");
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("decode"));
    });
  } catch {
    URL.revokeObjectURL(url);
    message(null);
    toast("Браузер не смог открыть это видео. Откройте страницу в Chrome или Safari либо перекодируйте ролик в MP4 (H.264).", true);
    return;
  }
  source = { kind: "file", video, name: file.name, url, file };
  await seekTo(video, Math.min(0.5, (video.duration || 1) / 4));
  message(null);
  enterMarkup();
  ensureDetector().catch((e) => toast(`Не удалось загрузить нейросеть: ${e.message}`, true));
}

// ---------------------------------------------------------------- источник: камера
async function openCamera(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("Камера недоступна: браузер не даёт доступ к ней на этой странице.", true);
    return;
  }
  closeSource();
  const wanted = checkCameraId();
  try {
    source = { kind: "live", live: await openWebcam(wanted) };
  } catch {
    // сохранённую камеру отключили — берём любую
    try {
      source = { kind: "live", live: await openWebcam(null) };
    } catch {
      toast("Нет доступа к камере. Разрешите доступ в настройках браузера и попробуйте снова.", true);
      return;
    }
  }
  enterMarkup();
  void fillCheckCameras();
  ensureDetector().catch((e) => toast(`Не удалось загрузить нейросеть: ${e.message}`, true));
}

// Выбор камеры на проверке видео (встроенная, USB). Запоминается в браузере.
const checkCameraSelect = $<HTMLSelectElement>("#check-camera");
const CHECK_CAM_KEY = "mantis.check.camera";
function checkCameraId(): string | null {
  try {
    return localStorage.getItem(CHECK_CAM_KEY);
  } catch {
    return null;
  }
}
/** Список камер — после разрешения на камеру браузер отдаёт их названия. */
async function fillCheckCameras(): Promise<void> {
  const live = source?.kind === "live" ? source.live : null;
  const field = $("#check-camera-field");
  if (!live || live.kind !== "webcam") {
    field.hidden = true;
    return;
  }
  const cams = await listCameras().catch(() => [] as MediaDeviceInfo[]);
  const current = (live.video?.srcObject as MediaStream | null)?.getVideoTracks()[0]?.getSettings().deviceId ?? "";
  checkCameraSelect.replaceChildren(
    ...cams.map((c, i) => {
      const o = document.createElement("option");
      o.value = c.deviceId;
      o.textContent = c.label || `Камера ${i + 1}`;
      return o;
    }),
  );
  checkCameraSelect.value = current;
  field.hidden = cams.length < 2;
}
checkCameraSelect.addEventListener("change", async () => {
  const id = checkCameraSelect.value;
  try {
    localStorage.setItem(CHECK_CAM_KEY, id);
  } catch {
    /* нет */
  }
  closeSource();
  try {
    source = { kind: "live", live: await openWebcam(id) };
  } catch {
    toast("Эта камера не открылась. Проверьте, что она подключена и не занята другой программой.", true);
    try {
      source = { kind: "live", live: await openWebcam(null) };
    } catch {
      return;
    }
  }
  enterMarkup();
  void fillCheckCameras();
});
// Подключили или отключили камеру — обновим список
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  if (mode === "check" && source?.kind === "live") void fillCheckCameras();
  if (mode === "pilot" && !pilot) void fillCameras();
});

/** IP-камера для проверки: окно поиска и подключения, затем разметка. */
async function openIpForCheck(): Promise<void> {
  const r = await chooseIpCamera();
  if (!r) return;
  saveIpCamera(r.cfg);
  closeSource();
  source = { kind: "live", live: r.source };
  enterMarkup();
  ensureDetector().catch((e) => toast(`Не удалось загрузить нейросеть: ${e.message}`, true));
}

function closeSource(): void {
  cancelAnimationFrame(previewRaf);
  stopReplay();
  if (!source) return;
  if (source.kind === "live") source.live.close();
  else {
    URL.revokeObjectURL(source.url);
    source.video.removeAttribute("src");
  }
  source = null;
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-4 && video.readyState >= 2) {
      resolve();
      return;
    }
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    video.currentTime = t;
  });
}

// ---------------------------------------------------------------- разметка
let dragging: string | null = null;

function enterMarkup(): void {
  if (!source) return;
  running = false;
  drop.hidden = true;
  canvas.hidden = false;
  reportEl.hidden = true;
  timeline.hidden = true;
  legend.hidden = true;
  stage.classList.add("editing");
  canvas.width = source.kind === "live" ? source.live.width : source.video.videoWidth;
  canvas.height = source.kind === "live" ? source.live.height : source.video.videoHeight;
  showStep("markup");
  $("#btn-start").textContent = mode === "pilot" ? "Запустить пилот" : "Начать анализ";
  $("#btn-other").textContent = mode === "pilot" ? "Назад" : "Другое видео";
  $("#fps-field").hidden = mode === "pilot";
  if (mode !== "check" || source.kind !== "live" || source.live.kind !== "webcam") $("#check-camera-field").hidden = true;
  syncMarkupControls();
  renderPreview();
}

/** Последний кадр IP-камеры для предпросмотра разметки. */
let previewShot: ImageBitmap | null = null;
let previewBusy = false;

function renderPreview(): void {
  cancelAnimationFrame(previewRaf);
  if (!source) return;
  if (source.kind === "file") ctx.drawImage(source.video, 0, 0, canvas.width, canvas.height);
  else if (source.live.video) ctx.drawImage(source.live.video, 0, 0, canvas.width, canvas.height);
  else {
    // IP-камера: кадры приходят через мост — подтягиваем новый, рисуем последний
    const live = source.live;
    if (!previewBusy) {
      previewBusy = true;
      live
        .grab()
        .then((b) => {
          previewShot?.close();
          previewShot = b;
        })
        .catch(() => undefined)
        .finally(() => (previewBusy = false));
    }
    if (previewShot) ctx.drawImage(previewShot, 0, 0, canvas.width, canvas.height);
    else {
      ctx.fillStyle = "#0e1839";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }
  drawMarkup(ctx, markup, { handles: true, active: dragging });
  // у камеры кадр живой — перерисовываем постоянно
  if (source.kind === "live" && !running && stage.classList.contains("editing")) previewRaf = requestAnimationFrame(renderPreview);
}

function toNorm(e: PointerEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
}

canvas.addEventListener("pointerdown", (e) => {
  if (!stage.classList.contains("editing")) return;
  const p = toNorm(e);
  const r = canvas.getBoundingClientRect();
  let best: string | null = null;
  let bestD = 28; // css px
  for (const [id, h] of handlePoints(markup)) {
    const d = Math.hypot((h.x - p.x) * r.width, (h.y - p.y) * r.height);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  if (!best) return;
  dragging = best;
  canvas.setPointerCapture(e.pointerId);
  renderPreview();
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const p = toNorm(e);
  const m = /^(zone|line|entrance)(\d)$/.exec(dragging)!;
  const arr = markup[m[1] as "zone" | "line" | "entrance"];
  arr[Number(m[2])] = p;
  if (source?.kind === "file") renderPreview();
});
const endDrag = () => {
  if (!dragging) return;
  dragging = null;
  save();
  if (source?.kind === "file") renderPreview();
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

function syncMarkupControls(): void {
  $<HTMLInputElement>("#line-on").checked = markup.lineEnabled;
  $<HTMLInputElement>("#entrance-on").checked = markup.entranceEnabled;
  $("#line-actions").hidden = !markup.lineEnabled;
}

$("#zone-reset").addEventListener("click", () => {
  markup.zone = FULL_FRAME.map((p) => ({ ...p }));
  save();
  renderPreview();
});
$<HTMLInputElement>("#line-on").addEventListener("change", (e) => {
  markup.lineEnabled = (e.target as HTMLInputElement).checked;
  syncMarkupControls();
  save();
  renderPreview();
});
$<HTMLInputElement>("#entrance-on").addEventListener("change", (e) => {
  markup.entranceEnabled = (e.target as HTMLInputElement).checked;
  save();
  renderPreview();
});
document.querySelectorAll<HTMLButtonElement>("[data-line]").forEach((b) =>
  b.addEventListener("click", () => {
    markup.line = (b.dataset.line === "horizontal" ? HORIZONTAL_LINE : VERTICAL_LINE).map((p) => ({ ...p }));
    save();
    renderPreview();
  }),
);
$("#direction").addEventListener("change", save);
document.querySelectorAll<HTMLInputElement>(".grid-fields input").forEach((i) => i.addEventListener("change", save));

const direction = (): ShowcaseDirection =>
  ($<HTMLInputElement>('#direction input:checked')?.value as ShowcaseDirection) ?? "camera";

function readParams(): Record<string, number> {
  const num = (id: string, d: number) => {
    const v = parseFloat($<HTMLInputElement>(id).value.replace(",", "."));
    return isFinite(v) && v > 0 ? v : d;
  };
  return {
    speed: num("#p-speed", 0.3),
    slow: num("#p-slow", 1),
    dwell: num("#p-dwell", 8),
    look: num("#p-look", 0.6),
    yaw: num("#p-yaw", 0.35),
    fps: Math.round(Math.min(30, Math.max(5, num("#p-fps", 15)))),
  };
}

function buildConfig(): AnalyticsConfig {
  const c = defaultConfig();
  const p = readParams();
  c.countLineEnabled = markup.lineEnabled;
  c.countLine = markup.line.map((q) => ({ ...q }));
  c.showcaseZone = markup.zone.map((q) => ({ ...q }));
  c.slowdown.speedThreshold = p.speed;
  c.slowdown.minSlowSeconds = p.slow;
  c.slowdown.dwellSeconds = p.dwell;
  c.look.minLookSeconds = p.look;
  c.look.maxYaw = p.yaw;
  c.look.minSideYaw = p.yaw;
  c.look.showcaseDirection = direction();
  return c;
}

// ---------------------------------------------------------------- анализ
const cEls = {
  passed: $("#c-passed"), split: $("#c-split"), slowed: $("#c-slowed"), looked: $("#c-looked"), entered: $("#c-entered"),
  rSlowed: $("#r-slowed"), rLooked: $("#r-looked"), rEntered: $("#r-entered"),
};
const feed = $("#feed");
const progress = $("#progress");
const runStat = $("#run-stat");
const runTitle = $("#run-title");

function setCounters(f: Pick<FrameResult, "counters" | "entered">, entranceOn: boolean): void {
  const c = f.counters;
  const bump = (el: HTMLElement, v: number) => {
    if (el.textContent !== String(v)) {
      el.textContent = String(v);
      const card = el.parentElement!;
      card.classList.add("bump");
      setTimeout(() => card.classList.remove("bump"), 600);
    }
  };
  bump(cEls.passed, c.passed);
  cEls.split.textContent = `→ ${c.passedForward} · ← ${c.passedBackward}`;
  bump(cEls.slowed, c.slowed);
  bump(cEls.looked, c.looked);
  bump(cEls.entered, f.entered);
  cEls.rSlowed.textContent = pct(c.slowed, c.passed);
  cEls.rLooked.textContent = pct(c.looked, c.passed);
  cEls.rEntered.textContent = pct(f.entered, c.passed);
  $("#counter-entered").hidden = !entranceOn;
  $(".counters").classList.toggle("with-entered", entranceOn);
}

function pushFeed(events: AnalyticsEvent[]): void {
  for (const e of events) {
    const li = document.createElement("li");
    li.className = `k-${e.kind}`;
    const t = document.createElement("span");
    t.className = "mono";
    t.textContent = fmtTime(e.t);
    const b = document.createElement("b");
    b.textContent = `№ ${numberOf(e.trackId)} ${eventTitle(e)}`;
    const wrap = document.createElement("span");
    wrap.append(b);
    li.append(t, wrap);
    feed.prepend(li);
  }
  while (feed.children.length > 60) feed.lastElementChild!.remove();
}

/** Порядковые номера людей (как в iOS): только тем, кто был в зоне и продержался в кадре не меньше min_track_seconds. */
function assignNumbers(session: Session, t: number, boxes: OverlayBox[]): void {
  const minT = session.cfg.tracking.minTrackSeconds;
  for (const b of boxes) {
    if (numbers.has(b.trackId)) continue;
    const tr = session.analytics.tracks.get(b.trackId);
    if (tr && tr.everInZone && t - tr.firstT >= minT) numbers.set(b.trackId, numbers.size + 1);
  }
}

async function startAnalysis(): Promise<void> {
  if (!source || running) return;
  save();
  let det: Detector;
  try {
    message("Загружаю нейросеть…");
    det = await ensureDetector();
  } catch (e) {
    message(null);
    toast(`Не удалось загрузить нейросеть: ${(e as Error).message}`, true);
    return;
  }
  message(null);

  const src = source;
  if (!src) return;
  const cfg = buildConfig();
  const fps = readParams().fps;
  const W = src.kind === "live" ? src.live.width : src.video.videoWidth;
  const H = src.kind === "live" ? src.live.height : src.video.videoHeight;
  canvas.width = W;
  canvas.height = H;
  const entrance = markup.entranceEnabled ? markup.entrance : null;

  running = true;
  stopRequested = false;
  cancelAnimationFrame(previewRaf);
  stage.classList.remove("editing");
  stopReplay();
  frames = [];
  numbers.clear();
  feed.replaceChildren();
  reportEl.hidden = true;
  timeline.hidden = true;
  legend.hidden = false;
  showStep("run");
  $("#btn-stop").parentElement!.hidden = false;
  $("#done-actions").hidden = true;
  runTitle.textContent = src.kind === "live" ? `${src.live.kind === "ip" ? "IP-камера" : "Камера"} · идёт подсчёт` : "Анализ видео";
  progress.classList.toggle("live", src.kind === "live");
  setCounters({ counters: { passed: 0, passedForward: 0, passedBackward: 0, slowed: 0, looked: 0 }, entered: 0 }, !!entrance);

  const started = performance.now();
  let session: Session;
  let report: SessionReport;
  try {
    if (src.kind === "file") {
      session = new Session(cfg, W, H, entrance, fps);
      await runFile(det, session, src.video, fps);
    } else {
      session = new Session(cfg, W, H, entrance, 15, { reid: true, staffMinutes: 10, seenAfter: cfg.tracking.minTrackSeconds });
      await runCamera(det, session, src.live);
    }
    report = session.finish();
  } catch (e) {
    running = false;
    if (source !== src) return;
    toast(`Анализ прервался: ${(e as Error).message}`, true);
    enterMarkup();
    return;
  }
  running = false;
  if (source !== src) return; // пользователь ушёл на другое видео
  for (const t of report.tracks) if (t.everInZone && !numbers.has(t.trackId)) numbers.set(t.trackId, numbers.size + 1);

  lastReport = {
    report,
    sourceName: src.kind === "file" ? src.name : src.live.label,
    processingSeconds: (performance.now() - started) / 1000,
    backend: det.backend,
    fps,
    live: src.kind === "live",
    numberOf,
  };
  // итог — в «Отчёты» (и в облако, если вошли), как ResultView / CameraView на Mac
  {
    const c = report.counters, m = report.metrics;
    const people = report.tracks.filter((t) => t.everInZone).length;
    const sc = showcaseScore(people, c.looked, c.slowed, m.stopped ?? 0, m.approached ?? 0, report.entered ?? null);
    if (src.kind === "file" || people > 0) {
      reports.add(newReport({
        source: src.kind === "file" ? "video" : "camera", title: src.kind === "file" ? `Видео · ${src.name}` : "Камера",
        duration: report.seconds, people, passed: c.passed, slowed: c.slowed, looked: c.looked, stopped: m.stopped ?? 0,
        approached: m.approached ?? 0, entered: report.entered ?? undefined, score: sc?.value,
      }));
    }
  }
  finishUi();
}

async function runFile(det: Detector, session: Session, video: HTMLVideoElement, fps: number): Promise<void> {
  video.pause();
  const duration = video.duration;
  const total = Math.max(1, Math.floor(duration * fps));
  let k = 0;
  let avgMs = 0;
  const tick = performance.now();
  await seekTo(video, 0);
  while (k < total && !stopRequested) {
    const t = k / fps;
    // Снимок кадра для показа: видео уже уйдёт на следующий кадр, пока нейросеть считает этот
    const shot = await createImageBitmap(video);
    const job = await det.submit(video, canvas.width, canvas.height);
    const next = k + 1 < total ? seekTo(video, (k + 1) / fps) : Promise.resolve();
    const res = await job.result;
    avgMs = avgMs ? avgMs * 0.9 + res.ms * 0.1 : res.ms;
    const fr = session.update(t, res.detections);
    assignNumbers(session, t, fr.boxes);
    frames.push({ t, boxes: fr.boxes });
    ctx.drawImage(shot, 0, 0, canvas.width, canvas.height);
    shot.close();
    drawMarkup(ctx, markup);
    drawPeople(ctx, fr.boxes, numberOf);
    setCounters(fr, !!session.entrancePx);
    pushFeed(fr.events);
    const done = (k + 1) / total;
    progress.querySelector("i")!.style.width = `${(done * 100).toFixed(1)}%`;
    progress.setAttribute("aria-valuenow", String(Math.round(done * 100)));
    const elapsed = (performance.now() - tick) / 1000;
    const left = (elapsed / (k + 1)) * (total - k - 1);
    runStat.textContent = `${fmtTime(t)} / ${fmtTime(duration)} · осталось ~${fmtTime(left)} · ${Math.round(avgMs)} мс/кадр`;
    await next;
    k++;
  }
}

async function runCamera(det: Detector, session: Session, live: LiveSource): Promise<void> {
  const t0 = performance.now();
  let avgMs = 0;
  let n = 0;
  while (!stopRequested) {
    const t = (performance.now() - t0) / 1000;
    if (live.lost()) throw new Error("камера отключилась");
    const shot = await live.grab();
    const res = await det.detect(shot, canvas.width, canvas.height);
    ctx.drawImage(shot, 0, 0, canvas.width, canvas.height);
    shot.close();
    avgMs = avgMs ? avgMs * 0.9 + res.ms * 0.1 : res.ms;
    const fr = session.update(t, res.detections);
    assignNumbers(session, t, fr.boxes);
    n++;
    drawMarkup(ctx, markup);
    drawPeople(ctx, fr.boxes, numberOf);
    setCounters(fr, !!session.entrancePx);
    pushFeed(fr.events);
    const fpsNow = 1000 / Math.max(1, (performance.now() - t0) / n);
    runStat.textContent = `${fmtTime(t)} · ${fpsNow.toFixed(1)} кадр/с · ${Math.round(avgMs)} мс/кадр`;
  }
}

function finishUi(): void {
  if (!lastReport || !source) return;
  const r = lastReport.report;
  runTitle.textContent = "Готово";
  progress.classList.remove("live");
  progress.querySelector("i")!.style.width = "100%";
  runStat.textContent = `${fmtTime(r.seconds)} видео · обработка ${fmtTime(lastReport.processingSeconds)}`;
  setCounters({ counters: r.counters, entered: r.entered ?? 0 }, r.entered !== null);
  $("#btn-stop").parentElement!.hidden = true;
  $("#done-actions").hidden = false;
  $("#btn-twin").hidden = !(source.kind === "file" && frames.length);
  $("#btn-heat").hidden = !(source.kind === "file" && frames.length);
  renderReport(reportEl, lastReport);
  reportEl.hidden = false;
  if (source.kind === "file" && frames.length) {
    timeline.hidden = false;
    showFrameAt(source.video.currentTime);
  }
}

// ---------------------------------------------------------------- просмотр результата
let replayRaf = 0;

function frameAt(t: number): StoredFrame | null {
  if (!frames.length || t < frames[0].t - 1e-3) return null;
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].t <= t + 1e-3) lo = mid;
    else hi = mid - 1;
  }
  // кадр не старше полутора шагов анализа — иначе рамки «висят»
  return t - frames[lo].t < 0.2 ? frames[lo] : null;
}

function showFrameAt(t: number): void {
  if (source?.kind !== "file") return;
  ctx.drawImage(source.video, 0, 0, canvas.width, canvas.height);
  drawMarkup(ctx, markup);
  const f = frameAt(t);
  if (f) drawPeople(ctx, f.boxes, numberOf);
  const d = source.video.duration || 0;
  timeLabel.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
  if (document.activeElement !== seek) seek.value = String(d ? Math.round((t / d) * 1000) : 0);
}

function replayLoop(): void {
  if (source?.kind !== "file" || source.video.paused) return;
  showFrameAt(source.video.currentTime);
  replayRaf = requestAnimationFrame(replayLoop);
}

function stopReplay(): void {
  cancelAnimationFrame(replayRaf);
  if (source?.kind === "file") source.video.pause();
  btnPlay.textContent = "▶";
  btnPlay.setAttribute("aria-label", "Воспроизвести");
}

btnPlay.addEventListener("click", async () => {
  if (!source || source.kind !== "file" || running) return;
  const v = source.video;
  if (v.paused) {
    if (v.ended || v.currentTime >= v.duration - 0.05) v.currentTime = 0;
    await v.play();
    btnPlay.textContent = "❚❚";
    btnPlay.setAttribute("aria-label", "Пауза");
    v.onended = stopReplay;
    replayLoop();
  } else {
    stopReplay();
    showFrameAt(v.currentTime);
  }
});
seek.addEventListener("input", async () => {
  if (!source || source.kind !== "file" || running) return;
  const v = source.video;
  const t = (Number(seek.value) / 1000) * (v.duration || 0);
  await seekTo(v, t);
  showFrameAt(t);
});

// ---------------------------------------------------------------- кнопки
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) openFile(f);
  fileInput.value = "";
});
$("#btn-camera").addEventListener("click", openCamera);
$("#btn-ipcam").addEventListener("click", openIpForCheck);
$("#btn-start").addEventListener("click", () => (mode === "pilot" ? startPilot() : startAnalysis()));
$("#btn-stop").addEventListener("click", () => (stopRequested = true));
$("#btn-remark").addEventListener("click", () => {
  if (!source) return;
  if (source.kind === "file") seekTo(source.video, Math.min(0.5, source.video.duration / 4)).then(enterMarkup);
  else enterMarkup();
});
const goHome = () => {
  stopRequested = true;
  closeSource();
  canvas.hidden = true;
  drop.hidden = false;
  timeline.hidden = true;
  legend.hidden = true;
  reportEl.hidden = true;
  stage.classList.remove("editing");
  message(null);
  showStep("source");
};
$("#btn-other").addEventListener("click", () => (mode === "pilot" ? pilotHome() : goHome()));
$("#btn-new").addEventListener("click", goHome);
$("#btn-twin").addEventListener("click", () => {
  if (source?.kind !== "file" || !frames.length) return;
  const src = source;
  const w = src.video.videoWidth, h = src.video.videoHeight;
  const fr = frames.map((f) => ({ t: f.t, boxes: f.boxes }));
  switchTab("monitoring");
  monitoring.go("monitor");
  void twin.openVideo(src.file, { width: w, height: h, frames: fr });
});

$("#btn-heat").addEventListener("click", () => {
  if (source?.kind !== "file" || !frames.length) return;
  void openHeatmap({ frames, video: source.video, width: source.video.videoWidth, height: source.video.videoHeight, title: source.file.name.replace(/\.[^.]+$/, "") });
});

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
$("#exp-summary").addEventListener("click", () => lastReport && exportSummary(lastReport, stamp()));
$("#exp-events").addEventListener("click", () => lastReport && exportEvents(lastReport, stamp()));
$("#exp-tracks").addEventListener("click", () => lastReport && exportTracks(lastReport, stamp()));

// Перетаскивание файла на сцену
["dragenter", "dragover"].forEach((ev) =>
  stage.addEventListener(ev, (e) => {
    e.preventDefault();
    if (!running) stage.classList.add("dragover");
  }),
);
["dragleave", "drop"].forEach((ev) => stage.addEventListener(ev, () => stage.classList.remove("dragover")));
stage.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f && !running) openFile(f);
});
// Не даём браузеру открыть файл, брошенный мимо сцены
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// ---------------------------------------------------------------- старт
applySaved("check");
showStep("source");

// ================================================================ аккаунт
const account = new Account();
const accountBtn = $("#btn-account");
const accountDialog = $<HTMLDialogElement>("#account-dialog");

function authError(el: string, text: string | null): void {
  const e = $(el);
  e.hidden = !text;
  e.textContent = text ?? "";
}

function fillProfileForm(): void {
  const p = account.state.profile;
  $<HTMLInputElement>("#pf-point").value = p.point;
  $<HTMLInputElement>("#pf-city").value = p.city;
  $<HTMLInputElement>("#pf-check").value = String(p.avgCheck);
  $<HTMLInputElement>("#pf-hours").value = String(p.hoursPerDay);
  $<HTMLInputElement>("#pf-look").value = String(p.lookToBuy);
  $<HTMLInputElement>("#pf-enter").value = String(p.enterToBuy);
}

accountBtn.addEventListener("click", () => {
  authError("#auth-error", null);
  authError("#profile-error", null);
  fillProfileForm();
  accountDialog.showModal();
});

async function authAction(fn: () => Promise<void>, okText?: string): Promise<void> {
  const email = $<HTMLInputElement>("#auth-email").value;
  const password = $<HTMLInputElement>("#auth-password").value;
  if (!email.includes("@")) return authError("#auth-error", "Введите почту");
  if (fn !== resetCall && password.length < 6) return authError("#auth-error", "Пароль — минимум 6 символов");
  authError("#auth-error", null);
  const buttons = accountDialog.querySelectorAll<HTMLButtonElement>("#auth-signed-out button");
  buttons.forEach((b) => (b.disabled = true));
  try {
    await fn();
    if (okText) toast(okText);
  } catch (e) {
    authError("#auth-error", friendlyError(e));
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}
const email = () => $<HTMLInputElement>("#auth-email").value;
const password = () => $<HTMLInputElement>("#auth-password").value;
const resetCall = () => resetPassword(email());
$("#btn-signin").addEventListener("click", () => authAction(() => signIn(email(), password())));
$("#btn-signup").addEventListener("click", () => authAction(() => signUp(email(), password()), "Аккаунт создан"));
$("#btn-reset").addEventListener("click", () => authAction(resetCall, "Письмо для смены пароля отправлено"));
$("#btn-signout").addEventListener("click", async () => {
  if (pilot || multi?.model.running) return authError("#profile-error", "Сначала остановите пилот");
  await signOut();
  accountDialog.close();
  toast("Вы вышли. Статистика этого браузера осталась на нём.");
});
$("#btn-profile-save").addEventListener("click", () => {
  const num = (id: string, d: number) => {
    const v = parseFloat($<HTMLInputElement>(id).value.replace(",", "."));
    return isFinite(v) && v >= 0 ? v : d;
  };
  const p = account.state.profile;
  account.setProfile({
    ...p,
    point: $<HTMLInputElement>("#pf-point").value.trim(),
    city: $<HTMLInputElement>("#pf-city").value.trim(),
    avgCheck: num("#pf-check", p.avgCheck),
    hoursPerDay: Math.min(24, Math.max(1, num("#pf-hours", p.hoursPerDay))),
    lookToBuy: Math.min(100, num("#pf-look", p.lookToBuy)),
    enterToBuy: Math.min(100, num("#pf-enter", p.enterToBuy)),
  });
  accountDialog.close();
  toast("Профиль точки сохранён");
});

account.subscribe((st) => {
  const u = st.user;
  accountBtn.classList.toggle("signed", !!u);
  $("#account-label").textContent = "Профиль";
  accountBtn.title = u ? `Профиль · ${st.profile.point || u.email || ""}` : "Профиль · вход не выполнен";
  accountBtn.querySelector(".avatar")!.textContent = u?.email?.[0] ?? "";
  $("#auth-signed-out").hidden = !!u;
  $("#auth-signed-in").hidden = !u;
  $("#auth-who").textContent = u?.email ?? "";
  renderPilotAccount();
  updateSyncLine();
  if (currentTab === "stats") renderStatsView();
});

// ================================================================ пилот на нескольких камерах
// Вкладка «Пилот» — сетка камер, как в Mantis для Mac: в браузере, у Mantis Агента и в приложении для Windows.
// (Старый пилот на одну камеру ниже остаётся как запасной код; его настройки переносятся в первую камеру.)
let twinRef: TwinView | null = null;
const multi: MultiView | null = mountMulti($("#multi"), {
  account, getDetector: ensureDetector, resetDetector, toast, openAccount: () => accountBtn.click(),
  onSetup: (ch) => void twinRef?.setupCamera(ch),
  onRunStart: () => {
    startRunTwin();
    cameraAlerts.begin();
    void videoRun.start(multi!.model.channels);
  },
  onRunEnd: (run, closing) => saveRunReport(run, closing),
  bindingText: (ch) => {
    // двойник создаётся сразу после сетки камер — до этого привязок ещё нет
    const c = twinRef?.model.plan.calibrations[ch.id];
    if (!c || !calibrationValid(c)) return { text: "не привязана к плану", ok: false };
    if (floorPointsUntouched(c)) return { text: "по полу: точки не расставлены", ok: false };
    return { text: c.mode === "sector" ? "на плане по сектору" : "на плане по полу", ok: true };
  },
});
if (isDesktop) document.body.classList.add("desktop");
migrateSinglePilot();

// ================================================================ цифровой двойник и записи (как в Mantis для Mac)
const records = mountRecords($("#records"));
const twin = mountTwin($("#twin"), {
  multi: multi!,
  getDetector: ensureDetector,
  toast,
  goCameras: () => monitoring.go("cameras"),
  goPlan: () => monitoring.go("plan"),
  goStats: () => switchTab("stats"),
  signedIn: () => !!account.state.user,
  onSaved: () => records.reload(),
  videoConfig: () => {
    // разметка вкладки «Проверка видео», но зона — весь кадр: на плане нужны все люди
    const saved = loadSaved("check");
    const m = saved.markup?.zone?.length === 4 && saved.markup.line?.length === 2 ? saved.markup : defaultMarkup();
    const c = defaultConfig();
    c.countLineEnabled = m.lineEnabled;
    c.countLine = m.line.map((q) => ({ ...q }));
    c.showcaseZone = FULL_FRAME.map((q) => ({ ...q }));
    c.look.showcaseDirection = saved.direction ?? "camera";
    return { cfg: c, entrance: m.entranceEnabled ? m.entrance : null, fps: 15 };
  },
});

twinRef = twin;

/** Блок «Цифровой двойник в облаке» в окне профиля. */
function mountTwinCloud(pub: TwinPublisher): void {
  const en = $<HTMLInputElement>("#tc-enabled");
  const site = $<HTMLInputElement>("#tc-site");
  en.checked = pub.enabled;
  site.value = pub.siteId === "main" ? "" : pub.siteId;
  en.addEventListener("change", () => (pub.enabled = en.checked));
  site.addEventListener("change", () => {
    pub.siteId = site.value;
    site.value = pub.siteId === "main" ? "" : pub.siteId;
  });
  pub.subscribe((st) => {
    const dot = $("#tc-dot");
    dot.dataset.state = st.kind;
    $("#tc-status").textContent = st.kind === "off" ? "Выключено"
      : st.kind === "signedOut" ? "Войдите — данные привязываются к аккаунту"
      : st.kind === "error" ? st.text
      : st.kind === "standby" ? `На связи · сейчас точку передаёт «${st.other}» — этот компьютер его не перебивает`
      : `Передаётся${st.demo ? " демо" : ""} · ${st.at.toLocaleTimeString("ru-RU")} · ${st.demo ? "на плане" : "в кадре"} ${st.people} · точка «${pub.siteId}»`;
  });
}

// Живой цифровой двойник в облаке — как в приложении для iPhone: раз в секунду в Realtime Database для личного кабинета
const twinCloud = new TwinPublisher({
  account, pilot: multi!.model, twin: twin.model,
  deviceName: () => {
    const ua = navigator.userAgent;
    const os = /iPad|Macintosh.*Mobile/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iPad"
      : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
    return `Mantis · ${desktopShell === "windows" ? "Windows" : os ? `браузер на ${os}` : "браузер"}`;
  },
  demo: () => demo.snapshot(),
  onPlanFromCloud: () => {
    twin.planChanged();
    multi?.refresh();
    toast("План точки обновлён из личного кабинета");
  },
});
mountTwinCloud(twinCloud);
multi!.refresh();

// ================================================================ запуск мониторинга → запись двойника и отчёт (как PilotModel.swift)
const videoStorage = new VideoStorage(reports);
const cameraAlerts = new CameraAlerts();
const videoRun = new VideoRun(videoStorage, (note) => note && toast(note, true));
multi?.onFrame((ch, shot, fr) => {
  videoRun.frame(ch, shot, fr);
  if (multi?.model.running) cameraAlerts.frame(ch, shot, fr?.boxes ?? null);
});
// уведомления о камерах (раз в 10 с), расписание мониторинга и сторож сна, значок в трее
setInterval(() => {
  if (multi?.model.running) cameraAlerts.check(multi.model.channels);
}, 10_000);
if (multi) startSchedule(multi.model);
// значок в трее Windows: идёт ли мониторинг и сколько людей, запуск и остановка (строка меню и Dock на Mac)
setInterval(() => {
  const m = multi?.model;
  if (!m) return;
  const people = twinRef?.model.people.length ?? 0;
  const live = m.channels.filter((c) => c.isLive).length;
  const since = m.startedAt ? new Date(m.startedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "";
  trayStatus(m.running
    ? { running: true, title: `Мониторинг идёт${since ? ` · с ${since}` : ""}`, people, canStart: false,
        lines: [`Сейчас на плане: ${people} · за запуск: ${m.totals.people}`, `Камеры на связи: ${live} из ${m.channels.length}`] }
    : { running: false, title: "Мониторинг остановлен", people: 0, canStart: m.channels.length > 0,
        lines: schedulePrefs.enabled ? [`По расписанию: ${scheduleText()}`] : [] });
}, 2000);
onTrayCommand((cmd) => {
  if (cmd === "start") void multi?.setRunning(true);
  else if (cmd === "stop") {
    stoppedManually();
    void multi?.setRunning(false);
  } else if (cmd === "report") setStatsSection("last");
});

/** Цифровой двойник пишется сам на каждый запуск (камеры, привязанные к плану). */
function startRunTwin(): void {
  const t = twinRef?.model;
  const pilotM = multi?.model;
  if (!t || !pilotM || t.recorder || t.demo) return;
  const refs = pilotM.channels.flatMap((ch, i) =>
    t.plan.calibrations[ch.id] ? [{ id: ch.id, name: channelShort(ch.config), colorIndex: channelColorIndex(ch.config, i) }] : []);
  if (refs.length) t.startRecording(refs);
}

/** Последний сохранённый отчёт мониторинга — «Отчёт сохранён» на экране. */
let lastRunSaved: RunReport | null = null;

async function saveRunReport(run: RunEnd, closing: boolean): Promise<void> {
  const duration = (run.ended - run.started) / 1000;
  const video = await videoRun.finish();
  // двойник этого запуска — в «Записи»
  let twinID: string | undefined;
  const t = twinRef?.model;
  const rec = t && t.recorder && !t.recorder.demo ? t.stopRecording() : null;
  if (rec && rec.data.frames.length > 1 && duration >= 5) {
    const name = `Мониторинг ${new Date(run.started).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
    const m = closing ? null : await saveRecording(name, "live", rec.data, null, t!.backgroundBlob);
    if (m) {
      twinID = m.id;
      records.reload();
    }
  }
  if (duration < 5) return;
  const tot = Object.values(run.hours).reduce(addHours, emptyHour());
  const hasEntrance = run.cameras.some((c) => c.entrance);
  const title = run.cameras.length > 1 ? `Мониторинг · ${run.cameras.length} камеры` : `Мониторинг · ${run.cameras[0]?.name ?? "камера"}`;
  const r = newReport({
    source: "camera", title, duration, people: tot.people, passed: tot.passed, slowed: tot.slowed, looked: tot.looked,
    entered: hasEntrance ? tot.entered : undefined, started: run.started, hours: run.hours, twinID,
    cameras: run.cameras.map((c) => {
      const clips = video.clips.get(c.id) ?? [];
      return {
        name: c.name, people: c.stat.people, passed: c.stat.passed, slowed: c.stat.slowed, looked: c.stat.looked,
        entered: c.entrance ? c.stat.entered : undefined, seconds: c.stat.seconds,
        ...(clips.length ? { video: clips[0].file, videoSeconds: clips.reduce((a, x) => a + x.seconds, 0), clips } : {}),
      };
    }),
  });
  if (video.folder && video.clips.size) r.videoFolder = video.folder;
  reports.add(r);
  lastRunSaved = r;
  if (!closing) toast("Отчёт запуска сохранён — «Статистика» → «Последний запуск»");
}
void lastRunSaved;

// ================================================================ мониторинг, справка, «О приложении», боковое меню
const monitoring = mountMonitoring({
  root: $("#monitoring"), head: $("#mon-head"), planRoot: $("#plan-step"), multiRoot: $("#multi"), multi: multi!, twin,
  quickShow: () => {
    if (multi?.model.running) {
      toast("Идёт мониторинг: камеры заняты. Быстрый показ — когда мониторинг остановлен.", true);
      return;
    }
    switchTab("check");
    void openCamera();
  },
});
mountHelp($("#help"));
// Точки: все точки аккаунта вживую — люди на плане, кто на связи, счётчики, план и камеры (как личный кабинет)
const sites = mountCabinet($("#sites"), { embedded: true, openProfile: () => accountBtn.click() });
account.subscribe((st) => sites.setUser(st.user));
sites.hide();

const demo = mountDemo($("#demo"), {
  livePlan: () => ({ plan: twin.model.plan, background: twin.model.backgroundBlob }),
  onSaved: () => records.reload(),
  toast,
});

// Экран не гаснет (планшет у витрины), пока идёт мониторинг, демо, подсчёт или открыта камера
setInterval(() => {
  keepAwake(!!multi?.model.running || demo.isRunning() || running || source?.kind === "live");
}, 2000);
setNavigator((t) => switchTab(t as Tab));
const about = mountAbout($("#about"), {
  toast,
  backend: () => detector?.backend ?? "не загружена",
  platform: () => (isDesktop ? "Windows" : "браузер"),
});
const settings = mountSettings($("#settings"), {
  video: videoStorage,
  toast,
  cameras: () => (multi?.model.channels ?? []).map((c) => ({ title: c.title, counting: c.isCounting, fps: c.fps })),
  backend: () => detector?.backend ?? "не загружена",
  running: () => !!multi?.model.running,
});

// ---- подсказка сверху экрана (как ScreenTipBar на Mac)
const tipBar = mountTipBar($("#tip-bar"));
function refreshTip(): void {
  const key: Record<string, string | null> = {
    monitoring: monitoring.current(), check: "video", sites: "online", demo: "demo", settings: "settings", help: null, about: null,
    stats: statsSection === "last" ? "stats.last" : statsSection === "reports" ? "stats.reports" : statsSection === "hours" ? "stats.hours" : "records",
  };
  tipBar.set(key[currentTab] ?? null);
}
window.addEventListener("mantis:step", refreshTip);
$("#sample-hide").addEventListener("click", () => sample.hide());
sample.subscribe(() => {
  if (currentTab === "stats") showStatsSection();
});

const SB_KEY = "sidebarCollapsed";
function applySidebar(collapsed: boolean): void {
  document.body.classList.toggle("sb-collapsed", collapsed);
  $("#sb-collapse").title = collapsed ? "Развернуть меню" : "Свернуть меню";
  $("#sb-collapse").querySelector(".sb-label")!.textContent = collapsed ? "Развернуть меню" : "Свернуть меню";
}
applySidebar((() => {
  try {
    return localStorage.getItem(SB_KEY) === "1";
  } catch {
    return false;
  }
})());
$("#sb-collapse").addEventListener("click", () => {
  const c = !document.body.classList.contains("sb-collapsed");
  applySidebar(c);
  try {
    localStorage.setItem(SB_KEY, c ? "1" : "0");
  } catch {
    /* нет */
  }
});
// точка «идёт мониторинг» у пункта меню
setInterval(() => {
  const dot = $("#sb-live");
  const m = multi?.model;
  dot.hidden = !m?.running;
  if (m) dot.dataset.state = m.state === "recovering" ? "recovering" : "on";
}, 1000);

/** Был настроен пилот на одну камеру (прошлая версия) — переносим его камеру и разметку в первую камеру сетки. */
function migrateSinglePilot(): void {
  if (!multi || multi.model.channels.length) return;
  const old = loadSaved("pilot");
  if (!old.markup && !old.cameraId) return;
  const ip = old.cameraId === IP_OPTION ? loadIpCamera() : null;
  const m = old.markup?.zone?.length === 4 && old.markup.line?.length === 2 && old.markup.entrance?.length === 2 ? old.markup : defaultMarkup();
  void multi.model.upsert(newChannelConfig({
    name: ip ? ip.title : "Камера",
    kind: ip ? "ip" : "webcam",
    deviceId: ip ? "" : old.cameraId ?? "",
    ip,
    markup: m,
    direction: old.direction ?? "camera",
  }));
  try {
    if (localStorage.getItem(PILOT_FLAG) === "1") {
      localStorage.removeItem(PILOT_FLAG);
      localStorage.setItem("mantis.multi.active", "1");
    }
  } catch {
    /* нет */
  }
}

// ================================================================ пилот

function renderPilotAccount(): void {
  const box = $("#pilot-account");
  const st = account.state;
  box.replaceChildren();
  const line = (html: string) => {
    const d = document.createElement("div");
    d.className = "row";
    d.textContent = html;
    return d;
  };
  if (st.user) {
    const r = line("");
    const left = document.createElement("span");
    left.textContent = "Статистика сохраняется в облаке";
    const b = document.createElement("b");
    b.textContent = st.profile.point || "точка без названия";
    r.append(left, b);
    box.append(r, line(st.user.email ?? ""));
  } else {
    box.append(line("Вы не вошли. Подсчёт будет храниться только в этом браузере."));
    const btn = document.createElement("button");
    btn.className = "btn small";
    btn.type = "button";
    btn.textContent = "Войти или зарегистрироваться";
    btn.addEventListener("click", () => accountBtn.click());
    box.append(btn);
  }
}

async function fillCameras(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const saved = loadSaved("pilot").cameraId ?? "";
  try {
    const cams = await listCameras();
    cameraSelect.replaceChildren(
      ...cams.map((c, i) => {
        const o = document.createElement("option");
        o.value = c.deviceId;
        o.textContent = c.label || `Камера ${i + 1}`;
        return o;
      }),
    );
    const ip = loadIpCamera();
    if (ip) {
      const o = document.createElement("option");
      o.value = IP_OPTION;
      o.textContent = `IP: ${ip.title}`;
      cameraSelect.append(o);
    }
    if (!cams.length && !ip) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "Камера не найдена";
      cameraSelect.append(o);
    }
    if (saved && (cams.some((c) => c.deviceId === saved) || (saved === IP_OPTION && ip))) cameraSelect.value = saved;
  } catch {
    /* оставим как есть */
  }
}
cameraSelect.addEventListener("change", save);

function markupSummary(): void {
  const parts = [markup.lineEnabled ? "линия подсчёта" : null, markup.entranceEnabled ? "вход в магазин" : null];
  const zoneFull = markup.zone.every((p, i) => p.x === FULL_FRAME[i].x && p.y === FULL_FRAME[i].y);
  parts.unshift(zoneFull ? "зона — весь кадр" : "своя зона");
  $("#markup-summary").textContent = `Сохранённая разметка: ${parts.filter(Boolean).join(", ")}.`;
}

/** Экран пилота без запущенного подсчёта. */
function pilotHome(): void {
  closeSource();
  stage.classList.remove("editing");
  canvas.hidden = true;
  drop.hidden = true;
  pilotIntro.hidden = false;
  legend.hidden = true;
  timeline.hidden = true;
  reportEl.hidden = true;
  message(null);
  showStep("pilot");
  $("#pilot-setup").hidden = false;
  $("#pilot-live").hidden = true;
  renderPilotAccount();
  markupSummary();
  void fillCameras();
}

/** Открыть источник пилота: IP-камеру (через мост) или камеру компьютера. */
async function openPilotSource(): Promise<LiveSource> {
  const choice = cameraSelect.value || loadSaved("pilot").cameraId || "";
  if (choice === IP_OPTION) {
    const ip = loadIpCamera();
    if (!ip) throw new Error("IP-камера не настроена");
    return openIpCamera(ip);
  }
  return openWebcam(choice || null);
}

/** Открыть выбранную камеру и перейти к разметке. */
async function pilotMarkup(): Promise<void> {
  closeSource();
  const btn = $<HTMLButtonElement>("#btn-pilot-setup");
  btn.disabled = true;
  try {
    message(cameraSelect.value === IP_OPTION ? "Подключаю IP-камеру…" : null);
    const live = await openPilotSource();
    source = { kind: "live", live };
  } catch (e) {
    message(null);
    toast(cameraSelect.value === IP_OPTION ? `IP-камера: ${(e as Error).message}` : "Нет доступа к камере. Разрешите доступ в настройках браузера и попробуйте снова.", true);
    return;
  } finally {
    btn.disabled = false;
  }
  message(null);
  pilotIntro.hidden = true;
  if (source.live.kind === "webcam") {
    await fillCameras(); // после разрешения видны названия камер
    const id = source.live.video && (source.live.video.srcObject as MediaStream | null)?.getVideoTracks()[0]?.getSettings().deviceId;
    if (id) cameraSelect.value = id;
  }
  save();
  enterMarkup();
  ensureDetector().catch((e) => toast(`Не удалось загрузить нейросеть: ${e.message}`, true));
}
$("#btn-pilot-ip").addEventListener("click", async () => {
  const r = await chooseIpCamera();
  if (!r) return;
  saveIpCamera(r.cfg);
  await fillCameras();
  cameraSelect.value = IP_OPTION;
  save();
  // камера уже подключена — сразу к разметке
  closeSource();
  source = { kind: "live", live: r.source };
  pilotIntro.hidden = true;
  enterMarkup();
  ensureDetector().catch((e) => toast(`Не удалось загрузить нейросеть: ${e.message}`, true));
});
$("#btn-pilot-setup").addEventListener("click", pilotMarkup);

function todayStat(): { day: HourStat; hour: HourStat } {
  const now = new Date();
  const hk = hourKey(now);
  let day = emptyHour();
  for (const [k, v] of Object.entries(account.hours.hours)) if (k.slice(0, 10) === hk.slice(0, 10)) day = addHours(day, v);
  return { day, hour: account.hours.hours[hk] ?? emptyHour() };
}

function renderToday(): void {
  const { day, hour } = todayStat();
  const set = (id: string, v: string) => ($(id).textContent = v);
  set("#t-people", String(day.people));
  set("#t-hour", `за этот час ${hour.people}`);
  set("#t-passed", String(day.passed));
  set("#t-looked", String(day.looked));
  set("#t-slowed", String(day.slowed));
  set("#t-entered", String(day.entered));
  set("#t-looked-r", pct(day.looked, day.people));
  set("#t-slowed-r", pct(day.slowed, day.people));
  set("#t-entered-r", pct(day.entered, day.people));
  $("#t-entered-card").hidden = !markup.entranceEnabled && day.entered === 0;
}

function updateSyncLine(): void {
  const st = account.state;
  const el = $("#pilot-sync");
  if (!st.user) el.textContent = `Только в этом браузере · не отправлено часов: ${account.hours.pending}`;
  else if (st.error) el.textContent = st.error;
  else if (st.lastSync) el.textContent = `В облаке · синхронизировано в ${st.lastSync.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
  else el.textContent = "В облаке · первая отправка через минуту";
}

function onPilotStatus(s: PilotStatus): void {
  pilotStatus = s;
  const box = $("#pilot-state");
  box.dataset.state = s.state;
  $("#pilot-state-text").textContent = s.state === "counting" ? "Идёт подсчёт" : s.message;
  const since = new Date(s.startedAt);
  const sameDay = since.toDateString() === new Date().toDateString();
  const sinceText = since.toLocaleString("ru-RU", sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  $("#pilot-meta").textContent =
    s.state === "counting" ? `с ${sinceText} · ${s.fps.toFixed(1)} кадр/с · ${Math.round(s.msPerFrame)} мс/кадр` : s.lastError ? `последний сбой: ${s.lastError}` : "";
  $("#pilot-hidden-warn").hidden = !s.hidden;
  engine.dataset.state = s.state === "counting" ? "ready" : "loading";
  renderToday();
  updateSyncLine();
}

async function startPilot(resume = false): Promise<void> {
  if (pilot) return;
  save();
  const cfg = buildConfig();
  const entrance = markup.entranceEnabled ? markup.entrance : null;
  closeSource(); // камеру откроет сам пилот
  stage.classList.remove("editing");
  pilotIntro.hidden = true;
  drop.hidden = true;
  canvas.hidden = false;
  legend.hidden = false;
  showStep("pilot");
  $("#pilot-setup").hidden = true;
  $("#pilot-live").hidden = false;
  renderPilotAccount();
  if (resume) toast("Пилот возобновлён после перезагрузки страницы");

  pilot = new PilotRunner({
    cfg,
    entrance,
    openSource: openPilotSource,
    account,
    getDetector: ensureDetector,
    resetDetector,
    onStatus: onPilotStatus,
    onFrame: (fr, shot) => {
      if (canvas.width !== shot.width || canvas.height !== shot.height) {
        canvas.width = shot.width;
        canvas.height = shot.height;
      }
      if ((currentTab as string) !== "pilot") return; // прежний пилот на одну камеру (запасной код)
      ctx.drawImage(shot, 0, 0);
      drawMarkup(ctx, markup);
      drawPeople(ctx, fr.boxes);
    },
  });
  pilot.start();
}

$("#btn-pilot-stop").addEventListener("click", async () => {
  if (!pilot) return;
  const p = pilot;
  pilot = null;
  $<HTMLButtonElement>("#btn-pilot-stop").disabled = true;
  await p.stop();
  $<HTMLButtonElement>("#btn-pilot-stop").disabled = false;
  exitKiosk();
  toast("Пилот остановлен. Статистика — на вкладке «Статистика».");
  pilotHome();
});

account.hours.onChange(() => {
  if (pilot) renderToday();
});

// Во весь экран: только картинка и счётчики
function exitKiosk(): void {
  document.body.classList.remove("kiosk");
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
}
$("#btn-fullscreen").addEventListener("click", async () => {
  if (document.body.classList.contains("kiosk")) return exitKiosk();
  document.body.classList.add("kiosk");
  try {
    await document.documentElement.requestFullscreen();
  } catch {
    /* без полноэкранного режима просто прячем лишнее */
  }
  $("#btn-fullscreen").textContent = "Выйти из полноэкранного";
});
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) {
    document.body.classList.remove("kiosk");
    $("#btn-fullscreen").textContent = "Во весь экран";
  }
});

// Приложение для Windows перед выходом: досчитать и сохранить (пилот продолжится при следующем запуске)
(window as unknown as { __mantisQuit?: () => void }).__mantisQuit = () => {
  multi?.model.prepareForUnload();
  account.hours.save();
  void account.upload();
};

// Не даём случайно закрыть вкладку с идущим пилотом
window.addEventListener("beforeunload", (e) => {
  // приложение для Windows: окно с идущим пилотом прячется в трей, а при выходе досчитываем и сохраняем
  multi?.model.prepareForUnload();
  if (multi?.model.running && !isDesktop) e.preventDefault(); // браузер: спросить перед закрытием вкладки
  if (pilot) {
    account.hours.save();
    e.preventDefault();
  }
});

// ================================================================ статистика
let statsMetric: Metric = "people";
let devicesCache: Awaited<ReturnType<typeof loadDevices>> = [];
/** Статистика по камерам из облака (браузер); в настольной версии берётся из пилота. */
let cameraCache: Awaited<ReturnType<typeof loadCameraHours>> = { hours: {}, names: {} };

function cameraSeries(): CameraSeries[] {
  const extra: CameraSeries[] = sample.on
    ? SAMPLE_CAMERAS.map(([id, name]) => ({ id, name, hours: sample.cameraHours[id] ?? {}, live: null }))
    : [];
  return [...realCameraSeries(), ...extra];
}

function realCameraSeries(): CameraSeries[] {
  if (multi) {
    const store = multi.model.cameraHours;
    const live = new Map(multi.model.channels.map((c) => [c.id, c] as const));
    const ids = [...new Set([...multi.model.channels.map((c) => c.id), ...store.cameraIds])];
    return ids.map((id) => ({
      id, name: live.get(id)?.title ?? store.name(id), hours: store.hours[id] ?? {},
      live: live.has(id) ? live.get(id)!.isCounting : null,
    }));
  }
  return Object.entries(cameraCache.hours).map(([id, hours]) => ({ id, name: cameraCache.names[id] ?? "Камера", hours, live: null }));
}

function statsDays(): number {
  return Number(document.querySelector<HTMLInputElement>('#stats-period input:checked')?.value ?? 7);
}

/** Камера, по которой смотрим статистику (null — все камеры). */
let statsCamera: string | null = null;

/** Часы выбранной камеры или общие. */
function statsHours(): Record<string, HourStat> {
  if (statsCamera) return cameraSeries().find((c) => c.id === statsCamera)?.hours ?? {};
  return sample.withSample(account.hours.hours);
}

function renderStatsView(): void {
  renderMetricChips($("#stats-metric"), statsMetric, (m) => {
    statsMetric = m;
    renderStatsView();
  });
  renderDevices($("#devices"), devicesCache);
  const cams = cameraSeries().filter((c) => Object.keys(c.hours).length);
  if (statsCamera && !cams.some((c) => c.id === statsCamera)) statsCamera = null;
  const camBox = $("#stats-camera");
  camBox.hidden = cams.length < 2;
  camBox.replaceChildren(...[{ id: null as string | null, name: "Все камеры" }, ...cams].map((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = c.name;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(c.id === statsCamera));
    b.addEventListener("click", () => {
      statsCamera = c.id;
      renderStatsView();
    });
    return b;
  }));
  const camHidden = !!statsCamera;
  $("#stats-cameras").hidden = camHidden;
  if (!camHidden) renderCameraTable($("#stats-cameras"), cameraSeries(), statsDays());
  const scope = statsCamera ? cams.find((c) => c.id === statsCamera)?.name ?? "камера" : "все камеры";
  renderCompare($("#stats-compare"), statsHours(), scope, renderStatsView);
  renderStats($("#stats-body"), $("#stats-sub"), {
    hours: statsHours(),
    profile: account.state.profile,
    days: statsDays(),
    metric: statsMetric,
    signedIn: !!account.state.user,
    devices: devicesCache,
  });
}

async function refreshStats(): Promise<void> {
  const btn = $<HTMLButtonElement>("#btn-stats-refresh");
  btn.disabled = true;
  try {
    if (account.uid) {
      await account.pull();
      devicesCache = await loadDevices(account.uid).catch(() => devicesCache);
      if (multi) await multi.model.cameraHours.pull(account.uid).catch(() => undefined);
      else cameraCache = await loadCameraHours(account.uid).catch(() => cameraCache);
    }
  } finally {
    btn.disabled = false;
    renderStatsView();
  }
}
$("#stats-period").addEventListener("change", renderStatsView);
let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => currentTab === "stats" && renderStatsView(), 150);
});
$("#btn-stats-refresh").addEventListener("click", refreshStats);
$("#btn-stats-excel").addEventListener("click", () => {
  const rows = rowsFor(statsHours(), statsDays());
  if (!rows.length) return toast("За этот период данных нет", true);
  const days = statsDays();
  const who = statsCamera ? cameraSeries().find((c) => c.id === statsCamera)?.name ?? "камера" : "все камеры";
  download(hoursCsv(rows), `Статистика Mantis ${days ? `${days} дней` : "всё время"} ${who} ${dayStamp()}.csv`);
});

// ================================================================ отчёты и разделы статистики (как StatsHubView на Mac)
type StatsSection = "last" | "reports" | "hours" | "records";
const STATS_SECTIONS: [StatsSection, string][] = [["last", "Последний запуск"], ["reports", "Отчёты"], ["hours", "По часам и дням"], ["records", "Записи двойника"]];
let statsSection: StatsSection = (() => {
  try {
    const v = localStorage.getItem("stats.section") as StatsSection | null;
    return v && STATS_SECTIONS.some((x) => x[0] === v) ? v : "last";
  } catch {
    return "last";
  }
})();
/** Открытый отчёт в разделе «Отчёты» (null — список). */
let openedReport: { r: import("./reports/store").ReportSummary; o: DetailOptions } | null = null;

reports.uid = () => account.uid;
let reportsPulledFor: string | null = null;
account.subscribe((st) => {
  const uid = st.user?.uid ?? null;
  if (uid && uid !== reportsPulledFor) {
    reportsPulledFor = uid;
    void reports.pull().catch((e) => console.warn("[mantis] отчёты из облака:", e));
  }
  if (!uid) reportsPulledFor = null;
});

const reportsCtx: ReportsCtx = {
  store: reports,
  profile: () => account.state.profile,
  toast,
  video: videoStorage.files(),
  twin: {
    async meta(id) {
      const m = (await listRecordings()).find((x) => x.id === id);
      return m ? { duration: m.duration, people: m.people, peak: m.peak } : null;
    },
    open(id) {
      setStatsSection("records");
      records.select(id);
    },
    async remove(id) {
      await deleteRecording(id);
      records.reload();
    },
  },
};
const reportsRoot = $("#reports-view");
const reportsListBox = document.createElement("div");
const reportsDetailBox = document.createElement("div");
reportsRoot.append(reportsListBox, reportsDetailBox);
const reportsList = mountReportsList(reportsListBox, reportsCtx, (r, o) => {
  openedReport = { r, o: o ?? {} };
  showStatsSection();
});

function renderHub(): void {
  const bar = $("#stats-hub");
  const seg = document.createElement("div");
  seg.className = "seg hub-seg";
  seg.style.gridTemplateColumns = `repeat(${STATS_SECTIONS.length}, auto)`;
  for (const [v, t] of STATS_SECTIONS) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "stats-section";
    input.checked = v === statsSection;
    input.addEventListener("change", () => input.checked && setStatsSection(v));
    const span = document.createElement("span");
    span.textContent = t;
    label.append(input, span);
    seg.append(label);
  }
  bar.replaceChildren(seg);
}

function setStatsSection(v: StatsSection): void {
  statsSection = v;
  openedReport = null;
  try {
    localStorage.setItem("stats.section", v);
  } catch {
    /* нет */
  }
  if (currentTab !== "stats") switchTab("stats");
  else showStatsSection();
}

function showStatsSection(): void {
  refreshTip();
  $("#sample-banner").hidden = !sample.on || currentTab !== "stats";
  renderHub();
  $("#stats-hub").hidden = false;
  statsEl.hidden = statsSection !== "hours";
  reportsRoot.hidden = statsSection !== "last" && statsSection !== "reports";
  if (statsSection === "records") records.show();
  else records.hide();
  if (statsSection === "hours") {
    renderStatsView();
    void refreshStats();
  } else if (statsSection === "last") {
    reportsListBox.hidden = true;
    reportsDetailBox.hidden = false;
    const r = lastRunReport(reports);
    if (r) renderReportDetail(reportsDetailBox, r, reportsCtx, { onDeleted: showStatsSection });
    else {
      const e = document.createElement("div");
      e.className = "empty";
      e.innerHTML = "<h3>Запусков пока не было</h3><p>Запустите и остановите мониторинг — здесь появится статистика последнего запуска.</p>";
      reportsDetailBox.replaceChildren(e);
    }
  } else if (statsSection === "reports") {
    if (openedReport) {
      reportsListBox.hidden = true;
      reportsDetailBox.hidden = false;
      const back = () => {
        openedReport = null;
        showStatsSection();
      };
      renderReportDetail(reportsDetailBox, openedReport.r, reportsCtx, { ...openedReport.o, back, onDeleted: back });
    } else {
      reportsDetailBox.hidden = true;
      reportsListBox.hidden = false;
      reportsList.render();
    }
  }
}
reports.subscribe(() => {
  if (currentTab === "stats" && statsSection === "last") showStatsSection();
});

// ================================================================ вкладки

function switchTab(tab: Tab): void {
  // «Записи» — теперь раздел «Статистики», как на Mac
  if (tab === "records") {
    statsSection = "records";
    tab = "stats";
    if (currentTab === "stats") return showStatsSection();
  }
  if (tab === currentTab) return;
  if (tab === "check" && (pilot || multi?.model.running)) {
    toast("Идёт мониторинг: камеры заняты. Остановите мониторинг, чтобы проверять видео.", true);
    return;
  }
  if (running && tab !== currentTab) {
    stopRequested = true; // проверка видео прерывается при уходе
  }
  currentTab = tab;
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) =>
    b.dataset.tab === tab ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"),
  );
  monitoring.hide();
  records.hide();
  $("#stats-hub").hidden = true;
  $("#sample-banner").hidden = true;
  reportsRoot.hidden = true;
  demo.hide();
  sites.hide();
  $("#sites").hidden = tab !== "sites";
  $("#help").hidden = tab !== "help";
  $("#about").hidden = tab !== "about";
  if (tab === "about") about.refresh();
  if (tab === "settings") settings.show();
  else settings.hide();
  queueMicrotask(refreshTip);
  if (tab !== "check" && tab !== "stats") {
    if (!pilot) closeSource();
    layoutEl.hidden = true;
    statsEl.hidden = true;
    if (tab === "monitoring") monitoring.show();
    if (tab === "demo") demo.show();
    if (tab === "sites") sites.show();
    return;
  }
  layoutEl.hidden = tab === "stats";
  statsEl.hidden = tab !== "stats";
  if (tab === "stats") {
    showStatsSection();
    return;
  }
  const newMode: Mode = "check";
  if (newMode !== mode) {
    if (!pilot) closeSource();
    mode = newMode;
    applySaved(mode);
  }
  reportEl.hidden = true;
  if (false as boolean) {
    // прежний пилот на одну камеру (запасной код, экран не показывается)
    if (pilot) {
      canvas.hidden = false;
      drop.hidden = true;
      pilotIntro.hidden = true;
      legend.hidden = false;
      showStep("pilot");
      $("#pilot-setup").hidden = true;
      $("#pilot-live").hidden = false;
      if (pilotStatus) onPilotStatus(pilotStatus);
    } else pilotHome();
  } else {
    pilotIntro.hidden = true;
    goHome();
  }
}
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab as Tab)));

// ================================================================ Mantis Агент
// Если страницу отдаёт агент (программа на этом компьютере), показываем его настройки в панели пилота.
interface AgentInfo {
  agent: string;
  version: string;
  autostart: boolean;
}
(async function agentControls() {
  if (isDesktop || multi) return; // автозапуск и выключение — на экране пилота (сетка камер)
  let info: AgentInfo | null = null;
  try {
    const r = await fetch(new URL("api/agent", new URL(import.meta.env.BASE_URL, location.href)), { cache: "no-store" });
    if (r.ok) info = (await r.json()) as AgentInfo;
  } catch {
    /* страница открыта не через агента */
  }
  if (info?.agent !== "mantis") return;
  $("#agent-box").hidden = false;
  $("#agent-version").textContent = info.version;
  const sw = $<HTMLInputElement>("#agent-autostart");
  sw.checked = info.autostart;
  sw.addEventListener("change", async () => {
    try {
      const r = await fetch(new URL("api/agent/autostart", new URL(import.meta.env.BASE_URL, location.href)), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: sw.checked }),
      });
      const j = (await r.json()) as { autostart?: boolean; error?: string };
      if (!r.ok) throw new Error(j.error ?? "не получилось");
      sw.checked = !!j.autostart;
      toast(sw.checked ? "Агент будет запускаться при входе в систему" : "Автозапуск выключен");
    } catch (e) {
      sw.checked = !sw.checked;
      toast(`Автозапуск: ${(e as Error).message}`, true);
    }
  });
  $("#agent-quit").addEventListener("click", async () => {
    if (pilot) {
      toast("Сначала остановите пилот", true);
      return;
    }
    await fetch(new URL("api/agent/quit", new URL(import.meta.env.BASE_URL, location.href)), { method: "POST" }).catch(() => undefined);
    document.body.replaceChildren(Object.assign(document.createElement("p"), {
      className: "empty",
      textContent: "Агент выключен. Чтобы продолжить, запустите Mantis Agent снова.",
    }));
  });
})();

// Пилот шёл до перезагрузки страницы — продолжаем сам
(async function resumePilot() {
  if (multi) {
    // пункт «Анализ» скрыт из меню — приложение открывается на мониторинге
    switchTab("monitoring");
    if (!MultiPilot.wasActive) return;
    switchTab("monitoring");
    await account.whenReady();
    await multi.resume();
    return;
  }
  let flag = false;
  try {
    flag = localStorage.getItem(PILOT_FLAG) === "1";
  } catch {
    /* нет */
  }
  if (!flag) return;
  switchTab("monitoring");
  await account.whenReady();
  void startPilot(true);
})();

// Тестовый доступ (для автопроверки): window.mantis
declare global {
  interface Window {
    mantis?: { openFile: (f: File) => Promise<void>; start: () => Promise<void>; report: () => ReportContext | null; markup: () => Markup };
  }
}
window.mantis = { openFile, start: startAnalysis, report: () => lastReport, markup: () => markup };
