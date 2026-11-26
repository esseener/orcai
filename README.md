# orca插件 工作区

当前有效项目只有一个：

| 目录 | 内容 |
| --- | --- |
| [`Orzic for fusion/`](Orzic%20for%20fusion/README.md) | 角色模型控制台 + MCP 服务（首个适配器：OMP）。源码、README、已构建的 `bin/orzic-fusion.exe` 都在这里。 |

历史项目、原型和实验已归档，不在根目录展开：

| 目录 | 内容 |
| --- | --- |
| [`_archive/2026-11-25/`](_archive/2026-11-25/README.md) | 旧 Orzic 插件、orzic-fusion / rust 原型、packages 单仓、Orca 团队流、早期脚本与文档。 |

整理规则：

- 源码、资源、文档原样保留在归档目录，可随时移回。
- 已删除可重建产物：`node_modules`、Rust `target`、`dist`、`.ruff_cache`。需要时在对应目录重新安装/构建。
- 新项目的构建产物只保留 `Orzic for fusion/bin/orzic-fusion.exe`，`target/` 已清理。

```text
orca插件/
├─ Orzic for fusion/      ← 当前项目
│  ├─ src/
│  ├─ bin/orzic-fusion.exe
│  ├─ Cargo.toml
│  └─ README.md
├─ _archive/2026-11-25/   ← 归档（源码与资源）
├─ .omp/                  ← 当前工作区的 OMP 项目配置
└─ .git/
```
