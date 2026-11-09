// Realtime Database цифрового двойника (живое состояние точек) — одно подключение на страницу.
// Только WebSocket: запасной способ SDK (long-polling через <script>) на этой странице не работает —
// её изоляция (COOP/COEP, нужна нейросети) блокирует такие скрипты, и подключение молча «висит».

import { type Database, forceWebSockets, getDatabase } from "firebase/database";
import { firebaseApp } from "./firebase";

/** База проекта (регион europe-west1), как TwinKeys.defaultDatabaseURL в iOS. */
export const TWIN_DB_URL = "https://jinpix-ac93d-default-rtdb.europe-west1.firebasedatabase.app";

let forced = false;

export function twinDatabase(url = TWIN_DB_URL): Database {
  if (!forced) {
    forceWebSockets();
    forced = true;
    try {
      // прошлый неудачный WebSocket SDK запоминает и дальше пробует только long-polling — сбрасываем
      for (const k of Object.keys(localStorage)) if (k.startsWith("firebase:previous_websocket_failure")) localStorage.removeItem(k);
    } catch {
      /* нет хранилища */
    }
  }
  return getDatabase(firebaseApp(), url);
}
