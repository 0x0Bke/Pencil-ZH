"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PATCHES_DIR = path.join(__dirname, "..", "patches");
const PENCIL_STORAGE_PATH = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Code",
  "User",
  "globalStorage",
  "highagency.pencildev",
);
const VERSION_PATH = path.join(PENCIL_STORAGE_PATH, "current-version.json");
const TARGET_RELATIVE_PATH = "editor/assets/index.js";
const TARGET_PATH = path.join(PENCIL_STORAGE_PATH, TARGET_RELATIVE_PATH);
const CHECK_ONLY = process.argv.includes("--check");

function main() {
  if (!fs.existsSync(VERSION_PATH)) {
    fail(`未找到 Pencil editor 版本文件：${VERSION_PATH}`);
  }
  if (!fs.existsSync(TARGET_PATH)) {
    fail(`未找到 Pencil bundle：${TARGET_PATH}`);
  }

  const versionInfo = JSON.parse(fs.readFileSync(VERSION_PATH, "utf8"));
  const patchPath = findPatchPath(versionInfo.version);
  const patch = JSON.parse(fs.readFileSync(patchPath, "utf8"));
  const content = fs.readFileSync(TARGET_PATH);
  const text = content.toString("utf8");
  const filePatch = patch.files.find((file) => file.relativePath === TARGET_RELATIVE_PATH);
  if (!filePatch) {
    fail(`补丁文件中没有目标文件：${TARGET_RELATIVE_PATH}`);
  }

  assertLooksOriginal(text, filePatch.replacements);

  const currentSha256 = sha256(content);
  if (filePatch.originalSha256 === currentSha256) {
    console.log(`originalSha256 已是最新：${currentSha256}`);
    return;
  }

  if (CHECK_ONLY) {
    fail(
      `originalSha256 需要更新：${filePatch.originalSha256} -> ${currentSha256}。运行 npm run refresh-hash 更新。`,
    );
  }

  filePatch.originalSha256 = currentSha256;
  fs.writeFileSync(`${patchPath}.tmp`, `${JSON.stringify(patch, null, 2)}\n`, "utf8");
  fs.renameSync(`${patchPath}.tmp`, patchPath);
  console.log(`已更新 ${path.relative(process.cwd(), patchPath)} 的 originalSha256：${currentSha256}`);
}

function findPatchPath(editorVersion) {
  const patches = fs
    .readdirSync(PATCHES_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(PATCHES_DIR, file));
  for (const patchPath of patches) {
    const patch = JSON.parse(fs.readFileSync(patchPath, "utf8"));
    if (patch.editorVersion === editorVersion) {
      return patchPath;
    }
  }
  fail(`没有找到 editorVersion=${editorVersion} 的补丁 JSON。`);
}

function assertLooksOriginal(text, replacements) {
  const translatedHits = replacements.filter((replacement) => text.includes(replacement.to));
  if (translatedHits.length > 0) {
    fail(
      `当前 bundle 看起来已经被汉化或修改，拒绝刷新 originalSha256。命中的中文词条示例：${translatedHits
        .slice(0, 5)
        .map((replacement) => replacement.to)
        .join("，")}`,
    );
  }

  const sourceHits = replacements.filter((replacement) => text.includes(replacement.from));
  if (sourceHits.length === 0) {
    fail("当前 bundle 没有命中任何英文源词条，拒绝刷新 originalSha256。");
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

main();
