你是「研究引擎」试点冒烟执行者。工作区 = `D:\AI\attndepth`（已迁移完成，verify clean）。本会话的沙箱工作区就是本工程，因此后台任务可以正常写 `experiments/`。

**硬约束**：不启动任何训练脚本（只允许 smoke-diag 秒级冒烟）；不用 write/edit/pwsh 改受管文件。

## S1 冒烟端到端
- S1a `run_draft` template=smoke-diag params={"seed":0} → 记 runId
- S1b `run_launch` runId=<S1a>
- S1c 等 20 秒 → `job_output` 读日志（原样贴出）
- S1d `run_query` → 贴出该 run 行
- S1e `run_observe` runId=<S1a> → 预期提取到 python_version
- S1f 用 pwsh 证明 `experiments/<S1a>/raw/smoke.log` 存在并打印前几行

## S2 终检
- S2a `project_verify` scope=all → 预期 clean
- S2b `view_render` kind=report → 刷新报表
- S2c `project_verify` scope=all → 预期 clean

## 最后输出
1. **用 write 工具把报告写入 `D:\CCNI\expHarness\accept-pilot-smoke.report.md`**：表（编号/验收项/通过-失败/关键证据）+ 异常段
2. 回复里给不超过 8 行摘要
