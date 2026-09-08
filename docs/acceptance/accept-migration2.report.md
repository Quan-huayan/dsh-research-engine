# accept-migration2 迁移收尾验收报告

- 工程：`D:\AI\attndepth`（已迁移一轮，本轮为缺陷修复后的复检）
- 执行会话工作区：`D:\CCNI\expHarness`；文件策略：`workspace-write`
- 执行时间：2026-09-08 19:26 ~ 19:28（本地）
- 硬约束遵守情况：旧产物零删除 ✅；未用 write/edit/pwsh 改受管文件 ✅；未启动训练脚本，只跑了秒级 smoke-diag ✅
- 总结论：**R1–R4、R6 全部通过；R5 因本会话文件沙箱边界未完成（环境阻塞，非迁移缺陷）**

---

## 1. 验收表（编号 / 验收项 / 通过-失败 / 关键证据）

| 编号 | 验收项 | 结论 | 关键证据 |
|---|---|---|---|
| R1 | `project_init` root=`D:\AI\attndepth` mode=migrate（幂等修复） | **通过** | 返回「修复复检完成（工程已是 v3，只补齐派生文件 / 证据清单 / 实体来源）」；既有 run 12 个补证据清单、实体 9 条补来源、台账第 46 行 |
| R2a | `project_verify` scope=all 预期 clean | **通过** | `体检结果：通过（clean）`，dirty=[]；仅提示「尚无生效约定」（不算 dirty） |
| R2b | `run_query` 贴出全部 run | **通过** | 12 条（draft 4 / done 2 / failed 6） |
| R2c | `entity_query` 每条实体都有来源 | **通过** | 9 条实体全部显示 `来源：.research/legacy/project-v2.yaml`，无「（缺）」 |
| R2d | `note_query` | **通过** | 生效 4 条 + 待裁决 4 条 |
| R2e | `note_query` status=proposed，标题与内容一致 | **通过** | 4 条：`dataset-cifar100` / `method-variant-map` / `run-log-locations` / `six-variants-naming`；逐条读 `.kb/notes/*.md` 核对 name↔description↔正文一致 |
| R3a | `note_adjudicate` accept：method-variant-map | **通过** | `proposed → accepted（权威：evidence）`，台账第 48 行 |
| R3a | `note_adjudicate` accept：run-log-locations | **通过** | `proposed → accepted（权威：evidence）`，台账第 49 行 |
| R3a | `note_adjudicate` accept：six-variants-naming | **通过** | `proposed → accepted（权威：evidence）`，台账第 50 行 |
| R3b | `dataset-cifar100` 无可解析证据 → 如实说明，不强行 accept | **通过** | 该笔记 front-matter `evidence: []`（空数组），无法形成证据权威 → 只能停在 proposed（详见异常段 §2.2） |
| R3c | `note_query` 生效结论清单 | **通过** | 生效 7 条（1 claim + 3 lesson + 3 proposal-accepted），待裁决 1 条 |
| R4a | `view_render` kind=report | **通过** | `_report/runs.csv`、`_report/summary.json`，条目数 12，待裁决 1，台账第 51 行 |
| R4b | `view_render` kind=notes-skill | **通过（有观察项）** | `skills/attndepth/SKILL.md`，条目数 **1**，台账第 52 行（见异常段 §2.3） |
| R4c | `view_render` kind=index | **通过** | `.kb/index.yaml`，条目数 8（accepted 7 / proposed 1），台账第 53 行 |
| R4d | pwsh 打印 `skills/attndepth/SKILL.md` 全文 | **通过** | 960 字节，全文见 §3 |
| R5a | `run_draft` template=smoke-diag params={"seed":0} | **通过** | runId=`attndepth-smoke-diag-20260908-112714-e4d`，台账第 54 行 |
| R5b | `run_launch` runId=<R5a> | **通过** | 后台 jobId=`research.run-1`，命令 `python smoke_hello.py --seed 0 --diag experiments/<runId>/raw/smoke.log` |
| R5c | 等 20 秒 → `job_output` 读日志 | **通过（步骤）** | 输出 `[沙箱拒绝（mode=workspace-write）]` / `[status: failed, 退出码 1]`；stdout.log 内含 `PermissionError: [Errno 13]` 栈 |
| R5d | `run_query` 贴出该 run 行 | **通过** | `attndepth-smoke-diag-20260908-112714-e4d　smoke-diag　阶段 dataset　failed　参数 {"seed":0}　产出 2（raw 1）　观察 0　退出码 1` |
| R5e | `run_observe` 预期提取 python_version | **失败** | `拒绝：没有提取到任何字段。字段 python_version：清单里没有角色为 log 的产出文件` |
| R5f | 证明 `experiments/<R5a>/raw/smoke.log` 存在 | **失败** | `Test-Path = False`；独立写探针也被拒（`UnauthorizedAccessException`） |
| R6a | `project_verify` scope=all 预期 clean | **通过** | `体检结果：通过（clean）`，台账第 58 行 |
| R6b | pth/png/txt/ipynb 计数不减少；`.kb/notes` 不减少；`registry.jsonl` 行数不减少 | **通过** | pth 32→32、png 40→40、txt 12→12、ipynb 4→4；notes 8→8；registry 36→**58** 行 |
| R6c | `Test-Path D:\AI\attndepth\.git` 必须仍为 False | **通过** | `git=False`（引擎版本库在 `.research/engine.git`，非根 `.git`，且早于本轮创建） |

