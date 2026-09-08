# research-engine 八要素字段字典（契约 v3）

> 与 `contract/*.schema.json` 配套：schema 管结构与类型，本表管**语义、来源、校验**。
> 每一行 = 一个字段在物理上的唯一落点、谁能写它、写入时校验什么、读它时怎么判合法。

## 0. 落点速查

| 要素 | 物理落点 | 属主 |
|---|---|---|
| 对话 | `registry.jsonl` 的 `decision` 事件 | exp-ledger |
| 环境 | `project.yaml` / `pipeline.yaml` / `templates.yaml` / `scripts/*.meta.json` | exp-ledger / stage-ctrl / task-dispatch |
| 状态 | `registry.jsonl`（权威）+ `.research/state.json`、`_report/*`（派生） | exp-ledger / stage-ctrl / kb-core |
| 证据 | `experiments/<runId>/{config,manifest,observations}.json` + `raw/` | task-dispatch（raw 由进程写） |
| 用户权威 | `project.yaml.conventions[]` + `decision` 事件 | exp-ledger |
| 证据权威 | `experiments/<runId>/observations.json` | task-dispatch |
| agent 提议 | `.kb/notes/*.md`（`status: proposed`） | kb-core |
| 结论 | `.kb/notes/*.md`（`kind: claim`） | kb-core |

## 1. `registry.jsonl` 事件（append-only）

每行一个 JSON 对象，公共字段：

| 字段 | 类型 | 必填 | 来源 | 校验 |
|---|---|---|---|---|
| `record` | string | 是 | 事件类型 | 枚举：`project/entity/decision/pipeline/stage/run/observe/verify/render/reconcile/note` |
| `ts` | string | 是 | 工具时钟 | ISO 8601 |
| `actor` | string | 是 | 工具 | `engine`（工具自身）或 `user`（带裁决） |
| `seq` | integer | 是 | 追加时自增 | 必须 = 行号；旧台账缺此字段按行号解释 |
| `prev` | string | 是 | 上一行内容的 sha256 | 空台账为 `"genesis"`；断链即台账被外部改写 |
| `commit` | string | 否 | 版本库 | **内部字段**，绝不进入模型可见文本 |

各 `record` 的专有字段：

| record | 字段 |
|---|---|
| `project` | `action`（`init`/`reconcile`）, `root`, `id` |
| `entity` | `id`, `kind`, `name?`, `props?`, `source` |
| `decision` | `kind`（`convention`/`note`/`run-archive`）, `id`, `askCallId`, `question?`, `answer`, `sessionId`, `attested?` |
| `pipeline` | `action`（`stage`/`edge`）, `stage?`, `edgeFrom?`, `edgeTo?`, `entry`, `graphVersion` |
| `stage` | `from`, `to`, `graphVersion`（**只有真正的阶段转移**；声明走 `pipeline`） |
| `run` | `runId`, `template`, `templateVersion`, `stage`, `kind`, `status`, `params`, `paramsHash`, `graphVersion`, `jobId?`, `detail?`, `outputs?`, `complete?` |
| `observe` | `runId`, `fields[]`, `compareTo?` |
| `verify` | `status`（`clean`/`dirty`/`unknown`）, `dirty[]`, `unknown[]`, `attested[]` |
| `render` | `kind`（`notes-skill`/`report`/`index`/`state`）, `paths[]`, `count` |
| `reconcile` | `mode`, `paths[]`, `reason`, `decision?` |
| `note` | `name`, `kind`, `status`, `authority`, `decidedBy?` |

**重放语义**：状态 = 按 `seq` 折叠事件。`run` 取该 runId 最后一条（字段逐条合并）；`stage` 取最后一条的 `to`（`pipeline` 事件不参与当前阶段的折叠）。

## 2. `project.yaml`

| 字段 | 类型 | 必填 | 来源 | 校验 |
|---|---|---|---|---|
| `schemaVersion` | integer | 是 | 常量 3 | 不等则拒绝写入 |
| `project.id` | string | 是 | `project_init` | kebab-case，与目录名建议一致 |
| `project.name` | string | 是 | `project_init` / 用户 | 非空 |
| `project.domain` | string | 否 | `project_init` | — |
| `managed` | string[] | 是 | `contract/managed.json` | 必须与受管白名单一致 |
| `conventions[]` | convention[] | 是 | `convention_declare` | 每条必须带 `decision`；`authority` 恒为 `user` |
| `vocabulary` | object | 否 | `project_init` / 迁移 | 开放词汇 |
| `legacy.keep[]` | {pattern,count} | 否 | `project_init` | 只登记不哈希 |

### convention

