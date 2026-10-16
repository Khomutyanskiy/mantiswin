// Настольная оболочка Mantis (Windows, Tauri): страница та же, но открыта внутри приложения.
// Оболочка открывает страницу с ?desktop=windows и даёт несколько команд через IPC Tauri:
// запрет сна, автозапуск при входе в систему, сведения о компьютере, выход.
// В обычном браузере всё это недоступно — функции возвращают null / false.

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

interface TauriInternals {
  invoke: Invoke;
}

const params = new URLSearchParams(location.search);
const FLAG = "mantis.desktop";

/** Название платформы оболочки: "windows" или null (обычный браузер). */
export const desktopShell: string | null = (() => {
  const q = params.get("desktop");
  try {
    // запоминаем: после перезагрузки страницы без параметра (F5) режим остаётся
    if (q) sessionStorage.setItem(FLAG, q);
    return q ?? sessionStorage.getItem(FLAG) ?? (hasIpc() ? "windows" : null);
  } catch {
    return q ?? (hasIpc() ? "windows" : null);
  }
})();

export const isDesktop = desktopShell !== null;

function hasIpc(): boolean {
  return typeof (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__?.invoke === "function";
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  const ipc = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (!ipc?.invoke) return null;
  try {
    return (await ipc.invoke(cmd, args)) as T;
  } catch (e) {
    console.warn("[mantis] команда оболочки не выполнилась:", cmd, e);
    return null;
  }
}

export interface DesktopInfo {
  version: string;
  hostname: string;
  autostart: boolean;
}

export function desktopInfo(): Promise<DesktopInfo | null> {
  return call<DesktopInfo>("app_info");
}

/** Не давать компьютеру и экрану засыпать, пока идёт пилот. */
export async function keepAwake(on: boolean): Promise<void> {
  await call("keep_awake", { on });
}

export async function setAutostart(on: boolean): Promise<boolean | null> {
  return call<boolean>("set_autostart", { on });
}

export async function quitApp(): Promise<void> {
  await call("quit_app");
}

/** Оболочка спрашивает перед закрытием окна: идёт ли подсчёт (тогда окно прячется в трей). */
export function reportPilotRunning(running: boolean): void {
  void call("pilot_state", { running });
}
