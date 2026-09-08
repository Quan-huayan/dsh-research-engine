# research-engine 工具流程规格（对齐稿 v2）

> 依据 `research-engine-principles.md`（八要素）与 `research-engine-tools.md`（22 工具权责表）。
> 每个工具按同一模板描述：**入参 / 前置闸门 / 流程 / 产物 / 返回 / 拒绝**。
> 约定：所有写入都遵循 `写文件 → 引擎内建 git 提交 → 追加台账事件`；崩溃在两步之间只会留下 `dirty`，由 `project_reconcile` 修复。
> **内建 git 对模型完全不可见**：模型没有 git 工具、看不到 commit/哈希/diff 命令，工具返回文本也不含任何 git 词汇（见 §附）。

---

## 0. 公共流程（所有工具共用）

1. **解析工程根**：入参 `root?`，否则会话 cwd；工程外路径一律拒绝。
2. **写入前置守卫（隐式 verify）**：写类工具先用引擎内建 git 核对该工具将触及的受管文件——工作树与 HEAD 不一致（被外部改/删）→ **拒绝写入**并给出修复路径；`query/render` 不受限。
3. **执行**：只读工具直接读；写类工具按各自动作执行。
4. **落盘 + 提交**：写受管文件 → 引擎内建 git `add -- <白名单路径>` + commit（模型不可见）→ 台账事件内部记录 commit。
5. **追加台账**：经 `ledger_append` 追加事件；**模型可见文本不含 commit/哈希**。
6. **返回文本**：只讲"发生了什么 + 下一步 + 是否需用户裁决"；不出现 git 词汇、commit、哈希、内部路径。
7. **拒绝文本**：必须包含"为什么拒绝 + 怎么修"。

---

## exp-ledger（8）

### 1. `project_init`
- **入参**：`id`、`name`、`domain?`
- **前置**：工程根下不存在 `project.yaml`
- **流程**：
  1) 解析工程根；校验 `id` 为 kebab-case；
  2) **发现现状**：检测已有 `project.yaml/registry/pipeline/templates/scripts/notes/experiments`、旧命名引擎文件、会话导出 zip；
  3) **建基础设施**：`.research/engine.git`（引擎内建 git，显式 `GIT_DIR`/`GIT_WORK_TREE`）+ git-lfs（`info/attributes` 把 `experiments/*/raw/**` 映射到 LFS）+ `.research/managed.json`（受管白名单）；
  4) **分类登记既有文件**：legacy 保护类（`.pth/.png/.txt/.ipynb`）记 `size/mtime`（不哈希）；既有 `.py` 记"未声明脚本"；数据/权重目录记"实体候选"；会话 zip 记"对话副本（不参与证据）"；
  5) 写 `project.yaml`：`project{id,name,domain}`、`schemaVersion`、`managed[]`、`legacy{keep[],protectedAreas[]}`、`conventions: []`；
  6) 创建空 `registry.jsonl`；`pipeline.yaml`/`templates.yaml` 留给属主首次声明（不越权建）；
  7) **首次提交**：受管文件入库；台账事件 `{record:'project', action:'init'}`；
  8) 初始体检（等同 `project_verify`）→ 状态 `clean`。
- **产物**：`project.yaml`、`registry.jsonl`、`.research/engine.git`、`.research/managed.json`、台账事件
- **返回**：工程根、id、legacy 计数、现状清单、待办（`stage_declare`/`template_declare`/`script_declare(adopt)`）
- **拒绝**：`project.yaml` 已存在（不覆盖）；id 非法；根不可写；git 不可用（降级需用户确认）

### 2. `project_load`
- **入参**：`root?`
- **前置**：`project.yaml` 存在
- **流程**：读 `project.yaml` + `pipeline.yaml` + `templates.yaml` → 读最近一次 verify 结果 → 组装环境视图（只读，不写）
- **产物**：无
- **返回**：身份、阶段机摘要、模板列表（含 `observables`）、约定列表（含状态与裁决引用）、受管区、legacy 摘要、最近 verify 状态
- **拒绝**：文件缺失/解析失败（报具体文件与行）

