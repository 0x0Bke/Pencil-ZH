"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { PATCH_FILES, loadPatch, replaceAllStrict, sha256 } = require("../lib/patcher");

const root = path.join(__dirname, "..");
const installedBundle =
  "/Users/fuyue/Library/Application Support/Code/User/globalStorage/highagency.pencildev/editor/assets/index.js";

const patches = PATCH_FILES.map((fileName) =>
  loadPatch(path.join(root, "patches", fileName)),
);

assert.equal(patches.length, 2);
assert.deepEqual(
  patches.map((patch) => `${patch.pencilExtensionVersion}/${patch.editorVersion}`),
  ["0.6.48/0.1.81", "0.6.47/0.1.79"],
);

for (const patch of patches) {
  assert.equal(patch.files.length, 1);
}

if (fs.existsSync(installedBundle)) {
  const content = fs.readFileSync(installedBundle, "utf8");
  const currentSha256 = sha256(Buffer.from(content, "utf8"));
  const patch = patches.find((candidate) => candidate.files[0].originalSha256 === currentSha256);
  if (patch) {
    const filePatch = patch.files[0];
    const patched = replaceAllStrict(content, filePatch.replacements, filePatch.relativePath);
    assert.notEqual(patched, content);
    for (const replacement of filePatch.replacements) {
      assert.ok(patched.includes(replacement.to), `missing translated string: ${replacement.to}`);
    }
  } else {
    console.log(
      `installed bundle is not a supported original hash; skipped live bundle check: ${currentSha256}`,
    );
  }
}

console.log("patch file ok");
