# 验收复验报告：越权窗口守卫 + 失败 run 真实退出码

- 执行时间：2026-09-08T11:18Z（工作区 `D:\CCNI\expHarness\scratch-proj5`，起始为空目录）
- 依据：`accept-reverify.md`
- 结论：**两组验收项全部通过**（1.6 有一处拒因差异，见备注）

| 编号 | 验收项 | 通过/失败 | 关键证据（原文摘录） |
|---|---|---|---|
| 1.1 | `project_init` root=scratch-proj5 id=scratch5 name=守卫复验 | 通过 | 「工程已接入：D:\CCNI\expHarness\scratch-proj5／工程 id：scratch5／版本能力：可用（原始产出可还原）／遗留登记：（无）」 |
| 1.2 | `stage_declare` action=stage id=data name=数据 entry=data | 通过 | 「阶段机已更新（图版本 1）：阶段 声明 data／当前图：1 个阶段 / 0 条边 / 入口 data」 |
| 1.3 | 用 write 工具越权追加 `# rogue edit` 到 project.yaml | 通过（按设计越权） | 「Updated file」；project.yaml 尾部新增第 34 行 `# rogue edit` |
| 1.4 | `project_verify` scope=all → 预期 dirty 且点名 project.yaml | 通过 | 「体检结果：存在待修问题（dirty）／受管文件被工程外部改动：- project.yaml（被外部修改）」 |
| 1.5 | `stage_declare` action=stage id=rogue → 预期被拒 | 通过 | 「拒绝写入：受管区已被工程外部的改动覆盖，当前内容与已登记版本不一致。- project.yaml（被外部修改）／修法：project_reconcile mode=restore…」 |
| 1.6 | `template_declare` id=rogue scriptRef=probe → 预期被拒 | 通过（拒因不同，见备注） | 「拒绝：脚本 probe 尚未声明。修法：先 script_declare（create 新建 / adopt 收编既有文件）。」 |
| 1.7 | `project_reconcile` paths=["project.yaml"] mode=restore reason=复验：越权还原 | 通过 | 「处理方式：取回已登记版本／已处理：- project.yaml（已还原）」 |
| 1.8 | `project_verify` scope=all → 预期 clean | 通过 | 「体检结果：通过（clean）」 |
| 2.1 | `script_declare` mode=create name=exit3 allowlist=["python"] | 通过 | 「脚本已声明：exit3（新建）／路径：scripts/exit3.py 指纹：d470b63d10fb6eaaa3f3f7de3afb8bb6003a1b86d5f7b83f5b95121378e243a7 版本：1」 |
| 2.2 | `template_declare` id=exit3 allow=["python"] scriptRef=exit3 | 通过 | 「模板已声明：exit3@v1／脚本：exit3（scripts/exit3.py）　命令白名单：python／参数契约：无必填项」 |
| 2.3 | `run_draft` template=exit3 params={} | 通过 | runId=`scratch5-exit3-20260908-111811-554`；命令 `python scripts/exit3.py`；台账 status=draft |
| 2.4 | `run_launch` runId=scratch5-exit3-…-554 | 通过 | 「已在后台启动：scratch5-exit3-20260908-111811-554／任务标识：research.run-1」 |
| 2.5 | 等 15 秒 → `run_query`，回答 detail 退出码是 3 还是 1 | 通过 | 「- scratch5-exit3-20260908-111811-554　exit3　阶段 data　**failed**　参数 {}　产出 1（raw 0）　观察 0　**退出码 3**」；registry 行原文：`"status":"failed","detail":"退出码 3"`。**明确回答：detail 里的退出码是 3，不是 1。** |
| 2.6 | pwsh 直接执行 `python scripts/exit3.py` 对照 | 通过 | stdout：`exit probe`；`LASTEXITCODE=3`（与 2.5 一致） |
| 附加 | 收尾 `project_verify` scope=all（只读） | 通过 | 「体检结果：通过（clean）」（run 执行未破坏受管区） |

## 备注

1. **1.6 拒因差异（重要）**：`template_declare id=rogue scriptRef=probe` 确实被拒绝，但命中的是**更早的参数校验**（`脚本 probe 尚未声明`），未走到「越权窗口」守卫分支。因此该项只能证明「该调用被拒」，**不能单独证明模板写入路径也受越权守卫保护**。越权守卫本身的证据由 **1.5（stage_declare 被拒，拒因即受管区被外部改动覆盖）+ 1.4（verify 点名 project.yaml）+ 1.7/1.8（restore 后转 clean）** 共同支撑。若需补强，需在 dirty 窗口内用**已声明脚本**（如 exit3）再发一次 `template_declare`；本轮受「禁止除 1.3 外再改受管文件」约束，未执行第二次越权写入。

2. **D4 复验结论**：上一轮观察到的「脚本 `sys.exit(3)` 被记成退出码 1」在本轮**未复现**。`research.run-1` 完成通知、`run_query` 记录、`registry.jsonl` 的 `detail` 三处一致给出 **退出码 3**，且与 pwsh 直接执行的 `$LASTEXITCODE=3` 完全对齐。该缺陷应判定为**已修复**。

3. **I3 复验结论**：越权窗口内的全局守卫**已生效**——外部改动受管文件后，`project_verify` 判 dirty 并点名，`stage_declare` 写入被拒并给出 restore 修法，restore 后恢复 clean。

4. 环境：Python 3.13.5；run 产出目录 `experiments/scratch5-exit3-20260908-111811-554/`（config.json + manifest.json，raw 为空，因脚本仅打印一行后退出）。