### 3. `project_verify`
- **入参**：`scope?`（`all` 默认）
- **流程**（内部全用引擎 git，返回文本不提 git）：
  1) 受管白名单内逐文件比对工作树与 HEAD → `clean / dirty / unknown`（`M`/`D` = 被外部改/删；白名单外未跟踪文件忽略）；
  2) 与台账交叉锚定：每条事件记录的 commit 必须存在于引擎 git 历史中（防历史被重写）；
  3) 校验 schema（project/pipeline/templates）；
  4) 校验阶段图 fatal 规则；
  5) 校验每个 run 的 manifest 完整性（`raw/` 下未登记文件 → `unknown`）；
  6) 校验 decision 引用：会话日志可读则回查，不可读标 `attested`；
  7) 记台账事件 `{record:'verify', status, dirty[], unknown[]}`。
- **产物**：台账事件（**不改任何文件**）
- **返回**：状态 + 问题清单（每条含"怎么修"，用业务语言：如"受管文件 `project.yaml` 被外部修改"）
- **拒绝**：无（永远返回报告）；带 `fix:true` 参数时拒绝并提示用 `project_reconcile`

### 4. `project_reconcile`
- **入参**：`paths[]`、`mode`（`restore` 默认 / `adopt`）、`reason`、`decision?`
- **前置**：这些路径当前为 `dirty/unknown`
- **处理情景**：

| 情景 | 检测 | 处理 |
|---|---|---|
| agent 用 write/edit/pwsh 改了受管文件 | 工作树 ≠ HEAD | **默认 `restore`**；要保留内容必须 `adopt` + 用户 decision |
| 用户手改 | 同上 | 同上（用户改动可 `adopt`，语义文件仍需重声明） |
| 崩溃在"写文件"与"提交"之间 | 工作树 ≠ HEAD 或台账缺行 | `restore` 或 `adopt`（带原因），补记事件 |
| 受管区出现未登记文件 | `unknown` | 登记（记哈希）或标 `ignored`（记原因） |
| 受管文件被删 | 工作树缺失 | `restore` 取回；或 `adopt` 确认删除（需 decision） |
| `raw/` 证据被改 | manifest 哈希不符 | 默认 `restore`（LFS 取回）+ 记 incident；**LFS 不可用 → 该 run 标 `invalidated`** |
| 进程产出未登记 | manifest 缺条目 | `run_launch` 补登记；否则该 run 证据不完整，不得据此下结论 |
| 大遗留文件被改 | `size/mtime` 变 | 报 `legacy-changed`（不哈希），提示历史证据可能被破坏 |
| 会话日志缺失 | decision 无法回查 | 降级 `attested`，不算 dirty |

- **流程**：
  1) `restore`：从引擎内建 git 的 HEAD 取回内容写回 → 记事件（模型看到"已还原"）；
  2) `adopt`：回查 `decision` → 记录新内容为新版本 → **语义文件（阶段/模板/约定/脚本）拒绝在此改语义**，指向对应 `declare` 工具；
  3) 台账事件（内部记 commit；返回文本不提）。
- **产物**：台账事件（+ 文件还原）
- **返回**：已还原/已接受清单、仍需语义修复的路径
- **拒绝**：没有 dirty；`adopt` 无 decision；试图借 reconcile 改语义

### 5. `entity_declare`
- **入参**：`kind`、`id?`、`name?`、`props?`、`source`（必填）
- **前置**：`source` 可解析（`文件:行` / `runId` / `实测时间+命令`）
- **流程**：校验 source → 规范化记录 → 追加台账事件 `{record:'entity', ...}`
- **产物**：台账事件
- **返回**：登记结果 + 同 kind 现有数量
- **拒绝**：缺 `source`；source 指向的文件不存在或行号越界

### 6. `entity_query`
- **入参**：`record`（`entity` / `decision`）、`id?`、`kind?`、`limit?`
- **流程**：只读台账过滤（decision 附带裁决人、问题、答复原文摘要、时间）
- **产物**：无
- **返回**：列表
- **拒绝**：无

### 7. `convention_declare`
- **入参**：`statement`、`scope?`、`source`、`decision{askCallId, answer}`
- **前置**：`decision` 必填
- **流程**：
  1) 用 `ctx.sessionQuery` 回查 `askCallId`：必须存在、必须是 `ask_user_question`、结果必须是用户答复；
  2) 取问答原文，校验 `statement` 与答复不矛盾（答复中出现的硬约束必须体现在 statement 里）；
  3) 写 `project.yaml.conventions[]`：`{id, statement, authority:'user', status:'active', source, decision:{askCallId, answer, sessionId, ts}}`；
  4) 追加台账事件 `{record:'decision', kind:'convention', ...}` + 文件哈希。
