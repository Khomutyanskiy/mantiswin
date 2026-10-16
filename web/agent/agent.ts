// Mantis Агент — одна программа для компьютера у витрины (Mac / Windows).
// Внутри: страница Mantis с нейросетью, мост IP-камер (поиск ONVIF, RTSP → кадры) и ffmpeg.
// Запуск: двойной клик → открывается браузер на http://localhost:8787. Повторный запуск просто открывает браузер.
// Собирается Bun-ом в исполняемый файл: agent/build.sh.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import { join } from "node:path";
// @ts-expect-error — мост написан на чистом JS
import { createBridge } from "../bridge/api.mjs";
import pkg from "../package.json";
// Встроенные файлы (кладёт agent/build.sh перед сборкой под каждую платформу)
// @ts-expect-error — путь к встроенному файлу
import assetsFile from "./build/assets.bin" with { type: "file" };
// @ts-expect-error — путь к встроенному файлу
import ffmpegFile from "./build/ffmpeg.bin" with { type: "file" };

const VERSION: string = pkg.version;
const BASE_PORT = Number(process.env.MANTIS_PORT || 8787);
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const noBrowser = process.argv.includes("--no-browser");
/** Агент запущен настольным приложением (Mantis для Windows): окно со страницей и автозапуск — у приложения. */
const SHELL = process.env.MANTIS_SHELL || "";
const PARENT_PID = Number(process.env.MANTIS_PARENT_PID || 0);

// ---------------------------------------------------------------- папка данных и журнал
const dataDir = isMac
  ? join(os.homedir(), "Library", "Application Support", "Mantis Agent")
  : isWin
    ? join(process.env.LOCALAPPDATA || join(os.homedir(), "AppData", "Local"), "Mantis Agent")
    : join(os.homedir(), ".local", "share", "mantis-agent");
mkdirSync(dataDir, { recursive: true });
const logFile = join(dataDir, "agent.log");
try {
  if (existsSync(logFile) && statSync(logFile).size > 5_000_000) unlinkSync(logFile);
} catch {
  /* нет */
}
function log(...a: unknown[]): void {
  const line = `${new Date().toISOString()} ${a.map(String).join(" ")}`;
  console.log(line);
  try {
    appendFileSync(logFile, line + "\n");
  } catch {
    /* нет */
  }
}

// ---------------------------------------------------------------- ffmpeg из встроенного файла
async function prepareFfmpeg(): Promise<string> {
  const target = join(dataDir, isWin ? `ffmpeg-${VERSION}.exe` : `ffmpeg-${VERSION}`);
  const src = Bun.file(ffmpegFile);
  if (!existsSync(target) || statSync(target).size !== src.size) {
    log("Распаковываю ffmpeg →", target);
    writeFileSync(target, new Uint8Array(await src.arrayBuffer()));
    if (!isWin) chmodSync(target, 0o755);
  }
  return target;
}

// ---------------------------------------------------------------- страница из встроенного архива
interface Entry {
  path: string;
  offset: number;
  size: number;
}
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript", mjs: "text/javascript", css: "text/css", wasm: "application/wasm",
  onnx: "application/octet-stream", png: "image/png", svg: "image/svg+xml", woff2: "font/woff2", woff: "font/woff", json: "application/json",
};

async function loadSite(): Promise<Map<string, Uint8Array>> {
  const buf = new Uint8Array(await Bun.file(assetsFile).arrayBuffer());
  const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true);
  const index = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + len))) as Entry[];
  const base = 4 + len;
  const site = new Map<string, Uint8Array>();
  for (const e of index) site.set(e.path, buf.subarray(base + e.offset, base + e.offset + e.size));
  return site;
}

// ---------------------------------------------------------------- автозапуск при входе в систему
const LAUNCH_LABEL = "ru.rsmit.mantis-agent";
const launchPlist = join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);

function autostartEnabled(): boolean {
  if (isMac) return existsSync(launchPlist);
  if (isWin) {
    const r = spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "MantisAgent"], { windowsHide: true });
    return r.status === 0;
  }
  return false;
}

