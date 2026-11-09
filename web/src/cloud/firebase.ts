// Firebase: вход по почте и паролю, профиль магазина, почасовая статистика, пульс устройства.
// Та же структура Firestore, что у iOS-приложения (mantis/Services/Cloud.swift):
//   users/{uid}                 — профиль магазина
//   users/{uid}/hours/{key}     — счётчики за час
//   users/{uid}/devices/{id}    — точки с пилотом (браузер, Mac, Windows): последний сигнал и состояние
//   users/{uid}/camera_hours/{камера}_{день} — счётчики по каждой камере (пилот на нескольких камерах: Mac, Windows)

import { type FirebaseApp, initializeApp } from "firebase/app";
import {
  type Auth, type User, createUserWithEmailAndPassword, getAuth, onAuthStateChanged, sendPasswordResetEmail,
  signInWithEmailAndPassword, signOut as fbSignOut,
} from "firebase/auth";
import {
  type Firestore, collection, doc, getDoc, getDocs, initializeFirestore, persistentLocalCache,
  persistentMultipleTabManager, serverTimestamp, setDoc, writeBatch,
} from "firebase/firestore";
import { type HourStat, parseHour } from "../pilot/hours";

// Конфигурация веб-приложения проекта jinpix-ac93d. Это не секрет: доступ к данным ограничивают правила Firestore.
const firebaseConfig = {
  apiKey: "AIzaSyAq1IrC3Wh0qXKkEEEu8lsfLsuNFU0woG4",
  authDomain: "jinpix-ac93d.firebaseapp.com",
  projectId: "jinpix-ac93d",
  storageBucket: "jinpix-ac93d.firebasestorage.app",
  messagingSenderId: "611953242655",
  appId: "1:611953242655:web:02f77b809f83c5d7209b2a",
};

/** Профиль магазина — как BusinessProfile в iOS. */
export interface BusinessProfile {
  name: string;
  company: string;
  point: string;
  city: string;
  avgCheck: number;
  lookToBuy: number;
  enterToBuy: number;
  hoursPerDay: number;
  daysPerMonth: number;
}

export const defaultProfile = (): BusinessProfile => ({
  name: "", company: "", point: "", city: "", avgCheck: 3000, lookToBuy: 3, enterToBuy: 20, hoursPerDay: 12, daysPerMonth: 30,
});

export function parseProfile(d: Record<string, unknown> | undefined): BusinessProfile {
  const p = defaultProfile();
  if (!d) return p;
  for (const k of ["name", "company", "point", "city"] as const) if (typeof d[k] === "string") p[k] = d[k] as string;
  for (const k of ["avgCheck", "lookToBuy", "enterToBuy", "hoursPerDay", "daysPerMonth"] as const)
    if (typeof d[k] === "number") p[k] = d[k] as number;
  return p;
}

export interface DeviceStatus {
  name: string;
  point: string;
  status: "counting" | "stopped";
  fps: number;
  startedAt: number | null;
  today: HourStat;
}

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

function init(): { auth: Auth; db: Firestore } {
  if (!app) {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    // Офлайн-кэш: записи копятся без интернета и уходят, когда связь вернётся
    try {
      db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
    } catch {
      db = initializeFirestore(app, {});
    }
  }
  return { auth: auth!, db: db! };
}

/** Приложение Firebase (для Realtime Database цифрового двойника). */
export function firebaseApp(): FirebaseApp {
  init();
  return app!;
}

/** Firestore проекта. */
export function firestore(): Firestore {
  return init().db;
}

export function watchAuth(cb: (user: User | null) => void): () => void {
  return onAuthStateChanged(init().auth, cb);
}

export function currentUser(): User | null {
  return init().auth.currentUser;
}

/** Понятные сообщения вместо кодов Firebase Auth. */
export function friendlyError(e: unknown): string {
  const code = (e as { code?: string })?.code ?? "";
  const map: Record<string, string> = {
    "auth/invalid-credential": "Неверная почта или пароль",
    "auth/wrong-password": "Неверная почта или пароль",
    "auth/user-not-found": "Неверная почта или пароль",
    "auth/invalid-email": "Неверный адрес почты",
    "auth/email-already-in-use": "Эта почта уже зарегистрирована — войдите",
    "auth/weak-password": "Пароль слишком простой — минимум 6 символов",
    "auth/too-many-requests": "Слишком много попыток, попробуйте позже",
    "auth/network-request-failed": "Нет связи с интернетом",
    "auth/unauthorized-domain": "Этот адрес сайта не разрешён в Firebase (Authentication → Settings → Authorized domains)",
    "permission-denied": "Нет доступа к данным: проверьте правила Firestore",
    unavailable: "Нет связи с сервером",
  };
  return map[code] ?? (e instanceof Error ? e.message : String(e));
}

export async function signIn(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(init().auth, email.trim(), password);
}

export async function signUp(email: string, password: string): Promise<void> {
  await createUserWithEmailAndPassword(init().auth, email.trim(), password);
}

export async function resetPassword(email: string): Promise<void> {
  await sendPasswordResetEmail(init().auth, email.trim());
}

