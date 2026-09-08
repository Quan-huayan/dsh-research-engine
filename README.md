# @quan-huayan/dsh-research-engine · 研究引擎

> 一个 DeepSeek Harness（dsh）**agent preset**：把研究工程变成「不可变证据 + 一条可重放的过程」。
> 环境 / 台账 / 状态机 / 执行 / 知识五层由工具独占，模型只能经工具改工程，数字只能由工具从已登记文件里提取。

**English** — `@quan-huayan/dsh-research-engine` ships a self-contained dsh agent preset (`research-engine`) plus a
profile bundle layer that registers it. Inside a research project every mutation goes through a tool, every claim
points at evidence, and user authority must quote a real answer; the engine keeps its own internal version store the
model never sees. 21 model-facing tools + 1 internal service, 7 JSON schemas, 5 plugin modules, zero runtime deps
beyond `js-yaml` / `ajv`.

- 版本：**0.1.0**
- 包名：`@quan-huayan/dsh-research-engine`（npm）
- 需要：Node ≥ 22；dsh（0.1.1-rc.2 及以上均可）；`git` 必需，`git-lfs` 可选（不装则 `raw/` 降级为哈希-only）

---

## 1. 根本原则

**任何研究结论，都必须能由不可变证据 + 一条可重放的过程重新得到。**

三条推论决定引擎的每一个动作：

| | 原则 | 物理落点 |
|---|---|---|
| P1 | **证据优先**：结论只能指向证据；数字只能由工具从已登记文件里提取 | `experiments/<runId>/{config,manifest,observations}.json` + `raw/` |
| P2 | **封闭变更**：工程里的所有变更只能经工具发生 | 写类工具前置守卫 + 内建版本库（模型不可见） |
| P3 | **权威分离**：用户权威 / 证据权威 / agent 提议不得互相冒充 | `conventions[]` + `decision` 事件 / `observations.json` / `.kb/notes` 的 `status` |

八要素落点、22 条权责、逐工具流程见 [`docs/`](docs/README.md)。

---

## 2. 安装

### 方式 A：组合包（推荐，dsh ≥ 0.1.2-rc.1）

```sh
dsh plugin --profile web add @quan-huayan/dsh-research-engine
```

本包声明了 `dsh.bundle.patch`，`dsh` 会把它追加进该 profile 的 `dsh.profile.bundles`；启动时
[`cordis.patch.yml`](cordis.patch.yml) 把本包自带的 `presets/` 注册成 `agent-presets` roster 的一个
`system` 根 —— **新建会话即可在 preset 选择器里看到「研究引擎」**，无需重启。

先只看组合结果、不启动：

```sh
dsh --profile web --dump-config      # 应能看到 "# == @quan-huayan/dsh-research-engine" 这一层
```

卸载：`dsh plugin --profile web remove @quan-huayan/dsh-research-engine`（依赖与层一起移除）。

> **dsh 0.1.1-rc.x 的限制**：那一版的启动器会把 `agent-presets` 的 `roots` 覆写为「仅随附根」，
> 组合包注册的自带根不生效（`--dump-config` 里能看到，启动后没有）。请用方式 B。

### 方式 B：装进用户 preset 根（全版本可用）

```sh
node node_modules/@quan-huayan/dsh-research-engine/scripts/install.mjs
# 或从本仓库直接跑：
node scripts/install.mjs
```

把 `presets/research-engine/` 同步到 `$DSH_HOME/.agent-presets/research-engine`。
脚本是幂等的：目标不存在就装；内容相同就跳过；**内容不同会拒绝覆盖并提示**，确认要覆盖加 `--force`
（先自动备份成 `research-engine.bak-<时间戳>`）。`--dry-run` 只报告将要做什么，`--dir <目录>` 换 preset 根。

两种方式可以共存：组合包的 `system` 根排在用户根之前，同名 id 由组合包那份胜出。

---

## 3. 用它

1. 在目标工作区**新建**会话，选「研究引擎」preset（切换 preset 只在空白会话可用）。
2. 首句直接说目标，或先让它看现状：

```
project_load → project_verify          # 先看现状，别凭记忆断言工程内容
stage_read → stage_goto                # 走到该在的阶段
（需要新能力）script_declare → template_declare
run_draft → run_launch → job_output    # 跑
run_observe                            # 数字来自产出文件本身
note_write(claim, evidence=[runId]) → note_adjudicate(accept)
view_render(report) → view_render(notes-skill)
```

新目录接引擎：让它 `project_init`。已经存在的旧工程：`project_init mode=migrate`（原文归档、逐项迁移、
不删任何既有文件）。

### 21 个模型面工具

