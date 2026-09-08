# research-engine 核心原则的体现（对齐稿 v1）

> 本文件是**对齐稿**：把"根本原则"翻译成项目里可触摸的物理形态。它不描述工具实现，只回答四件事——
> 每个要素**是什么**、**物理上体现在哪**、**受什么硬约定约束**、**靠什么机制维护**；最后给出三条原则的物理翻译。
> 未经确认前，不据此改代码。

---

## 0. 根本原则

**任何研究结论，都必须能由不可变证据 + 一条可重放的过程重新得到。**

三条推论（后面所有物理形态都由它们推出）：

- **P1 证据优先**：结论只能指向证据，不能指向记忆、印象或对话。
- **P2 封闭变更**：项目里所有状态变更只能经工具发生；因此项目永远可解释、可重建。
- **P3 权威分离**：用户权威、证据权威、agent 提议三种东西不能互相冒充。

---

## 1. 八个要素

### 1.1 对话
- **是什么**：用户与 agent 的自然语言流；只产生两样东西——**意图**与**裁决**。
- **物理体现**：
  - 原始对话：**项目外**，在 harness 会话日志（`~/.dsh/sessions/…/session.jsonl.zstd`）；
  - 项目内只留**转录**：`registry.jsonl` 里的 `decision` 事件（含问题、选项、用户答复原文、callId、sessionId、时间、哈希）。
- **硬约定**：项目里的任何事实、结论、约定**不得以"对话里说过"为依据**；只有转录成 `decision` 事件才生效。
- **维护**：由 `ask_user_question`（宿主工具）产生，由授权域的工具**在写入时回查会话并拷贝原文**；会话日志消失时记录降级为 `attested`（原文在案、无法回源），不失效。

### 1.2 环境
- **是什么**：事前声明"允许发生什么"的约束集合——工程身份、阶段机、模板（含命令白名单与参数 schema）、约定、受管区清单。
- **物理体现**：`project.yaml`（`project / stages / pipeline / templates / conventions / managed / legacy`）。
- **硬约定**：只放"允许什么"，不放结果；只能由 ①② 的工具写；agent 可以提议，但**约定类必须带 `decision` 引用**才生效。
- **维护**：工具写入并记录 `{path, sha256, before, actor, ts}` 到台账；版本字段随模板/约定变更递增。

### 1.3 状态
- **是什么**：在既定环境下"现在实际如何"的可变事实——当前阶段、每个 run 的 status、job 是否在跑、是否有 dirty/unknown。
- **物理体现**：
  - 权威来源：`registry.jsonl`（追加式事件）；
  - 派生视图：`.research/state.json`（当前阶段）、`_report/*`（汇总），**显式标 `derived`**。
- **硬约定**：只有工具能改；用户不能直接改，只能通过指令/裁决让工具改；状态必须能**从事件重放**，派生文件可随时删除重建。
- **维护**：追加事件 → 重放得出视图；派生文件永不作为事实来源。

### 1.4 证据
- **是什么**：一次具体执行的不可变产物（日志、结果、图、权重）及其身份。
- **物理体现**：`experiments/<runId>/`
  - `config.json`：实例冻结（模板版本、参数、脚本哈希、解释器、环境快照 python/torch/cuda/seed/GPU、完整命令行）；
  - `raw/`：进程产出的原始文件；
  - `manifest.json`：每个产出文件的身份（`role`、`sha256`、字节数、生产者 tool/process、时间）；
  - 遗留证据（用户既有的大文件）：`legacy` 登记（路径/大小/mtime/角色，标 `immutable-by-policy`，不做全量哈希）。
- **硬约定**：证据**不由模型撰写**；产生后不可变；要"改"只能产生新证据；未登记的文件不算证据（`unknown`）。
- **维护**：写入时登记 + 哈希；`project_verify` 重算比对。

### 1.5 用户权威
- **是什么**：用户对"应该怎样"的决定权——约定、取舍、优先级、撤回、归档。
- **物理体现**：
  - 生效声明：`project.yaml` 的 `conventions:`（带 `authority: user` + `decision` 引用）；
  - 凭据：`registry.jsonl` 的 `decision` 事件（问答原文）。
