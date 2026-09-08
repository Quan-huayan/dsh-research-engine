---
name: research-engine
description: 研究引擎外观路由与工程契约教学——走 research_* 统一入口，不直接调 ①–④；解释 project.yaml 骨架、registry 台账、阶段图、任务模板、kb 知识库与报告，以及安全闸规则。
whenToUse: 本 preset 的所有工作（接新项目、阶段导航、实验派发、知识写入/检索、报告整合）都先加载本技能以确认路由与契约。
---

# research-engine —— 外观路由 + 工程契约

你在「研究引擎」preset 下。**统一入口只走 `research_*` 三个工具，不直接调用
`project_* / stage_* / run_* / kb_*` 底层插件工具**（它们存在，但外观层才是入口——
经 preset 自带 persona 引导）。工程一切数据都在**会话工作区（=工程根目录）**下的文件里，
跨会话持久、确定性可读。

> 命名说明：工具名只允许 `[A-Za-z0-9_-]`（模型 provider 的函数名约束），因此命名空间用下划线：
> `project_load`、`stage_goto`、`run_launch`、`kb_use_learn`、`research_go` …

## 0. 三层结构速记

```
research_*（外观，只路由）          ← 你只碰这一层
  ├─ exp-ledger    ① project_* / entity_*    拥有 project.yaml + registry.jsonl
  ├─ stage-ctrl    ② stage_*                 拥有 stages + pipeline.edges（非线性阶段图）
  ├─ task-dispatch ③ run_*                   拥有 run.templates + experiments/ + run 台账（安全闸）
  └─ kb-core       ④ kb_*                    拥有 .kb/notes + index.yaml + _report/（唯一知识写入口）
```

## 1. research_* 路由表（op 与参数照传底层工具）

| 工具 | op | 作用 |
|---|---|---|
| `research_project` | `load` | 载入校验 project.yaml（骨架过 schema + 唯一性/引用结构校验，内容开放仅提示） |
| | `init` | 生成合规骨架 project.yaml + registry.jsonl；旧杂乱目录 legacy **keep+record 零删除**（`.pth/.png/.txt/.ipynb`） |
| | `query` | entity_query：registry.jsonl 实体台账查询（id/kind/extends） |
| | `write` | entity_write：按 schema 规范化写实体记录（同 id 更新） |
| `research_go` | `read` | stage_read：阶段图（阶段/边/入口/当前阶段）+ fatal/warn 校验 |
| | `define` | stage_define：加阶段(action=stage)/加边(action=edge)（可带 entry）；fatal 违规**拒绝写入返回文本** |
| | `goto` | stage_goto：只放行 `pipeline.edges` 里的边；**非法边返回拒绝文本而非报错**；合法回跳允许 |
| | `templates` | run_templates：模板列表 |
| | `template` | run_template：按参数 schema 生成合规模板 |
| | `draft` | run_draft：模板展开 → experiments/<runId>/config.json + registry 登记(draft) |
| | `launch` | run_launch：**安全闸**（脚本在工程内、命令前缀∈allow、不写工程外）→ `ctx.jobs` 后台任务，返回 jobId，**绝不 fork** |
| `research_memo` | `learn` | **唯一知识写入口**：.kb/notes/<name>.md，frontmatter 自校验（name kebab-case + description 必填非空，仿 skill 解析） |
| | `context` | 跨会话检索策展笔记（读 index.yaml + 笔记文件）——阶段进入时注入旧结论 |
| | `report` | 聚合 run → `_report/{runs.csv, summary.json}`（报告归于 kb） |
| | `index` | 重建 .kb/index.yaml（无效笔记整档丢弃并列出） |

## 2. 工程契约（project.yaml 骨架）

结构由 `contract/project.schema.json` 管、**内容开放**。字段：

