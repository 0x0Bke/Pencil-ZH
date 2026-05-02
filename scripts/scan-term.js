"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const term = process.argv.slice(2).join(" ");
if (!term) {
  console.error("用法：npm run scan-term -- \"Frame\"");
  process.exit(1);
}

const bundlePath = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Code",
  "User",
  "globalStorage",
  "highagency.pencildev",
  "editor",
  "assets",
  "index.js",
);

if (!fs.existsSync(bundlePath)) {
  console.error(`未找到 Pencil bundle：${bundlePath}`);
  process.exit(1);
}

const content = fs.readFileSync(bundlePath, "utf8");
const positions = [];
let index = content.indexOf(term);
while (index !== -1) {
  positions.push(index);
  index = content.indexOf(term, index + term.length);
}

console.log(`term: ${term}`);
console.log(`matches: ${positions.length}`);
console.log("");

for (const position of positions.slice(0, 30)) {
  const start = Math.max(0, position - 90);
  const end = Math.min(content.length, position + term.length + 90);
  const snippet = content
    .slice(start, end)
    .replace(/\s+/g, " ")
    .replaceAll(term, `>>>${term}<<<`);
  console.log(`@${position}: ${snippet}`);
}

if (positions.length > 30) {
  console.log(`... ${positions.length - 30} more`);
}