- **产物**：`project.yaml` 更新、台账事件
- **返回**：约定 id + 引文 + 生效范围
- **拒绝**：无 decision；回查失败（标 `attested` 需用户显式同意）；statement 与答复矛盾

### 8. `ledger_append`（内部服务，不暴露给模型）
- **入参**：`event`、`actor`、`commit?`（若本次调用伴随文件变更）
- **流程**：组装 `{...event, commit, actor, ts}` → 追加一行 → 返回行号
- **产物**：`registry.jsonl`
- **返回**：行号
- **拒绝**：事件体非法；`registry.jsonl` 工作树与 HEAD 不一致（说明被外部改动，要求先 verify/reconcile）

---

## stage-ctrl（3）

### 9. `stage_declare`
- **入参**：`action`（`stage`/`edge`）、`id`/`from`/`to`/`entry?`
- **流程**：读 `pipeline.yaml` → 应用变更 → 图校验（fatal：id 重复/端点未知/边重复/自环/entry 未知/entry 有入边）→ 通过后写回 → 台账事件 + 哈希
- **产物**：`pipeline.yaml`、台账事件
- **返回**：变更结果 + warn（有边未设 entry、不可达、孤立占位）
- **拒绝**：任一 fatal（返回具体条目）

### 10. `stage_read`
- **入参**：`root?`
- **流程**：读 `pipeline.yaml` → 从台账重放当前阶段 → 组装视图（只读）
- **产物**：无
- **返回**：阶段/边/入口、当前节点、合法去向、fatal/warn
- **拒绝**：无

### 11. `stage_goto`
- **入参**：`from?`（缺省=当前阶段）、`to`
- **流程**：校验 `(from,to)` 在已声明边中 → 追加台账事件 `{record:'stage', from, to}` → 物化 `.research/state.json`（派生）
- **产物**：台账事件、派生状态文件
- **返回**：当前阶段、历史条数
- **拒绝**：边未声明（返回"合法去向"列表，不报错）

---

## task-dispatch（7）

### 12. `template_declare`
- **入参**：`id`、`allow[]`、`scriptRef`、`paramsSchema`、`observables[]`、`args?`、`overwrite?`
- **前置**：`allow` 非空；`scriptRef` 已由 `script_declare` 声明（或指向已登记 legacy 脚本）
- **流程**：校验 → 写 `templates.yaml`（`version` 递增）→ 台账事件 + 哈希
- **产物**：`templates.yaml`、台账事件
- **返回**：`id@version`、`observables` 列表、allow 白名单
- **拒绝**：allow 为空；scriptRef 未声明；id 已存在且未 `overwrite`

### 13. `script_declare`
- **入参**：`name`、`purpose`、`entrypoint`、`allowlist[]`、`content`（脚本正文）、`overwrite?`
- **前置**：目标路径在工程内 `scripts/`；`content` 由本次调用提供（**不允许声明"已存在于磁盘"的脚本**）
- **流程**：写 `scripts/<name>.py` → 写 `scripts/<name>.meta.json`（`purpose/entrypoint/allowlist/owner/sha256/version`）→ 台账事件
- **产物**：脚本 + 元数据 + 台账事件
- **返回**：路径、sha256、version
- **拒绝**：写到工程外；缺 allowlist；同名且内容不同但未 `overwrite`

### 14. `run_draft`
- **入参**：`template`、`params`、`stage?`、`kind?`、`from?`（复现某 run 的参数）
- **前置**：`project_verify` 无 dirty；`stage` 已声明；模板存在；占位符齐备
- **流程**：
  1) 解析模板版本、脚本引用、脚本哈希；
  2) 校验 params（schema + `{{占位}}` 完整性）；
  3) 生成 `runId`；`from` 给定时复制其 params；
  4) 冻结实例：写 `config.json`（模板版本、params、`paramsHash`、stage、kind、完整命令、解释器、脚本哈希、工作目录、`graphVersion`）；
  5) 写 `manifest.json` 初稿（登记 `config.json` 自身）；
  6) 提交受管文件（内建 git）→ 台账事件 `{record:'run', status:'draft'}`。
