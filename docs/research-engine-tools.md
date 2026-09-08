# research-engine 工具重设计（对齐稿 v2）

> 依据：`research-engine-principles.md`（八要素 + 三条原则的物理翻译）。
> 原则：**一个工具 = 一个物理落点 + 一次范畴转移 + 一组必填元数据 + 明确的拒绝条件**。
> 落点之外的文件不写；跨域只走 id 与属主提供的服务；不能填进这张表的工具一律删除。
> **引擎内建 git 是隐形基础设施**：所有写类工具在落盘后隐式提交受管文件（`raw/` 走 git-lfs），
> 但模型侧没有 git 工具、返回文本不含任何 git 词汇（见 `research-engine-tool-flows.md` 附录）。

---

## 1. 权责矩阵：文件 → 属主 → 工具集

| 物理落点 | 属主 | 它是什么范畴 | 写它的工具 |
|---|---|---|---|
| `project.yaml` | exp-ledger | 环境（身份/受管区/legacy/约定） | `project_init`、`convention_declare`、`project_reconcile` |
| `registry.jsonl` | exp-ledger | 状态 + 事件（run/entity/decision/verify） | 各域经 exp-ledger 的台账服务追加 |
| `pipeline.yaml` | stage-ctrl | 环境（状态机） | `stage_declare` |
| `templates.yaml` | task-dispatch | 环境（可执行声明） | `template_declare` |
| `scripts/*.py` + `scripts/*.meta.json` | task-dispatch | 环境（辅助脚本） | `script_declare` |
| `experiments/<runId>/config.json` | task-dispatch | 证据（实例冻结） | `run_draft` |
| `experiments/<runId>/manifest.json` | task-dispatch | 证据索引 | `run_draft`（建）、`run_launch`（登记产出） |
| `experiments/<runId>/raw/*` | 进程（非工具） | 证据（原始产出） | 进程写，`run_launch` 登记；**经 git-lfs 入库** |
| `.research/engine.git/` | 引擎基础设施（无工具属主） | 版本与审计（**模型不可见**） | 由所有写类工具隐式提交 |
| `experiments/<runId>/observations.json` | task-dispatch | 证据权威（提取值） | `run_observe` |
| `.kb/notes/*.md` | kb-core | 知识（提议/结论/教训/问题） | `note_write`、`note_adjudicate` |
| `skills/<project>/SKILL.md` | kb-core | **派生视图**（从约定+已接受结论渲染） | `view_render` |
| `_report/*` | kb-core | **派生视图** | `view_render` |
| `.kb/index.yaml` | kb-core | **派生视图** | `view_render` |
| `.research/state.json` | stage-ctrl | **派生状态**（当前阶段） | `stage_goto`（重放物化） |
| legacy 区（`.pth/.png/.txt/.ipynb`） | 用户 | 证据（不可变，登记制） | 只登记，不改不删 |

---

## 2. 工具表（最终）

### exp-ledger —— 环境 / 台账 / 校验（8）

| 工具 | 落点 | 范畴转移 | 必填元数据 | 拒绝条件 |
|---|---|---|---|---|
| `project_init` | `project.yaml`+`registry.jsonl`+`.research/engine.git` | 无 → 环境 | `id`、`name` | 已存在 / 根不可写 |
| `project_load` | 只读 | 读环境全貌（身份/阶段机/模板/约定/受管区） | — | 文件缺失 |
| `project_verify` | 只读 + verify 事件 | 校验 → `clean/dirty/unknown`（内部用引擎 git 比对工作树与 HEAD + 台账 commit 反查） | — | 不改任何文件 |
| `project_reconcile` | 受管文件 | 越权改动 → `restore`（默认，从引擎 git 取回）或 `adopt`（需用户裁决） | `paths[]`、`mode`、原因、`decision?` | 无 dirty 可修 / `adopt` 无 decision / 借 reconcile 改语义 |
| `entity_declare` | `registry.jsonl` | 声明 → 研究对象 | `kind`、`source` | 缺 source |
| `entity_query` | 只读 | 查询 entity / decision 事件 | — | — |
| `convention_declare` | `project.yaml` | 对话裁决 → 环境约定 | `statement`、`decision{askCallId,answer}`、`source` | 无 decision 引用 / 回查不通过 |
| `ledger_append`（内部服务，不暴露为工具） | `registry.jsonl` | 各域事件追加 | 事件体 + 前值哈希 | — |

### stage-ctrl —— 状态机（3）

| 工具 | 落点 | 范畴转移 | 必填元数据 | 拒绝条件 |
|---|---|---|---|---|
| `stage_declare` | `pipeline.yaml` | 声明 → 阶段机 | `entry`、阶段/边唯一性 | fatal 图违规 |
| `stage_read` | 只读 | 读图 + 当前节点 | — | — |
| `stage_goto` | `.research/state.json` + 台账事件 | 状态转移 | `from`（缺省=当前）、`to` | 边未声明 |

### task-dispatch —— 实例 / 执行 / 证据（7）