---

## 2. 异常段

### 2.1 R5 未完成：本会话文件沙箱边界（环境阻塞，非迁移缺陷）

**现象链（可复现证据）**

1. `run_launch` 正常派发，jobId=`research.run-1`，台账依次写入 `draft(54) → queued(55) → running(56) → failed(57)`，`prev` 哈希链连续 —— 状态机与安全闸本身工作正常。
2. `job_output` 返回：`[沙箱拒绝（mode=workspace-write）]` / `[status: failed, 退出码 1]`。
3. 产出 `raw/stdout.log`（466 B，已登记进 manifest，`complete: true`）内容：
   ```
   Traceback (most recent call last):
     File "D:\AI\attndepth\smoke_hello.py", line 91, in <module>
       raise SystemExit(main())
     File "D:\AI\attndepth\smoke_hello.py", line 45, in main
       log = open(args.diag, "a", encoding="utf-8") if args.diag else None
   PermissionError: [Errno 13] Permission denied: 'experiments/attndepth-smoke-diag-20260908-112714-e4d/raw/smoke.log'
   ```
4. 独立定位：`python --version` 在 `workdir=D:\AI\attndepth` 下 **exit 0**（Python 3.13.5）→ 说明**进程能启动**，被拒的是**写文件**。
5. 独立写探针（同一目录、临时文件、命令内自删）：
   `Set-Content ...\_sbx_probe.tmp` → `DENIED: UnauthorizedAccessException :: Access to the path '...' is denied.`
6. 读操作不受限（本轮所有 read/pwsh 读取 `D:\AI\attndepth` 均成功）。

**根因**：本会话 `DSH` 文件策略为 `workspace-write`，可写根 = 会话工作区 `D:\CCNI\expHarness`；被验收工程 `D:\AI\attndepth` 位于该根之外，因此引擎派发的子进程无法在工程内落盘。**本会话审批提示已禁用，无法提权**，故不绕行（未复制工程、未改用其他脚本）。

**为什么这不能算迁移缺陷**

- 引擎全链路在“写被拒”场景下表现正确：命令白名单校验通过、后台派发成功、退出码与 stdout 捕获正确、产出登记与 manifest 指纹正确、台账 4 条状态迁移连续、失败原因可回溯。
- 工程内历史同名 run `attndepth-smoke-diag-20260908-091258-238` 为 `done / exit code: 0`（当时会话可写工程）——证明脚本与模板本身可跑。
- 工程内既有结论 `lesson-sandbox-127-fixed-v4`（已生效）记录 v4 已消除 silent 127；本轮复现的是**显式** `PermissionError`（不再是静默 127），与该结论方向一致。

**若要在本会话完成 R5，需要**：把会话可写根扩大到 `D:\AI\attndepth`（`danger-full-access` 或等效），或让工程位于会话工作区内。二者均超出本脚本权限范围。

### 2.2 `dataset-cifar100` 为何只能停在 proposed

