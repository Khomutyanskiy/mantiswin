#!/usr/bin/env node
// Mantis на этом компьютере без сервера разработки: отдаёт собранную страницу (dist/) и мост IP-камер.
//   npm run build && npm run serve        → http://localhost:8787
// Нужен для пилота на мини-ПК у витрины: страница, нейросеть и камеры — всё локально.

import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge } from "./api.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";

const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".png": "image/png", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json",
};

if (!existsSync(join(root, "index.html"))) {
  console.error("Нет сборки: сначала выполните npm run build");
  process.exit(1);
}

const bridge = createBridge();
const server = http.createServer((req, res) => {
  // Заголовки для многопоточного WASM
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  bridge.handle(req, res, () => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cross-Origin-Resource-Policy": "same-origin" });
    createReadStream(file).pipe(res);
  });
});
server.listen(port, host, () => console.log(`Mantis: http://localhost:${port}`));
const stop = () => {
  bridge.close();
  server.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
