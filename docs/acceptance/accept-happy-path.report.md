# 研究引擎验收报告 —— accept-happy-path.md

- 执行时间：2026-09-08（runId 内时间戳 20260908-110939）
- 工作区：`D:\CCNI\expHarness\scratch-proj2`（执行前为空目录）
- 工程 id / 名称：`scratch2` / 验收草稿工程
- 关键 runId：`scratch2-smoke-check-20260908-110939-12a`
- 关键 askCallId：`call_00_y6NHba1IpEazKhn5HAVN7932`

## 1. 验收结果表

| 编号 | 验收项 | 通过/失败 | 关键证据（一行） |
|---|---|---|---|
| A0 | `project_init` 接入空目录 | 通过 | 「工程已接入…版本能力：可用（原始产出可还原）…遗留登记：（无）…未声明脚本 0 个」 |
| A1 | `project_load` 现状 | 通过 | 「阶段机：未声明／模板：（无）／约定：（无生效约定）／台账 0 条／结构校验：通过」 |
| A2 | `project_verify` scope=all | 通过 | 「体检结果：通过（clean）」+ 3 条待声明（阶段机／模板／约定） |
| B1 | 声明阶段 dataset（entry） | 通过 | 「图版本 2…1 个阶段 / 0 条边 / 入口 dataset」 |
| B2 | 声明阶段 train | 通过 | 「图版本 3…2 个阶段」+ 提示 train 不可达 |
| B3 | 声明阶段 report | 通过 | 「图版本 4…3 个阶段」+ 提示 train、report 不可达 |
| B4 | 声明边 dataset→train | 通过 | 「图版本 5：边 dataset → train…1 条边」+ 提示 report 仍不可达 |
| B5 | 声明边 train→report | 通过 | 「图版本 6：边 train → report…2 条边」，无不可达提示 |
| B6 | `stage_read` | 通过 | 「阶段（3）：dataset、train、report／边（2）／入口 dataset／当前 dataset／合法去向：train」 |
| B7 | `stage_goto` to=train | 通过 | 「阶段已推进：dataset → train…历史转移 1 次」 |
| C | `script_declare` create | 通过 | 「脚本已声明：smoke-check（新建）…指纹 37db8c5f…版本 1…命令白名单：python」 |
| D | `template_declare` | 通过 | 「模板已声明：smoke-check@v1…可提取字段：val_acc[log]…参数契约：必填 seed」 |
| E1 | `run_draft` | 通过 | 「实例已冻结：runId=scratch2-smoke-check-20260908-110939-12a…阶段 train…status=draft」 |
| E2 | `run_launch` | 通过 | 「已在后台启动…任务标识：research.run-1…不阻塞本轮」 |
| E3 | 等 20s 后 `job_output` | 通过 | 日志 5 行（含 `val_acc 42.50`、`torch 2.11.0+cu128`）；`[status: completed, 退出码 0]` |
| E4 | `run_query` | 通过 | 「运行记录 1 条：…done…产出 2（raw 1）…退出码 0」 |
| E5 | `run_observe` | 通过 | 「val_acc = 42.5 %　来源：experiments/…/raw/smoke.log:5」 |
| E6 | pwsh 证明产出存在 | 通过 | `exists: True`，Length 71，内容末行 `val_acc 42.50` |
| F1 | `ask_user_question` | 通过 | 答复 `selected:["必须 <10%"]`，补充「按 <10% 走，别放宽」 |
| F1b | 取 askCallId（entity_query record=ask） | 通过 | 提问标识 `call_00_y6NHba1IpEazKhn5HAVN7932` |
| F2 | `convention_declare`（<10%） | 通过 | 「约定已生效：convention…用户答复原文：…必须 <10%…」 |
| F2b | 冲突约定（<5%）预期被拒 | 通过（按预期被拒） | 「拒绝：条文与用户答复不一致 —— 答复里的硬约束没有体现：10%。」 |
| F3 | `project_load` 确认约定 | 通过 | 「约定：convention「…必须 <10%」〔裁决 call_00_y6NHba1IpEazKhn5HAVN7932〕」 |
| F4 | `entity_query` record=decision | 通过 | 「用户裁决 1 条：…答复原文：…必须 <10% ｜ 补充：按 <10% 走，别放宽」 |
| G1 | `note_write` claim | 通过 | 「已写入 .kb/notes/smoke-val-acc.md…状态：proposed…证据：…-12a#val_acc」 |
| G2 | `note_adjudicate` accept | 通过 | 「proposed → accepted（权威：evidence）…证据逐条复核可解析」 |
| G3 | `note_query` | 通过 | 「生效结论 1 条：smoke-val-acc［claim / accepted / evidence］」 |
| G4 | 无证据 claim 预期被拒 | 通过（按预期被拒） | 「拒绝：claim 必须带 evidence。」 |
| H1 | `view_render` report | 通过 | 「_report/runs.csv、_report/summary.json…条目数：1」 |
| H2 | `view_render` notes-skill | 通过 | 「skills/scratch2/SKILL.md…条目数：2」 |
| H3 | `view_render` index | 通过 | 「.kb/index.yaml…条目数：1」 |
| H4 | pwsh 打印两个派生视图 | 通过 | summary.json 显示 runs 1 / done 1 / pendingAdjudication [] / conflicts []；SKILL.md 含约定 + 结论两节 |

