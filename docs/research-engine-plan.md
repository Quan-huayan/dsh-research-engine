# research-engine 实施计划（v3）

> **本文件取代旧版 v2 及 v2.1–v2.6 勘误记录。** 规格以三份对齐稿为准：
> `research-engine-principles.md`（根本原则 / 八要素 / 三条原则的物理翻译）、
> `research-engine-tools.md`（权责矩阵 + 22 工具表）、
> `research-engine-tool-flows.md`（22 工具逐个流程 + 内建 git 附录）。
> 本计划只回答：**按什么顺序实现、每步产出什么、怎么验收、旧实现怎么迁移**。

---

## 1. 根本原则（一句话 + 三条推论）

**任何研究结论，都必须能由不可变证据 + 一条可重放的过程重新得到。**

- **P1 证据优先**：结论只能指向证据；数字只能由工具从已登记文件里提取。
- **P2 封闭变更**：项目里所有变更只能经工具发生；引擎用**内建 git**（模型不可见）提供版本、还原、审计。
- **P3 权威分离**：用户权威（必须带 `ask_user_question` 引用）、证据权威（工具提取）、agent 提议（`status: proposed`）不可互相冒充。

**八要素与物理落点**（详见 principles §1）：

| 要素 | 落点 |
|---|---|
| 对话 | 项目外会话日志 + 项目内 `decision` 事件（问答原文） |
| 环境 | `project.yaml` / `pipeline.yaml` / `templates.yaml` / `scripts/*.meta.json` |
| 状态 | `registry.jsonl`（事件）+ `.research/state.json`、`_report/*`（派生） |
| 证据 | `experiments/<runId>/{config,manifest}.json` + `raw/`（LFS） |
| 用户权威 | `project.yaml.conventions[]` + `decision` 事件 |
| 证据权威 | `experiments/<runId>/observations.json` |
| agent 提议 | `.kb/notes/*.md`（`status: proposed`，**不得放环境位置**） |
| 结论 | `.kb/notes/*.md`（`kind: claim` + `evidence[]` + `scope` + `status`） |

**内建 git 的定位**：基础设施，不是要素。位置 `<project>/.research/engine.git`，工作树 = 项目根；每次调用显式传 `GIT_DIR`/`GIT_WORK_TREE`（绝不依赖目录发现）；`raw/` 走 git-lfs。**模型完全不可见**：无 git 工具、返回文本无 git 词汇、commit 只作台账内部字段。

---

## 2. 硬约束与已证实的教训

### 2.1 不可突破的约束

1. 不创建 bundle、不装 npm 包、**不重启服务器**、不改 web profile、不改内置 standard；
2. 插件源码内嵌 preset 目录，用相对路径行加载（免安装、免重启）；
3. 工具名只允许 `^[a-zA-Z0-9_-]+$`（模型 provider 函数名约束）；
4. 模型侧**不得出现任何 git 细节**（工具返回、SKILL、persona、错误文本都不得含 git 词汇）；
5. 旧产物（`.pth/.png/.txt/.ipynb`）零删除；用户 git 仓库零改动。

### 2.2 现场已证实的教训（旧实现踩过的坑，新实现必须带解）

| 教训 | 新实现的对策 |
|---|---|
| 工具名含 `.`/空格 → provider 400，整轮失败 | 全部下划线命名（已定的 22 个工具名） |
| 工具返回值含未声明字段 → `ToolOutputError` | 返回严格匹配 `output.schema`，只返回声明字段 |
| 本地插件裸导入 `@deepseek-ai/*` 解析失败 | 只用 `node:*` + `createRequire` 锚定 `$DSH_HOME/profiles/node_modules` |
| 后台 job 缺 `sandboxPolicy`/`dshEnv` → exit 127 且无输出 | 请求与 `dsh-tool-pwsh` 同构（含 `sandboxPolicy`、`dshEnv`） |
| `proc.readOutput()` 返回对象被当字符串丢弃 | 渲染 `delta` + lossy/spill + 沙箱提示 |
| 模板占位符缺参被展开为空 → 命令残缺 | `run_draft` 拒绝缺参；`run_launch` 以 config 为权威再校验 |
| 同进程模块缓存导致改代码不生效 | 行名带 `?v=N`，每次改插件递增 N |
| agent 自生成"领域契约"被当权威 | 工程笔记降为**派生视图**（工具渲染），提议只进 `.kb/notes` 且 `status: proposed` |

