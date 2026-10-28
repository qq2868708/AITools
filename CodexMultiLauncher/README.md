# Codex TokenAPI 多实例控制台

这是一个独立的 Windows 本地小工具，用浏览器配置并启动 Codex 桌面客户端。导入配置的开关直接控制原配置及其现有进程；新建实例拥有独立的 `CODEX_HOME`、`APPDATA`、`LOCALAPPDATA`，并通过 `TOKENAPI_API_KEY` 注入自己的 TokenAPI。

## 使用

1. 双击 `start.bat`，或在 PowerShell 执行 `.\start.ps1`。
2. 浏览器打开后点击“导入本机配置”。工具会读取 `.codex-sub2api` 的 TokenAPI 隔离配置和 `.codex` 的 Sub2API 配置，导入成两张实例卡片。
3. 需要新增配置时点击“新建实例”，填写实例名称、工作区、TokenAPI 地址、Token 和模型。
4. 点击“保存”；卡片标题区的 Toggle 直接负责启动或关闭该实例，顶部“同时启动全部”可以一次启动所有配置。
5. 展开配置区后可以点击“设为默认”，默认配置会显示“默认配置（现有配置）”标记；导入的 Sub2API 现有配置首次会作为默认配置。
6. 配置卡片默认折叠，可用工具栏的“全部展开/全部折叠”统一切换。

配置和 DPAPI 加密后的 Token 默认存放在 `%LOCALAPPDATA%\CodexMultiLauncher`。Token 不会通过 `/api/state` 返回浏览器。如果系统不是 Microsoft Store 安装的 Codex，可以在每个实例中填写 `ChatGPT.exe` 的完整路径；留空时工具会自动从 Codex AppX 包中查找最新版本。

实例状态会同时检查启动器进程和 Codex 的实际 `ChatGPT.exe` 进程。导入的现有 `.codex` / `.codex-sub2api` 配置也会按其应用数据目录识别已经运行的客户端，即使客户端不是由本工具启动的。

导入卡片的开关关闭时，会停止该原配置下的全部 Codex 窗口；再次打开时使用同一个原配置目录，不另建副本。已运行的配置再次收到启动请求会保持运行。导入配置启动时读取原有 `config.toml`，工具不会覆盖该文件；表单保存的模型和地址用于生成的隔离配置，修改原配置的这些选项仍需编辑原文件。

## 运行要求

- Windows 10/11
- Python 3.10 或更高版本（只使用标准库）
- 已安装 Codex 桌面版；Microsoft Store 版本使用与参考快捷方式相同的 `Invoke-CommandInDesktopPackage` 隔离启动方式

服务只绑定 `127.0.0.1`。`start.bat` / `start.ps1` 通过 WMI 启动独立的隐藏后台服务，启动窗口或 Codex 关闭后控制台仍可使用；重复启动会复用现有服务。日志保存在配置目录的 `server.log`。需要停止控制台服务时，可结束 `/api/health` 返回的服务 PID；这不会停止已经运行的 Codex 实例。直接执行 `python server.py` 仍可前台运行，前台模式不保证独立于调用方的进程树。

## 验证

在仓库根目录运行 `python -m unittest discover -s CodexMultiLauncher -p test_server.py` 和 `node --test CodexMultiLauncher/test_app.mjs`。

Windows 完整启动链测试：设置 `$env:CODEX_LAUNCHER_INTEGRATION = '1'`，再运行 `python -m unittest discover -s CodexMultiLauncher -p test_windows_launcher.py`。测试编译临时探针程序并通过真实包启动、进程发现和停止流程验证，不启动真实 Codex，也不调用 API。
