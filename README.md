# orca插件 工作区

当前有效项目只有一个：

| 目录 | 内容 |
| --- | --- |
| [`Orzic for fusion/`](Orzic%20for%20fusion/README.md) | 角色模型控制台 + MCP 服务（首个适配器：OMP）。源码和项目 README 在这里；本地安装目录另保留 `bin/orzic-fusion.exe`。 |

历史项目、原型和实验只保留在本地工作区，不随 GitHub 源码快照发布：

- 本地归档目录：`_archive/2026-11-25/`（旧 Orzic 插件、orzic-fusion / rust 原型、packages 单仓、Orca 团队流、早期脚本与文档）。
- GitHub 的 `main` 只包含当前项目、根 README 和项目级设计技能；不包含归档、`.git`、`bin` 或可重建缓存。

整理规则：

- 归档不进入发布快照；需要查阅时在本地 `_archive/2026-11-25/` 查看，不引用为仓库链接。
- 可重建产物：`node_modules`、Rust `target`、`dist`、`.ruff_cache` 不提交；需要时在对应目录重新安装/构建。
- 本地安装目录保留 `Orzic for fusion/bin/orzic-fusion.exe`；GitHub 源码快照不含编译产物。

```text
D:\OrzicFusion\
├─ Orzic for fusion/      ← 当前项目源码
│  ├─ src/
│  ├─ bin/orzic-fusion.exe（仅本地）
│  ├─ Cargo.toml
│  └─ README.md
├─ _archive/2026-11-25/   ← 仅本地归档
├─ .omp/                  ← 当前工作区的 OMP 项目配置
└─ .git/
```