- **硬约定**：只能由用户产生（经 `ask_user_question`）；agent 只能**原样转录**，不得推断、润色、代答；没有 `decision` 引用的 user-authority 记录视为非法。
- **维护**：写入时**强校验**——`ctx.sessionQuery` 回查 callId 存在且结果为用户答复；事后可选回查，日志缺失则降级 `attested`。

### 1.6 证据权威
- **是什么**：由可复现证据支撑的"是什么"层面的陈述（观察值）。
- **物理体现**：`experiments/<runId>/observations.json` —— 每条 `{field, value, unit, file, line, sha256, extractedAt}`。
- **硬约定**：**不是写上去的标签，是检查出来的结果**——只能由工具从**已登记**文件里提取；文件未登记或哈希不符 → 拒绝提取；模型手写的数字永远不算证据权威。
- **维护**：提取即记录来源指针与当时哈希；后续校验重算哈希。

### 1.7 agent 提议
- **是什么**：模型基于证据做出的推断、假设、建议（结论草案、下一步设计、冲突解释）。
- **物理体现**：`.kb/notes/*.md`，frontmatter 必带 `kind`、`status: proposed`、`authority: agent`、`evidence: […]`（可为空但必须显式写）。
- **硬约定**：**位置即权威**——提议只能放"数据"位置（notes），**不得放环境位置**（skills/ 或 project.yaml）；默认不生效，不能当规则引用。
- **维护**：升级路径只有两条——被可复现证据支撑（→证据权威）或被用户裁决（→用户权威）；否则一直是 `proposed`。

### 1.8 结论
- **是什么**：经裁决、有明确范围的陈述：一组证据 + 一个主张 + 成立条件 + 谁让它成立。
- **物理体现**：`.kb/notes/*.md`，`kind: claim`，必带 `scope`、`evidence[]`、`status`（`proposed/accepted/superseded/retracted`）、`authority`、`decidedBy`（若由用户裁决）。
- **硬约定**：成立后约束后续工作；与它冲突的新结果必须**显式提出**，不得静默合并；被取代/撤回只改状态，**不删除**。
- **维护**：`superseded`（被新证据取代）/ `retracted`（当初错了）都留档；冲突进"待裁决"队列。

---

## 2. 三条原则的物理翻译

| 原则 | 物理翻译（可检查的形态） |
|---|---|
| **P1 证据优先** | ① 每条结论/观察都有 `evidence[]` 指针（`runId` 或 `文件+行+sha256`）；② 观察值只能出现在 `observations.json`（工具提取），不得手写进正文；③ 写知识时工具逐条解析指针，解析失败即拒绝；④ 证据类型枚举里**没有"对话"**。 |
| **P2 封闭变更** | ① 明确受管区（`project.yaml / pipeline.yaml / templates.yaml / registry.jsonl / scripts/** / .kb/** / experiments/** / _report/** / .research/**`）与自由区（遗留 `.pth/.png/.txt/.ipynb` 等）；② 每次工具写入 → **引擎内建 git** 提交受管文件（模型不可见），台账事件内部记 commit；③ `project_verify` 比对工作树与 HEAD，不符 → `dirty`；④ **dirty 分级**：`query/render` 仍可用，`declare/instantiate/execute` 被拒直到 reconcile；⑤ 大遗留文件只登记 size/mtime，不做全量哈希。 |
| **P3 权威分离** | ① 每条记录带 `authority: user / evidence / agent`；② 用户权威必须带 `decision` 引用（`askCallId` + 答复原文），写入时强校验；③ 证据权威只能由工具提取产生；④ agent 提议必须 `status: proposed` 且只能放数据位置；⑤ 裁决事件必须留问答原文，前端把原文展示在结论/约定旁边。 |

---

## 3. 物理布局（一页速查）

