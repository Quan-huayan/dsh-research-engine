# research-engine v3 实施报告

> 依据：`research-engine-plan.md`（v3）+ 三份对齐稿（principles / tools / tool-flows）。
> 结论：**22 工具契约、七份 schema、内建版本库、四插件、preset 接线、attndepth 迁移、§6.1 自动检查、§6.2 A–J 行为验收全部完成**；验收中发现的 11 个缺陷已全部修复并复验。

---

## 1. 交付物

### 1.1 preset（引擎本体）：`<dshHome>/.agent-presets/research-engine/`

| 路径 | 内容 |
|---|---|
| `preset.yml` | 名称/说明/顺序 |
| `agent.cordis.yml` | standard 副本 + persona（用户面）+ preset 自带 skills 发现 + `research-engine` group（5 行，行名统一 `?v=7`） |
| `skills/research-engine/SKILL.md` | 用户面路由与契约（八要素落点、闸门、用户权威姿势、范畴错误清单、典型节奏） |
| `contract/` | `project.schema.json`、`pipeline.schema.json`、`templates.schema.json`、`conventions.schema.json`、`manifest.schema.json`、`observations.schema.json`、`note.schema.json`（七份）+ `managed.json`（受管白名单唯一来源）+ `fields.md`（八要素字段字典） |
| `plugins/engine-git/main.js` | 内建版本库封装（**不注册工具**，提供 `research.engineGit` 服务） |
| `plugins/exp-ledger/main.js` | 环境 / 台账 / 校验（7 工具 + `ledgerAppend` 内部服务） |
| `plugins/stage-ctrl/main.js` | 状态机（3 工具） |
| `plugins/task-dispatch/main.js` | 实例 / 执行 / 证据（7 工具） |
| `plugins/kb-core/main.js` | 知识 / 裁决 / 渲染（4 工具） |