### 2.3 范畴错误清单（出现即违规）

对话↔证据、状态↔证据、提议↔约定、提议↔环境、结论↔环境、证据↔结论、用户权威↔证据权威 —— 七种混淆的处理方式见 principles §4。

---

## 3. 目标产物

### 3.1 preset 目录（引擎本体）

```
<dshHome>/.agent-presets/research-engine/
  preset.yml
  agent.cordis.yml                 standard 副本 + persona + skill 发现 + research-engine group
  skills/research-engine/SKILL.md  用户面路由与契约（不出现内部工具名/git 词汇）
  contract/                        project.schema.json（拆分版）、pipeline.schema.json、
                                   templates.schema.json、conventions.schema.json、
                                   manifest.schema.json、observations.schema.json、note.schema.json
  plugins/
    exp-ledger/main.js             环境 / 台账 / 校验（8 工具）
    stage-ctrl/main.js             状态机（3 工具）
    task-dispatch/main.js          实例 / 执行 / 证据（7 工具）
    kb-core/main.js                知识 / 裁决 / 渲染（4 工具）
    engine-git/                    内建 git 封装（**内部模块，不注册工具**）
```

### 3.2 项目内引擎文件

```
<project>/
  project.yaml  pipeline.yaml  templates.yaml  scripts/  registry.jsonl
  experiments/<runId>/{config.json, manifest.json, observations.json, raw/}
  .kb/{notes/*.md, index.yaml}
  _report/{runs.csv, summary.json}
  .research/{state.json, managed.json, engine.git/}
  skills/<project>/SKILL.md       派生视图（view_render 生成）
  legacy 区                       用户既有文件：登记、不改、不删
```

---

## 4. 工具契约总表（22）

权责矩阵与逐工具"落点/转移/必填元数据/拒绝条件"见 `research-engine-tools.md`；逐个流程见 `research-engine-tool-flows.md`。速览：

| 域 | 工具 |
|---|---|
| exp-ledger（8） | `project_init`、`project_load`、`project_verify`、`project_reconcile`、`entity_declare`、`entity_query`、`convention_declare`、`ledger_append`（内部） |
| stage-ctrl（3） | `stage_declare`、`stage_read`、`stage_goto` |
| task-dispatch（7） | `template_declare`、`script_declare`、`run_draft`、`run_launch`、`run_observe`、`run_query`、`run_close` |
| kb-core（4） | `note_write`、`note_adjudicate`、`note_query`、`view_render` |

**已删除**：`research_project/go/memo`（纯包装）、`run_templates`、`kb_index`、`kb_use_report`。
**已改名**：`entity_write→entity_declare`、`stage_define→stage_declare`、`kb_use_learn→note_write`、`kb_use_context→note_query`。

---

## 5. 实施阶段

### 阶段 0 —— 契约与骨架
**产出**：`contract/*.schema.json`（project/pipeline/templates/conventions/manifest/observations/note 七份）；受管白名单定义；八要素字段字典（每个字段的类型、必填、来源、校验）。
**验收**：七份 schema 互相引用无环；用真实 attndepth 数据做一次"目标形态"校验（允许失败，输出差距清单）。
**失败模式**：schema 过宽 → 字段语义漂移；过窄 → 迁移卡住。

### 阶段 1 —— 基础设施层（先做，其他都依赖它）
**产出**：`engine-git` 内部模块（init / commit / status / diff / restore / lfs 配置 / 降级探测）；`ledger_append`；`project_init`（含发现现状、建 `engine.git`、LFS、`managed.json`、首次提交、初始体检）；`project_load`（诊断式返回）；`project_verify`（工作树 vs HEAD + 台账 commit 反查 + schema/图/manifest/decision 回查）；`project_reconcile`（九种情景 + restore/adopt）。
**验收**：① 越权改 `project.yaml` → 任意写类工具被拒 + verify 报 dirty；② `restore` 还原成功；③ `adopt` 无 decision 被拒；④ 项目根不出现 `.git`；⑤ 返回文本零 git 词汇；⑥ git 缺失时降级可跑。
**失败模式**：git 调用未隔离 → 碰到用户仓库（硬红线，必须用显式 `GIT_DIR`）；LFS 未装 → `raw/` 降级为哈希-only。

