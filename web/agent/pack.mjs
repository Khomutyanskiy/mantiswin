// Упаковать собранную страницу (dist/) в один файл для агента: [4 байта длина JSON][JSON-оглавление][данные].
// Bun встраивает в исполняемый файл только отдельные файлы, поэтому вся папка идёт одним архивом.
//   node agent/pack.mjs dist agent/build/assets.bin

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const [src = "dist", out = "agent/build/assets.bin"] = process.argv.slice(2);

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(src).sort();
const index = [];
const chunks = [];
let offset = 0;
for (const f of files) {
  const data = readFileSync(f);
  index.push({ path: "/" + relative(src, f).split("\\").join("/"), offset, size: data.length });
  chunks.push(data);
  offset += data.length;
}
const json = Buffer.from(JSON.stringify(index));
const head = Buffer.alloc(4);
head.writeUInt32LE(json.length);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([head, json, ...chunks]));
console.log(`${files.length} файлов, ${(offset / 1e6).toFixed(1)} МБ → ${out}`);