旧 preset 完整存档在 `D:\CCNI\expHarness\archive-preset-v6\`；旧 `plugins/research-facade` 已按 plan §7 删除。

### 1.2 工具面（21 个模型面工具 + 1 个内部服务）

`project_init`（含 `mode=migrate`）、`project_load`、`project_verify`、`project_reconcile`、`entity_declare`、`entity_query`（`record=entity|decision|ask`）、`convention_declare`｜`stage_declare`、`stage_read`、`stage_goto`｜`template_declare`、`script_declare`（`create`/`adopt`）、`run_draft`、`run_launch`、`run_observe`、`run_query`、`run_close`｜`note_write`、`note_adjudicate`、`note_query`、`view_render`｜内部 `ledger_append`。

### 1.3 验收与工具脚本（`D:\CCNI\expHarness\`）

| 文件 | 作用 |
|---|---|
| `tools/check-contract.mjs` | 七份 schema 编译 + 跨文件引用无环 + 真实数据「目标形态」差距清单 |
| `tools/check-plugins.mjs` | 五插件可加载、21 工具命名合法且唯一、`parameters`/`output.schema` 落在 dsh-tools 支持子集内、输出契约自洽 |
| `tools/probe-tools.mjs` | 假 ctx 装载五插件，逐工具跑 **180 项**断言（返回字段严格、返回文本零版本库词汇、拒绝路径必带修法、守卫/证据/权威/派生四组判据） |
| `tools/probe-migrate.mjs` | 造旧式工程 → `mode=migrate` → 核对阶段 6 的六项产出与幂等性 |
| `tools/check-preset.mjs` | 用宿主 `dsh-agent-presets` 的发现器解析 preset 合成文件（含 `!!js`） |
| `tools/test-answer-provider.mjs` | headless 脚本化「用户」，用于验收真实用户权威链路（非交付物） |
| `research-engine-headless-live.cordis.yml` | headless 验收 overlay（`?v=7`） |
| `accept-*.md` / `accept-*.report.md` | 六轮 headless 验收的任务书与报告 |
| `archive-preset-v6/` | 旧 preset 存档 |

---

## 2. 关键实现决定（与 plan 的对应）

| 要求 | 实现 |
|---|---|
| 内建版本库模型不可见 | `engine-git` 只提供内部服务，不注册工具；每次调用显式传 `GIT_DIR`/`GIT_WORK_TREE`（bare 仓库在 `.research/engine.git`，工程根永不出现 `.git`）；所有工具返回文本过 `scrub()` 兜底 |
| `raw/` 走 LFS | 仓库内 `info/attributes` + `git lfs install --local`（对象落 `.research/engine.git/lfs/`）；不可用则降级 `hash-only` |
| 封闭变更（P2） | 写类工具：**全局守卫**（受管区任何文件与 HEAD 不一致即拒绝）→ 写文件 → 入库 → 追加台账；`ledgerAppend` 自己也会把 `registry.jsonl` 入库，保证每次工具调用后工作树干净 |
| 证据权威（P1） | `run_observe` 只从**已登记**产出提取，校验文件指纹；进程输出在 settle 时无条件落盘 `raw/stdout.log` 并登记 |
| 用户权威（P3） | `verifyDecision` 回查会话事件（`tool/call` + `tool/result`），拷贝答复原文；`entity_query record=ask` 把提问标识暴露给模型 |
| 权威分离 | `note_write` 恒写 `proposed`/`agent`；`note_adjudicate accept` 只在证据逐条可解析时走证据权威，否则必须用户裁决 |
| 派生视图 | `view_render` 是唯一写入者；工程笔记头部标「派生视图 + 生成时间 + 来源」，不含内部工具名与版本库词汇 |
| 迁移（阶段 6） | `project_init mode=migrate`：原文归档 → 建基础设施 → 拆 pipeline/templates → 脚本 `adopt` → 补 run 证据清单 → 笔记补结构头 → 旧工程笔记移出环境位置；对已 v3 工程做**幂等修复复检** |

---

## 3. 验收结果

### 3.1 自动检查（§6.1）

| 判据 | 结果 |
|---|---|
| 契约：七份 schema 编译、跨文件引用无环 | ✅ 7/7，无环 |
| 契约：21 工具名 `^[a-zA-Z0-9_-]+$` 且唯一 | ✅ |
| 契约：`parameters`/`output.schema` 落在 dsh-tools 支持子集内 | ✅ 用宿主 `assertSupportedJsonSchema` 实检 |
| 隐形：所有工具返回文本（正常 + 拒绝）零版本库词汇 | ✅ 180 项逐次扫描零命中 |
| 守卫：越权改受管文件 → 写类工具一律拒绝 | ✅ 含脏窗口内的 `stage_declare`/`template_declare`/`run_launch` |
| 守卫：`restore` 恢复、`adopt` 无裁决被拒 | ✅ |
| 证据：未声明字段 / 未登记文件 / 指纹不符 三种情况均拒绝 | ✅ |
| 权威：无 `askCallId`、查不到标识、答复矛盾 三种情况均拒绝 | ✅ |
| 派生：手改 `_report`/`index`/`SKILL.md` → verify 报 dirty；重渲染恢复 | ✅ |
| 迁移自检 | ✅ 24 项全通过 |
| preset 合成：宿主自己的 preset 发现器解析 | ✅ 无问题（含 `!!js` 表达式） |
| preset 行名：`./plugins/*/main.js?v=7` 相对路径**真实挂载** | ✅ 用 `cordis:include` 以 preset 目录为 baseUrl 挂载，21 个工具全部进入工具清单 |

合计自动断言：**180 + 24 + 契约/插件/preset 静态检查，全部通过**。

### 3.2 headless 行为验收（§6.2）

| 组 | 内容 | 结果 |
|---|---|---|
| A–H | 接工程 → 声明 → 冒烟端到端 → 用户权威 → 知识裁决 → 派生视图 | **32/32**（`accept-happy-path.report.md`） |
| D/E/H/I/J/K | 失败重放回滚、非线性跳段、安全闸、越权与修复、证据/权威闸门、派生视图 | **33/34 → 缺陷修复后复验全通过**（`accept-guards.report.md`、`accept-reverify.report.md`） |
| J | 工程 = 用户 git 仓库时的隔离 | **E1–E4 全通过**：HEAD 逐字不变、已跟踪文件零改动、无新 `.git`、用户 `.git/config`/`HEAD`/`index`/`logs` 零写入（`accept-isolation.report.md`） |
| 阶段 6 | attndepth 迁移 + 修复复检 | **R1–R4、R6 全通过**；`project_verify` clean（`accept-migration.report.md`、`accept-migration2.report.md`） |
| 阶段 6 | 迁移后试点冒烟 | run `attndepth-smoke-diag-20260908-112907-35e` done；`run_observe` 提取 `python_version = 3.13.5`（`raw/smoke.log:2`）；verify clean（`accept-pilot-smoke.report.md`） |

### 3.3 attndepth 数据验收（§6.3）

| 要素 | 落点 | 状态 |
|---|---|---|
| 对话 | `registry.jsonl` 的 `decision` 事件 | 落点存在、当前为空（该工程尚无用户裁决；完整链路已在 scratch2 工程跑通） |
| 环境 | `project.yaml` / `pipeline.yaml`（5 阶段 / 6 边 / 入口 dataset）/ `templates.yaml`（7 模板）/ `scripts/*.meta.json` | ✅ |
| 状态 | `registry.jsonl`（65 行事件）+ `.research/state.json` | ✅ |
| 证据 | `experiments/<runId>/{config,manifest,observations}.json` + `raw/`（LFS） | ✅ 12 个既有 run 已补清单；冒烟 run 的 `raw/*.log` 在 LFS |
| 用户权威 | `project.yaml.conventions[]` + `decision` 事件 | 落点存在、当前为空（同上） |
| 证据权威 | `observations.json` | ✅ 冒烟 run 的 `python_version` |
| agent 提议 | `.kb/notes/*.md`（`status: proposed`） | ✅ `dataset-cifar100` |
| 结论 | `.kb/notes/*.md`（`accepted`） | ✅ 7 条（1 claim + 3 lesson + 3 proposal，全部 `authority: evidence`） |

迁移基线：`*.pth 32→32`、`*.png 40→40`、`*.txt 12→12`、`*.ipynb 4→4`、`.kb/notes 8→8`、`registry.jsonl 21→65` 行；`Test-Path .git` 仍为 `False`。

---

## 4. 验收中发现并修复的缺陷（11 项）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | `script_declare` / `view_render` 抛 `eg is not a function`，产物半落盘 | 工具体内把服务对象当函数调用 | 统一为 `const eg = () => ctx.get(...)` |
| 2 | `project_init` 后工程立刻 dirty（`registry.jsonl`） | 台账追加后未入库 | `ledgerAppend` 追加后立即把 `registry.jsonl` 入库 |
| 3 | 声明边会劫持「当前阶段」 | `stage` 事件混用声明与转移 | 声明改用 `record: 'pipeline'`，只有 `stage_goto` 产生 `stage` 转移 |
| 4 | 阶段历史计数把声明算成转移 | 同上 | 同上 |
| 5 | `run_query` 恒显示「参数 {}」 | run 事件只记 `paramsHash` | draft 事件补 `params` |
| 6 | 约定条文被硬约束抽取器误判（连 `id:` 前缀一起抓） | 抽取器作用在序列化串上 | 只从 `selected`/`custom` 抽取 + 极性词校验 |
| 7 | 中文条文生成无语义 id（如 `10`） | `slugify` 剥掉汉字只剩数字 | 回退 `convention-<n>` |
| 8 | 越权窗口内 `stage_declare` 未被拦 | 守卫只查本域文件 | 守卫改为**全局受管区** |
| 9 | 失败 run 的真实退出码 3 被记成 1 | 宿主 PowerShell 5.1 把非零退出归一为 1 | 命令尾追加 `; exit $LASTEXITCODE` |
| 10 | 迁移写出的 manifest 多 `note` 字段，违反 schema 且形成修复死锁 | 迁移自造字段 | 删字段（`complete:false` 已表达同一语义）+ verify 给出 restore 修法 |
| 11 | `note_adjudicate` 只认用户裁决；`note_query status=` 标题自相矛盾；进程输出是否落盘取决于模型有没有先读日志 | 三处判定过窄 | 有证据的笔记一律可依证据生效；状态过滤用中性标题；settle 前把未读输出读干净再落盘 |

另有 2 项为**测试文档**问题（验收脚本内容写错、会话工作区选错导致沙箱拒绝写入），已在复验中纠正。

---

## 5. 与 plan 的偏差与说明（3 处）

1. **`script_declare` 双模式**：tool-flows §13 写「不允许声明已存在于磁盘的脚本」，plan 阶段 2/6 要求 `create/adopt` 双模式。按 plan 实现 `adopt`（只写元数据侧车，绝不改动既有脚本），并在 `fields.md` 中记录。
2. **`entity_query` 增加 `record=ask`**：plan 的工具表里 `entity_query` 是「查询 entity / decision 事件」。实测 `ask_user_question` 的返回里**不含**调用标识，模型无法取得 `askCallId`；因此把「本会话的提问与答复（含标识）」并入 `entity_query`（不新增第 22 个工具）。
3. **版本库词汇扫描按词边界**：plan §6.1-2 的字面正则 `git|commit|HEAD|diff|hash|sha|\.git` 若按子串匹配，会把用户数据里的同形片段（如工程 id `usergit-probe`、`shanghai`）也算命中，并迫使引擎篡改用户数据。实现改为**词边界**替换与扫描：独立出现的版本库词汇一律抹掉，嵌在标识符里的同形片段保留。

---

## 6. 已知边界（不属本期）

- **用户权威落点在 attndepth 为空**：需要真实用户裁决才能填入；机制本身已在 scratch2 工程端到端验证（含「与答复矛盾被拒」）。
- **headless 无交互面**：`ask_user_question` 依赖 UI provider，headless 验收用脚本化 provider 替代；真实使用需在 Web/CLI 会话里进行。
- **`job_output` 在任务结束后可能为空**：进程输出已被引擎收进 `raw/stdout.log`（证据），工具返回文本已指向该文件。
- **plan §9 后置项**（前端外观、host 层硬限制、两 preset 硬隐藏）未做，符合计划。

---

## 7. 激活方式

1. 在目标工作区**新建**会话，选 `research-engine` preset（免重启，行名 `?v=7`）；
2. 首句让它 `project_load` → `project_verify`，或对新目录 `project_init`；
3. 试点工程 `D:\AI\attndepth` 已迁移完成，可直接接入。
