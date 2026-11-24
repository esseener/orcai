# Changelog

## 0.1.13 — 2026-11-24

- 隐藏范围收紧为 `devin/fusion-*` selector 前缀；`other/fusion-alpha`、`devin/my-fusion-model` 这类同名/同前缀变体不再被误隐藏，并补回归。
- 搜索保留 Unicode 字母/数字：中文模型名不再被压成空查询，`钣金`、`智能钣金` 可正常命中；`swe2`、`gpt54` 的分隔符匹配保持不变。纯标点查询回退为原来的子串匹配。

## 0.1.12 — 2026-11-24

- 模型选择器不再列出 Devin 的 `fusion-*` 合成模型(当前目录 1490 个模型里有 995 个)。它们淹没了普通模型:搜 `swe2` 原本命中 285 条 fusion 组合,200 条行数上限把真正的 `devin/swe-2` 挤出去;这些组合仍可用 `omp` CLI 或配置直接指定,面板只是不再展示。
- 搜索忽略分隔符并给 selector 尾部加权:`swe2` → `devin/swe-2`、`gpt54` → `gpt-5-4`,精确/前缀命中排在模糊命中之前。
- 新增 `src/panel.test.tsx`(`orca plugin test .`):挂载真实面板,断言 `swe2` 只列出 SWE-2 家族、无 fusion 行,且选中后 `fusion.set` 写入 `devin/swe-2`。

## 0.1.11 — 2026-11-24

首个按版本号发布的起点。

- 显示名改为 **Orcai**；插件 id、面板 id、状态文件仍保留 `orzic` 前缀，避免既有安装和审批失效。
- 规划优先路由：新任务切规划模型；规划期只读，`bash`/`eval`/`task` 和 `PLAN.md` 外写入都被拦截；成功写 `PLAN.md` 后才切执行模型。
- 规划阶段落盘：恢复进程不会丢失只读门禁；缺少可信 session pin 时直接停轮并拦截副作用工具，不再出现“规划模型还在、写入却放行”。
- 子代理不再参与插件的路由、只读门禁和验收；执行阶段的 `task` 委派在父会话触发一次验收，等待后台任务时延后到最终 settle。
- 模型选择器最多显示 200 条（原先 20 条），搜索仍覆盖 OMP 全部模型目录。
- 新增 `npm run check:version` 校验 manifest / package / 面板版本一致，以及 `npm run smoke:omp` 做 OMP 升级兼容冒烟。

## 0.1.2 — 基线

- 规划/执行模型路由、会话外验收 driver、锁与 session pin、面板和便签的最后一个未编号版本。
