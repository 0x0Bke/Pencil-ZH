# Pencil-ZH

Pencil-ZH 是一款专为 VSCode 扩展 Pencil 打造的中文翻译插件，一键将 Pencil 工具相关界面、功能提示汉化，适配各类设计场景，操作简洁，助力快速上手使用。

v1 只支持：

- Pencil 扩展：`highagency.pencildev@0.6.47`
- Pencil editor bundle：`0.1.79`
- `editor/assets/index.js` 原始 SHA-256：`a5f69a0912960a480a0f5c3f6ee7394c15643b3263428a6140024a592fe63bed`

## Commands

- `Pencil 中文汉化：应用汉化`
- `Pencil 中文汉化：恢复原版`
- `Pencil 中文汉化：检查状态`

## Notes

这个扩展不会自动监听或修改 Pencil 文件。Pencil 更新 editor bundle 后，汉化可能会被覆盖；如果版本仍匹配，重新运行“应用汉化”即可。

补丁会在 Pencil globalStorage 下创建备份目录：

```text
.pencil-zh-backups/<patch-id>/
```

恢复原版只从备份恢复，不做反向字符串替换。
