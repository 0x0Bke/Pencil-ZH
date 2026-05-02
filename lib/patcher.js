"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PATCHES_DIR = path.join(__dirname, "..", "patches");
const PATCH_FILES = fs.existsSync(DEFAULT_PATCHES_DIR)
  ? fs.readdirSync(DEFAULT_PATCHES_DIR).filter((fileName) => fileName.endsWith(".json")).sort()
  : [];
const PATCH_FILE = PATCH_FILES[PATCH_FILES.length - 1] || "";
const DOM_SCRIPT_MARKER = "pencil-zh-dom-translator";

function loadPatch(patchPath) {
  return JSON.parse(fs.readFileSync(patchPath, "utf8"));
}

function loadPatches(patchesDir) {
  return listPatchFiles(patchesDir).map((fileName) =>
    loadPatch(path.join(patchesDir, fileName)),
  );
}

function listPatchFiles(patchesDir) {
  return fs
    .readdirSync(patchesDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();
}

function selectPatch(patches, env) {
  return mergePatches(patches);
}

function mergePatches(patches) {
  const filesByPath = new Map();
  const domReplacementsBySource = new Map();

  for (const patch of patches) {
    for (const filePatch of patch.files || []) {
      const mergedFilePatch = filesByPath.get(filePatch.relativePath) || {
        relativePath: filePatch.relativePath,
        replacements: [],
      };
      const replacementsBySource = new Map(
        mergedFilePatch.replacements.map((replacement) => [replacement.from, replacement]),
      );
      for (const replacement of filePatch.replacements || []) {
        replacementsBySource.set(replacement.from, replacement);
      }
      mergedFilePatch.replacements = [...replacementsBySource.values()];
      filesByPath.set(filePatch.relativePath, mergedFilePatch);
    }

    for (const replacement of patch.domReplacements || []) {
      domReplacementsBySource.set(replacement.from, replacement);
    }
  }

  return {
    id: "pencil-zh-text-replacements",
    files: [...filesByPath.values()],
    domReplacements: [...domReplacementsBySource.values()],
  };
}

async function getPatchStatus(env, patch) {
  const files = patch.files.map((filePatch) => {
    const filePath = resolveTargetPath(env, filePatch.relativePath);
    const exists = fs.existsSync(filePath);
    const currentSha256 = exists ? sha256File(filePath) : "";
    const content = exists ? fs.readFileSync(filePath, "utf8") : "";
    const state = !exists
      ? "missing"
      : getTextPatchState(content, filePatch.replacements);

    return {
      relativePath: filePatch.relativePath,
      filePath,
      currentSha256,
      state,
      stateLabel: labelState(state),
    };
  });

  const supported = files.every((file) => file.state !== "missing");
  const patched = files.length > 0 && files.every((file) => file.state === "patched");
  const original = files.length > 0 && files.every((file) => file.state === "original");
  const partial = files.length > 0 && files.some((file) => file.state === "partial");
  const noMatch = files.length > 0 && files.every((file) => file.state === "no-match");

  return {
    pencilExtensionVersion: env.pencilExtensionVersion,
    editorVersion: env.editorVersion,
    supported,
    patched,
    original,
    partial,
    backupDir: getBackupDir(env, patch),
    files,
    stateLabel: patched
      ? "已汉化"
      : original
        ? "原版"
        : partial
          ? "部分汉化"
          : noMatch
            ? "未命中词条"
        : supported
          ? "可处理"
          : "目标文件缺失",
  };
}

async function applyPatch(env, patch) {
  const status = await getPatchStatus(env, patch);
  if (!status.supported) {
    throw new Error("Pencil editor 目标文件缺失，无法应用汉化。");
  }

  const prepared = [];
  for (const filePatch of patch.files) {
    const filePath = resolveTargetPath(env, filePatch.relativePath);
    const current = fs.readFileSync(filePath, "utf8");
    const backupPath = getBackupPath(env, patch, filePatch.relativePath);
    const currentState = getTextPatchState(current, filePatch.replacements);
    const shouldUseBackup =
      fs.existsSync(backupPath) &&
      currentState !== "original" &&
      hasSourceHits(fs.readFileSync(backupPath, "utf8"), filePatch.replacements);
    const source = shouldUseBackup ? fs.readFileSync(backupPath, "utf8") : current;
    const result = replaceAllAvailable(source, filePatch.replacements);
    if (result.content !== current) {
      prepared.push({
        filePatch,
        filePath,
        original: source,
        patched: result.content,
        replacementCount: result.replacementCount,
        overwriteBackup: currentState === "original",
      });
    }
  }

  if (Array.isArray(patch.domReplacements) && patch.domReplacements.length > 0) {
    const relativePath = "editor/index.html";
    const filePath = resolveTargetPath(env, relativePath);
    const current = fs.readFileSync(filePath, "utf8");
    const backupPath = getBackupPath(env, patch, relativePath);
    const shouldUseBackup = fs.existsSync(backupPath) && current.includes(DOM_SCRIPT_MARKER);
    const source = shouldUseBackup ? fs.readFileSync(backupPath, "utf8") : current;
    const patched = injectDomTranslator(source, patch.domReplacements);
    if (patched !== current) {
      prepared.push({
        filePatch: {
          relativePath,
        },
        filePath,
        original: source,
        patched,
        replacementCount: 0,
        overwriteBackup: !current.includes(DOM_SCRIPT_MARKER),
      });
    }
  }

  ensureBackupDir(env, patch);
  let replacementCount = 0;
  const resultFiles = [];
  for (const item of prepared) {
    writeBackupIfNeeded(env, patch, item.filePatch, item.original, {
      overwrite: item.overwriteBackup,
    });
    fs.writeFileSync(item.filePath, item.patched, "utf8");
    replacementCount += item.replacementCount || 0;
    resultFiles.push({
      relativePath: item.filePatch.relativePath,
      currentSha256: sha256File(item.filePath),
      stateLabel: "已汉化",
    });
  }

  return {
    files: resultFiles,
    replacementCount,
    alreadyPatched: resultFiles.length === 0,
  };
}

async function restorePatch(env, patch) {
  const restored = [];
  for (const filePatch of patch.files) {
    const targetPath = resolveTargetPath(env, filePatch.relativePath);
    const backupPath = getBackupPath(env, patch, filePatch.relativePath);
    if (!fs.existsSync(backupPath)) {
      continue;
    }

    fs.copyFileSync(backupPath, targetPath);
    restored.push({
      relativePath: filePatch.relativePath,
      currentSha256: sha256File(targetPath),
      stateLabel: "原版",
    });
  }

  const htmlBackupPath = getBackupPath(env, patch, "editor/index.html");
  const htmlTargetPath = resolveTargetPath(env, "editor/index.html");
  if (fs.existsSync(htmlBackupPath)) {
    fs.copyFileSync(htmlBackupPath, htmlTargetPath);
    restored.push({
      relativePath: "editor/index.html",
      currentSha256: sha256File(htmlTargetPath),
      stateLabel: "原版",
    });
  } else if (fs.existsSync(htmlTargetPath)) {
    const current = fs.readFileSync(htmlTargetPath, "utf8");
    const cleaned = removeDomTranslator(current);
    if (cleaned !== current) {
      fs.writeFileSync(htmlTargetPath, cleaned, "utf8");
      restored.push({
        relativePath: "editor/index.html",
        currentSha256: sha256File(htmlTargetPath),
        stateLabel: "已移除 DOM 翻译脚本",
      });
    }
  }

  return { files: restored };
}

function replaceAllAvailable(content, replacements) {
  let next = content;
  let replacementCount = 0;
  const orderedReplacements = [...replacements].sort((left, right) => {
    return right.from.length - left.from.length;
  });
  for (const replacement of orderedReplacements) {
    if (!replacement.from || !next.includes(replacement.from)) {
      continue;
    }
    const parts = next.split(replacement.from);
    replacementCount += parts.length - 1;
    next = parts.join(replacement.to);
  }
  return { content: next, replacementCount };
}

function injectDomTranslator(html, domReplacements) {
  const cleaned = removeDomTranslator(html);
  const script = buildDomTranslatorScript(domReplacements);
  if (!cleaned.includes("</body>")) {
    throw new Error("index.html 未找到 </body>，无法注入 DOM 翻译脚本。");
  }
  return cleaned.replace("</body>", `${script}\n  </body>`);
}

function removeDomTranslator(html) {
  const pattern = new RegExp(
    `\\n?\\s*<script id="${DOM_SCRIPT_MARKER}">[\\s\\S]*?<\\/script>\\s*`,
    "g",
  );
  return html.replace(pattern, "\n");
}

function buildDomTranslatorScript(domReplacements) {
  const dict = Object.fromEntries(domReplacements.map(({ from, to }) => [from, to]));
  return `  <script id="${DOM_SCRIPT_MARKER}">
    (() => {
      const dict = new Map(Object.entries(${JSON.stringify(dict)}));
      const ignoredTags = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT"]);
      let translating = false;

      function translateTextNode(node) {
        const value = node.nodeValue;
        if (!value) return;
        const parent = node.parentElement;
        if (!parent || ignoredTags.has(parent.tagName)) return;
        const trimmed = value.trim();
        const translated = dict.get(trimmed);
        if (!translated) return;
        node.nodeValue = value.replace(trimmed, translated);
      }

      function translateAttribute(element, name) {
        const value = element.getAttribute(name);
        if (!value) return;
        const translated = dict.get(value.trim());
        if (translated) element.setAttribute(name, value.replace(value.trim(), translated));
      }

      function translateElementAttributes(element) {
        translateAttribute(element, "title");
        translateAttribute(element, "aria-label");
        translateAttribute(element, "placeholder");
      }

      function walk(root) {
        if (root.nodeType === Node.ELEMENT_NODE) {
          translateElementAttributes(root);
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) translateTextNode(node);
        if (root.querySelectorAll) {
          for (const element of root.querySelectorAll("[title],[aria-label],[placeholder]")) {
            translateElementAttributes(element);
          }
        }
      }

      function translate(root = document.body) {
        if (!root || translating) return;
        translating = true;
        try {
          if (root.nodeType === Node.TEXT_NODE) translateTextNode(root);
          else walk(root);
        } finally {
          translating = false;
        }
      }

      if (document.body) translate();
      else document.addEventListener("DOMContentLoaded", () => translate(), { once: true });

      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === "characterData") translate(mutation.target);
          for (const node of mutation.addedNodes) translate(node);
          if (mutation.type === "attributes") translate(mutation.target);
        }
      }).observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["title", "aria-label", "placeholder"]
      });
    })();
  </script>`;
}

function looksPatched(content, replacements) {
  return getTextPatchState(content, replacements) === "patched";
}

function looksPartiallyPatched(content, replacements) {
  return getTextPatchState(content, replacements) === "partial";
}

function getTextPatchState(content, replacements) {
  let sourceHits = 0;
  let targetHits = 0;
  for (const replacement of replacements || []) {
    if (replacement.from && content.includes(replacement.from)) sourceHits++;
    if (replacement.to && content.includes(replacement.to)) targetHits++;
  }
  if (sourceHits > 0 && targetHits > 0) return "partial";
  if (sourceHits > 0) return "original";
  if (targetHits > 0) return "patched";
  return "no-match";
}

function hasSourceHits(content, replacements) {
  return (replacements || []).some(
    (replacement) => replacement.from && content.includes(replacement.from),
  );
}

function labelState(state) {
  switch (state) {
    case "original":
      return "原版";
    case "patched":
      return "已汉化";
    case "partial":
      return "部分汉化";
    case "missing":
      return "文件缺失";
    case "no-match":
      return "未命中词条";
    default:
      return "未知";
  }
}

function ensureBackupDir(env, patch) {
  fs.mkdirSync(getBackupDir(env, patch), { recursive: true });
}

function writeBackupIfNeeded(env, patch, filePatch, original, options = {}) {
  const backupPath = getBackupPath(env, patch, filePatch.relativePath);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  if (fs.existsSync(backupPath) && !options.overwrite) {
    return;
  }
  fs.writeFileSync(backupPath, original, "utf8");
}

function getBackupDir(env, patch) {
  return path.join(
    env.pencilStoragePath,
    ".pencil-zh-backups",
    patch.id || "pencil-zh-text-replacements",
  );
}

function getBackupPath(env, patch, relativePath) {
  return path.join(getBackupDir(env, patch), `${relativePath}.orig`);
}

function resolveTargetPath(env, relativePath) {
  return path.join(env.pencilStoragePath, relativePath);
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

module.exports = {
  PATCH_FILE,
  PATCH_FILES,
  applyPatch,
  getBackupPath,
  getPatchStatus,
  loadPatch,
  loadPatches,
  listPatchFiles,
  mergePatches,
  injectDomTranslator,
  looksPatched,
  replaceAllAvailable,
  removeDomTranslator,
  restorePatch,
  selectPatch,
  sha256,
  sha256File,
};
