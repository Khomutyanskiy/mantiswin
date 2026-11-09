// «О приложении»: версия, разработчик, приватность. Режим разработчика — 7 щелчков по версии (как AboutView на Mac).

import pkg from "../../package.json";

const DEV_KEY = "mantis.devMode";

export function mountAbout(root: HTMLElement, o: { backend: () => string; toast: (t: string) => void; platform: () => string }): { refresh(): void } {
  const card = document.createElement("div");
  card.className = "about-card";
  root.append(card);
  let taps = 0;
  const dev = () => {
    try {
      return localStorage.getItem(DEV_KEY) === "1";
    } catch {
      return false;
    }
  };
  const setDev = (on: boolean) => {
    try {
      if (on) localStorage.setItem(DEV_KEY, "1");
      else localStorage.removeItem(DEV_KEY);
    } catch {
      /* нет */
    }
  };
  const row = (k: string, v: string) => {
    const r = document.createElement("div");
    r.className = "about-row";
    const a = document.createElement("span");
    a.textContent = k;
    const b = document.createElement("b");
    b.textContent = v;
    r.append(a, b);
    return r;
  };
  function refresh(): void {
    const h = document.createElement("h1");
    h.textContent = "О приложении";
    const sub = document.createElement("p");
    sub.className = "eyebrow";
    sub.textContent = "Mantis · аналитика витрины";
    const ver = row("Версия", `${pkg.version} · ${o.platform()}`);
    ver.style.cursor = "default";
    ver.addEventListener("click", () => {
      taps += 1;
      if (taps < 7) return;
      taps = 0;
      setDev(!dev());
      o.toast(dev() ? "Режим разработчика включён" : "Режим разработчика выключен");
      refresh();
    });
    const priv = document.createElement("p");
    priv.className = "about-note";
    priv.textContent = "Видео и кадры обрабатываются только на этом компьютере, в браузере, и никуда не отправляются. Лица не сохраняются.";
    const box = document.createElement("section");
    box.className = "about-box";
    box.append(ver, row("Разработчик", "РСМ АйТи"), priv);
    const nodes: Node[] = [h, sub, box];
    if (dev()) {
      const d = document.createElement("section");
      d.className = "about-box";
      const t = document.createElement("p");
      t.className = "eyebrow";
      t.textContent = "Для разработчика";
      const off = document.createElement("button");
      off.type = "button";
      off.className = "btn small";
      off.textContent = "Выключить режим разработчика";
      off.addEventListener("click", () => {
        setDev(false);
        refresh();
      });
      d.append(t, row("Модель", "YOLO11n-pose, ONNX (onnxruntime-web)"), row("Нейросеть", o.backend()), row("Трекер", "ByteTrack"),
        row("Анализ", "15 кадров/с"), row("Совет", "?cpu в адресе — расчёт на процессоре"), off);
      nodes.push(d);
    }
    card.replaceChildren(...nodes);
  }
  refresh();
  return { refresh };
}