- 该笔记 front-matter 为 `evidence: []`（空数组），`authority: agent`，即**没有可解析的证据指针**。
- `note_adjudicate action=accept` 的权威来源是“证据逐条复核可解析”；无证据则无权威依据，强行 accept 会把 agent 自述升格为结论，违反“证据权威”原则。
- 内容侧交叉验证：正文所述“`x*/data` 以 junction 指向 `data/`”**实测为真**（`x\data`、`x1\data`、`x2\data` 均为 `LinkType=Junction`，Target=`D:\AI\attndepth\data`），但“junction 为真”并不等于“该笔记的表述已被登记证据支撑”——缺的是**证据指针**，不是事实。
- 建议的合规补证据路径（本轮未做，需用户裁决）：由用户确认后把 `data/cifar-100-python`（或其归档）登记为证据指针，再行 accept。

### 2.3 `notes-skill` 条目数（1）与 `note_query` 生效结论数（7）不一致

- `view_render kind=notes-skill` 返回 `条目数：1`；生成的 `SKILL.md`「已生效结论」区**只有** `conclusion-parameter-parity`（kind=claim）1 条，另有「生效约定（暂无）」与「待裁决 共 1 条」。
- 同期 `note_query` 显示生效 **7** 条；`.kb/index.yaml` 也完整列出 8 条（accepted 7 / proposed 1）。
- 差异集合：3 条 `kind=lesson`（`lesson-sandbox-127-fixed-v4`、`lesson-smoke-hello-seed-placeholder`、`lesson-attndepth-danger-prefix-...`）与 3 条本轮 accept 的 `kind=proposal` 均**未进入** SKILL.md 的结论区。
- 判断：**疑似渲染器按 kind 白名单（仅 claim）过滤**，而非数据丢失——`index.yaml` 与 `note_query` 均一致且完整。R4b 本身只要求“渲染”，故记为通过；但若期望 SKILL.md 汇总 lesson/已接受 proposal，则需确认渲染规则。

### 2.4 `project.yaml` 遗留计数声明与实测漂移（非本轮引入）

- `legacy.keep` 声明：`**/*.pth`=32、`**/*.png`=40、`**/*.txt`=**11**、`**/*.txt~`=**4**、`**/*.ipynb`=4。
- 实测：pth=32 ✅、png=40 ✅、ipynb=4 ✅、txt=**12**（声明少 1）、`*~*` 文件总数=**0**（声明 4）。
- 说明：这是上一轮（19:18）从 v2 遗留声明继承的计数漂移，**本轮未引入**，也不影响 R6b（R6b 只要求“不减少”）。仅作登记。

### 2.5 无生效约定

- R2a / R6a 两次体检均提示：`尚无生效约定（需要时：ask_user_question → convention_declare）`。该项**不算 dirty**，且不在本脚本验收项内，本轮未补。

---

## 3. R4d 输出：`skills/attndepth/SKILL.md` 全文

```
# AttnDepth —— 深度注意力堆叠与参数效率研究（CIFAR-100 / MNIST / PyTorch） —— 工程笔记

> 派生视图：由工具从「生效约定 + 已生效结论」渲染，生成时间 2026-09-08T11:27:00.564Z，来源：工程约定与知识记录。
> 请勿手改本文件（手改会被体检点名）；知识变化后重新渲染即可。

## 生效约定（用户权威）

（暂无）

## 已生效结论（证据权威）

### 首轮参数对齐失败是后续 6 变体/K 扫描的起因
- 主张：cifar3.txt 首跑四路参数量差异 29.17%（目标 <10%）→ 需调整 C=480/K=6 等配置重新对齐后才有公平对比；history/ 与 x*/ 多轮结果以此为主线迭代。跑新对比前先核对参数量打印段，差异超 10% 应视为无效对照。
- 成立条件：compare
- 证据：cifar3.txt
- 标识：conclusion-parameter-parity

## 待裁决

共 1 条提议尚未裁决（不进本文件的结论区）。
```

---

## 4. 基线对比（R6b 依据）

