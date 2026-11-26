# Orzic for fusion

**Orzic** 是一个本地多 Agent 控制台和 MCP 服务，用来集中配置角色模型、思考强度与 Agent 接入，并支持规划、执行和验收工作流。

![Orzic 控制台的 Agent 与 MCP 列表](Orzic%20for%20fusion/screenshots/desktop.png)

## 能做什么

- **集中配置模型与角色**：为规划、执行、验收等角色选择模型和思考强度，在控制台查看并保存各 Agent 的配置。
- **连接 MCP**：从 Agent 列表进入详情，查看注册状态并管理 `fusion` 服务连接。
- **规划、执行与验收**：OMP 支持每轮路由、规划门禁和按工作区启用的自动验收；OpenCode 和 Codex 支持先规划、确认后执行，以及手动验收。
- **查看会话资源与交接进度**：查看可识别进程的内存占用，复制交接提纲；OMP 还可通过 `/gogo` 保存项目接续快照。

## 支持范围

| Agent 或客户端 | 当前支持 |
| --- | --- |
| OMP（oh-my-pi） | MCP 注册、角色模型与路由设置、每轮路由、规划门禁、手动及可选自动验收 |
| OpenCode | MCP 注册、规划 / 执行 / 验收角色模型、受控会话、手动验收 |
| Codex | MCP 注册、规划 / 执行 / 验收角色模型、受控会话、手动验收 |
| Claude Desktop、Cursor、Windsurf、Antigravity、Gemini CLI 等 | MCP 注册；标准 JSON `mcpServers` 客户端也可使用自定义配置 |

OpenCode 和 Codex 的受控会话由 Fusion 创建和管理；自动验收及 REWORK 回喂目前仅接入 OMP。更多能力和限制见[项目说明](Orzic%20for%20fusion/README.md#当前范围)。

## 开始使用

本项目面向 Windows，桌面控制台使用 WebView2；运行时不可用时会回退到 Edge app 窗口。需要先安装 Rust 工具链，再从源码构建：

```powershell
cd "Orzic for fusion"
cargo build --release
.\target\release\orzic-fusion.exe
```

启动后在「Agent 与 MCP」中选择目标 Agent，进入详情注册服务并配置可用功能。接入 OMP 的每轮路由和规划门禁时，还需在 OMP 详情安装扩展，或运行 `orzic-fusion.exe install-omp`。MCP 服务由客户端按需启动，控制台无需常驻。

构建产物和本机安装目录不包含在仓库中。安装、命令及各客户端的具体配置请参阅[构建与运行](Orzic%20for%20fusion/README.md#构建与运行)、[OpenCode 接入](Orzic%20for%20fusion/README.md#opencode-接入)和 [Codex 接入](Orzic%20for%20fusion/README.md#codex-接入)。

## 窄窗口界面

控制台也会适配较窄的窗口：

<img src="Orzic%20for%20fusion/screenshots/mobile.png" alt="Orzic 控制台窄窗口中的 Agent 与 MCP 列表" width="390">

项目源码和完整文档位于 [Orzic for fusion](Orzic%20for%20fusion/)。
