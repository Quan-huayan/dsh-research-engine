你是「研究引擎」验收执行者。工作区 = `D:\CCNI\expHarness\scratch-proj2`（**空目录**）。本会话已挂载引擎工具（project_* / stage_* / script_declare / template_declare / run_* / note_* / view_render / entity_* / convention_declare / ask_user_question）。

**严格按序**执行下面 8 组，每完成一步立刻原样贴出工具返回文本（不要改写、不要总结替代原文）。被拒绝也是验收结果：原样贴出拒绝文本。

## A 接入与现状
- A0 `project_init` root=`D:\CCNI\expHarness\scratch-proj2` id=scratch2 name=验收草稿工程
- A1 `project_load`
- A2 `project_verify`（scope=all）—— 预期 clean + 待声明清单

## B 阶段机
- B1 `stage_declare` action=stage id=dataset name=数据与基线 entry=dataset
- B2 `stage_declare` action=stage id=train name=训练与对比
- B3 `stage_declare` action=stage id=report name=报告整合
- B4 `stage_declare` action=edge from=dataset to=train
- B5 `stage_declare` action=edge from=train to=report
- B6 `stage_read`
- B7 `stage_goto` to=train

## C 脚本
`script_declare` mode=create name=smoke-check purpose=冒烟：打印环境并写日志 allowlist=["python"] entrypoint="python scripts/smoke-check.py --seed 0 --out <raw>/smoke.log" content=下面这段 Python 原文（逐字）：

```python
"""冒烟脚本：打印环境，并把一段可提取的日志写进 --out 指定的文件。"""
import argparse
import os
import platform

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    outdir = os.path.dirname(a.out)
    if outdir:
        os.makedirs(outdir, exist_ok=True)
    lines = ["smoke start", "python %s" % platform.python_version(), "seed %d" % a.seed]
    try:
        import torch
        lines.append("torch %s" % torch.__version__)
    except Exception as exc:
        lines.append("torch unavailable: %s" % exc)
    lines.append("val_acc 42.50")
    with open(a.out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print("\n".join(lines), flush=True)

if __name__ == "__main__":
    main()
```

## D 模板
`template_declare`：
- id=smoke-check
- description=冒烟：跑 scripts/smoke-check.py，产出 raw/smoke.log
- allow=["python"]
- scriptRef=smoke-check
- args=`--seed {{seed}} --out {{__raw__}}/smoke.log`
- paramsSchema=`{"type":"object","properties":{"seed":{"type":"integer","description":"随机种子"}},"required":["seed"]}`
- observables=`[{"field":"val_acc","role":"log","pattern":"val_acc\\s+([0-9.]+)","unit":"%"}]`

## E 执行与证据
- E1 `run_draft` template=smoke-check params={"seed":0} → 记下 runId
- E2 `run_launch` runId=<E1 的 runId>
- E3 等 20 秒后 `job_output` 读该 job 的输出（原样贴出）
- E4 `run_query`
- E5 `run_observe` runId=<E1 的 runId>
- E6 用 pwsh 证明 `experiments/<runId>/raw/smoke.log` 存在并打印其内容

## F 用户权威
- F1 用 `ask_user_question` 提问：id=parity-tolerance，question=「参数差异的验收阈值取多少？」，options=[{"label":"必须 <10%"},{"label":"必须 <5%"},{"label":"不设阈值"}]，header=阈值
- F2 拿到答复后调用 `convention_declare`：statement=「参数对齐验收：两个模型的参数量差异必须 <10%」，source=「F1 的答复」，decision={askCallId: <从会话记录里取 F1 那次 ask_user_question 的调用标识>, answer: <用户答复原文>}
  - 若你拿不到 askCallId，如实贴出 ask_user_question 的完整返回，并说明缺什么字段。
  - F2b（**预期被拒**）再调一次 `convention_declare`：statement=「参数对齐验收：两个模型的参数量差异必须 <5%」（与用户答复的 <10% 矛盾），decision 同上 → 贴出拒绝文本。
- F3 `project_load`（确认约定可见且带裁决引文）
- F4 `entity_query` record=decision

## G 知识与裁决
- G1 `note_write` kind=claim name=smoke-val-acc description=冒烟脚本可稳定提取 val_acc statement=「smoke-check 模板能从 raw/smoke.log 里稳定提取 val_acc。」 evidence=[{"type":"observation","ref":"<E1 runId>#val_acc"}] scope="模板 smoke-check v1，产出角色 log"
- G2 `note_adjudicate` note=smoke-val-acc action=accept
- G3 `note_query`
- G4 `note_write` kind=claim name=no-evidence description=无证据的结论 statement=「不存在的结论。」 evidence=[] scope="x" → **预期被拒**

## H 派生视图
- H1 `view_render` kind=report
- H2 `view_render` kind=notes-skill
- H3 `view_render` kind=index
- H4 用 pwsh 打印 `_report/summary.json` 与 `skills/scratch2/SKILL.md` 全文

## 最后输出
1. **用 write 工具把最终报告写入 `D:\CCNI\expHarness\accept-happy-path.report.md`**，内容为：
   - 一张表：`编号 | 验收项 | 通过/失败 | 关键证据（一行）`
   - 一段「异常 / 与文档不符处」：只写你**实际观察到**的差异
   - 你新增/修改/删除了哪些文件（完整清单）
2. 然后在回复里给出一段不超过 10 行的摘要（详细内容以报告文件为准）。

## 禁止
- 不要用 write/edit/pwsh 直接改 `project.yaml` / `pipeline.yaml` / `templates.yaml` / `registry.jsonl` / `.kb/` 下任何文件
- 不要删除 `experiments/` 下任何内容