| 字段 | 类型 | 必填 | 来源 | 校验 |
|---|---|---|---|---|
| `id` | string | 是 | 工具生成（kebab） | 工程内唯一 |
| `statement` | string | 是 | 模型起草 | 与用户答复不矛盾（答复里的硬约束必须在 statement 中出现） |
| `scope` | string | 否 | 模型 | 缺省 = 全工程 |
| `authority` | string | 是 | 常量 `user` | 不可为 `agent` |
| `status` | string | 是 | 工具 | `active` / `deprecated`（**永不删除**） |
| `source` | string | 是 | 模型 | `文件:行` / `runId` / 实测命令 |
| `decision` | decision | 是 | 会话回查 | `askCallId` 必须对应本会话中一次真实提问且用户确有答复 |

## 3. `pipeline.yaml`

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `graphVersion` | integer | 是 | 每次 `stage_declare` 成功 +1 |
| `entry` | string\|null | 否 | 必须是已知阶段；且不得有入边（fatal） |
| `stages[].id` | string | 是 | 唯一；改名走「新 id + 旧 id `deprecated`」 |
| `stages[].status` | enum | 否 | `active`（缺省）/ `deprecated` |
| `edges[].from/to` | string | 是 | 端点必须已声明；不重复；不自环（fatal） |

## 4. `templates.yaml`

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `version` | integer | 是 | 内容变更 +1 |
| `status` | enum | 是 | `active` / `deprecated` |
| `allow` | string[] | 是 | 非空；`run_launch` 命令前缀必须命中 |
| `scriptRef` | object | 是 | 必须已由 `script_declare` 声明；哈希与磁盘一致 |
| `paramsSchema` | object | 是 | JSON Schema（object 根）；`run_draft` 用它校验 params |
| `observables[]` | observable[] | 是 | **可为空数组**，但字段必须显式声明；`run_observe` 只认这里 |
| `args` | string | 否 | `{{key}}` 必须在 params 中出现；保留占位见 `managed.json` |

## 5. `experiments/<runId>/config.json`（实例冻结）

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `runId` | string | `run_draft` | `<projectId>-<template>-<ts>-<rand>` |
| `template` / `templateVersion` | string / integer | 环境 | 冻结时的模板身份 |
| `params` / `paramsHash` | object / string | 入参 | 参数与规范化哈希 |
| `stage` / `graphVersion` | string / integer | 状态 | 冻结时的阶段机 |
| `command` | string | 工具渲染 | 完整命令行（**权威**，`run_launch` 以它为准） |
| `scriptRef` | object | 环境 | `{name, mode, path, sha256}` |
| `interpreter` | string | 工具推导 | 由脚本扩展名决定 |
| `workdir` | string | 工具 | 工程根 |
| `envExpectation` | object | 工具 | `{seed, device?, python?, torch?, cuda?, gpu?}`，`probed` 标记是否实测 |

## 6. `manifest.json` / `observations.json`

manifest：每个产出 `{path, role, sha256, bytes, producer, ts, stored}`；`raw/` 下未登记的文件 → 该 run 证据不完整（`complete:false`）。

observations：`{field, value, unit, file, line, sha256, extractedAt, compareTo?}`。
- `field` 必须来自模板 `observables[].field`；
- `file` 必须在 manifest 中登记且当前哈希与 `sha256` 一致；
- `compareTo` 记录 `{runId, verdict, otherValue, delta, deltaPct, tolerancePct}`。

## 7. `.kb/notes/<name>.md`

frontmatter（YAML）：

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `kind` | enum | 是 | `proposal` / `claim` / `lesson` / `question` |
| `status` | enum | 是 | `proposed`（缺省）/ `accepted` / `superseded` / `retracted` |
| `authority` | enum | 是 | 写入时恒为 `agent`；裁决后可带 `decidedBy`（user 权威） |
| `evidence[]` | pointer[] | claim 必填 | `{type:'run'\|'file'\|'observation', ref}`，逐条解析，失败即拒绝 |
| `scope` | string | claim 必填 | 成立条件 |
| `decidedBy` | decision | 裁决后 | 用户裁决原文 |

## 8. `.research/state.json`（派生）

`{derived:true, generatedAt, source:'registry.jsonl', graphVersion, stage, history[]}` —— 可随时重建。

**谁写它**：只有 `stage_goto`。

| 调用 | 语义 | 是否要用户裁决 |
|---|---|---|
| `stage_goto to=<阶段>` | 记录一次真实转移（必须走已声明的边） | 否 |
| `stage_goto replay=true` | 纯重放：按台账重算，不产生转移 | 见下 |

**冲突规则（P3）**：重放只在**会改变现有派生状态断言的值**时才需要用户裁决——
文件已存在且 `stage` 与台账重放值不同（或形状不合 v3）时，说明**两个来源互相矛盾**，
裁决权不在工具也不在 agent，必须带 `decision{askCallId, answer}`；裁决会记为 `decision` 事件（`kind: state-replay`）。
文件缺失、或已与台账一致时，重放只是缓存重建，不需要裁决。

**体检**：`project_verify` 会比对派生状态与台账；形状不合或值矛盾即点名并给出修法，
派生视图永远不会因为「没被检查」而继续撒谎。