### 阶段 2 —— 环境声明
**产出**：`stage_declare/read/goto`（pipeline.yaml + `graphVersion` + `allows[]` + 派生 state.json）；`template_declare`（`allow`/`paramsSchema`/`observables[]`/`scriptRef@version`）；`script_declare`（create/adopt 双模式）；`entity_declare/query`；`convention_declare`（`ask_user_question` 强校验）。
**验收**：图 fatal 拒绝；模板缺 `observables` 拒绝；脚本工程外拒绝；约定无 decision 引用拒绝；约定写入后 `project_load` 可见且带裁决引文。
**失败模式**：阶段 id 改名破坏历史引用 → 必须"新 id + 旧 id deprecated"。

### 阶段 3 —— 执行与证据
**产出**：`run_draft`（冻结 config：模板版本/params/paramsHash/命令/脚本哈希/环境预期/`graphVersion`）；`run_launch`（安全闸 + 同构 shell 请求 + 后台 job + settle 登记 `raw/` 并 LFS 入库）；`run_observe`（只提模板声明字段 + 来源哈希校验 + `compareTo`）；`run_query`；`run_close`。
**验收**：冒烟模板端到端 done；`observations.json` 每条带 `文件:行`；未声明字段被拒；缺占位参数被拒；沙箱运行器失败时 detail 明确；`raw/` 在 LFS 中可还原。
**失败模式**：manifest 漏登记 → 该 run 证据不完整，禁止据此下结论。

### 阶段 4 —— 知识与裁决
**产出**：`note_write`（kind 分派 + claim 强制证据 + 冲突转 proposal）；`note_adjudicate`（accept/retract/supersede + decision 回查）；`note_query`（默认 accepted，proposed 单列）。
**验收**：无证据的 claim 被拒；同 scope 冲突时只能写 proposal；用户裁决必须可回查；`superseded` 不删除。
**失败模式**：agent 提议被当约定引用 → `note_query` 必须显示 `status/authority`。

### 阶段 5 —— 派生视图
**产出**：`view_render(kind=notes-skill|report|index)`；三种派生视图头部标"派生 + 生成时间 + 来源 id"。
**验收**：手改派生视图 → verify 报 dirty；重新渲染可恢复；工程笔记 SKILL 不含内部工具名与 git 词汇。
**失败模式**：把派生视图当知识源 → 必须由 render 工具唯一写入。

### 阶段 6 —— 迁移与收编（attndepth 试点）
**产出**：
1. 旧 `project.yaml` 拆分为 `project.yaml` + `pipeline.yaml` + `templates.yaml`（内容不丢，逐项迁移）；
2. 旧 `registry.jsonl` 事件补 `stage`/`graphVersion`/commit 字段（保留历史，不重写）；
3. 既有脚本 `cifar2.py`/`cifar3.py`/`x1/cifar5.py` 用 `script_declare(adopt)` 收编；`smoke_hello.py` 等工具生成脚本走 `create`；
4. `.kb/notes` 按新 `kind/status/authority` 重分类（补 frontmatter，不删原文）；
5. 既有 run 补 `manifest.json`（`raw/` 已存在的补登记 + 哈希）；无产出的 run 标"证据不完整"；
6. 生成 `skills/attndepth/SKILL.md` 派生视图；旧 `attndepth-domain/SKILL.md` 移出环境位置（保留为历史，不再被加载）。
**验收**：迁移后 `project_verify` clean；`project_load` 全绿；legacy 计数不变；用户 git 仓库无改动（若存在）。
**失败模式**：迁移把语义改了却没走 declare → 必须"先声明、再迁移"。

### 阶段 7 —— 验收
见 §6。全部通过后，preset 行名版本号统一升到 `?v=7`。

---

## 6. 验收判据（可检验）

