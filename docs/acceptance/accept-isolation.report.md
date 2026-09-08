# 验收报告：工程 = 用户自己的 git 仓库时的隔离性（§6.2-J）

- 验收执行者：研究引擎验收执行者
- 依据：`D:\CCNI\expHarness\accept-isolation.md`
- 工作区：`D:\CCNI\expHarness\scratch-usergit`（真实用户 git 仓库，含已跟踪文件、一处未提交改动、一个未跟踪文件）
- 执行时间：2026-09-08（本地 +08:00，引擎时间戳 UTC）
- 总体结论：**隔离核心断言全部通过（E1–E4 通过，HEAD 未变、已跟踪文件零改动、无新 `.git`、用户 git 配置未改）**；但步骤 **C4 失败**（声明式观察字段 `ok` 提取不到），属观察管线契约问题，**不是隔离问题**。

---

## 0. 基线（执行前原样输出）

```powershell
cd D:\CCNI\expHarness\scratch-usergit
git rev-parse HEAD
git status --porcelain
git ls-files | Measure-Object -Line
```
```
bc2bf0991d4c7562b5046de2e75457753e4deb94
 M src/train.py
?? wip_scratch.py

Lines Words Characters Property
----- ----- ---------- --------
    3
```

基线补充证据（执行前采集，供 E2/E4 对比）：

```
=== ls-files ===
README.md
data/notes.txt
src/train.py
=== hash-object of tracked files (baseline) ===
d549519938086b3369f732e79bb1bb62568461bf  README.md
1db9acdac3c82ddadda4274819752bad32b1cab9  data/notes.txt
b63f3a28d2b29c69d538f55988e68cabde85b13c  src/train.py
=== .gitignore ===            -> 不存在（PathNotFound）
=== .git/config ===           -> [core] ... [user] email=user@example.com name=user
=== .git/HEAD ===             -> ref: refs/heads/master
=== Test-Path .git ===        -> True
=== .git 顶层条目 ===          -> hooks info logs objects refs COMMIT_EDITMSG config description HEAD index
```

---

## 1. 逐步验收表

