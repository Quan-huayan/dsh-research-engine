# accept-migration 执行报告（目标工程：D:\AI\attndepth）

- 执行者：研究引擎迁移执行者（本会话）
- 依据：`D:\CCNI\expHarness\accept-migration.md`（严格按 M1–M7 执行）
- 迁移时间：2026-09-08T11:18:35Z 起（本机 19:18:35）
- 硬约束遵守：旧产物零删除；`data/`、`history/`、`x/`、`x1/`、`x2/` 只登记不改；未用 write/edit/pwsh 改 `project.yaml` / `pipeline.yaml` / `templates.yaml` / `registry.jsonl` / `.kb/`（全部走工具）；未启动任何训练脚本。

## 1. 验收项总表

| 编号 | 验收项 | 通过/失败 | 关键证据（一行） |
|---|---|---|---|
| M1 | `project_init root=D:\AI\attndepth mode=migrate` | 通过 | 返回“迁移完成…旧文件已归档 .research/legacy/project-v2.yaml；阶段机 5/6；模板 7（observables 全空）；12 个 run 补证据清单（12 个不完整）；8 条笔记补 v3 结构头；旧工程笔记已移出环境位置” |
| M2a | `project_load` | 通过 | “结构校验：通过；模板 7 个；运行台账 12 条（done 2/failed 6/draft 4）；约定：无” |
| M2b | `project_verify scope=all` | 通过（执行） | 返回 dirty：4 个未登记派生文件 + 12 个 run manifest schema 违规（见异常 A1/A2；M7a 复检时已收敛为只剩 manifest） |
| M2c | `stage_read` | 通过 | 阶段 5 / 边 6 / 入口 dataset / 图版本 1 / 当前 dataset / 合法去向 attndepth、variants6 |
| M3 | 模板补 observables（5 个） | 通过（5/5） | `smoke-hello@v2`(python_version/stdout)、`smoke-diag@v2`(python_version/log)、`cifar100-main@v2`、`cifar2-rerun@v2`、`variant6-sweep@v2`(params_total/log)；台账第 25–29 行 |
| M4a | `run_query` 全量 | 通过 | 12 条 run：done 2 / failed 6 / draft 4；**每条“产出 1（raw 0）”** |
| M4b | 挑证据不完整的 run 说明 | 通过 | 取 `attndepth-cifar100-main-20260907-172705-4c8`（draft，从未启动，manifest 仅登记 config.json）：无任何进程产出，任何“CIFAR-100 结果”都无证据支撑，不得据此下结论 |
| M4c | `run_observe` 试提声明字段 | 通过（执行，全被拒） | `attndepth-smoke-diag-…-238`（done）→“清单里没有角色为 log 的产出文件”；`attndepth-smoke-hello-…-686`（done）→“没有角色为 stdout 的产出文件” |
| M5a | `note_query`（默认） | 通过 | 生效 4 条（1 claim + 3 lesson）/ 待裁决 4 条 |
| M5b | `note_query status=proposed` | 通过 | 列出 5 条 proposed：conclusion-parameter-parity、dataset-cifar100、method-variant-map、run-log-locations、six-variants-naming |
| M5c | 有可解析证据的 claim 逐条 accept | 部分通过（1/4） | `conclusion-parameter-parity` proposed→accepted（权威 evidence）；3 条 proposal 被拒“缺少 decision.askCallId”（见异常 A3） |
| M5d | 无证据 claim 不强行 accept | 通过（说明） | `dataset-cifar100`（proposal，无 evidence）保持 proposed：其内容为数据集目录/junction 口径，无 run/观察证据可解析，只能由用户裁决或先产出证据，故未 accept |
| M6a | `view_render kind=report` | 通过 | `_report/runs.csv`、`_report/summary.json`；条目 12，待裁决 4 |
| M6b | `view_render kind=notes-skill` | 通过 | `skills/attndepth/SKILL.md`；条目 1，待裁决 4 |
| M6c | `view_render kind=index` | 通过 | `.kb/index.yaml`；条目 8，待裁决 4 |
| M6d | SKILL.md 全文 + 洁净性 | 通过 | 全文 20 行已打印；扫描内部工具名 22 个 → 0 命中；版本库词汇（git/commit/HEAD/diff/hash/sha/.git）→ 0 命中 |
| M7a | `project_verify scope=all` 必须 clean | **失败** | 仍 dirty：12/12 run “manifest / must NOT have additional properties”（原因见异常 A1；无工具可修，未绕过） |
| M7b | 基线复核不得减少 | 通过 | 产物 88→88；`.kb/notes` 8→8；`registry.jsonl` 21→36 行 |
| M7c | `Test-Path D:\AI\attndepth\.git` 仍为 False | 通过 | False |
| M7d | 旧工程笔记移出 + 归档存在 | 通过 | `.dsh\skills\attndepth-domain\SKILL.md`=False；`.research\legacy\skills\attndepth-domain\SKILL.md`=True |

