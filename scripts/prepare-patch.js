"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PATCHES_DIR = path.join(__dirname, "..", "patches");
const DEFAULT_PATCH_PATH = path.join(PATCHES_DIR, "translations.json");
const PENCIL_STORAGE_PATH = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Code",
  "User",
  "globalStorage",
  "highagency.pencildev",
);
const TARGET_RELATIVE_PATH = "editor/assets/index.js";
const TARGET_PATH = path.join(PENCIL_STORAGE_PATH, TARGET_RELATIVE_PATH);

const args = parseArgs(process.argv.slice(2));

function main() {
  const targetPatchPath = args.source ? getNextDictionaryPath(PATCHES_DIR) : DEFAULT_PATCH_PATH;
  const sourcePatchPath = args.source ? path.resolve(args.source) : targetPatchPath;
  assertFile(sourcePatchPath, "补丁词典");

  const patch = normalizePatch(readPatch(sourcePatchPath));
  reportSourceCoverage(patch);

  const rendered = `${JSON.stringify(patch, null, 2)}\n`;
  if (args.check) {
    const current = fs.existsSync(targetPatchPath)
      ? fs.readFileSync(targetPatchPath, "utf8")
      : "";
    if (current !== rendered) {
      fail(`${path.relative(process.cwd(), targetPatchPath)} 需要更新。`);
    }
    console.log(`${path.relative(process.cwd(), targetPatchPath)} 已是最新。`);
    return;
  }

  fs.writeFileSync(`${targetPatchPath}.tmp`, rendered, "utf8");
  fs.renameSync(`${targetPatchPath}.tmp`, targetPatchPath);
  console.log(`已更新 ${path.relative(process.cwd(), targetPatchPath)}`);
}

function normalizePatch(patch) {
  delete patch.id;
  delete patch.pencilExtensionVersion;
  delete patch.editorVersion;

  patch.domReplacements = normalizeReplacements(patch.domReplacements || []);
  patch.files = (patch.files || []).map((filePatch) => {
    const normalized = {
      relativePath: filePatch.relativePath,
      replacements: normalizeReplacements(filePatch.replacements || []),
    };
    return normalized;
  });

  return patch;
}

function normalizeReplacements(replacements) {
  const bySource = new Map();
  for (const replacement of replacements) {
    if (!replacement.from || !replacement.to) continue;
    bySource.set(replacement.from, {
      from: replacement.from,
      to: replacement.to,
    });
  }
  return [...bySource.values()];
}

function reportSourceCoverage(patch) {
  if (!fs.existsSync(TARGET_PATH)) {
    console.log(`未找到当前 Pencil bundle，跳过词条命中检查：${TARGET_PATH}`);
    return;
  }

  const text = fs.readFileSync(TARGET_PATH, "utf8");
  const filePatch = patch.files.find((file) => file.relativePath === TARGET_RELATIVE_PATH);
  if (!filePatch) {
    console.log(`词典中没有 ${TARGET_RELATIVE_PATH}，跳过词条命中检查。`);
    return;
  }

  const missing = filePatch.replacements.filter((replacement) => !text.includes(replacement.from));
  const hitCount = filePatch.replacements.length - missing.length;
  console.log(`当前 bundle 命中 ${hitCount}/${filePatch.replacements.length} 个英文源词条。`);
  if (missing.length > 0) {
    console.log(
      `未命中词条会保留在词典中。示例：${missing
        .slice(0, 12)
        .map((replacement) => replacement.from)
        .join("，")}`,
    );
  }
}

function getNextDictionaryPath(patchesDir) {
  const usedNumbers = new Set(
    fs
      .readdirSync(patchesDir)
      .map((fileName) => fileName.match(/^translations-(\d+)\.json$/))
      .filter(Boolean)
      .map((match) => Number.parseInt(match[1], 10)),
  );
  let nextNumber = 1;
  while (usedNumbers.has(nextNumber)) nextNumber++;
  return path.join(patchesDir, `translations-${String(nextNumber).padStart(3, "0")}.json`);
}

function readPatch(patchPath) {
  return JSON.parse(fs.readFileSync(patchPath, "utf8"));
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    fail(`未找到 ${label}：${filePath}`);
  }
}

function parseArgs(rawArgs) {
  const parsed = { check: false };
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (arg === "--check") {
      parsed.check = true;
      continue;
    }
    if (arg === "--source") {
      const value = rawArgs[index + 1];
      if (!value) fail(`${arg} 需要一个值。`);
      parsed.source = value;
      index++;
      continue;
    }
    fail(`未知参数：${arg}`);
  }
  return parsed;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

main();
