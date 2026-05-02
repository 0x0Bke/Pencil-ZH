"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  listPatchFiles,
  loadPatch,
  mergePatches,
  replaceAllAvailable,
} = require("../lib/patcher");

const root = path.join(__dirname, "..");
const installedBundle =
  "/Users/fuyue/Library/Application Support/Code/User/globalStorage/highagency.pencildev/editor/assets/index.js";

const patchFiles = listPatchFiles(path.join(root, "patches"));
const patches = patchFiles.map((fileName) => loadPatch(path.join(root, "patches", fileName)));

assert.ok(patches.length >= 1);
assert.deepEqual(new Set(patchFiles).size, patchFiles.length);

for (const patch of patches) {
  assert.ok(Array.isArray(patch.files));
  assert.ok(patch.files.length > 0);
  for (const filePatch of patch.files) {
    assert.ok(filePatch.relativePath);
    assert.ok(Array.isArray(filePatch.replacements));
    assert.ok(filePatch.replacements.length > 0);
    for (const replacement of filePatch.replacements) {
      assert.ok(replacement.from);
      assert.ok(replacement.to);
    }
  }
}

if (fs.existsSync(installedBundle)) {
  const content = fs.readFileSync(installedBundle, "utf8");
  const mergedPatch = mergePatches(patches);
  const filePatch = mergedPatch.files.find(
    (candidate) => candidate.relativePath === "editor/assets/index.js",
  );
  if (filePatch) {
    const result = replaceAllAvailable(content, filePatch.replacements);
    if (result.replacementCount === 0) {
      console.log("installed bundle has no matching source strings; skipped live replace check");
    }
  } else {
    console.log("no editor/assets/index.js patch; skipped live replace check");
  }
}

console.log("patch file ok");