function setAutostart(on: boolean): void {
  const exe = process.execPath;
  if (isMac) {
    if (on) {
      mkdirSync(join(os.homedir(), "Library", "LaunchAgents"), { recursive: true });
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      writeFileSync(
        launchPlist,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(exe)}</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`,
      );
    } else if (existsSync(launchPlist)) unlinkSync(launchPlist);
  } else if (isWin) {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    if (on) spawnSync("reg", ["add", key, "/v", "MantisAgent", "/t", "REG_SZ", "/d", `"${exe}"`, "/f"], { windowsHide: true });
    else spawnSync("reg", ["delete", key, "/v", "MantisAgent", "/f"], { windowsHide: true });
  } else {
    throw new Error("Автозапуск поддерживается на macOS и Windows");
  }
}

// ---------------------------------------------------------------- браузер
function openBrowser(url: string): void {
  if (noBrowser || SHELL) return;
  log("Открываю браузер:", url);
  const cmd = isMac ? ["open", [url]] : isWin ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch (e) {
    log("Не удалось открыть браузер:", e);
  }
}

/** Агент уже запущен? Тогда просто откроем страницу. */
function probe(port: number): Promise<"mantis" | "busy" | "free"> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/agent", timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body.includes('"agent":"mantis"') ? "mantis" : "busy"));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code === "ECONNREFUSED" ? "free" : "busy"));
  });
}

// ---------------------------------------------------------------- запуск
async function main(): Promise<void> {
  log(`Mantis Агент ${VERSION} · ${process.platform}-${process.arch}`);
  let port = BASE_PORT;
  for (; port < BASE_PORT + 10; port++) {
    const st = await probe(port);
    if (st === "mantis") {
      openBrowser(`http://localhost:${port}/`);
      log("Агент уже работает на порту", port);
      ready(port);
      setTimeout(() => process.exit(0), 500);
      return;
    }
    if (st === "free") break;
  }

  process.env.FFMPEG_PATH = await prepareFfmpeg();
  const site = await loadSite();
  const bridge = createBridge();

  const send = (res: http.ServerResponse, code: number, data: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  };
  const readBody = (req: http.IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        try {
          resolve(b ? JSON.parse(b) : {});
        } catch {
          resolve({});
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    const url = new URL(req.url ?? "/", "http://localhost");
    // Команды самого агента
    if (url.pathname === "/api/agent" && req.method === "GET") {
      return send(res, 200, {
        agent: "mantis", version: VERSION, platform: process.platform, shell: SHELL || null, hostname: os.hostname(),
        autostart: SHELL ? false : autostartEnabled(), log: logFile,
      });
    }
    if (url.pathname === "/api/agent/autostart" && req.method === "POST") {
      if (SHELL) return send(res, 409, { error: "Автозапуском управляет приложение Mantis" });
      try {
        const b = await readBody(req);
        setAutostart(!!b.enabled);
        log("Автозапуск:", !!b.enabled);
        return send(res, 200, { autostart: autostartEnabled() });
      } catch (e) {
        return send(res, 500, { error: (e as Error).message });
      }
    }
    if (url.pathname === "/api/agent/quit" && req.method === "POST") {
      log("Выключение по команде со страницы");
      send(res, 200, { ok: true });
      setTimeout(() => {
        bridge.close();
        process.exit(0);
      }, 300);
      return;
    }
    // Мост IP-камер, затем страница
    bridge.handle(req, res, () => {
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith("/")) path += "index.html";
      let data = site.get(path);
      if (!data) {
        path = "/index.html";
        data = site.get(path)!;
      }
      const ext = path.split(".").pop() ?? "";
      res.writeHead(200, {
        "Content-Type": TYPES[ext] ?? "application/octet-stream",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cache-Control": path === "/index.html" ? "no-cache" : "public, max-age=31536000, immutable",
      });
      res.end(data);
    });
  });

  // Только этот компьютер: снаружи агент не виден
  server.listen(port, "127.0.0.1", () => {
    log(`Работаю: http://localhost:${port}/ · журнал ${logFile}`);
    ready(port);
    openBrowser(`http://localhost:${port}/`);
  });
  const stop = () => {
    bridge.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Приложение закрылось или упало — агент не остаётся висеть без окна
  if (PARENT_PID) {
    setInterval(() => {
      try {
        process.kill(PARENT_PID, 0);
      } catch {
        log("Приложение закрылось — выключаюсь");
        stop();
      }
    }, 5000).unref();
  }
}

/** Строка для настольного приложения: на каком порту страница (приложение читает stdout агента). */
function ready(port: number): void {
  if (SHELL) process.stdout.write(`MANTIS_READY port=${port}\n`);
}

main().catch((e) => {
  log("Ошибка запуска:", e?.stack ?? e);
  process.exit(1);
});
