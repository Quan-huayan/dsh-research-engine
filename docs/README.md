# 文档索引

引擎的行为规格以三份对齐稿为准；实施计划只回答「按什么顺序实现、怎么验收」；
实施报告记录交付物与验收结果。

## 规格（对齐稿）

| 文件 | 回答什么 |
|---|---|
| [`research-engine-principles.md`](research-engine-principles.md) | 根本原则、八要素、三条原则的物理翻译 |
| [`research-engine-tools.md`](research-engine-tools.md) | 权责矩阵 + 22 工具表 |
| [`research-engine-tool-flows.md`](research-engine-tool-flows.md) | 22 工具逐个流程 + 内建版本库附录 |

## 实施

| 文件 | 内容 |
|---|---|
| [`research-engine-plan.md`](research-engine-plan.md) | v3 实施计划：阶段 0–7、验收判据、迁移策略、风险降级 |
| [`research-engine-implementation-report.md`](research-engine-implementation-report.md) | 交付物、关键实现决定、验收结果、11 项缺陷修复记录 |

## 验收

`acceptance/` 下是六轮 headless 行为验收的任务书、原始输出与报告：

| 轮次 | 覆盖 |
|---|---|
| `accept-happy-path.*` | A–H：接工程 → 声明 → 冒烟端到端 → 用户权威 → 知识裁决 → 派生视图 |
| `accept-guards.*` | D/E/H/I/K：失败重放回滚、非线性跳段、安全闸、越权与修复、证据/权威闸门 |
| `accept-reverify.*` | 缺陷修复后的复验 |
| `accept-isolation.*` | J：工程本身是用户 git 仓库时的隔离（HEAD 逐字不变、无新 `.git`） |
| `accept-migration.*` / `accept-migration2.*` | 阶段 6：attndepth 迁移与幂等复检 |
| `accept-pilot-smoke.*` | 迁移后试点冒烟 |
| `live-accept-task.md`、`live-before.txt`、`live-after.txt` | 现场验收的任务书与前后快照 |

## 其他

- `../overlays/` —— headless 验收用的 `--patch` overlay（把五个插件以等价形式挂进 headless profile）。
- `../archive/preset-v6/` —— v6 旧 preset 存档（已被 v7 取代，仅作历史）。
