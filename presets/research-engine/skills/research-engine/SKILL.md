---
name: research-engine
description: 研究工程的工作方式：先看现状再动手，所有变更走工具，结论必须指向证据，用户权威必须来自真实答复。
---

# 研究引擎：怎么在工程里工作

根本原则：**任何研究结论，都必须能由不可变证据 + 一条可重放的过程重新得到。**

三条推论决定你的每一个动作：

1. **证据优先** —— 结论只能指向证据；数字只能由工具从已登记文件里提取，不许手写。
2. **封闭变更** —— 工程里的所有变更只能经工具发生。用 write / edit / pwsh 直接改受管文件会被体检点名，并在你下次调用写类工具时被拒绝。
3. **权威分离** —— 用户权威、证据权威、agent 提议三者不得互相冒充。

## 一、工程的物理形态

| 位置 | 是什么 | 谁能写 |
|---|---|---|
| `project.yaml` | 环境：身份、受管区、遗留登记、生效约定 | `project_init` / `convention_declare` / `project_reconcile` |
| `pipeline.yaml` | 环境：阶段机（阶段 + 边 + 入口 + 图版本） | `stage_declare` |
| `templates.yaml` | 环境：可执行声明（命令白名单 + 参数契约 + 可提取字段） | `template_declare` |
| `scripts/` | 环境：辅助脚本与其元数据 | `script_declare` |
| `registry.jsonl` | 状态与事件台账（追加式） | 各工具内部 |
| `experiments/<runId>/` | 证据：`config.json`（实例冻结）、`manifest.json`（产出清单）、`observations.json`（提取值）、`raw/`（原始产出） | 工具 + 进程 |
| `.kb/notes/*.md` | 提议（`proposed`）与结论（`accepted`） | `note_write` / `note_adjudicate` |
| `_report/*`、`.kb/index.yaml`、`skills/<工程>/SKILL.md` | 派生视图（可重建，别手改） | `view_render` |
| `.research/state.json` | 派生状态（当前阶段） | `stage_goto` |
| 遗留区（`.pth/.png/.txt/.ipynb`、`data/`、`history/`、`x*/`） | 用户既有文件：只登记，不改不删 | 无人 |

## 二、按意图找工具

**看现状（永远先做这步）**
- `project_load` —— 工程全貌：身份、阶段机、模板、约定、最近体检
- `project_verify` —— 体检：受管区是否被外部改动、证据是否完整、结构是否合规
- `stage_read` —— 阶段机与当前节点、合法去向
- `stage_goto` —— `to=<阶段>` 沿已声明的边推进；`replay=true` 按台账重放物化派生状态（若重放会改变文件当前断言的值，即两个来源矛盾，必须由用户裁决）
- `run_query` —— 运行台账（状态、参数、产出数、观察值）
- `note_query` —— 知识：默认只列生效结论，提议单列
- `entity_query` —— 实体、已登记的用户裁决（含问答原文）；`record=ask` 列出本会话的提问标识与答复

**接新工程**
- `project_init` —— 接入目录：发现现状、建受管白名单、登记遗留文件、初始体检

**声明环境（顺序有依赖）**
- `stage_declare` —— `action=stage` 声明阶段 → `action=edge` 连边 → 传 `entry` 设入口
- `script_declare` —— `mode=create` 新建脚本；`mode=adopt` 收编磁盘上已有脚本
- `template_declare` —— 引用已声明脚本，给出 `allow`、`paramsSchema`、**`observables`**（可提取字段，必须显式给，可以是 `[]`）
- `convention_declare` —— 把用户裁决写成生效约定（见第四节）
- `entity_declare` —— 登记研究对象（必须带可解析的 `source`）

**做实验**
1. `run_draft` —— 冻结实例：模板版本、参数、完整命令、脚本指纹、阶段、图版本 → 得到 `runId`
2. `run_launch` —— 安全闸 + 后台派发（不阻塞本轮）；结束后自动登记 `raw/` 产出，并把进程输出收进 `raw/stdout.log`
3. `job_output` —— 运行中读日志；任务结束后完整输出在 `experiments/<runId>/raw/stdout.log`（已收进证据，`job_output` 此时可能为空）；`job_kill` —— 取消
4. `run_observe` —— 从**已登记**产出里提取数值，形成证据权威；可 `compareTo` 另一个 run 做对比
5. `run_close` —— 作废（`invalidated`）或归档（`archived`，需用户裁决）；**产出永不删除**