- **产物**：`experiments/<runId>/{config,manifest}.json`、台账事件
- **返回**：runId、命令、下一步（`run_launch`）
- **拒绝**：占位符缺参；stage 非法；verify dirty；模板/脚本缺失

### 15. `run_launch`
- **入参**：`runId`
- **前置**：run 状态为 `draft`；verify 无 dirty；安全闸通过
- **流程**：
  1) 读 `config.json`（权威来源）→ 渲染命令；
  2) 安全闸：命令前缀 ∈ `allow`、脚本 resolve 后在工程内；
  3) 解析 shell/sandbox 策略（`shell.sandboxMode`、`sandboxPolicy`、`shellEnv`）；
  4) 台账 `status:'queued'`；
  5) `jobs.start({kind:'research.run', owner, run})` 后台执行（不 fork、不阻塞）；
  6) 台账 `status:'running'` + `jobId`；
  7) 结束时：登记 `raw/` 产出到 `manifest.json`（`role/sha256/bytes/producer`）→ **`raw/` 经 git-lfs 入库**、元数据提交 → 台账 `status:'done'/'failed'` + `detail`（沙箱运行器失败单独标注）。
- **产物**：台账事件、manifest 更新、LFS 中的证据副本
- **返回**：jobId、命令、环境摘要（`sandboxMode/dshEnv/sandboxPolicy`）
- **拒绝**：安全闸命中（记 lesson）；verify dirty；状态不是 draft

### 16. `run_observe`
- **入参**：`runId`、`fields?`（缺省=模板全部 observables）、`compareTo?`
- **前置**：run 已终态；字段已在模板 `observables[]` 声明；来源文件已在 manifest 登记
- **流程**：
  1) 读 manifest 找每个 observable 的来源文件（按 `role`）；
  2) 校验文件哈希与 manifest 一致；
  3) 按声明 pattern 提取 → `{field, value, unit, file, line, sha256, extractedAt}`；
  4) 合并写入 `observations.json`；
  5) `compareTo` 给定时与目标 run 的观察比对 → 记录 `match/mismatch + delta`；
  6) 台账事件 `{record:'observe', runId, fields}`。
- **产物**：`observations.json`、台账事件
- **返回**：提取值 + 来源（`文件:行`）+ 对比结果
- **拒绝**：字段未声明；文件未登记；哈希不符；run 未结束

### 17. `run_query`
- **入参**：`runId?`、`template?`、`stage?`、`status?`、`limit?`
- **流程**：只读台账 + run 目录清单（含产物与观察摘要）
- **产物**：无
- **返回**：表（runId/模板/阶段/状态/参数/产物数/观察值）
- **拒绝**：无

### 18. `run_close`
- **入参**：`runId`、`status`（`invalidated`/`archived`）、`reason`、`decision?`
- **流程**：校验状态迁移合法（终态→失效/归档）→ `archived` 需 decision 引用（回查）→ 台账事件（**产物不动**）
- **产物**：台账事件
- **返回**：新状态 + 原因
- **拒绝**：试图物理删除；`archived` 无 decision

---

## kb-core（4）

### 19. `note_write`
- **入参**：`kind`（`proposal`/`claim`/`lesson`/`question`）、`name`、`description`、`statement`、`evidence[]?`、`scope?`
- **前置**：`kind=claim` 必须有 `evidence[]`；同 scope 存在未裁决冲突时只能写 `proposal`
- **流程**：校验（name kebab、evidence 逐条解析）→ 写 `.kb/notes/<name>.md`（frontmatter：`kind/status:'proposed'/authority:'agent'/evidence/scope`）→ 台账事件
- **产物**：笔记、台账事件
- **返回**：笔记名、状态（`proposed`）、是否需裁决
- **拒绝**：claim 缺证据；指针解析失败；name 非法

### 20. `note_adjudicate`
- **入参**：`note`、`action`（`accept`/`retract`/`supersede`）、`supersedes?`、`decision?`
- **前置**：需要 user 权威的动作（约定类、撤回已接受结论）必须带 `decision`
- **流程**：
  1) 需要时回查 `askCallId`（同 `convention_declare`）；
  2) 改笔记 frontmatter `status`（`accepted`/`retracted`/`superseded`）并记录 `decidedBy`；
  3) 追加台账 `decision` 事件；
  4) 提示"建议 `view_render`"。
- **产物**：笔记状态更新、台账事件
- **返回**：新状态 + 引文
- **拒绝**：需要 decision 而缺失；note 不存在；非法状态迁移

