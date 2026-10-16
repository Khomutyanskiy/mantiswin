// Состояние аккаунта для интерфейса: кто вошёл, профиль магазина, синхронизация часов с облаком.
// Логика как у AccountModel + HourlyStore в iOS: при входе облако и браузер объединяются (максимум по полям),
// дальше изменённые часы уходят в облако раз в минуту.

import type { User } from "firebase/auth";
import { HourlyStore } from "../pilot/hours";
import {
  type BusinessProfile, defaultProfile, friendlyError, loadHours, loadProfile, saveHours, saveProfile, watchAuth,
} from "./firebase";

export interface AccountState {
  user: User | null;
  profile: BusinessProfile;
  syncing: boolean;
  lastSync: Date | null;
  error: string | null;
}

const PROFILE_KEY = "mantis.profile.v1";

function loadLocalProfile(): BusinessProfile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) return { ...defaultProfile(), ...(JSON.parse(raw) as Partial<BusinessProfile>) };
  } catch {
    /* нет */
  }
  return defaultProfile();
}

export class Account {
  readonly hours = new HourlyStore();
  state: AccountState = { user: null, profile: loadLocalProfile(), syncing: false, lastSync: null, error: null };
  private listeners = new Set<(s: AccountState) => void>();
  private uploading = false;
  private ready: Promise<void>;

  constructor() {
    let resolveReady!: () => void;
    this.ready = new Promise((r) => (resolveReady = r));
    try {
      watchAuth((user) => {
        const changed = user?.uid !== this.state.user?.uid;
        this.set({ user });
        resolveReady();
        if (changed && user) void this.pull();
      });
    } catch (e) {
      this.set({ error: friendlyError(e) });
      resolveReady();
    }
  }

  /** Дождаться первого ответа Firebase о входе (после перезагрузки страницы). */
  whenReady(): Promise<void> {
    return this.ready;
  }

  get uid(): string | null {
    return this.state.user?.uid ?? null;
  }

  subscribe(fn: (s: AccountState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(p: Partial<AccountState>): void {
    this.state = { ...this.state, ...p };
    for (const fn of this.listeners) fn(this.state);
  }

  /** Подтянуть профиль и часы из облака и объединить с браузером. */
  async pull(): Promise<void> {
    const uid = this.uid;
    if (!uid) return;
    this.set({ syncing: true });
    try {
      const remote = await loadProfile(uid);
      if (remote) this.setProfile(remote, false);
      else await saveProfile(uid, this.state.profile);
      this.hours.merge(await loadHours(uid));
      await this.upload();
      this.set({ syncing: false, error: null, lastSync: new Date() });
    } catch (e) {
      this.set({ syncing: false, error: `Синхронизация: ${friendlyError(e)}` });
    }
  }

  setProfile(p: BusinessProfile, toCloud = true): void {
    this.set({ profile: p });
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
    } catch {
      /* нет */
    }
    const uid = this.uid;
    if (toCloud && uid) saveProfile(uid, p).catch((e) => this.set({ error: friendlyError(e) }));
  }

  /** Отправить изменённые часы. Если не получилось — они останутся в очереди. */
  async upload(): Promise<void> {
    const uid = this.uid;
    if (!uid || this.uploading || this.hours.pending === 0) return;
    this.uploading = true;
    const batch = this.hours.takeDirty();
    try {
      // Без интернета Firestore держит запись в своей очереди (и на диске) и отправит её сам —
      // поэтому долго не ждём, а просто сообщаем, что отправка отложена.
      const res = await Promise.race([
        saveHours(uid, batch).then(() => "sent" as const),
        new Promise<"queued">((r) => setTimeout(() => r("queued"), 20_000)),
      ]);
      if (res === "sent") this.set({ lastSync: new Date(), error: null });
      else this.set({ error: "Нет связи с облаком — данные отправятся, когда появится интернет" });
    } catch (e) {
      this.hours.markDirty(Object.keys(batch));
      this.set({ error: `Не отправилось в облако: ${friendlyError(e)}` });
    } finally {
      this.uploading = false;
    }
  }
}