**沉淀知识**
- `note_write` —— `kind=claim` 必须带 `evidence[]` 与 `scope`；与已生效结论同范围冲突时只能写 `proposal`
- `note_adjudicate` —— `accept` / `retract` / `supersede`；有可解析证据的 claim 可依证据生效，其余需用户裁决
- `view_render` —— `kind=notes-skill` 生成工程笔记；`report` 生成运行报表；`index` 生成笔记索引

**修受管区**
- `project_reconcile` —— `mode=restore`（默认，取回已登记版本）/ `adopt`（接受外部改动，需用户裁决）/ `ignore`（登记为有意忽略）

## 三、闸门：不满足就是拒绝，不是提醒

- 写类工具前置：它要触及的受管文件必须与已登记版本一致。被外部改动 → 拒绝，先去 `project_reconcile`。
- `run_draft` / `run_launch` 另需：整个工程的受管区都没有未修复的改动；阶段已声明。
- `run_launch` 安全闸：命令前缀必须在模板 `allow` 内，脚本必须落在工程内。命中即拒绝，并记入教训库，run 保持 `draft`。
- `run_observe`：字段必须在模板 `observables` 里声明过；来源文件必须已在清单登记且指纹一致。
- `note_write(claim)`：`evidence[]` 每条都必须能解析；解析失败即拒绝。
- `convention_declare` / `note_adjudicate`（需用户权威时）：必须带真实答复，写入时回查会话。

**被拒绝时怎么做**：拒绝文本里永远写着「为什么 + 怎么修」。照着修，不要绕道用 write/pwsh 直接改文件——那样只会让下一次调用继续被拒，并且体检会点名。

## 四、用户权威的正确姿势

需要用户拍板时（约定、取舍、优先级、撤回结论、归档）：

1. 用 `ask_user_question` 提问，**每个问题给稳定 id**，选项写清楚；
2. 用 `entity_query record=ask` 取回**提问标识**（`askCallId`）与用户答复原文（问题自己的 id 不是提问标识）；
3. 把标识与答复原文一起传给 `convention_declare` 或 `note_adjudicate`；
4. 引擎会回查会话：标识必须对应一次真实的 `ask_user_question`，答复必须与用户实际答复一致；
5. `statement` 里必须体现答复中的硬约束（数字、引号内容、「必须/不得/至少/不超过」）。

**禁止**：把用户的沉默、你的推断、或「用户之前说过类似的话」当作裁决；代答、润色、改写答复原文都会被拒绝。

## 五、范畴错误清单（出现即违规）

| 混淆 | 表现 | 正确做法 |
|---|---|---|
| 对话 ↔ 证据 | 用「用户说过」当依据 | 先转成 `decision`（约定/裁决）事件 |
| 状态 ↔ 证据 | 把 run 的 `done` 当结论成立 | 结论要观察值 + 裁决 |
| 提议 ↔ 约定 | 自己写「铁律」 | 降级为 `proposal`，标 `proposed` |
| 提议 ↔ 环境 | 把笔记放进 `skills/` 或写进 `project.yaml` | 提议只放 `.kb/notes`；工程笔记由 `view_render` 渲染 |
| 结论 ↔ 环境 | 用结论改白名单或阶段 | 环境变更只能走声明工具 |
| 证据 ↔ 结论 | 把数字当判断 | 拆成「观察」和「结论」两条记录 |
| 用户权威 ↔ 证据权威 | 用户拍板改写事实 | 用户权威只覆盖「应该怎样」 |

## 六、典型会话节奏

```
project_load → project_verify            # 先看现状
stage_read → 按合法边 stage_goto          # 走到该在的阶段
（需要新能力）script_declare → template_declare
run_draft → run_launch → job_output      # 跑
run_observe → 数字来自产出文件本身
note_write(claim, evidence=[runId]) → note_adjudicate(accept)
view_render(report) → view_render(notes-skill)
```

报告与工程笔记都是**派生视图**：它们由工具从「生效约定 + 已生效结论」渲染，不是知识源，也不要手改。