### 6.1 自动检查（脚本）
1. **契约**：22 个工具名匹配 `^[a-zA-Z0-9_-]+$` 且全局唯一；每个工具的 `parameters`/`output.schema` 落在 dsh-tools 支持子集内；实际返回值过 `output.schema` 且只含声明字段。
2. **隐形 git**：所有工具的返回文本（正常 + 拒绝路径）扫描 `git|commit|HEAD|diff|hash|sha|\.git` 零命中；模型侧工具清单无 git 工具。
3. **守卫**：写类工具在受管文件被外部改动后一律拒绝；`restore` 后恢复；`adopt` 无 decision 被拒。
4. **证据**：`run_observe` 对未声明字段/未登记文件/哈希不符三种情况均拒绝。
5. **权威**：`convention_declare`/`note_adjudicate` 在无 `askCallId` 或回查失败时拒绝。
6. **派生**：手改 `_report`/`index`/`SKILL.md`/`state.json` → verify 报 dirty。

### 6.2 行为验收（headless 会话）
沿用 `live-accept-task.md` 的模式，用 headless 组合跑：
- **A 接工程**：`project_load` → `project_verify(clean)` → 阶段/模板/约定声明；
- **B 冒烟**：`run_draft` → `run_launch` → `run_observe`（声明字段）；
- **C 正式实验**：多 run + 后台并发 + `run_observe` 汇总；
- **D 失败/重放/回滚**：失败 run 保留 config → 修正重跑（新 runId，旧记录仍在）→ `run_close(invalidated)`；
- **E 非线性跳段**：非法边拒绝、合法回跳成功；
- **F 跨会话知识**：会话1 `note_write` → 会话2 `note_query` 命中（带 status/authority）；
- **G 报告**：`view_render(report)` 落盘 + 冲突清单；
- **H 安全闸**：危险模板被拒 + 记 lesson；
- **I 越权**：用普通工具改受管文件 → 引擎拒绝写 + verify 点名 + restore 成功；
- **J 隔离**：若项目是用户 git 仓库（如 `context-mod-shuhua`），跑完 A–I 后 `git status` 与该仓库 HEAD 无变化。

### 6.3 数据验收
八要素各自落点存在且状态正确（对话→decision 事件；环境→三份声明文件；状态→台账+派生；证据→run 目录+LFS；用户权威→conventions+decision；证据权威→observations；提议→notes(proposed)；结论→notes(accepted)）。

---

## 7. 迁移与版本策略

- 旧插件目录**不原地改**：新建 `plugins/{exp-ledger,stage-ctrl,task-dispatch,kb-core,engine-git}`，旧 `research-facade` 删除；
- 旧工具名不再保留别名（避免"两套入口"），preset SKILL 与 persona 同步改写为用户面；
- 行名版本：本次统一 `?v=7`（每次改插件内容递增）；
- 旧 `attndepth-domain/SKILL.md` 保留为历史文件但移出 `.dsh/skills/`（不再被加载），内容由 `view_render(notes-skill)` 派生视图取代。

---

## 8. 风险与降级

| 风险 | 降级 |
|---|---|
| git 不可用 | 台账-only（无还原），`project_init` 需用户确认，verify 标 `git: unavailable` |
| git-lfs 不可用 | `raw/` 不入库，仅 manifest 哈希；证据被改 → 该 run `invalidated` |
| 会话日志缺失 | decision 降级 `attested`（原文在案、无法回源） |
| 沙箱运行器失败 | `run_launch` detail 明确标注"沙箱运行器失败，命令未运行" |
| provider 约束变化 | 自动检查 §6.1-1 兜底 |
| 同进程模块缓存 | `?v=N` + 新建会话 |

---

## 9. 后置项（本期不做）

1. **前端（外观本体）**：client 插件 + host 只读桥 + 前端构建 + 重启/刷新——需先解除"不改 web profile / 不重启"两条约束，按 `research-engine-tool-flows.md` 的派生视图数据面设计；
2. **host 层硬限制模型工具**（禁止 write/pwsh 触碰受管区）——宿主配置，非插件可做；
3. **两 preset 硬隐藏**（用户 preset 只见部分工具）——不做，极简优先。

---

## 10. 落地位置与激活

- **引擎 preset**：`<dshHome>/.agent-presets/research-engine/`（自包含）；
- **试点**：`D:\AI\attndepth`（迁移目标），另在 `D:\CCNI\context-mod-shuhua` 做"用户 git 仓库不被影响"的隔离验收（§6.2-J）；
- **激活**：在目标工作区**新建**会话、选 `research-engine` preset（免重启；行名 `?v=7`）；
- **文档**：本计划 + 三份对齐稿构成完整规格。