- `project: {id, name, domain?, description?}`
- `kb: {types: []}` —— 笔记类型白名单（内容开放，唯一性由插件校验）
- `entities: [{id, kind?, name?, extends?, props?}]` —— 实体台账条目（extends 引用 kb.types 或外部）
- `stages: [{id, name, description?}]`、`pipeline: {entry, edges: [{from,to}]}`
- `templates: {<id>: {description, parameters, command: {allow: [前缀白名单], script?, args?}}}`
- `legacy: {keep: [{pattern, count?}], note}` —— 旧产物只登记不删除

**换工程** = 写一份新 project.yaml（可 `research_project op=init` 生成骨架）+ 领域 SKILL.md，零插件代码。

## 3. 阶段图语义（确定性规则）

- **fatal（拒绝写）**：阶段 id 重复 / 边端点不是已知阶段 / 边(from→to)重复 / 自环 / entry 不是已知阶段 / entry 有入边（入口歧义）。
- **warn（read 报告）**：有边但未设 entry；从入口沿有向边不可达的阶段；孤立占位阶段（构建期允许，接边后解除）。
- **终点无出边合法**（如 report 阶段）；`stage_goto` 只做“边存在 + from 正确（缺省=当前阶段）”检查，非法边拒绝返回文本；回跳沿已定义边允许。

## 4. 任务与安全闸（run_draft → run_launch）

1. `run_template`（或改 project.yaml）建模板：`command.allow` 是**命令前缀白名单**（如 `["python"]`），
   `script` 为工程内相对路径，`args` 支持 `{{key}}` 占位。
2. `run_draft`：参数校验 → `experiments/<runId>/config.json` → registry 状态 `draft`。
3. `run_launch`：双点拦截——本插件安全闸（前缀命中 allow、脚本 resolve 后在工程内、命令仅来自模板 args 占位）
   → 命中**拒绝并记 kb 教训**；随后 `ctx.jobs.start(kind=research.run)` 后台执行（宿主 shell/sandbox 兜底）。
   状态机：`draft → queued → running → done/failed`；模板被删 → `invalidated`（不物理删）。
   读日志 `job_output`，取消 `job_kill`；结果落 `experiments/<runId>/result.json`（由进程写）。

## 5. 知识与报告（kb）

- 写知识**只能** `research_memo op=learn`（别用 read/write 直接改 .kb/notes）。
- 跨会话：新会话用 `op=context query=…` 读回旧结论；阶段切换时主动注入相关结论。
- 报告：`op=report`（可按 runIds/template/stage/status 过滤）→ `_report/runs.csv` + `summary.json`。

## 6. 会话工作流速查（验收场景 A–H）

- **接新项目(A)**：`research_project op=init`（新目录）→ 校验 `op=load` → 建图 `research_go op=read` → 依场景走。
- **冒烟(B)**：小模板 draft + launch（short args），`job_output` 看日志。
- **正式实验+收集(C)**：多模板/多 seed → draft×N → launch×N（后台不阻塞）→ 全 done 后 `op=report` 落 `_report/`。
- **失败/重放/回滚(D)**：job_kill / failed run 保留 config；修正后重 draft 新 runId；registry 永不物理删记录。
- **非线性跳段(E)**：`research_go op=goto`；非法边被拒（返回拒绝文本）；合法回跳需先 define 边。
- **跨会话知识(F)**：会话1 `op=learn` → 会话2 `op=context` 读回（index+笔记文件确定性可读）。
- **报告整合(G)**：`op=report` 聚合 → runs.csv/summary.json。
- **安全闸(H)**：危险模板（前缀不在 allow / 脚本在工程外）被 `run_launch` 拒并记教训 `lesson-<runId>`。

## 7. 铁律

- 旧产物（`.pth/.png/.txt/.ipynb`）**零删除**，只经 `project_init`/entity 登记 keep。
- 长任务一律后台 job，**不 fork 训练进程、不阻塞本轮**。
- 同名工具/服务冲突在载入时报错（本项目内各前缀互斥）；别在工程外建新文件，除非是引擎自有目录
  （`.research/ .kb/ experiments/ _report/ registry.jsonl project.yaml`）。
- 拿不准底层 API 签名时用 `cordis_inspect` 复核，本 SKILL 不替代运行时真相。
