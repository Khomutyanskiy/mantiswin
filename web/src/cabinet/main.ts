// Личный кабинет руководителя (cabinet.html): живой цифровой двойник точки с любого устройства.
// Всё содержимое — в view.ts (то же показывает раздел «Точки» в приложении); здесь — вход и запуск страницы.

import "@fontsource-variable/onest";
import "@fontsource/jetbrains-mono/400.css";
import "../styles.css";
import { watchAuth } from "../cloud/firebase";
import { cabinetError, mountCabinet } from "./view";

const cab = mountCabinet(document.getElementById("cabinet")!);
try {
  watchAuth((user) => cab.setUser(user));
} catch (e) {
  cabinetError(e);
}
