"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PATCH_FILES = [
  "pencil-0.6.48-editor-0.1.81.json",
  "pencil-0.6.47-editor-0.1.79.json",
];
const PATCH_FILE = PATCH_FILES[0];
const DOM_SCRIPT_MARKER = "pencil-zh-dom-translator";

function loadPatch(patchPath) {
  return JSON.parse(fs.readFileSync(patchPath, "utf8"));
}

function loadPatches(patchesDir) {
  return PATCH_FILES.map((fileName) => loadPatch(path.join(patchesDir, fileName)));
}

function selectPatch(patches, env) {
  const patch = patches.find(
    (candidate) =>
      candidate.pencilExtensionVersion === env.pencilExtensionVersion &&
      candidate.editorVersion === env.editorVersion,
  );
  if (patch) {
    return patch;
  }

  const supported = patches
    .map(
      (candidate) =>
        `${candidate.pencilExtensionVersion} / editor ${candidate.editorVersion}`,
    )
    .join("；");
  throw new Error(
    `当前 Pencil 版本未适配：${env.pencilExtensionVersion} / editor ${env.editorVersion}。已内置支持：${supported}。`,
  );
}

async function getPatchStatus(env, patch) {
  const files = patch.files.map((filePatch) => {
    const filePath = resolveTargetPath(env, filePatch.relativePath);
    const exists = fs.existsSync(filePath);
    const currentSha256 = exists ? sha256File(filePath) : "";
    const patchedSha256 = filePatch.patchedSha256 || "";
    const content = exists ? fs.readFileSync(filePath, "utf8") : "";
    const state = !exists
      ? "missing"
      : currentSha256 === filePatch.originalSha256
        ? "original"
        : patchedSha256 && currentSha256 === patchedSha256
          ? "patched"
          : looksPatched(content, filePatch.replacements)
            ? "patched"
            : looksPartiallyPatched(content, filePatch.replacements)
              ? "partial"
              : "unknown";

    return {
      relativePath: filePatch.relativePath,
      filePath,
      currentSha256,
      state,
      stateLabel: labelState(state),
    };
  });

  const supported =
    env.pencilExtensionVersion === patch.pencilExtensionVersion &&
    env.editorVersion === patch.editorVersion &&
    files.every(
      (file) =>
        file.state === "original" || file.state === "patched" || file.state === "partial",
    );
  const patched = files.length > 0 && files.every((file) => file.state === "patched");
  const original = files.length > 0 && files.every((file) => file.state === "original");
  const partial = files.length > 0 && files.some((file) => file.state === "partial");

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
        : supported
          ? "可处理"
          : "未适配或文件状态未知",
  };
}

async function applyPatch(env, patch) {
  assertVersionSupported(env, patch);

  const status = await getPatchStatus(env, patch);
  if (!status.supported) {
    throw new Error(
      `当前 Pencil 版本或 bundle hash 未适配。扩展版本 ${env.pencilExtensionVersion}，editor 版本 ${env.editorVersion}。`,
    );
  }
  if (status.patched) {
    return { files: status.files, replacementCount: 0, alreadyPatched: true };
  }

  const prepared = [];
  for (const filePatch of patch.files) {
    const filePath = resolveTargetPath(env, filePatch.relativePath);
    const currentSha256 = sha256File(filePath);
    const original = fs.readFileSync(filePath, "utf8");
    if (
      currentSha256 !== filePatch.originalSha256 &&
      !looksPartiallyPatched(original, filePatch.replacements)
    ) {
      throw new Error(
        `文件状态不是可补丁的原版：${filePatch.relativePath}，当前 hash ${currentSha256}`,
      );
    }

    const patched = replaceAllStrict(original, filePatch.replacements, filePatch.relativePath);
    prepared.push({ filePatch, filePath, original, patched });
  }

  if (Array.isArray(patch.domReplacements) && patch.domReplacements.length > 0) {
    const relativePath = "editor/index.html";
    const filePath = resolveTargetPath(env, relativePath);
    const original = fs.readFileSync(filePath, "utf8");
    const patched = injectDomTranslator(original, patch.domReplacements);
    prepared.push({
      filePatch: {
        relativePath,
        originalSha256: sha256(Buffer.from(original, "utf8")),
      },
      filePath,
      original,
      patched,
    });
  }

  ensureBackupDir(env, patch);
  let replacementCount = 0;
  const resultFiles = [];
  for (const item of prepared) {
    writeBackupIfNeeded(env, patch, item.filePatch, item.original);
    fs.writeFileSync(item.filePath, item.patched, "utf8");
    replacementCount += item.filePatch.replacements?.length || 0;
    resultFiles.push({
      relativePath: item.filePatch.relativePath,
      currentSha256: sha256File(item.filePath),
      stateLabel: "已汉化",
    });
  }

  return { files: resultFiles, replacementCount, alreadyPatched: false };
}