## 2. 异常 / 与文档不符处（只写实际观察）

**A1（阻断 M7a，最严重）迁移自己写出 schema 违规的 manifest，且无工具可修。**
`project_init mode=migrate` 给“证据不完整”的 run 写入的 `manifest.json` 多出 `note` 字段：
顶层键 = `schemaVersion, runId, entries, complete, updatedAt, note`；12/12 个 run 全部如此。
`project_verify` 逐条判 `run <id> manifest / must NOT have additional properties`。
对照同机由 `run_draft` 真实生成的 manifest（`D:\CCNI\expHarness\tools\_probe-project\experiments\probe-proj-probe-tpl-20260908-111648-b70\manifest.json`）顶层键只有 5 个、无 `note`。
可修路径实测不通：`run_launch` 才会重写 manifest，但其前置要求“全局 verify 无 dirty”；`run_draft` 同样要求 verify clean → 形成死锁。手改 `experiments/*/manifest.json` 属受管证据文件、且被硬约束排除。故 M7a 如实报 dirty，未绕过。

**A2 迁移未登记迁移前既有的派生文件，需靠重渲染/收编补齐。**
迁移后 verify 报 4 个未登记受管文件：`.kb/index.yaml`、`.research/state.json`、`_report/runs.csv`、`_report/summary.json`（`registry.jsonl` seq 24 的 verify 事件同此）。
M6 重新渲染后 `_report/*`、`.kb/index.yaml` 被登记（dirty 收敛）；`.research/state.json` 无任何写类工具会重提交，按 verify 提示执行 `project_reconcile mode=ignore`（seq 35）后 dirty 只剩 A1。

**A3 `note_adjudicate` 对“有可解析证据的 proposal”只认用户裁决，且提示语与事实不符。**
`method-variant-map` / `run-log-locations` / `six-variants-naming`（均 kind=proposal）被拒：“缺少 decision.askCallId …（这条笔记没有可解析证据，生效只能由用户裁决。）”
但三条的 evidence 实测全部存在：`cifar3.txt`、`cifar3.py`、`cifar2.py`、`x2\checkpoint_attndepth.pth`、`x1\cifar5.py`（`Test-Path` 全 True），`note_query` 也照常显示这些证据指针。与 `research-engine-principles.md` §1.7“升级路径只有两条——被可复现证据支撑（→证据权威）或被用户裁决（→用户权威）”的表述不符：实现只认后者。

**A4 `note_query status=proposed` 的返回标题自相矛盾。**
返回首行为“生效结论 5 条：”，其下 5 条全部标 `[proposal / proposed / agent]`。默认查询时同一批却列在“待裁决（proposed…）”标题下。

**A5 迁移后的 entity 全部缺 `source`。**
`entity_query` 9 条实体（cifar100、mnist、model-a/b/c/d、six-variants、history-dir、x-works）全部显示“来源：（缺）”；而 `entity_declare` 的契约把 `source` 列为必填。`project_verify` 未把这列为问题（不算 dirty，但工程不完整）。

**A6 verify 事件记录与报告不一致。**
`registry.jsonl` seq 36：`status:"dirty"` 但 `dirty:[]`、`unknown:[]`；同一次返回文本却列出 12 条结构问题（结构问题不进 dirty 列表，重放时无法从事件还原问题清单）。

**A7 按验收脚本回填后的口径变化（本次执行导致，如实记录）。**
`smoke-diag` 的 paramsSchema 按脚本 M3 指定回填为仅 `seed`（args 改为 `--seed {{seed}} --diag {{__raw__}}/smoke.log`），但 description 仍保留迁移原文“`--seed N --diag <工程内相对路径>`”，二者不再逐字对应。

**A8 历史 run 的证据链仍不完整（迁移只能“登记不补造”）。**
12 条 run 的 manifest 全部 `raw 0`；done 的 `attndepth-smoke-diag-…-238` 其真实产出在 `experiments\_diag_live_d.txt`（含 `python 3.13.5`，正合模板声明的 `python_version`），但该文件位于 run 目录之外、未被登记，故 `run_observe` 正确拒绝提取。

**A9 环境观察。** `Get-ChildItem D:\AI\attndepth\data\cifar-100-python` 递归读取时返回 UnauthorizedAccess（部分子目录拒绝访问）；基线命令带 `-ErrorAction SilentlyContinue`，计数不受影响（仍为 88）。

## 3. 迁移前后基线对比（计数）

