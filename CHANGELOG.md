# 更新日志

本文件记录本包对外可见的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] — 2026-09-08

首个发布版本：research-engine preset 从「本机 `$DSH_HOME/.agent-presets/` 里的私有副本」
变成可分发的 npm 包。

### 新增

- `presets/research-engine/` —— 引擎本体（唯一真源）：`preset.yml`、`agent.cordis.yml`、
  用户面 `SKILL.md`、7 份 JSON schema + `managed.json` + `fields.md`、5 个插件模块。
- `cordis.patch.yml` + `startup.js` —— 组合包层：把自带的 preset 根注册成 `agent-presets`
  的 `system` 根（`dsh plugin --profile <name> add` 后新会话即可选用）。
- `scripts/install.mjs` —— 把 preset 同步进 `$DSH_HOME/.agent-presets/` 的幂等安装器
  （`--force` 先备份、`--dry-run` 只报告、`--dir` 换根）；覆盖 dsh 0.1.1-rc.x 等
  组合包根不生效的版本。
- `README.md`、`CHANGELOG.md`、`.gitignore`、`LICENSE`（MIT）。

### 变更

- 插件依赖解析改为多锚点回退：先按插件自身位置解析（随包安装的 `node_modules`），
  再回退到 `$DSH_HOME/profiles/node_modules` 的扁平安装 —— 同一份代码既能作为 npm 包运行，
  也能作为拷贝进用户 preset 根的副本运行。
- 仓库结构：规格稿与验收报告移入 `docs/`，v6 存档移入 `archive/preset-v6/`，
  headless 验收 overlay 移入 `overlays/`，测试工程移入 `fixtures/`（gitignore）。
- 自检脚本默认读仓库内的 preset，可用 `RESEARCH_ENGINE_PRESET` 覆盖。

### 已知问题

- dsh 0.1.1-rc.x 的启动器会覆写 `agent-presets` 的 `roots`，组合包注册的自带根在该版本不生效；
  请改用 `scripts/install.mjs`。
- `tools/probe-*.mjs` 在 dsh 沙箱内运行时，`git-lfs` 无法创建命名管道，导致引擎提交 `raw/` 失败、
  探针误报 8 项；在普通终端运行即全绿。

[0.1.0]: https://github.com/quan-huayan/dsh-research-engine/releases/tag/v0.1.0