| 编号 | 验收项 | 通过/失败 | 关键证据 |
|---|---|---|---|
| A1 | `project_init` 接入用户仓库 | 通过 | 「工程已接入…版本能力：可用（原始产出可还原）｜遗留登记：.txt×1｜未声明脚本 2 个」。落盘仅 `project.yaml`、`registry.jsonl`、`.research/`；`project.yaml` 中 `project.id: usergit-probe`（工具显示把字面量 `git` 渲染为 `·`，故显示 `user·-probe`） |
| A2 | `project_load` | 通过 | 工程 `user·-probe`（实际 id `usergit-probe`）；受管区 14 条规则；遗留 `**/*.txt×1`；台账 0 条；结构校验：通过 |
| A3 | `project_verify`（接入后） | 通过 | 「体检结果：通过（clean）」，仅提示尚未声明阶段机/模板/约定 |
| B1 | `stage_declare` stage data（entry） | 通过 | 图版本 1，1 阶段/0 边/入口 data |
| B2 | `stage_declare` stage train | 通过 | 图版本 2，2 阶段；提示 train 不可达（预期，边未声明） |
| B3 | `stage_declare` edge data→train | 通过 | 图版本 3，2 阶段/1 边/入口 data |
| B4 | `script_declare` probe | 通过 | `scripts/probe.py`，指纹 `ce3a0371…45d89`，白名单 `python` |
| B5 | `template_declare` probe | 通过 | `probe@v1`，observables `ok[stdout]`，参数契约无必填项 |
| C1 | `run_draft` | 通过 | runId=`usergit-probe-probe-20260908-111936-40b`（显示为 `user·-probe-…`），status=draft，命令 `python scripts/probe.py --out experiments/…/raw/probe.log` |
| C2 | `run_launch` | 通过 | 后台启动 `research.run-1`，退出码 0；stdout=`probe ok` |
| C3 | 等 15s → `run_query` | 通过 | 「1 条：… probe 阶段 data **done** 参数 {} 产出 1（raw 0）观察 0 退出码 0」 |
| **C4** | **`run_observe` runId=C1** | **失败** | 「拒绝：没有提取到任何字段。字段 ok：清单里没有角色为 stdout 的产出文件」。manifest 仅 1 条（`config.json`，role=config）；`experiments/…/raw/` 为空；`observations.json` 未生成。根因见 §2 |
| D1 | `note_write` lesson | 通过 | `.kb/notes/isolation-probe.md`，类型 lesson，状态 proposed |
| D2 | `view_render` report | 通过 | `_report/runs.csv`、`_report/summary.json`，条目 1/待裁决 1 |
| D3 | `view_render` index | 通过 | `.kb/index.yaml`，条目 1/待裁决 1 |
| D4 | `view_render` notes-skill | 通过 | `skills/usergit-probe/SKILL.md`，条目 0/待裁决 1（lesson 尚未裁决，故技能未收录，符合设计） |
| D5 | `project_verify`（全流程后） | 通过 | 「体检结果：通过（clean）」。注：C4 的观察缺失未被体检判为 dirty（可考虑补一条完整性检查，非本次隔离结论） |
| **E1** | HEAD 必须完全不变 | **通过** | 基线 `bc2bf0991d4c7562b5046de2e75457753e4deb94` → 执行后 `bc2bf0991d4c7562b5046de2e75457753e4deb94`，逐字一致 |
| **E2** | 已跟踪文件不得出现 ` M`/` D`/`R ` 之类状态 | **通过** | 状态码集合仅 `{ M, ?? }`；`git diff --name-status HEAD` 仅 `M src/train.py`（**基线既有**的未提交改动，非引擎所致）；三个已跟踪文件 blob 哈希与基线逐一相同（`d5495199…`/`1db9acda…`/`b63f3a28…`）；无 ` D`/`R `/`A `/`MM`；新增项全为 `??` |
| **E3** | 工程根没有生成 `.git` | **通过** | `Test-Path .git` = True，但该 `.git` 是**用户仓库原有**（基线即 True）；递归查找全工程 `.git` 目录只有根那一个；引擎版本库落在 **`.research/engine.git`**（bare=true，28 次提交），未在根新建 `.git` |
| **E4** | 用户 `.gitignore`/`.git\config`/`.git\HEAD` 与基线一致 | **通过** | `.gitignore`：基线不存在 → 执行后 `Test-Path` 仍 False（一致：引擎未创建、未改写）；`.git/config` 内容与基线逐字相同；`.git/HEAD` = `ref: refs/heads/master` 与基线逐字相同；`.git` 顶层条目与基线完全相同；`.git/logs/HEAD` 仅 1 条（用户初始提交），无引擎提交/检出记录；`.git/info/exclude` 为 git 默认内容、无自定义 hook；**用户 `.git` 内无任何文件在探针开始（19:19:00 本地）之后被写入** |

### E 段原样输出

```powershell
cd D:\CCNI\expHarness\scratch-usergit
git rev-parse HEAD
git status --porcelain
```
```
bc2bf0991d4c7562b5046de2e75457753e4deb94
 M src/train.py
?? .kb/
?? .research/
?? _report/
?? experiments/
?? pipeline.yaml
?? project.yaml
?? registry.jsonl
?? scripts/
?? skills/
?? templates.yaml
?? wip_scratch.py
```

```
=== E2b status codes only (machine) ===
 M
??
=== E2c diff of tracked files vs HEAD (name-status) ===
M	src/train.py
=== E3 Test-Path .git ===
True
=== E3b nested .git dirs anywhere under project ===
D:\CCNI\expHarness\scratch-usergit\.git
=== E4 .gitignore exists? ===
False
=== E4 .git/config ===
[core]
	repositoryformatversion = 0
	filemode = false
	bare = false
	logallrefupdates = true
	symlinks = false
	ignorecase = true
[user]
	email = user@example.com
	name = user
=== E4 .git/HEAD ===
ref: refs/heads/master
=== any user-.git file modified at/after probe start (19:19:00 local) ===
(none)
```

