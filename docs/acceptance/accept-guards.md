你是「研究引擎」验收执行者。工作区 = `D:\CCNI\expHarness\scratch-proj2`（已有：阶段机 dataset→train→report、模板 smoke-check、一次 done 的 run、一条生效约定、一条生效结论）。

**严格按序**执行下面 6 组。每一步立刻原样贴出工具返回文本（被拒也要贴原文）。允许你用 write/pwsh 做"越权模拟"，凡是要你越权的步骤都明确写了。

## D 失败 / 重放 / 回滚
- D1 `script_declare` mode=create name=fail-probe purpose=故意失败探针 allowlist=["python"] entrypoint="python scripts/fail-probe.py" content=`import sys` + 换行 + `print("fail probe start", flush=True)` + 换行 + `sys.exit(3)`
- D2 `template_declare` id=fail-probe description=故意失败 allow=["python"] scriptRef=fail-probe observables=[] paramsSchema=`{"type":"object","properties":{}}`
- D3 `run_draft` template=fail-probe params={} → 记下 runId（记为 R_fail）
- D4 `run_launch` runId=R_fail → 等 15 秒 → `run_query` → 贴出该 run 的 status/detail
- D5 用 pwsh 证明 `experiments/R_fail/config.json` 仍然存在
- D6 `run_close` runId=R_fail status=invalidated reason=验收：故意失败探针
- D7 `run_query` → 证明 R_fail 与之前那条 done 的记录**同时存在**

## E 非线性跳段
- E1 `stage_read` → 记录当前阶段
- E2 `stage_goto` from=report to=dataset → **预期被拒**（没有这条边）→ 贴原文
- E3 `stage_declare` action=edge from=report to=train note=合法回跳
- E4 `stage_goto` from=report to=train → 预期成功 → 贴原文
- E5 `stage_read` → 确认当前阶段 = train

## H 安全闸
- H1 `template_declare` id=danger-prefix description=白名单不匹配的模板 allow=["python3"] scriptRef=smoke-check args=`--seed 0 --out {{__raw__}}/smoke.log` observables=[] paramsSchema=`{"type":"object","properties":{}}`
- H2 `run_draft` template=danger-prefix params={} → 记下 runId（R_danger）
- H3 `run_launch` runId=R_danger → **预期被安全闸拒绝** → 贴原文
- H4 `run_query` → 证明 R_danger 仍是 draft
- H5 用 glob/read 确认 `.kb/notes/` 里新增了一条 lesson 笔记（贴文件名与 frontmatter）

## I 越权与修复
- I1 用 **write 工具**把 `D:\CCNI\expHarness\scratch-proj2\project.yaml` 末尾追加一行 `# rogue edit`（这是故意的越权模拟）
- I2 `project_verify` scope=all → **预期报 dirty 并点名 project.yaml** → 贴原文
- I3 `stage_declare` action=stage id=rogue → **预期被拒** → 贴原文
- I4 `project_reconcile` paths=["project.yaml"] mode=restore reason=验收：越权模拟后还原 → 贴原文
- I5 `project_verify` scope=all → **预期 clean** → 贴原文

## J 证据与权威闸门
- J1 `run_observe` runId=<之前那条 done 的 runId> fields=["nope"] → **预期被拒**（字段未声明）
- J2 用 **pwsh** 往 `experiments/<done runId>/raw/smoke.log` 末尾追加一行 `tampered`（故意的证据篡改）
- J3 `run_observe` runId=<done runId> → **预期被拒**（产出已被改动）
- J4 `project_verify` scope=evidence → 预期报该文件被改动
- J5 `project_reconcile` paths=["experiments/<done runId>/raw/smoke.log"] mode=restore reason=验收：证据被篡改后还原
- J6 `run_observe` runId=<done runId> → 预期恢复成功
- J7 `convention_declare` statement=「无裁决的约定」 source=x decision={} → **预期被拒**
- J8 `note_write` kind=proposal name=probe-proposal description=无证据提议 statement=「这只是一个提议。」 → 然后 `note_adjudicate` note=probe-proposal action=accept（不带 decision）→ **预期被拒**

## K 派生视图
- K1 用 **write 工具**往 `D:\CCNI\expHarness\scratch-proj2\_report\summary.json` 末尾追加 `// rogue`（故意手改派生视图）
- K2 `project_verify` → **预期报 dirty 并点名 _report/summary.json**
- K3 `view_render` kind=report → 重新渲染
- K4 `project_verify` → **预期 clean**

## 最后输出
1. **用 write 工具把最终报告写入 `D:\CCNI\expHarness\accept-guards.report.md`**，内容为：
   - 表：`编号 | 验收项 | 通过/失败 | 关键证据（一行）`
   - 「异常 / 与文档不符处」：只写你实际观察到的差异
   - 你新增/修改/删除的文件清单
2. 然后在回复里给出一段不超过 10 行的摘要（详细内容以报告文件为准）。

## 禁止
- 除 I1、J2、K1 明确要求的越权模拟外，不要用 write/edit/pwsh 直接改受管文件
- 不要删除 `experiments/` 下任何内容
- 不要启动任何训练脚本
