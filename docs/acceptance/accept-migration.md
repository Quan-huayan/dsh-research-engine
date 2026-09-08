你是「研究引擎」的迁移执行者。目标工程 = `D:\AI\attndepth`（真实的旧式工程：单文件 `project.yaml` 里塞了 stages/pipeline/templates/entities/kb.types；`registry.jsonl` 是旧格式；`.kb/notes` 是旧 frontmatter；`.dsh/skills/attndepth-domain/SKILL.md` 是旧工程笔记）。

本组任务 = plan §5 阶段 6（迁移与收编）。**硬约束**：
- 旧产物（`.pth/.png/.txt/.ipynb`）零删除；`data/`、`history/`、`x/`、`x1/`、`x2/` 只登记不改；
- 不用 write/edit/pwsh 直接改 `project.yaml` / `pipeline.yaml` / `templates.yaml` / `registry.jsonl` / `.kb/`；一切变更走工具；
- 不启动任何训练脚本。

## 迁移前先记录基线（pwsh，原样贴出）
```powershell
cd D:\AI\attndepth
(Get-ChildItem -Recurse -File -Include *.pth,*.png,*.txt,*.ipynb -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|\.research)\\' }).Count
Get-ChildItem .kb\notes | Measure-Object | Select-Object -ExpandProperty Count
Get-Content registry.jsonl | Measure-Object -Line
Test-Path .git
```

## M1 就地迁移
`project_init` root=`D:\AI\attndepth` mode=migrate
→ 原样贴出返回文本（它会归档旧文件、建版本库、拆出 pipeline.yaml/templates.yaml、补 run 的证据清单、给笔记补结构头、把旧工程笔记移出环境位置）

## M2 复检
- M2a `project_load`
- M2b `project_verify` scope=all
- M2c `stage_read`

## M3 模板补 observables（旧模板迁移后 observables 全为空）
对下列模板逐个 `template_declare` overwrite=true（其余字段按 `project_load` 显示的现有值原样回填）：
- `smoke-hello`：args=`--seed {{seed}}`，paramsSchema=`{"type":"object","properties":{"seed":{"type":"integer"}},"required":["seed"]}`，observables=`[{"field":"python_version","role":"stdout","pattern":"python\\s+([0-9.]+)"}]`
- `smoke-diag`：args=`--seed {{seed}} --diag {{__raw__}}/smoke.log`，paramsSchema=`{"type":"object","properties":{"seed":{"type":"integer"}},"required":["seed"]}`，observables=`[{"field":"python_version","role":"log","pattern":"python\\s+([0-9.]+)"}]`
- `cifar100-main`、`cifar2-rerun`、`variant6-sweep`：observables=`[{"field":"params_total","role":"log","pattern":"params[:=]\\s*([0-9.]+)"}]`（若模板不存在就跳过并说明）

## M4 证据补齐（对旧 run 逐个）
- M4a `run_query` → 贴出全部 run 及其状态
- M4b 挑一个 **证据不完整** 的 run（没有 raw 产出的），说明它为什么不得据此下结论
- M4c 挑一个有产出的 run（如果有），`run_observe` 试提一个模板声明过的字段

## M5 知识重分类
- M5a `note_query`（默认只列 accepted）→ 贴出结果
- M5b `note_query` status=proposed → 贴出待裁决清单
- M5c 对每一条 **有可解析证据的 claim**（`evidence[]` 非空且文件存在）执行 `note_adjudicate` action=accept → 逐条贴返回
- M5d 若某条 claim 没有证据而你也无法为它找到可解析证据，**不要**强行 accept；如实说明它为什么只能停在 proposed

## M6 派生视图
- M6a `view_render` kind=report
- M6b `view_render` kind=notes-skill
- M6c `view_render` kind=index
- M6d pwsh 打印 `skills/attndepth/SKILL.md` 全文，并确认它**不含**任何内部工具名、也不含版本库词汇

## M7 最终验收
- M7a `project_verify` scope=all → 必须 clean（若 dirty，贴出并说明原因，不要绕过）
- M7b pwsh 复核迁移前的基线：`*.pth/*.png/*.txt/*.ipynb` 计数**不得减少**；`.kb/notes` 条数不得减少；`registry.jsonl` 行数不得减少
- M7c `Test-Path D:\AI\attndepth\.git` 必须仍为 False（工程根不得出现 .git）
- M7d 确认 `.dsh/skills/attndepth-domain/SKILL.md` 已不在原位置，且 `.research/legacy/skills/attndepth-domain/SKILL.md` 存在

## 最后输出
1. **用 write 工具把报告写入 `D:\CCNI\expHarness\accept-migration.report.md`**：
   - 表：`编号 | 验收项 | 通过/失败 | 关键证据（一行）`
   - 「异常 / 与文档不符处」（只写实际观察）
   - 迁移前后的基线对比表（计数）
   - 完整文件变更清单
2. 回复里给不超过 10 行摘要