### 21. `note_query`
- **入参**：`kind?`、`status?`、`scope?`、`evidence?`（runId/文件）、`query?`
- **流程**：只读笔记 + 索引；默认只返回 `accepted`，`proposed` 单列并标状态
- **产物**：无
- **返回**：命中列表（含 `status/authority/evidence` 指针）
- **拒绝**：无

### 22. `view_render`
- **入参**：`kind`（`notes-skill`/`report`/`index`）
- **流程**：
  - `notes-skill`：读 `conventions(active)` + `claims(accepted)` → 渲染 `skills/<project>/SKILL.md`（头部标"派生视图 + 生成时间 + 来源 id"）；
  - `report`：读台账 run/observe → 写 `_report/{runs.csv,summary.json}`（含"待裁决/冲突"清单）；
  - `index`：扫描 `.kb/notes` → 写 `.kb/index.yaml`。
  - 每次追加台账事件 `{record:'render', kind}`。
- **产物**：三种派生视图 + 台账事件
- **返回**：生成路径、条目数、未裁决项数量
- **拒绝**：无（但派生文件若被手改，`project_verify` 会报 dirty）

---

## 附：一次完整研究的调用序列（示例）

```
project_load → project_verify(clean)
ask_user_question（确认"参数差 <10%"）
convention_declare(decision=…)
template_declare(observables=[val_acc, params_total])
script_declare(如需新脚本)
run_draft(params={seed:0}) × N → run_launch × N
run_observe(runId, fields=…) → observations.json
note_write(kind=claim, evidence=[runIds]) → note_adjudicate(accept)
view_render(report) → view_render(notes-skill)
run_close(invalidated)（如某次作废）
```

---

## 附：内建 git 的实现约定（模型完全不可见）

### 位置与隔离（不碰用户仓库）

- 引擎仓库：`<project>/.research/engine.git`（`GIT_DIR`），工作树 = 项目根（`GIT_WORK_TREE`）。
- **每次调用都显式传 `GIT_DIR`/`GIT_WORK_TREE`**，绝不依赖目录发现 → 物理上不可能读到用户的 `.git`（已实测：项目根不会生成 `.git`）。
- 隔离项：`GIT_CONFIG_NOSYSTEM=1`、引擎身份、`core.hooksPath` 指向空目录、不读用户 excludes。
- 五条硬规则：① 不用默认 git 发现；② 不写 `.gitignore`、不改用户 index/HEAD/config/hooks；③ 不在项目根建 `.git`；④ 若项目本身是用户仓库，只**只读**取 `rev-parse HEAD` 作为证据标签；⑤ `.research/engine.git` 在用户仓库里会显示为 untracked——**不代改 ignore**，只在 `project_init` 报告里提示一句。

### 受管白名单（进引擎仓库的路径）

`project.yaml`、`pipeline.yaml`、`templates.yaml`、`registry.jsonl`、`scripts/**`、`.kb/**`、`experiments/*/{config,manifest,observations}.json`、`_report/**`、`.research/state.json`。

**`experiments/*/raw/**` 经 git-lfs 入库**（`info/attributes` 在引擎仓库内声明，不影响工作树）；legacy 保护类与用户其他文件**永不入库**。

### 模型不可见规则

- 模型侧**没有 git 工具**；工具返回文本**不出现** git/commit/哈希/diff/分支等任何词汇；
- `project_verify` 用业务语言报告（"受管文件 `project.yaml` 被外部修改"），不报 `M`/`HEAD`；
- `project_reconcile` 返回"已还原/已接受"，不回显命令；
- commit 只作为台账事件的**内部字段**，供引擎与前端（第 2 期）使用；
- 模型若用 pwsh 直接动引擎仓库 → 台账 commit 反查失败 → `dirty` 并点名（这是检测，不是预防）。

### 降级

| 缺失 | 降级行为 |
|---|---|
| git 不可用 | 仅台账记录（无版本/还原能力）；`project_init` 需用户确认；verify 标 `git: unavailable` |
| git-lfs 不可用 | `raw/` 不入库，仅 manifest 哈希；证据被改 → 该 run 标 `invalidated` |
| 引擎仓库被篡改 | 台账 commit 反查失败 → `dirty`；可 `restore`（若仓库仍可用）或按用户裁决重建 |
