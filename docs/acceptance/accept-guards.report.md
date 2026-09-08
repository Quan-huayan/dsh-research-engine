# 研究引擎验收报告 — accept-guards

- 执行者：验收执行者（AI）
- 工作区：`D:\CCNI\expHarness\scratch-proj2`（工程 id=scratch2）
- 执行时间：2026-09-08 19:11 ~ 19:13（本地）
- 执行方式：严格按 `accept-guards.md` 顺序执行 D → E → H → I → J → K，每步原文留存
- 结论：**34 项中 33 项通过，1 项失败（I3）**；最终 `project_verify scope=all` = clean

## 一、验收结果表

| 编号 | 验收项 | 通过/失败 | 关键证据（一行） |
| --- | --- | --- | --- |
| D1 | script_declare 新建失败探针 | 通过 | 脚本已声明：fail-probe（新建），指纹 ba5af032…，台账第 23 行 |
| D2 | template_declare fail-probe | 通过 | 模板已声明：fail-probe@v1，白名单 python，台账第 24 行 |
| D3 | run_draft 冻结失败探针 | 通过 | runId=scratch2-fail-probe-20260908-111125-6bf，status=draft，台账第 25 行 |
| D4 | run_launch 失败可观测 | 通过 | run_query：fail-probe / failed / 退出码 1 / 产出 1（raw 0）/ 观察 0 |
| D5 | 失败 run 的 config.json 保留 | 通过 | `experiments/scratch2-fail-probe-…-6bf/config.json` 存在（749 字节），另有 manifest.json |
| D6 | run_close 作废 | 通过 | 已标记 invalidated；「产出与观察值一律保留，未删除任何文件」，台账第 29 行 |
| D7 | 失败记录与 done 记录并存 | 通过 | run_query 同时列出 smoke-check(done) 与 fail-probe(invalidated)，共 2 条 |
| E1 | 记录当前阶段 | 通过 | 当前阶段=train，合法去向 report，图版本 6 |
| E2 | 未声明边被拒 | 通过 | 拒绝：report → dataset 不是已声明的边；合法去向（无，当前阶段是终点） |
| E3 | 声明回跳边 | 通过 | 阶段机已更新（图版本 7）：边 report → train，台账第 30 行 |
| E4 | 回跳成功 | 通过 | 阶段已推进：report → train，图版本 7，历史转移 2 次 |
| E5 | 当前阶段复核 | 通过 | 当前阶段=train，边 3 条，图版本 7 |
| H1 | 白名单不匹配模板 | 通过 | 模板已声明：danger-prefix@v1，命令白名单 python3，台账第 33 行 |
| H2 | 冻结危险 run | 通过 | runId=scratch2-danger-prefix-20260908-111206-70d，status=draft，台账第 34 行 |
| H3 | 安全闸拒绝启动 | 通过 | 拒绝（安全闸）：命令前缀 "python" 不在白名单 ["python3"] 内；未启动任何进程 |
| H4 | 被拦 run 保持 draft | 通过 | run_query：danger-prefix 仍为 draft |
| H5 | 自动记教训笔记 | 通过 | `.kb/notes/lesson-blocked-scratch2-danger-prefix-20260908-111206-70d.md`（kind=lesson / status=accepted / authority=evidence / scope=engine-safety） |
| I1 | 越权改 project.yaml | 通过 | write 工具在末尾追加 `# rogue edit` |
| I2 | 体检报 dirty | 通过 | 体检结果：存在待修问题（dirty）→ project.yaml（被外部修改） |
| **I3** | **越权期声明新阶段被拒** | **失败** | **预期被拒，实际成功**：「阶段机已更新（图版本 8）：阶段 声明 rogue」 |
| I4 | 还原 project.yaml | 通过 | 处理方式：取回已登记版本 → project.yaml（已还原） |
| I5 | 体检 clean | 通过 | 体检结果：通过（clean）——没有发现问题 |
| J1 | 未声明字段被拒 | 通过 | 拒绝：这些字段没有在模板里声明过：nope（模板声明 val_acc） |
| J2 | 篡改证据 | 通过 | pwsh 向 raw/smoke.log 末尾追加 `tampered`（前后内容已贴出） |
| J3 | 篡改后提取被拒 | 通过 | 拒绝：产出文件已被改动 experiments/…-12a/raw/smoke.log；未匹配到字段 |
| J4 | 证据体检报改动 | 通过 | 体检结果：dirty → run …-12a：登记文件已被改动 experiments/…-12a/raw/smoke.log |
| J5 | 还原证据 | 通过 | 处理方式：取回已登记版本 → experiments/…-12a/raw/smoke.log（已还原） |
| J6 | 还原后提取成功 | 通过 | 已提取 1 个字段：val_acc = 42.5 %，来源 raw/smoke.log:5，台账第 42 行 |
| J7 | 无裁决约定被拒 | 通过 | 拒绝：缺少 decision.askCallId |
| J8 | 无证据 proposal 不可 accept | 通过 | note_write 成功（proposal / proposed / agent，台账第 43 行）；note_adjudicate accept → 拒绝：缺少 decision.askCallId（无可解析证据，只能由用户裁决） |
| K1 | 手改派生视图 | 通过 | write 工具向 `_report/summary.json` 末尾追加 `// rogue` |
| K2 | 体检报 dirty | 通过 | 体检结果：dirty → _report/summary.json（被外部修改） |
| K3 | 重渲染 | 通过 | 已渲染派生视图（report）：_report/runs.csv、_report/summary.json；条目数 3、待裁决 1 |
| K4 | 体检 clean | 通过 | 体检结果：通过（clean） |

