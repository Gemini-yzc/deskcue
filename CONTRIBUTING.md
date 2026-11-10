# 参与开发

使用 Windows 10/11 x64 与 Node.js 20 以上版本。执行 `npm ci`、`npm start`，修改后运行 `npm run check` 与 `npm test`。打包使用 `npm run dist`，产物在 dist。

改动需说明问题、预期行为、实际验证结果，并同步更新 README。时间、保留期限和存储变更需要有边界测试。不要提交 data、缓存、凭据和 EXE；发布文件放 GitHub Releases 或 CI 附件。

项目使用 CommonJS、具名函数、两空格缩进。主进程验证所有写入，界面只通过 preload 的受限接口访问数据。Windows 桌面层代码来自 Stikly，修改时保留原作者的许可证和归属。

本仓库当前只交付 Windows 版本。macOS 适配应先讨论桌面层、通知权限与应用外部数据目录，不应直接复用 Windows PowerShell 实现。