| 域 | 工具 |
|---|---|
| 环境 / 台账（7） | `project_init` `project_load` `project_verify` `project_reconcile` `entity_declare` `entity_query` `convention_declare` |
| 状态机（3） | `stage_declare` `stage_read` `stage_goto` |
| 执行 / 证据（7） | `template_declare` `script_declare` `run_draft` `run_launch` `run_observe` `run_query` `run_close` |
| 知识 / 裁决（4） | `note_write` `note_adjudicate` `note_query` `view_render` |

内建服务 `research.engineGit` 不注册工具，模型侧看不到任何版本库概念。

### 工程里的物理形态

```
project.yaml  pipeline.yaml  templates.yaml  scripts/  registry.jsonl
experiments/<runId>/{config.json, manifest.json, observations.json, raw/}
.kb/{notes/*.md, index.yaml}          _report/{runs.csv, summary.json}
.research/{state.json, managed.json, engine.git/}
skills/<工程>/SKILL.md                 ← 派生视图，由 view_render 生成
遗留区（.pth/.png/.txt/.ipynb …）      ← 只登记，不改不删
```

---

## 4. 仓库结构

```
presets/research-engine/        引擎本体（唯一真源）
  preset.yml  agent.cordis.yml
  skills/research-engine/SKILL.md
  contract/                     7 份 schema + managed.json + fields.md
  plugins/{engine-git,exp-ledger,stage-ctrl,task-dispatch,kb-core}/main.js
cordis.patch.yml                组合包层：把 presets/ 注册成 agent-presets 的 system 根
startup.js                      组合包的提供方行（只暴露 presetsDir 服务）
scripts/install.mjs             把 preset 装进 $DSH_HOME/.agent-presets/
tools/                          自检脚本（不进 npm 包）
overlays/                       headless 验收 overlay
docs/                           规格稿 + 六轮验收报告
archive/preset-v6/              v6 历史存档
fixtures/                       测试工程（gitignore，不进包）
```

---

## 5. 自检

```sh
npm run check          # 契约 + 插件静态检查 + 197 项工具探针
npm run check:preset   # 用 dsh 自己的 preset 发现器解析 agent.cordis.yml
node tools/probe-migrate.mjs   # 迁移自检
```

| 脚本 | 覆盖 |
|---|---|
| `tools/check-contract.mjs` | 7 份 schema 可编译、跨文件引用无环、真实数据差距清单 |
| `tools/check-plugins.mjs` | 5 插件可加载、21 工具名合法唯一、schema 落在 dsh-tools 支持子集内 |
| `tools/probe-tools.mjs` | 假 ctx 逐工具跑 197 项断言（严格返回字段、返回文本零版本库词汇、拒绝路径必带修法） |
| `tools/probe-migrate.mjs` | 旧式工程 → `project_init mode=migrate` → 核对六项产出与幂等复检 |
| `tools/check-preset.mjs` | 宿主 preset 发现器解析合成文件（含 `!!js`） |

> **探针必须在 dsh 沙箱之外跑。** 沙箱禁止创建命名管道，`git-lfs` 因此起不来
> （`couldn't create signal pipe, Win32 error 5`），引擎提交 `raw/` 失败，探针会误报 8 项。
> 在普通终端里跑即全绿。

`RESEARCH_ENGINE_PRESET` 环境变量可让所有自检改读别的 preset 副本（例如已安装的那份）。

---

## 6. 已知边界

- **用户权威落点为空是正常的**：约定与裁决需要真实用户答复，引擎拒绝推断、代答、润色。
- **`job_output` 在任务结束后可能为空**：进程输出已被收进 `experiments/<runId>/raw/stdout.log`（证据）。
- **`git-lfs` 不可用时**：`raw/` 降级为哈希-only，证据被改动即 `invalidated`。
- **前端外观**（client 插件 + host 只读桥）未做；本期只有模型面与派生视图。
- **preset 副本会漂移**：升级本包后，方式 B 装下的副本需要重跑 `scripts/install.mjs`（脚本会提示）。

---

## 7. 开发与发布（维护者）

改动 `presets/research-engine/` 后：

1. 递增 `agent.cordis.yml` 里 `./plugins/*/main.js?v=N` 的 N —— loader 按 URL 缓存 ESM，同进程内改代码只有 URL 变了才重新求值。
2. 跑 §5 的自检。
3. 更新 `CHANGELOG.md` 与 `package.json` 的 `version`。
4. 发布：`npm publish`（`publishConfig.access=public`）。
   预览包内容：`npm pack --dry-run`。

---

## 8. 许可

**待定** —— 发布前请补上 `LICENSE` 文件与 `package.json` 的 `license` 字段。
在此之前本包按「保留所有权利」处理，请勿直接再分发。
