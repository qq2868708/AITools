# Codex TokenAPI 多实例控制台

这是一个独立的 Windows 本地小工具，用浏览器配置并同时启动多个隔离的 Codex 桌面客户端。它参考了桌面快捷方式 `Codex TokenAPI (隔离).lnk` 调用的启动链：每个实例拥有独立的 `CODEX_HOME`、`APPDATA`、`LOCALAPPDATA`，并通过 `TOKENAPI_API_KEY` 注入自己的 TokenAPI。

## 使用

1. 双击 `start.bat`，或在 PowerShell 执行 `.\start.ps1`。
2. 浏览器打开后点击“导入本机配置”。工具会读取 `.codex-sub2api` 的 TokenAPI 隔离配置和 `.codex` 的 Sub2API 配置，导入成两张实例卡片。
3. 需要新增配置时点击“新建实例”，填写实例名称、工作区、TokenAPI 地址、Token 和模型。
4. 点击“保存”；卡片标题区的 Toggle 直接负责启动或关闭该实例，顶部“同时启动全部”可以一次启动所有配置。
5. 展开配置区后可以点击“设为默认”，默认配置会显示“默认配置（现有配置）”标记；导入的 Sub2API 现有配置首次会作为默认配置。
6. 配置卡片默认折叠，可用工具栏的“全部展开/全部折叠”统一切换。

配置和 DPAPI 加密后的 Token 默认存放在 `%LOCALAPPDATA%\CodexMultiLauncher`。Token 不会通过 `/api/state` 返回浏览器。如果系统不是 Microsoft Store 安装的 Codex，可以在每个实例中填写 `ChatGPT.exe` 的完整路径；留空时工具会自动从 Codex AppX 包中查找最新版本。

实例状态会同时检查启动器进程和 Codex 的实际 `ChatGPT.exe` 进程。导入的现有 `.codex` / `.codex-sub2api` 配置也会按其应用数据目录识别已经运行的客户端，即使客户端不是由本工具启动的。

## 运行要求

- Windows 10/11
- Python 3.10 或更高版本（只使用标准库）
- 已安装 Codex 桌面版；Microsoft Store 版本使用与参考快捷方式相同的 `Invoke-CommandInDesktopPackage` 隔离启动方式

服务只绑定 `127.0.0.1`。关闭 PowerShell 窗口即可停止控制台服务；已经启动的 Codex 实例需要在界面中停止或自行关闭。