| 指标 | 本轮前（19:26 基线） | 本轮后（19:28） | 判定 |
|---|---|---|---|
| `*.pth` | 32 | 32 | 未减少 ✅ |
| `*.png` | 40 | 40 | 未减少 ✅ |
| `*.txt` | 12 | 12 | 未减少 ✅ |
| `*.ipynb` | 4 | 4 | 未减少 ✅ |
| `.kb/notes` 条数 | 8 | 8 | 未减少 ✅（3 条为状态变更，非增删） |
| `registry.jsonl` 行数 | 36 | **58** | 增加 ✅（seq 45–58） |
| 全量文件数 | 338 | 476 | 增加 ✅（见下） |
| `D:\AI\attndepth\.git` | False | False | 保持 False ✅ |
| run 条数 | 12 | 13 | 增加 ✅（新增 R5a 失败 run） |
| 生效结论 / 待裁决 | 4 / 4 | **7 / 1** | 裁决推进 ✅ |
| 实体（带来源） | 9 | 9（全部带来源） | ✅ |

**+138 全量文件的构成**（R6b 只要求不减少，此处解释增量来源，避免误判为旧产物被动过）：
- `.research/engine.git/**` 版本库对象（每次受管写入产生 blob/tree/commit，含 LFS 对象）——主要增量；
- 派生视图：`_report/runs.csv`、`_report/summary.json`、`skills/attndepth/SKILL.md`、`.kb/index.yaml`；
- 新 run 目录：`experiments/attndepth-smoke-diag-20260908-112714-e4d/{config.json,manifest.json,raw/stdout.log}`。
- 说明：`.research/engine.git` 创建于 19:18:34（上一轮迁移），**不是本轮新建**；根 `.git` 始终不存在。

---

## 5. 文件清单（本轮新增 / 变更，按时间序）

**受管文件（引擎写入，非人工编辑）**

| 时间 | 文件 | 变更 |
|---|---|---|
| 19:26:32 | `experiments/*/manifest.json` ×12 | R1 幂等修复：重写证据清单 |
| 19:26:32 | `.research/managed.json` | R1 修复同步 |
| 19:26:50 | `.kb/notes/method-variant-map.md` | R3a 状态 proposed→accepted |
| 19:26:51 | `.kb/notes/run-log-locations.md` | R3a 状态 proposed→accepted |
| 19:26:53 | `.kb/notes/six-variants-naming.md` | R3a 状态 proposed→accepted |
| 19:26:58 | `_report/runs.csv`、`_report/summary.json` | R4a 派生视图（12 runs，待裁决 1） |
| 19:27:00 | `skills/attndepth/SKILL.md` | R4b 派生视图（条目 1） |
| 19:27:03 | `.kb/index.yaml` | R4c 派生视图（8 条） |
| 19:27:14 | `experiments/attndepth-smoke-diag-20260908-112714-e4d/config.json` | R5a 冻结 |
| 19:27:17 | `experiments/attndepth-smoke-diag-20260908-112714-e4d/manifest.json`、`raw/stdout.log` | R5b/c 产出登记（complete=true） |
| 19:28:02 | `registry.jsonl` | 台账 seq 46–58（13 条） |
| — | `.research/engine.git/**` | 受管写入产生的版本对象（增量主体） |

**本报告（会话工作区内，非受管工程文件）**

| 文件 | 说明 |
|---|---|
| `D:\CCNI\expHarness\accept-migration2.report.md` | 本报告（write 工具写入） |

**零删除确认**：本轮未删除任何文件；未修改 `data/`、`history/`、`x/`、`x1/`、`x2/` 等保护区内任何文件。

---

## 6. 结论

- **R1–R4、R6 全部通过**：迁移修复幂等生效，工程体检 clean，实体来源齐全，知识裁决按证据推进，三份派生视图生成成功，终检 clean 且旧产物计数无减少、根 `.git` 仍为 False。
- **R5 未完成**：唯一原因是本会话文件沙箱以 `D:\CCNI\expHarness` 为可写根、工程在其外，子进程写入 `raw/smoke.log` 被 `PermissionError(Errno 13)` 拒绝；审批已禁用无法提权。**这是环境边界，不是迁移缺陷**——引擎的状态机、安全闸、产出登记、失败捕获均正常，且历史上同一模板在可写会话中曾 `done/exit 0`。
- **待用户决策项**：① 是否扩大会话可写根以完成 R5 端到端冒烟；② 是否为 `dataset-cifar100` 补证据指针后再裁决；③ `notes-skill` 是否应纳入 lesson / 已接受 proposal。
