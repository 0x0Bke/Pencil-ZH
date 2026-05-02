"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const {
  applyPatch,
  loadPatches,
  restorePatch,
  selectPatch,
} = require("./lib/patcher");

const PENCIL_EXTENSION_ID = "highagency.pencildev";
const STATE_KEY = "pencilZhPatch.lastApplied";

function activate(context) {
  const patchesDir = path.join(context.extensionPath, "patches");

  context.subscriptions.push(
    vscode.commands.registerCommand("pencilZhPatch.apply", async () => {
      await runCommand(context, patchesDir, async (env, patch) => {
        const result = await applyPatch(env, patch);
        await context.globalState.update(STATE_KEY, {
          patchId: patch.id,
          appliedAt: new Date().toISOString(),
          pencilExtensionVersion: env.pencilExtensionVersion,
          editorVersion: env.editorVersion,
          files: result.files,
        });

        const reload = "重新加载窗口";
        const answer = await vscode.window.showInformationMessage(
          `Pencil 汉化已应用：${result.replacementCount} 处替换。需要重新加载窗口后生效。`,
          reload,
        );
        if (answer === reload) {
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      });
    }),
    vscode.commands.registerCommand("pencilZhPatch.restore", async () => {
      await runCommand(context, patchesDir, async (env, patch) => {
        const result = await restorePatch(env, patch);
        await context.globalState.update(STATE_KEY, undefined);

        const reload = "重新加载窗口";
        const answer = await vscode.window.showInformationMessage(
          `Pencil 原版 bundle 已恢复：${result.files.length} 个文件。需要重新加载窗口后生效。`,
          reload,
        );
        if (answer === reload) {
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      });
    }),
  );
}

function deactivate() {}

async function runCommand(context, patchesDir, action) {
  try {
    const env = resolvePencilEnvironment(context);
    const patch = selectPatch(loadPatches(patchesDir), env);
    await action(env, patch);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(`Pencil 中文补丁管理器：${message}`);
  }
}

function resolvePencilEnvironment(context) {
  const pencilExtension = vscode.extensions.getExtension(PENCIL_EXTENSION_ID);
  if (!pencilExtension) {
    throw new Error("未安装 Pencil 扩展 highagency.pencildev。");
  }

  const globalStorageRoot = path.dirname(context.globalStorageUri.fsPath);
  const pencilStoragePath = path.join(globalStorageRoot, PENCIL_EXTENSION_ID);
  const versionPath = path.join(pencilStoragePath, "current-version.json");

  let editorVersion = "unknown";
  if (fs.existsSync(versionPath)) {
    try {
      editorVersion = JSON.parse(fs.readFileSync(versionPath, "utf8")).version || "unknown";
    } catch (error) {
      throw new Error(`无法读取 Pencil editor 版本文件：${error.message}`);
    }
  }

  return {
    pencilExtensionVersion: pencilExtension.packageJSON.version,
    editorVersion,
    pencilStoragePath,
  };
}

module.exports = {
  activate,
  deactivate,
};