| 工具 | 落点 | 范畴转移 | 必填元数据 | 拒绝条件 |
|---|---|---|---|---|
| `template_declare` | `templates.yaml` | 声明 → 可执行声明 | `allow`、`paramsSchema`、`scriptRef`、**`observables[]`**、`version` | allow 为空 / 脚本未声明 |
| `script_declare` | `scripts/` | 声明 → 辅助脚本 | `purpose`、`entrypoint`、`allowlist`、`owner`、`sha256` | 写到工程外 / 无 allowlist |
| `run_draft` | `experiments/<runId>/` | 声明+参数 → 实例 | `template@version`、`params`、`stage`、脚本哈希、环境快照、完整命令 | 占位符缺参 / stage 非法 / verify dirty |
| `run_launch` | 台账 + manifest | 实例 → 执行 | `runId`、`owner`、后台 | 安全闸命中 / verify dirty / 非后台 |
| `run_observe` | `observations.json` | 产出 → 证据权威 | `runId`、**模板声明的字段名**、`compareTo?` | 字段未声明 / 产出未登记 / 哈希不符 |
| `run_query` | 只读 | 查询 run 与产出清单 | — | — |
| `run_close` | 台账 + 状态 | 实例 → `invalidated`/`archived` | `runId`、`reason`、`decision`（归档时） | 试图物理删除 |

### kb-core —— 知识 / 裁决 / 渲染（4）

| 工具 | 落点 | 范畴转移 | 必填元数据 | 拒绝条件 |
|---|---|---|---|---|
| `note_write` | `.kb/notes/` | 想法 → 提议 / 结论 | `kind`（proposal/claim/lesson/question）、`statement`；claim 另需 `evidence[]`+`scope` | claim 缺证据 / 指针解析失败 |
| `note_adjudicate` | 台账 decision 事件 + 笔记状态 | 提议 → 生效/撤回/取代 | `note`、`decision`（用户裁决时）、`supersedes?` | user-authority 无 decision 引用 |
| `note_query` | 只读 | 检索（kind/status/scope/evidence） | — | — |
| `view_render` | `skills/<project>/SKILL.md`、`_report/*`、`index.yaml` | 状态 → 派生视图 | `kind`（notes/report/index） | 试图手写这些文件 |

---

## 3. 流程：合法转移与闸门

```
① 接入：project_init → project_load → project_verify(clean)
                     ↘ stage_declare（阶段机）→ template_declare（含 observables）→ script_declare
② 约定：ask_user_question → convention_declare（强校验 decision）
③ 实验：run_draft（config+manifest 初稿）→ run_launch（后台）→ 进程产出
        → run_launch 登记产出到 manifest → run_observe（只能提模板声明的字段）
④ 知识：note_write(proposal/claim) → note_adjudicate → view_render
⑤ 收尾：run_close(invalidated/archived)；证据与结论永不物理删
```

**闸门（不满足即拒绝，不是提醒）**
- **所有写类工具前置**：本域受管文件的工作树必须与 HEAD 一致（引擎内建 git 隐式守卫，模型不可见）——被外部改动/删除即拒绝，并指向 `project_reconcile`。
- `run_draft`/`run_launch` 另需：全局 `project_verify` 无 dirty；stage 已声明且当前节点合法。
- `run_observe` 前置：字段在模板 `observables` 中声明；产出文件已登记且哈希一致。
- `note_write(claim)` 前置：`evidence[]` 全部可解析；同 scope 无未裁决冲突（有则只能写 `proposal`）。
- `note_adjudicate` 前置：user-authority 必须带 `decision`，写入时用 `ctx.sessionQuery` 回查 callId。
- `convention_declare` 前置：同上（强校验）。

---

## 4. 与旧工具的映射（改了什么、删了什么）

| 旧 | 新 | 说明 |
|---|---|---|
| `research_project` / `research_go` / `research_memo` | **删除** | 纯包装层，不承担任何范畴转移 |
| `project_load` / `project_init` | 保留 | 语义不变 |
| `entity_write` | `entity_declare` | 改名对齐"声明"范畴；去掉与 `project.yaml.entities` 的重复 |
| `entity_query` | 保留 | 增加 `record=decision` |
| `stage_*` | 保留 | `stage_declare` 取代 `stage_define` |
| `run_templates` | **删除** | 环境读取并入 `project_load` |
| `run_template` | `template_declare` | 增加 `observables[]` 与 `version` |
| `run_draft` / `run_launch` | 保留 | 增加 config 冻结字段与闸门 |
| `kb_use_learn` | `note_write` | 按 `kind` 分派规则（claim 需证据） |
| `kb_use_context` | `note_query` | 增加按 evidence/scope 过滤 |
| `kb_use_report` / `kb_index` | `view_render` | 合并为"渲染派生视图" |
| — | `project_verify` / `project_reconcile` | 新增：哈希与越权检测（P2 的牙齿） |
| — | `convention_declare` | 新增：用户权威的唯一写入口 |
| — | `script_declare` | 新增：辅助脚本必须工具产生且带元数据 |
| — | `run_observe` | 新增：证据权威只能由工具提取 |
| — | `note_adjudicate` | 新增：裁决（带 decision 引用） |
| — | `run_close` | 新增：失效/归档，替代删除 |

---

## 5. 需要你确认的四处

1. **文件按属主拆分**：`pipeline.yaml`、`templates.yaml` 从 `project.yaml` 拆出（单文件单属主）——同意吗？
2. **台账单写者**：`registry.jsonl` 由 exp-ledger 拥有，其他域通过其服务追加（跨域不直接写文件）——同意吗？
3. **观察字段必须在模板里声明**（`observables[]`），`run_observe` 只能提取声明过的字段——同意吗？这条同时防"挑数字"。
4. **`view_render` 合并** `_report` / `index` / 工程笔记 SKILL 三种派生视图（一个工具、三种 kind）——同意吗？
