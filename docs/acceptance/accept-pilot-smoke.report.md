# accept-pilot-smoke 验收报告

- 依据：`D:\CCNI\expHarness\accept-pilot-smoke.md`
- 执行者：研究引擎试点冒烟执行者
- 工程：attndepth（`D:\AI\attndepth`）
- 冻结 runId：`attndepth-smoke-diag-20260908-112907-35e`（模板 smoke-diag@v2，阶段 dataset）
- 执行窗口：2026-09-08T19:29:07+08:00 → 2026-09-08T19:29:55+08:00
- 硬约束遵守：未启动任何训练脚本（仅 smoke-diag 秒级冒烟）；未用 write/edit/pwsh 改受管文件。
- 落盘说明：原定路径 `D:\CCNI\expHarness\accept-pilot-smoke.report.md` 被沙箱拒绝（workspace-write 只允许写 `D:\AI\attndepth`，且本会话禁用审批提示，不能申请提权）。本文件为就地副本，请人工移动到 `D:\CCNI\expHarness\`。

## 验收表

| 编号 | 验收项 | 通过/失败 | 关键证据 |
| --- | --- | --- | --- |
| S1a | `run_draft` template=smoke-diag params={"seed":0} | 通过 | `实例已冻结：runId=attndepth-smoke-diag-20260908-112907-35e`；模板 smoke-diag@v2，阶段 dataset，命令 `python smoke_hello.py --seed 0 --diag experiments/attndepth-smoke-diag-20260908-112907-35e/raw/smoke.log`；台账第 59 行 status=draft |
| S1b | `run_launch` runId=S1a | 通过 | `已在后台启动：attndepth-smoke-diag-20260908-112907-35e`；任务标识 `research.run-1`；沙箱模式=workspace-write，环境变量已注入，策略已解析；收尾通知 `status: completed, 退出码 0` |
| S1c | 等 20 秒 → `job_output` 读日志 | **偏差** | `Start-Sleep -Seconds 20` 后 `job_output(job_id="research.run-1")` 两次返回 `(no new output)`（含 `wait:true, 5000ms`）。日志实际由已登记产出取得：`raw/stdout.log`（12 行，含 `smoke ok`）与 `raw/smoke.log`（11 行，含 `smoke ok`） |
| S1d | `run_query` 贴出该 run 行 | 通过 | `- attndepth-smoke-diag-20260908-112907-35e　smoke-diag　阶段 dataset　done　参数 {"seed":0}　产出 3（raw 2）　观察 0　退出码 0` |
| S1e | `run_observe` 提取 python_version | 通过 | `python_version = 3.13.5　来源：experiments/attndepth-smoke-diag-20260908-112907-35e/raw/smoke.log:2`；台账第 63 行 |
| S1f | pwsh 证明 `experiments/<runId>/raw/smoke.log` 存在并打印前几行 | 通过 | `EXISTS: ...\raw\smoke.log  size=727 bytes  mtime=2026-09-08T19:29:13.5635725+08:00`；前几行见下方「S1f 日志原文」 |
| S2a | `project_verify` scope=all | 通过 | `体检结果：通过（clean）`；仅提示「尚无生效约定」（明确标注不算 dirty） |
| S2b | `view_render` kind=report | 通过 | `已渲染派生视图（report）：_report/runs.csv、_report/summary.json`；条目数 14，待裁决 1；生成时间 2026-09-08T11:29:55.036Z；台账第 65 行 |
| S2c | `project_verify` scope=all（渲染后复检） | 通过 | `体检结果：通过（clean）`；与 S2a 一致，渲染未引入 dirty |

**汇总：9 项中 8 项通过、1 项偏差（S1c）、0 项失败。**

## S1f 日志原文（`raw/smoke.log`，前 10 行）

```
[2026-09-08T11:29:12.128700+00:00] smoke start seed=0
python 3.13.5 | Windows-11-10.0.26200-SP0
cwd D:\AI\attndepth
argv ['smoke_hello.py', '--seed', '0', '--diag', 'experiments/attndepth-smoke-diag-20260908-112907-35e/raw/smoke.log']
subprocess pipe rc=0 out='subprocess-pipe-ok'
workspace write ok
D:\data_and_kits\python\3.13\Lib\site-packages\torch\cuda\__init__.py:61: FutureWarning: The pynvml package is deprecated. Please install nvidia-ml-py instead. If you did not install pynvml directly, please report this to the maintainers of the package that installed pynvml for you.
  import pynvml  # type: ignore[import]
torch 2.11.0+cu128 | cuda_available True
gpu NVIDIA GeForce RTX 5070 Ti Laptop GPU
```

（第 11 行 = `smoke ok`，文件共 11 行 / 727 bytes。）

## 异常段

### A1（S1c，偏差，需关注）`job_output` 未返回任何日志内容

- 现象：`run_launch` 明确指示「读日志：job_output(job_id="research.run-1")」，但作业完成后 `job_output` 连续两次返回 `(no new output)`（第二次带 `wait:true, timeout_ms=5000`），`job_list` 显示 `research.run-1 [research.run] completed`。
- 判定依据：run 本身健康 —— 退出码 0、台账 done、产出 3（raw 2）已登记、`raw/stdout.log`（12 行）与 `raw/smoke.log`（11 行）内容完整且均以 `smoke ok` 收尾。
- 初步归因（未做代码级验证）：`run_launch` 以重定向到文件的 stdio 派发子进程（stdout/stderr 落入 `raw/stdout.log`），作业流通道因此无内容可回传；即「日志落盘」正常、「日志上流到 job_output」缺失。
- 影响：不影响 run 记录与证据链（run_observe 已从已登记产出成功取证），但违背验收脚本对 S1c 的预期观测方式。
- 建议：在 `run_launch` 的回执中把「读日志」改为 `experiments/<runId>/raw/stdout.log`，或让作业结束回执附带日志尾部。

### A2（环境噪音，非失败）torch pynvml FutureWarning

`raw/stdout.log` 的 `[stderr]` 段含 `FutureWarning: The pynvml package is deprecated. Please install nvidia-ml-py instead.`（来自 `torch/cuda/__init__.py:61`）。不影响退出码与产出，建议后续环境统一时清理。

### A3（提示，非 dirty）体检的「待声明」项

S2a/S2c 均为 clean，但附带提示「尚无生效约定（需要时：ask_user_question → convention_declare）」。验收脚本未要求建立约定，本次不新增。

### A4（提示）报表待裁决条目

S2b 渲染结果 `条目数：14　待裁决：1`。属既有台账状态，本次冒烟未产生待裁决项。

## 结论

试点端到端链路（冻结 → 派发 → 落盘 → 台账 → 取证 → 体检 → 渲染 → 复检）可用且最终 clean；唯一偏差集中在 `job_output` 的日志回传通道，日志已由受管产出可靠承载，建议按 A1 修正验收脚本的读日志路径或补上作业日志回传。