```
<project root>/
  project.yaml            环境：身份 / 受管区 / legacy 声明 / 约定
  pipeline.yaml           环境：阶段机
  templates.yaml          环境：模板（含 observables）
  registry.jsonl          状态与事件：run / entity / decision / verify / render（append-only）
  scripts/                环境：辅助脚本 + *.meta.json
  experiments/<runId>/
    config.json           实例冻结（模板版本、参数、脚本哈希、环境快照、完整命令、graphVersion）
    manifest.json         证据清单（角色 + sha256 + 生产者 + 时间）
    observations.json     证据权威（field/value/unit/file/line/sha256）
    raw/                  原始产出（日志、结果、图；经 git-lfs 入库）
  .kb/notes/<name>.md     知识：claim / lesson / question / proposal（kind + status + authority + evidence + scope）
  _report/*               派生视图（标 derived，可重建）
  .research/state.json    派生状态（当前阶段，可重放）
  .research/engine.git/   引擎内建 git（模型不可见；受管文件版本、还原、审计）
  .research/managed.json  受管白名单
  skills/<project>/SKILL.md  派生视图：由工具从「约定 + 已接受结论」渲染，**不得手写**
  legacy 区               用户既有文件：登记、不改、不删
```

**内建 git 的定位**：它是**基础设施，不是要素**——为 P2 提供"版本、还原、审计"能力，但**对模型完全不可见**：没有 git 工具、返回文本不含 git 词汇、commit 只作台账内部字段；模型若用普通工具直接动它，会被 `project_verify` 检出为 `dirty`。详细隔离规则见 `research-engine-tool-flows.md` 附录。

**"工程笔记 SKILL" 的定位**：它是**派生视图**（和 `_report` 同类），由工具从 `conventions` + `accepted` 结论渲染生成；不是知识源，不得手写，知识变化后重新渲染。

---

## 4. 范畴错误清单（出现即视为违规）

| 混淆 | 表现 | 处理 |
|---|---|---|
| 对话 ↔ 证据 | 用"用户说过"当依据 | 拒绝；必须转成 `decision` 事件 |
| 状态 ↔ 证据 | 把 run 的 done 当结论成立 | 拒绝；结论需观察 + 裁决 |
| 提议 ↔ 约定 | agent 写"铁律" | 降级为 `proposed`，前端标"待确认" |
| 提议 ↔ 环境 | 把 agent 笔记放 skills/ 或写进 project.yaml | 移出环境位置；或改为派生视图 |
| 结论 ↔ 环境 | 用结论改白名单/阶段 | 拒绝；环境变更只能由用户/工具声明 |
| 证据 ↔ 结论 | 把数字当判断（"29.17% 所以无效"） | 拆成观察 + 结论两条记录 |
| 用户权威 ↔ 证据权威 | 用户拍板改写事实 | 拒绝；用户权威只覆盖"应该怎样" |

---

## 5. 降级与失效语义（不物理删）

| 对象 | 允许的状态变化 | 物理删除 |
|---|---|---|
| 证据（run 产出） | `invalidated`（该 run 作废）、`archived`（归档）；被外部改动时**默认从内建 git/LFS 还原**并记 incident（无 LFS 则 `invalidated`） | **永不** |
| 遗留证据（`.pth/.png/.txt/.ipynb`） | 只登记 `size/mtime`；被改动 → `legacy-changed` 告警 | **永不** |
| 结论 | `superseded`、`retracted` | **永不** |
| 约定 | `deprecated`（历史 run 仍引用） | **永不** |
| 模板/脚本 | `deprecated` + 版本递增 | **永不** |
| 派生视图（`_report`、`state.json`、渲染出的 SKILL、`index`） | 可重建 | **允许** |
| 会话日志缺失导致的凭据 | `attested`（原文在案，无法回源） | 不适用 |

---

## 6. 待你确认的三处

1. **`decision` 事件放 `registry.jsonl`**（不另开 decisions 文件）——同意吗？
2. **`observations.json` 放 run 目录**（随证据走），而不是放知识库——同意吗？
3. **工程笔记 SKILL 定位为"派生视图"**（工具渲染、可重建、非知识源）——同意吗？