> 说明：` M src/train.py` 在**基线**就已存在，且 `src/train.py` 的 blob 哈希前后一致（`b63f3a28d2b29c69d538f55988e68cabde85b13c`），文件 mtime 为 19:10:08（早于探针 19:19:36），故**引擎未修改该已跟踪文件**。状态里的 `??` 新增项均为引擎产物或基线既有的 `wip_scratch.py`。

---

## 2. C4 失败根因（有证据，非隔离问题）

现象：`run_observe` 拒绝，提示「清单里没有角色为 stdout 的产出文件」。

证据链：
1. `experiments/usergit-probe-probe-20260908-111936-40b/raw/` **为空目录**。探针脚本正文是 `print("probe ok", flush=True)`，**不读取也不写 `--out` 参数**，所以进程没有在 `raw/` 落任何文件。设计上 `experiments/<runId>/raw/*` 由「进程（非工具）」写入、`run_launch` 只登记已存在的文件（`research-engine-tools.md:22`）。
2. 即使有文件，**角色名也不匹配**：同工作区其他工程的 manifest 中，进程产出被登记为 `role=log`（如 `scratch-proj2/…/raw/smoke.log`、`tools/_probe-project/…/raw/out.log`），其模板 observables 也写 `role: log` 且脚本自己写日志文件；本次模板（B5）却声明 `role: "stdout"`，故永远匹配不到。
3. 次要：B5 的 `pattern: "probe ok"` 没有捕获组，而 `template_declare` 约定「第 1 个捕获组 = 数值」，即便有产出也无法取出数值。

结论：这是**验收夹具与引擎观察契约不一致**（角色名 `stdout` vs `log` + 脚本未产出文件 + 正则无捕获组），与「引擎不碰用户仓库」的隔离目标无关。C2/C3 已证明执行与登记链路本身正常（done、退出码 0、stdout `probe ok`）。

---

## 3. F 结论（三问）

1. **用户仓库的 HEAD 是否变化？** 否。前后均为 `bc2bf0991d4c7562b5046de2e75457753e4deb94`，完全不变。
2. **用户已跟踪文件是否有任何被修改/删除？** 没有。3 个已跟踪文件（`README.md`、`data/notes.txt`、`src/train.py`）的 blob 哈希与基线逐一相同，无删除/重命名；状态里唯一的 ` M src/train.py` 是基线既有的用户未提交改动（哈希未变、mtime 早于探针）。
3. **引擎的文件是否全部落在未跟踪区（允许），且没有改写用户的 `.gitignore`？** 是。引擎产物（`.kb/`、`.research/`、`_report/`、`experiments/`、`pipeline.yaml`、`project.yaml`、`registry.jsonl`、`scripts/`、`skills/`、`templates.yaml`）全部为 `??` 未跟踪项；用户 `.gitignore` 基线不存在、执行后仍不存在，未被创建或改写；用户 `.git` 内部无任何文件在探针开始后被写入，`.git/config`、`.git/HEAD`、`.git/info/exclude`、hooks 均与基线一致。

**隔离判定（§6.2-J）：通过。** 唯一的失败项是 C4 的观察字段提取（夹具/契约不一致），不构成对用户仓库的污染或改写。

---

## 4. 附：完整执行顺序（供复核）

A1 `project_init` → A2 `project_load` → A3 `project_verify` → B1 `stage data(entry)` → B2 `stage train` → B3 `edge data→train` → B4 `script_declare probe` → B5 `template_declare probe` → C1 `run_draft`（runId `usergit-probe-probe-20260908-111936-40b`）→ C2 `run_launch`（job `research.run-1`，退出码 0）→ 等 15s → C3 `run_query`（done）→ **C4 `run_observe`（失败）** → D1 `note_write` → D2/D3/D4 `view_render`（report/index/notes-skill）→ D5 `project_verify`（clean）→ E1–E4 隔离断言（全通过）。

未执行任何 `git commit`/`add`/`checkout`/`stash`/`reset`；未修改用户已跟踪文件；未删除任何文件。