async function restorePatch(env, patch) {
  assertVersionSupported(env, patch);

  const restored = [];
  for (const filePatch of patch.files) {
    const targetPath = resolveTargetPath(env, filePatch.relativePath);
    const backupPath = getBackupPath(env, patch, filePatch.relativePath);
    if (!fs.existsSync(backupPath)) {
      throw new Error(`没有可用于恢复的备份：${backupPath}`);
    }

    const backupSha256 = sha256File(backupPath);
    if (backupSha256 !== filePatch.originalSha256) {
      throw new Error(
        `备份 hash 不匹配，拒绝恢复：${filePatch.relativePath}，备份 hash ${backupSha256}`,
      );
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

function replaceAllStrict(content, replacements, relativePath) {
  let next = content;
  const orderedReplacements = [...replacements].sort((left, right) => {
    return right.from.length - left.from.length;
  });
  for (const replacement of orderedReplacements) {
    if (!next.includes(replacement.from)) {
      if (next.includes(replacement.to)) {
        continue;
      }
      throw new Error(`补丁字符串未命中：${relativePath} -> ${replacement.from}`);
    }
    next = next.split(replacement.from).join(replacement.to);
  }
  return next;
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
  return replacements.every(
    (replacement) => !content.includes(replacement.from) && content.includes(replacement.to),
  );
}

function looksPartiallyPatched(content, replacements) {
  let translatedCount = 0;
  for (const replacement of replacements) {
    const hasSource = content.includes(replacement.from);
    const hasTarget = content.includes(replacement.to);
    if (!hasSource && !hasTarget) {
      return false;
    }
    if (hasTarget) {
      translatedCount++;
    }
  }
  return translatedCount > 0;
}

function assertVersionSupported(env, patch) {
  if (env.pencilExtensionVersion !== patch.pencilExtensionVersion) {
    throw new Error(
      `Pencil 扩展版本未适配：当前 ${env.pencilExtensionVersion}，需要 ${patch.pencilExtensionVersion}。`,
    );
  }
  if (env.editorVersion !== patch.editorVersion) {
    throw new Error(
      `Pencil editor 版本未适配：当前 ${env.editorVersion}，需要 ${patch.editorVersion}。`,
    );
  }
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
    default:
      return "未知";
  }
}

function ensureBackupDir(env, patch) {
  fs.mkdirSync(getBackupDir(env, patch), { recursive: true });
}

function writeBackupIfNeeded(env, patch, filePatch, original) {
  const backupPath = getBackupPath(env, patch, filePatch.relativePath);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  if (fs.existsSync(backupPath)) {
    if (filePatch.originalSha256) {
      const currentBackupSha256 = sha256File(backupPath);
      if (currentBackupSha256 !== filePatch.originalSha256) {
        throw new Error(`已有备份 hash 不匹配，拒绝覆盖：${backupPath}`);
      }
    }
    return;
  }
  fs.writeFileSync(backupPath, original, "utf8");
  if (filePatch.originalSha256) {
    fs.writeFileSync(
      `${backupPath}.sha256`,
      `${filePatch.originalSha256}  ${filePatch.relativePath}\n`,
      "utf8",
    );
  }
}

function getBackupDir(env, patch) {
  return path.join(env.pencilStoragePath, ".pencil-zh-backups", patch.id);
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
  injectDomTranslator,
  looksPatched,
  replaceAllStrict,
  removeDomTranslator,
  restorePatch,
  selectPatch,
  sha256,
  sha256File,
};