| 指标（命令见 accept-migration.md §迁移前基线） | 迁移前 | 迁移后 | 判定 |
|---|---|---|---|
| `*.pth,*.png,*.txt,*.ipynb` 递归文件数（排除 node_modules/.git/.research） | 88 | 88 | 未减少 ✅ |
| `.kb\notes` 条目数 | 8 | 8 | 未减少 ✅ |
| `registry.jsonl` 行数 | 21 | 36 | 未减少（+15 条迁移/裁决/渲染事件）✅ |
| `Test-Path .git` | False | False | 工程根仍无 `.git` ✅ |

受保护遗留区复核（只登记不改，最新写入时间均早于迁移）：`history/` 17 文件（最新 2026-04-30）、`x/` 28 文件（2026-05-02）、`x1/` 43 文件（2026-05-18）、`x2/` 2 文件（2026-05-18）；`experiments/*/config.json` 12 个时间戳全为迁移前（迁移未改写 config，只新增 manifest）。

## 4. 完整文件变更清单

### 4.1 新增
| 路径 | 说明 |
|---|---|
| `pipeline.yaml` | 从旧 project.yaml 拆出 stages(5)+edges(6)+entry+graphVersion=1 |
| `templates.yaml` | 从旧 project.yaml 拆出 templates(7)，scriptRef 全部 `mode: adopt` |
| `skills\attndepth\SKILL.md` | `view_render(notes-skill)` 派生视图（标注派生+生成时间+来源） |
| `scripts\cifar2.meta.json`、`cifar3.meta.json`、`cifar5.meta.json`、`diag-job-probe.meta.json`、`hold-probe.meta.json`、`smoke-hello.meta.json` | 脚本元数据（adopt 收编） |
| `experiments\<12 个 runId>\manifest.json` | 12 份证据清单初稿（均 `complete:false`，含 A1 的 `note` 字段） |
| `.research\managed.json` | 受管白名单工程内副本（14 条规则） |
| `.research\ignored.json` | 本次 `project_reconcile mode=ignore` 写入 |
| `.research\legacy\project-v2.yaml` | 旧 project.yaml 全文归档 |
| `.research\legacy\skills\attndepth-domain\SKILL.md` | 旧工程笔记归档 |
| `.research\engine.git\` | 版本库（引擎内部基础设施，模型不可见） |

### 4.2 修改
| 路径 | 说明 |
|---|---|
| `project.yaml` | 重写为 schemaVersion 3：保留 project 身份 + legacy；新增 managed(14)/conventions/vocabulary；entities(9)/stages/pipeline/templates 迁出（分别落到 registry.jsonl / pipeline.yaml / templates.yaml） |
| `registry.jsonl` | 追加 seq 22–36（pipeline migrate、project migrate、verify×3、note×6、render×3、reconcile）；原 1–21 行逐字保留 |
| `.kb\notes\*.md` ×8 | 补 v3 frontmatter（schemaVersion/kind/status/authority/evidence/scope + `legacy:` 原字段块）；正文原文保留 |
| `.kb\index.yaml` | `view_render(index)` 重渲染（条目 8） |
| `_report\runs.csv`、`_report\summary.json` | `view_render(report)` 重渲染（条目 12，待裁决 4） |
| `templates.yaml` | M3 二次声明：smoke-hello/smoke-diag/cifar100-main/cifar2-rerun/variant6-sweep 升 v2 并补 observables |

### 4.3 移动 / 移出
| 原位置 | 现位置 |
|---|---|
| `project.yaml`（v2 全文） | `.research\legacy\project-v2.yaml`（原文归档） |
| `.dsh\skills\attndepth-domain\SKILL.md` | `.research\legacy\skills\attndepth-domain\SKILL.md`（原位置已不存在，不再被加载） |

### 4.4 明确未改动
- 遗留产物：`*.pth` / `*.png` / `*.txt` / `*.ipynb`（88 件，计数与时间戳均未变）
- 受保护区：`data/`、`history/`、`x/`、`x1/`、`x2/`
- 脚本与笔记本：`cifar2.py`、`cifar3.py`、`smoke_hello.py`、`diag_job_probe.py`、`diag_runner_probe.py`、`hold_probe.py`、`*.ipynb`
- `experiments\<runId>\config.json` ×12（未被改写）
- 会话导出 zip ×2

## 5. 结论

- M1–M6 与 M7b/M7c/M7d 全部按脚本执行并通过。
- **M7a 未通过**：`project_verify scope=all` 仍为 dirty，唯一剩余原因是 A1——迁移工具自身写入的 12 份 manifest 含 schema 未允许的 `note` 字段，而可修工具（`run_launch`/`run_draft`）都被“verify 无 dirty”前置挡住，形成死锁。按脚本要求“若 dirty，贴出并说明原因，不要绕过”，此处如实上报，未做任何手改。
