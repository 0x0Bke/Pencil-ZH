"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  applyPatch,
  getBackupPath,
  getPatchStatus,
  injectDomTranslator,
  loadPatches,
  replaceAllStrict,
  removeDomTranslator,
  restorePatch,
  selectPatch,
  sha256,
} = require("../lib/patcher");

async function main() {
  assert.equal(
    replaceAllStrict("Hello World!", [{ from: "World", to: "世界" }], "x"),
    "Hello 世界!",
  );
  assert.throws(
    () => replaceAllStrict("Hello World", [{ from: "Missing phrase", to: "缺失短语" }], "x"),
    /补丁字符串未命中/,
  );
  const html = "<html><body><div id=\"root\"></div></body></html>";
  const injected = injectDomTranslator(html, [{ from: "Frame", to: "画框" }]);
  assert.match(injected, /pencil-zh-dom-translator/);
  assert.match(injected, /"Frame":"画框"/);
  assert.equal(removeDomTranslator(injected).replace(/\n/g, ""), html);
  const availablePatches = loadPatches(path.join(__dirname, "..", "patches"));
  assert.equal(
    selectPatch(availablePatches, {
      pencilExtensionVersion: "0.6.48",
      editorVersion: "0.1.81",
    }).id,
    "pencil-0.6.48-editor-0.1.81-zh-cn-v1",
  );

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pencil-zh-patch-"));
  const targetRelativePath = "editor/assets/index.js";
  const targetPath = path.join(temp, targetRelativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const htmlPath = path.join(temp, "editor/index.html");
  fs.writeFileSync(htmlPath, "<html><body><div id=\"root\"></div></body></html>", "utf8");
  const original = "Sign in to Pencil\nExport PDF\n";
  fs.writeFileSync(targetPath, original, "utf8");

  const patch = {
    id: "test-patch",
    pencilExtensionVersion: "0.6.47",
    editorVersion: "0.1.79",
    files: [
      {
        relativePath: targetRelativePath,
        originalSha256: sha256(Buffer.from(original, "utf8")),
        replacements: [
          { from: "Sign in to Pencil", to: "登录 Pencil" },
          { from: "Export PDF", to: "导出 PDF" },
        ],
      },
    ],
    domReplacements: [{ from: "Frame", to: "画框" }],
  };
  const env = {
    pencilExtensionVersion: "0.6.47",
    editorVersion: "0.1.79",
    pencilStoragePath: temp,
  };

  let status = await getPatchStatus(env, patch);
  assert.equal(status.supported, true);
  assert.equal(status.original, true);

  const applied = await applyPatch(env, patch);
  assert.equal(applied.replacementCount, 2);
  assert.match(fs.readFileSync(targetPath, "utf8"), /登录 Pencil/);
  assert.match(fs.readFileSync(htmlPath, "utf8"), /pencil-zh-dom-translator/);
  assert.ok(fs.existsSync(getBackupPath(env, patch, targetRelativePath)));

  const repeated = await applyPatch(env, patch);
  assert.equal(repeated.alreadyPatched, true);

  status = await getPatchStatus(env, {
    ...patch,
    files: [
      {
        ...patch.files[0],
        patchedSha256: sha256(Buffer.from(fs.readFileSync(targetPath), "utf8")),
      },
    ],
  });
  assert.equal(status.patched, true);

  const restored = await restorePatch(env, patch);
  assert.equal(restored.files.length, 2);
  assert.equal(fs.readFileSync(targetPath, "utf8"), original);
  assert.doesNotMatch(fs.readFileSync(htmlPath, "utf8"), /pencil-zh-dom-translator/);

  fs.rmSync(temp, { recursive: true, force: true });
  console.log("patcher ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