合计：**通过 33 / 失败 1 / 共 34**。

## 二、异常 / 与文档不符处

1. **I3：越权期间的图写入闸门不存在（唯一失败项）**
   文档预期 `stage_declare action=stage id=rogue` 被拒，实际返回成功：「阶段机已更新（图版本 8）：阶段 声明 rogue；当前图：4 个阶段 / 3 条边 / 入口 dataset；提示：阶段不可达（从入口出发）：rogue」。该调用发生在 I2 已报 dirty（project.yaml 被外部修改）、I4 尚未还原的窗口内，说明「脏工程 → 图结构写入被闸门拦截」这一预期机制并未生效。
   连带观察：该不可达阶段已持久化到 `pipeline.yaml`（graphVersion 8，stages 含 rogue），但随后 I5、K4 的 `project_verify scope=all` 均报 **clean**，即「不可达阶段」只以提示形式出现，不构成 fatal，也不会让体检变 dirty。

2. **失败 run 的退出码记录不一致**
   `scripts/fail-probe.py` 显式 `sys.exit(3)`；用 pwsh 直接执行实测 `actual exit code = 3`。但引擎登记的退出码为 **1**（后台任务通知、`run_query`、`_report/summary.json` 的 detail 三处一致为「退出码 1」）。失败判定正确，数值与脚本真实退出码不符。

3. **补充观察（非文档预期差异）**：E4 执行时「当前阶段=train」，而调用传入 `from=report to=train`，引擎未校验 `from` 是否等于当前阶段，直接按调用方声明的起点走已声明的边并回写当前阶段（「阶段已推进：report → train」）。即 `stage_goto` 的 `from` 可覆盖当前阶段。

未观察到其他与文档不符的行为；D/E/H/J/K 各组预期均如实命中。

## 三、文件清单（新增 / 修改 / 删除）

### 新增（均由验收调用的引擎工具创建）
- `scripts/fail-probe.py`
- `scripts/fail-probe.meta.json`
- `experiments/scratch2-fail-probe-20260908-111125-6bf/config.json`
- `experiments/scratch2-fail-probe-20260908-111125-6bf/manifest.json`
- `experiments/scratch2-fail-probe-20260908-111125-6bf/raw/`（空目录）
- `experiments/scratch2-danger-prefix-20260908-111206-70d/config.json`
- `experiments/scratch2-danger-prefix-20260908-111206-70d/manifest.json`
- `.kb/notes/lesson-blocked-scratch2-danger-prefix-20260908-111206-70d.md`
- `.kb/notes/probe-proposal.md`

### 修改
- `templates.yaml`：新增模板 fail-probe@v1、danger-prefix@v1
- `pipeline.yaml`：图版本 6 → 8；新增边 report→train（note=合法回跳）；新增阶段 rogue
- `registry.jsonl`：新增脚本/模板/run/边/阶段/笔记等台账条目
- `.kb/index.yaml`：新增上述两条笔记的索引
- `.research/state.json`：阶段、转移历史、台账状态
- `_report/summary.json`、`_report/runs.csv`：K3 重新渲染（summary.json 的手改 `// rogue` 已被覆盖）
- `experiments/scratch2-smoke-check-20260908-110939-12a/observations.json`：J6 重新提取观察值
- `experiments/scratch2-smoke-check-20260908-110939-12a/raw/smoke.log`：J2 追加 `tampered` → J5 还原（现内容与登记版本一致）
- `project.yaml`：I1 追加 `# rogue edit` → I4 还原（现内容与登记版本一致）

### 删除
- 无（未删除任何文件；`experiments/` 下内容全部保留，含失败 run 与 draft run）

### 说明
- `.research/engine.git/**` 为引擎自身版本库，随上述操作产生内部对象变化，未逐条列出。
- 遗留状态（非本次验收要求，如实记录）：draft run `scratch2-danger-prefix-20260908-111206-70d` 仍为 draft；invalidated run `scratch2-fail-probe-20260908-111125-6bf` 的 config/manifest 保留；阶段 `rogue` 仍留在阶段机中（graphVersion 8）；proposal 笔记 `probe-proposal` 仍为 proposed 待裁决。
