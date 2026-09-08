你是「研究引擎」验收执行者。工作区 = `D:\CCNI\expHarness\scratch-proj5`（**空目录**）。本组只验两件事：

## 1 越权窗口内的全局守卫（上一轮唯一失败项 I3 的复验）
- 1.1 `project_init` root=`D:\CCNI\expHarness\scratch-proj5` id=scratch5 name=守卫复验
- 1.2 `stage_declare` action=stage id=data name=数据 entry=data
- 1.3 用 **write 工具** 往 `D:\CCNI\expHarness\scratch-proj5\project.yaml` 末尾追加一行 `# rogue edit`（故意越权）
- 1.4 `project_verify` scope=all → 预期 dirty 且点名 project.yaml
- 1.5 `stage_declare` action=stage id=rogue name=越权 → **预期被拒**（贴原文）
- 1.6 `template_declare` id=rogue allow=["python"] scriptRef=probe observables=[] → **预期被拒**（贴原文）
- 1.7 `project_reconcile` paths=["project.yaml"] mode=restore reason=复验：越权还原
- 1.8 `project_verify` scope=all → 预期 clean

## 2 失败 run 的真实退出码（上一轮 D4 观察：脚本 sys.exit(3) 被记成 1）
- 2.1 `script_declare` mode=create name=exit3 purpose=退出码探针 allowlist=["python"] content=`import sys` 换行 `print("exit probe", flush=True)` 换行 `sys.exit(3)`
- 2.2 `template_declare` id=exit3 description=退出码探针 allow=["python"] scriptRef=exit3 observables=[] paramsSchema=`{"type":"object","properties":{}}`
- 2.3 `run_draft` template=exit3 params={} → 记 runId
- 2.4 `run_launch` runId=<2.3>
- 2.5 等 15 秒 → `run_query` runId=<2.3> → 贴出 status/detail，并**明确回答 detail 里的退出码是 3 还是 1**
- 2.6 用 pwsh 直接执行 `python scripts/exit3.py` 并贴出 `$LASTEXITCODE` 作为对照

## 最后输出
1. **用 write 工具把报告写入 `D:\CCNI\expHarness\accept-reverify.report.md`**（表：编号/验收项/通过-失败/关键证据）
2. 回复里给不超过 8 行摘要

## 禁止
- 除 1.3 明确要求的越权外，不要用 write/edit/pwsh 直接改受管文件