export async function signOut(): Promise<void> {
  await fbSignOut(init().auth);
}

export async function loadProfile(uid: string): Promise<BusinessProfile | null> {
  const snap = await getDoc(doc(init().db, "users", uid));
  return snap.exists() ? parseProfile(snap.data()) : null;
}

export async function saveProfile(uid: string, p: BusinessProfile): Promise<void> {
  await setDoc(doc(init().db, "users", uid), { ...p }, { merge: true });
}

export async function loadHours(uid: string): Promise<Record<string, HourStat>> {
  const snap = await getDocs(collection(init().db, "users", uid, "hours"));
  const out: Record<string, HourStat> = {};
  snap.forEach((d) => (out[d.id] = parseHour(d.data())));
  return out;
}

/** Записать часы целиком (значение уже объединено с облаком по правилу максимума). */
export async function saveHours(uid: string, hours: Record<string, HourStat>): Promise<void> {
  const { db } = init();
  const entries = Object.entries(hours);
  for (let i = 0; i < entries.length; i += 400) {
    const batch = writeBatch(db);
    for (const [k, v] of entries.slice(i, i + 400)) batch.set(doc(db, "users", uid, "hours", k), { ...v });
    await batch.commit();
  }
}

/** Камера в пульсе точки (как у Mac): id, название, тип, считает ли, кадр/с, людей сегодня. */
export interface DeviceCamera {
  id: string;
  name: string;
  kind: string;
  counting: boolean;
  fps: number;
  todayPeople: number;
}

export async function saveDevice(
  uid: string, deviceId: string, s: DeviceStatus, extra: { platform?: string; cameras?: DeviceCamera[] } = {},
): Promise<void> {
  const data: Record<string, unknown> = { ...s, platform: extra.platform ?? "web", lastSeen: serverTimestamp() };
  if (extra.cameras?.length) data.cameras = extra.cameras;
  await setDoc(doc(init().db, "users", uid, "devices", deviceId), data, { merge: true });
}

export interface RemoteDevice extends DeviceStatus {
  id: string;
  lastSeen: Date | null;
  platform: string;
  /** Сколько камер у точки (0 — не сообщает, браузер). */
  cameraCount: number;
}

// ---------------------------------------------------------------- статистика по камерам (как CameraStats.swift)

/** Документ на камеру и день: { camera, name, day, device, hours: { "14": HourStat } }. */
export interface CameraDay {
  camera: string;
  name: string;
  day: string;
  hours: Record<string, HourStat>;
}

export async function saveCameraDays(uid: string, device: string, docs: Record<string, CameraDay>): Promise<void> {
  const { db } = init();
  const entries = Object.entries(docs);
  for (let i = 0; i < entries.length; i += 400) {
    const batch = writeBatch(db);
    for (const [id, d] of entries.slice(i, i + 400)) {
      const hours: Record<string, HourStat> = {};
      for (const [h, v] of Object.entries(d.hours)) hours[h] = { ...v };
      batch.set(doc(db, "users", uid, "camera_hours", id), { camera: d.camera, name: d.name, day: d.day, device, hours });
    }
    await batch.commit();
  }
}

/** Все камеры: камера → ключ часа (2026-10-15-14) → счётчики; и последние известные названия. */
export async function loadCameraHours(uid: string): Promise<{ hours: Record<string, Record<string, HourStat>>; names: Record<string, string> }> {
  const snap = await getDocs(collection(init().db, "users", uid, "camera_hours"));
  const hours: Record<string, Record<string, HourStat>> = {};
  const names: Record<string, string> = {};
  snap.forEach((d) => {
    const v = d.data() as Record<string, unknown>;
    const cam = typeof v.camera === "string" ? v.camera : null;
    const day = typeof v.day === "string" ? v.day : null;
    if (!cam || !day) return;
    if (typeof v.name === "string" && v.name) names[cam] = v.name;
    const hs = (v.hours ?? {}) as Record<string, Record<string, unknown>>;
    for (const [h, raw] of Object.entries(hs)) (hours[cam] ??= {})[`${day}-${h.padStart(2, "0")}`] = parseHour(raw);
  });
  return { hours, names };
}

export async function loadDevices(uid: string): Promise<RemoteDevice[]> {
  const snap = await getDocs(collection(init().db, "users", uid, "devices"));
  const out: RemoteDevice[] = [];
  snap.forEach((d) => {
    const v = d.data() as Record<string, unknown>;
    const ts = v.lastSeen as { toDate?: () => Date } | undefined;
    out.push({
      id: d.id,
      name: String(v.name ?? "Браузер"),
      point: String(v.point ?? ""),
      status: v.status === "counting" ? "counting" : "stopped",
      fps: Number(v.fps ?? 0),
      startedAt: typeof v.startedAt === "number" ? v.startedAt : null,
      today: parseHour(v.today as Record<string, unknown>),
      lastSeen: ts?.toDate ? ts.toDate() : null,
      platform: typeof v.platform === "string" ? v.platform : "web",
      cameraCount: Array.isArray(v.cameras) ? v.cameras.length : 0,
    });
  });
  return out;
}
