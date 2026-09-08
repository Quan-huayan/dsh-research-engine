你是「研究引擎」迁移收尾执行者。工程 = `D:\AI\attndepth`（已迁移过一轮，但上一轮暴露了 4 个缺陷，现已修复）。

**硬约束**：旧产物零删除；不用 write/edit/pwsh 改受管文件；不启动训练脚本（只允许 smoke-diag 这种秒级冒烟）。

## R1 迁移修复复检
`project_init` root=`D:\AI\attndepth` mode=migrate → 原样贴出返回（现在会对已 v3 的工程做幂等修复：重写证据清单、登记派生文件、给旧实体补来源）

## R2 复检
- R2a `project_verify` scope=all → **预期 clean**（若仍 dirty，原样贴出，不要绕过）
- R2b `run_query` → 贴出全部 run
- R2c `entity_query` → 确认每条实体都有来源（不再显示「（缺）」）
- R2d `note_query` → 贴出
- R2e `note_query` status=proposed → 贴出（标题应与内容一致）

## R3 知识裁决
- R3a 对下列**有可解析证据**的笔记逐条 `note_adjudicate` action=accept：`method-variant-map`、`run-log-locations`、`six-variants-naming`。逐条贴返回。
- R3b 对 `dataset-cifar100` 若它没有可解析证据，如实说明为什么它只能停在 proposed（不要强行 accept）
- R3c `note_query` → 贴出生效结论清单

## R4 派生视图
- R4a `view_render` kind=report
- R4b `view_render` kind=notes-skill
- R4c `view_render` kind=index
- R4d pwsh 打印 `skills/attndepth/SKILL.md` 全文

## R5 试点端到端冒烟（证明迁移后的工程真能跑）
- R5a `run_draft` template=smoke-diag params={"seed":0} → 记 runId
- R5b `run_launch` runId=<R5a>
- R5c 等 20 秒 → `job_output` 读日志
- R5d `run_query` → 贴出该 run 行
- R5e `run_observe` runId=<R5a> → 预期提取到 python_version
- R5f 用 pwsh 证明 `experiments/<R5a>/raw/smoke.log` 存在

## R6 终检
- R6a `project_verify` scope=all → **预期 clean**
- R6b pwsh 复核：`*.pth/*.png/*.txt/*.ipynb` 计数不得减少；`.kb/notes` 条数不得减少；`registry.jsonl` 行数不得减少
- R6c `Test-Path D:\AI\attndepth\.git` 必须仍为 False

## 最后输出
1. **用 write 工具把报告写入 `D:\CCNI\expHarness\accept-migration2.report.md`**：表（编号/验收项/通过-失败/关键证据）+ 异常段 + 基线对比 + 文件清单
2. 回复里给不超过 10 行摘要
