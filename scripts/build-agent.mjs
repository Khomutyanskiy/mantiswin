#!/usr/bin/env node
// Сборка встроенного агента для Mantis для Windows.
// Агент — web/agent/agent.ts (страница Mantis с нейросетью, мост IP-камер, ffmpeg), собирается Bun-ом в один .exe
// и кладётся туда, где его ждёт Tauri: src-tauri/binaries/mantis-agent-<триплет>(.exe).
//
//   node scripts/build-agent.mjs            — для Windows x64 (по умолчанию)
//   node scripts/build-agent.mjs --host     — для этого компьютера (tauri dev на Mac/Linux)
//
// Нужно: Node 20+, установленные зависимости web/ (npm ci), Bun ≥ 1.4 (переменная BUN, bun в PATH или web/node_modules).

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// web/ — рядом внутри репозитория mantiswin или соседняя папка в общем репозитории Mantis
const web = process.env.MANTIS_WEB
  ? resolve(process.env.MANTIS_WEB)
  : existsSync(join(root, "web", "package.json")) ? join(root, "web") : resolve(root, "..", "web");
const cache = join(root, ".cache");
const FFMPEG_RELEASE = "b6.1.1"; // тот же ffmpeg, что ставит пакет ffmpeg-static и web/agent/build.sh

const TARGETS = {
  "windows-x64": { bun: "bun-windows-x64", ffmpeg: "win32-x64", triple: "x86_64-pc-windows-msvc", exe: true },
  "darwin-arm64": { bun: "bun-darwin-arm64", ffmpeg: "darwin-arm64", triple: "aarch64-apple-darwin", exe: false },
  "darwin-x64": { bun: "bun-darwin-x64", ffmpeg: "darwin-x64", triple: "x86_64-apple-darwin", exe: false },
  "linux-x64": { bun: "bun-linux-x64", ffmpeg: "linux-x64", triple: "x86_64-unknown-linux-gnu", exe: false },
};

const hostKey = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const key = process.argv.includes("--host") ? hostKey : process.argv.find((a) => a in TARGETS) ?? "windows-x64";
const t = TARGETS[key];
if (!t) {
  console.error(`Неизвестная платформа: ${key}. Есть: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error(`Команда завершилась с ошибкой (${r.status ?? r.error?.message})`);
    process.exit(1);
  }
}

function findBun() {
  if (process.env.BUN) return process.env.BUN;
  const local = join(web, "node_modules", ".bin", process.platform === "win32" ? "bun.exe" : "bun");
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["bun"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split(/\r?\n/)[0];
  if (existsSync(local)) return local;
  console.error("Нет Bun: установите (https://bun.sh) или укажите путь в переменной BUN");
  process.exit(1);
}

async function ffmpeg(name) {
  mkdirSync(cache, { recursive: true });
  const file = join(cache, `ffmpeg-${name}${name.startsWith("win32") ? ".exe" : ""}`);
  if (existsSync(file) && statSync(file).size > 1_000_000) return file;
  const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_RELEASE}/ffmpeg-${name}.gz`;
  console.log(`Скачиваю ffmpeg: ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ffmpeg: ответ ${r.status}`);
  writeFileSync(file, gunzipSync(Buffer.from(await r.arrayBuffer())));
  return file;
}

console.log(`== Агент Mantis для ${key}`);
if (!existsSync(join(web, "node_modules"))) run("npm", ["ci", "--no-audit", "--no-fund", "--ignore-scripts"], web);

console.log("== Страница (web/dist)");
run("npm", ["run", "build", "--silent"], web);
mkdirSync(join(web, "agent", "build"), { recursive: true });
run("node", ["agent/pack.mjs", "dist", "agent/build/assets.bin"], web);

console.log("== ffmpeg");
copyFileSync(await ffmpeg(t.ffmpeg), join(web, "agent", "build", "ffmpeg.bin"));

console.log("== Bun → один исполняемый файл");
const outDir = join(root, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `mantis-agent-${t.triple}${t.exe ? ".exe" : ""}`);
rmSync(out, { force: true });
const args = ["build", "agent/agent.ts", "--compile", "--minify", `--target=${t.bun}`, "--loader", ".bin:file", "--outfile", out];
if (t.exe) args.splice(4, 0, "--windows-hide-console");
run(findBun(), args, web);
rmSync(join(web, "agent", "build", "ffmpeg.bin"), { force: true });
console.log(`Готово: ${out} (${(statSync(out).size / 1e6).toFixed(1)} МБ)`);
