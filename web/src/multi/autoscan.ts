// Новая IP-камера без ручных шагов — порт IPAutoDiscoveryView.swift (Mantis для Mac): при открытии сразу ищем
// камеры в сети, у каждой найденной сами подбираем адрес потока и вход и проверяем, что видео идёт.
// Подключившиеся отмечены — остаётся нажать «Добавить». Пароль спрашиваем только у камер, где не подошли
// ни заводские, ни уже известные (пароли уже добавленных камер — обычно у всех камер магазина один).

import { type AutoFound, type FoundCamera, type IpCameraConfig, autoConnect, bridgeInfo, scanCameras } from "../sources";

type RowState =
  | { s: "connecting" }
  | { s: "ready"; found: AutoFound }
  | { s: "needsPassword" }
  | { s: "failed"; message: string }
  | { s: "added" };

interface Row {
  cam: FoundCamera;
  state: RowState;
  selected: boolean;
  user: string;
  password: string;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

export interface AutoScanDeps {
  /** Входы уже добавленных IP-камер. */
  known: () => [string, string][];
  /** Адреса уже добавленных камер. */
  added: () => Set<string>;
  /** Ввести адрес вручную (прежнее окно IP-камеры). */
  manual: () => void;
  /** Изменился выбор — обновить кнопку «Добавить». */
  onChange: () => void;
}

export interface AutoScanPanel {
  root: HTMLElement;
  /** Отмеченные подключившиеся камеры → настройки для добавления. */
  selected(): { cfg: IpCameraConfig; android: boolean }[];
  markAdded(): void;
  start(): void;
}

export function autoScanPanel(deps: AutoScanDeps): AutoScanPanel {
  const root = el("div", "autoscan");
  let rows: Row[] = [];
  let scanning = false;
  let subnet = "";
  let note: string | null = null;

  async function scan(): Promise<void> {
    if (scanning) return;
    const info = await bridgeInfo();
    if (!info) {
      note = "Поиск IP-камер работает в приложении Mantis для Windows и в Mantis Агенте (нужен мост камер). Введите адрес вручную.";
      render();
      return;
    }
    scanning = true;
    note = null;
    subnet = info.subnets.join(", ");
    render();
    try {
      const r = await scanCameras();
      const added = deps.added();
      const next: Row[] = [];
      for (const cam of r.cameras) {
        const old = rows.find((x) => x.cam.ip === cam.ip);
        if (old && old.state.s !== "connecting" && old.state.s !== "failed") next.push(old);
        else next.push({ cam, state: added.has(cam.ip) ? { s: "added" } : { s: "connecting" }, selected: false, user: "admin", password: "" });
      }
      rows = next;
      if (!r.subnets.length) note = "Нет подключения к сети. Подключите компьютер к сети магазина, где стоят камеры.";
    } catch (e) {
      note = `Поиск не удался: ${(e as Error).message}`;
    } finally {
      scanning = false;
    }
    render();
    await resolvePending();
  }

  /** Подбираем адреса у всех ожидающих, по 4 камеры одновременно. */
  async function resolvePending(): Promise<void> {
    const known = deps.known();
    const queue = rows.filter((r) => r.state.s === "connecting");
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        const out = await autoConnect(r.cam, known).catch((e) => ({ state: "failed" as const, message: (e as Error).message }));
        r.state = out.state === "ok" ? { s: "ready", found: out.found } : out.state === "needsPassword" ? { s: "needsPassword" } : { s: "failed", message: out.message };
        if (out.state === "ok") r.selected = true;
        render();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  async function connect(r: Row): Promise<void> {
    r.state = { s: "connecting" };
    render();
    // свой вход — первым; неверных попыток нет
    const out = await autoConnect(r.cam, [[r.user.trim(), r.password]], 0).catch((e) => ({ state: "failed" as const, message: (e as Error).message }));
    r.state = out.state === "ok" ? { s: "ready", found: out.found } : out.state === "needsPassword" ? { s: "failed", message: "Логин или пароль не подошли" } : { s: "failed", message: out.message };
    if (out.state === "ok") r.selected = true;
    render();
  }

  function render(): void {
    const head = el("div", "row-between");
    head.append(el("b", "small", subnet ? `Камеры в сети ${subnet}` : "Камеры в сети"));
    const again = button("Искать снова", "link", () => void scan());
    again.disabled = scanning || rows.some((r) => r.state.s === "connecting");
    head.append(again);
    const nodes: Node[] = [head];
    if (scanning) nodes.push(el("p", "autoscan-note", `Ищем камеры в сети${subnet ? ` ${subnet}` : ""}…`));
    else if (note) nodes.push(el("p", "autoscan-note warn-text", note));
    else if (!rows.length) nodes.push(el("p", "autoscan-note", "Камеры не найдены. Проверьте, что камера включена и в той же сети, что и компьютер, или введите адрес вручную."));
    for (const r of rows) {
      const row = el("div", `autoscan-row${r.selected ? " on" : ""}`);
      const ico = el("span", "autoscan-ico", r.cam.android ? "📱" : r.cam.onvifURL ? "◉" : "▣");
      const txt = el("div", "autoscan-text");
      const title = r.cam.name || r.cam.hardware || (r.cam.android ? "Телефон Android (IP Webcam)" : "IP-камера");
      const meta = el("div", "autoscan-meta");
      meta.append(el("span", "cam-kind", r.cam.android ? "Android" : "IP"), el("span", "mono small faint", r.cam.ip));
      const st = el("div", "autoscan-status");
      switch (r.state.s) {
        case "connecting": st.textContent = "Подключаемся…"; st.className = "autoscan-status faint"; break;
        case "ready": st.textContent = `✓ Подключено · ${r.state.found.codec} · ${r.state.found.how}`; st.className = "autoscan-status ok"; break;
        case "needsPassword": st.textContent = "🔒 Нужен пароль камеры"; st.className = "autoscan-status warn-text"; break;
        case "failed": st.textContent = `⚠ ${r.state.message}`; st.className = "autoscan-status warn-text"; break;
        case "added": st.textContent = "Уже добавлена"; st.className = "autoscan-status faint"; break;
      }
      txt.append(el("b", undefined, title), meta, st);
      row.append(ico, txt);
      if (r.state.s === "ready") {
        row.append(el("span", `rp-tick${r.selected ? " on" : ""}`, r.selected ? "✓" : ""));
        row.addEventListener("click", () => {
          r.selected = !r.selected;
          render();
          deps.onChange();
        });
      } else if (r.state.s === "failed") {
        row.append(button("Ввести пароль", "link", () => {
          r.state = { s: "needsPassword" };
          render();
        }));
      }
      const wrap = el("div", "autoscan-item");
      wrap.append(row);
      if (r.state.s === "needsPassword") {
        const f = el("div", "autoscan-login");
        const u = el("input", "input");
        u.placeholder = "Логин";
        u.value = r.user;
        u.addEventListener("input", () => (r.user = u.value));
        const p = el("input", "input");
        p.type = "password";
        p.placeholder = "Пароль камеры";
        p.value = r.password;
        p.addEventListener("input", () => (r.password = p.value));
        p.addEventListener("keydown", (e) => e.key === "Enter" && void connect(r));
        f.append(u, p, button("Подключить", "btn primary small", () => void connect(r)));
        wrap.append(f);
      }
      nodes.push(wrap);
    }
    nodes.push(button("Ввести адрес вручную", "link", deps.manual));
    nodes.push(el("p", "hint-small faint", "Ищем камеры с ONVIF, устройства с открытым портом RTSP и телефоны Android с IP Webcam, сами подбираем адрес потока и вход (сначала — пароль уже добавленных камер, затем заводские) и проверяем видео. Пароль спросим, только если не подошёл ни один. Если Windows спросила про доступ к сети — разрешите и нажмите «Искать снова»."));
    root.replaceChildren(...nodes);
    if (mounted) deps.onChange();
  }

  let mounted = false;
  render();
  mounted = true;
  return {
    root,
    selected() {
      return rows.flatMap((r) => (r.state.s === "ready" && r.selected
        ? [{ cfg: { url: r.state.found.url, user: r.state.found.user, password: r.state.found.password, title: r.cam.name || r.cam.hardware || r.cam.ip }, android: !!r.cam.android }]
        : []));
    },
    markAdded() {
      for (const r of rows) if (r.state.s === "ready" && r.selected) {
        r.state = { s: "added" };
        r.selected = false;
      }
      render();
    },
    start() {
      if (!rows.length && !scanning) void scan();
    },
  };
}