合计：A(3) + B(7) + C(1) + D(1) + E(6) + F(6) + G(4) + H(4) = **32/32 通过**（其中 F2b、G4 属「预期被拒」，实际均按预期被拒）。

## 2. 异常 / 与文档不符处（仅记录实际观察到的差异）

1. **阶段机图版本从 2 起算**：B1 首次声明阶段返回「图版本 2」（而非 1），推测 `project_init` 已占用图版本 1。文档未说明初始图版本，实际不影响后续（B5 后为 6，与 5 次声明 + 初始 1 吻合）。
2. **`ask_user_question` 返回形态与台账渲染形态不同**：工具返回为 JSON `{"answers":[{"id":"parity-tolerance","selected":["必须 <10%"],"custom":"按 <10% 走，别放宽"}]}`；而 `entity_query record=ask` / `record=decision` 把它渲染为「parity-tolerance: 必须 <10% ｜ 补充：按 <10% 走，别放宽」。本次 `convention_declare` 的 `decision.answer` 采用了台账渲染串，且校验通过。文档 F2 只说「用户答复原文」，未指明取哪种形态。
3. **派生视图条目数口径不同**：`notes-skill` 报「条目数：2」（生效约定 1 + 已生效结论 1），`index` 报「条目数：1」（只统计笔记）。文档未给出口径说明，两者并存不矛盾。
4. **`view_render` report 额外产出 `_report/runs.csv`**：文档 H4 只要求打印 `_report/summary.json`，实际同一次渲染还写了 `_report/runs.csv`（工具返回文本已明示）。
5. **job 输出含环境噪声**：E3 的 stderr 有 torch 的 `FutureWarning: The pynvml package is deprecated`，属被调用 Python 环境的告警，非引擎行为。
6. **G1 证据形式**：`evidence.ref` 采用 `runId#val_acc` 即可依证据生效（无需用户裁决），与工具提示「有可解析证据的 claim 可依证据生效」一致；文档未额外要求字段。
7. 其余步骤（含两处预期拒绝 F2b、G4）与文档描述完全一致，未观察到其它不符。

## 3. 文件变更清单

### 3.1 本次验收新建（工程内，`D:\CCNI\expHarness\scratch-proj2`）

| 类别 | 路径 |
|---|---|
| 工程骨架 | `project.yaml`、`pipeline.yaml`、`templates.yaml`、`registry.jsonl` |
| 脚本 | `scripts/smoke-check.py`、`scripts/smoke-check.meta.json` |
| 运行产出 | `experiments/scratch2-smoke-check-20260908-110939-12a/config.json`、`.../manifest.json`、`.../observations.json`、`.../raw/smoke.log` |
| 知识库 | `.kb/notes/smoke-val-acc.md`、`.kb/index.yaml` |
| 派生视图 | `_report/runs.csv`、`_report/summary.json`、`skills/scratch2/SKILL.md` |
| 引擎内部（工具自动） | `.research/state.json`、`.research/managed.json`、`.research/engine.git/**`（含 `lfs/objects/…` 等版本库对象） |

### 3.2 本次验收新建（工程外）

- `D:\CCNI\expHarness\accept-happy-path.report.md`（本报告）

### 3.3 修改 / 删除

- 修改：无手工修改。上述文件均由引擎工具写入；`project.yaml`、`pipeline.yaml`、`templates.yaml`、`registry.jsonl`、`.kb/` 下文件均未用 write/edit/pwsh 直接改动。
- 删除：**无**（`experiments/` 下内容完整保留）。
