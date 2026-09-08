你是「研究引擎」现场验收执行者。工作区 = D:\AI\attndepth。本会话已挂载引擎工具：`research_project` / `research_go` / `research_memo`（外观层），底层 `project_*` / `stage_*` / `run_*` / `kb_*` 也在，但请**只走 research_***。

先读两份文件（read 工具），再动手：
1. `C:\Users\Laphend Anaya\.dsh\.agent-presets\research-engine\skills\research-engine\SKILL.md`
2. `D:\CCNI\expHarness\research-engine-plan.md` 的 §12 与 §16

然后**严格按序**执行下面 4 组验收。每完成一小项，立刻原样贴出工具返回文本（不要改写、不要总结替代原文）。

## D 失败 / 重放 / 回滚

D1 失败 run 保留 config：
- `research_go op=draft template=smoke-diag params={"seed":0,"diag":"experiments"}` → 记下 runId
- `research_go op=launch runId=<该 runId>` → 等约 10 秒 → `job_output` 读日志（预期 python 抛 IsADirectoryError）
- `research_project op=query record=run` → 贴出该行 status/detail
- 用 pwsh `Test-Path` 证明 `experiments/<runId>/config.json` 仍存在

D2 修正后重 draft（不覆盖旧记录）：
- 同一模板、`params={"seed":0,"diag":"experiments/_diag_live_d.txt"}` → draft → launch → 等约 15 秒 → 确认 status=done
- 再 `research_project op=query record=run` → 证明 D1 与 D2 两条记录**同时存在**（registry 不覆盖、不物理删）

D3 job_kill（重点观察状态机）：
- 用 write 新建 `D:\AI\attndepth\hold_probe.py`：docstring 写明"验收用：sleep 60s，供 job_kill 验证，不训练"；`import time`；`print("hold start", flush=True)`；`time.sleep(60)`；`print("hold end")`
- `research_go op=template` 建模板 `hold-probe`：`command.allow=["python"]`、`script="hold_probe.py"`、`args=""`
- draft + launch → 立刻 `job_kill(job_id)` → 等 5 秒
- 贴出 `job_output` 与该 run 在 `research_project op=query record=run` 里的 status/detail
- **如实记录 kill 之后状态是 cancelled / failed / done 哪一种**（不要替引擎辩护，也不要修代码）

## E 非线性跳段

- E1 `research_go op=read` → 记录当前阶段
- E2 `research_go op=goto from=compare to=dataset` → 预期**被拒**（返回拒绝文本，不是报错）→ 贴原文
- E3 `research_go op=goto from=compare to=attndepth` → 预期**成功**（合法回跳）→ 贴原文
- E4 `research_go op=read` → 确认当前阶段 = attndepth
- 说明：`.research/state.json` 原本不存在，跑完 E 后存在（stage=attndepth）属验收预期，保留即可

## H 安全闸（双点拦截）

- H1 建两个危险模板（用 `research_go op=template`；**若该工具拒绝这种模板，就改用 edit 直接写 project.yaml，并如实记录"生成器是否校验"**）：
  - `danger-prefix`：`command.allow=["python3"]`、`script="smoke_hello.py"`、`args="--seed 0"`（解释器由脚本扩展名决定 = python，前缀不在 allow 内）
  - `danger-outside`：`command.allow=["python"]`、`script="../outside_probe.py"`
- H2 各 draft 一次 → launch → 预期都被安全闸拒绝 → 贴出两条拒绝文本
- H3 用 glob/read 确认 `.kb/notes/` 新增了 `lesson-<runId>.md` → 贴文件名与 frontmatter
- H4 用 edit 把 H1 建的两个危险模板从 `project.yaml` 删掉 → `research_project op=load` 确认仍 valid=true

## ⑦ 清单核对

- ⑦1 pwsh 统计工程内 `*.pth` / `*.png` / `*.txt` / `*.ipynb` 数量（排除 node_modules/.git），与 `project.yaml` 的 `legacy.keep` 声明逐项对比
- ⑦2 确认 `x\data`、`x1\data`、`x2\data` 是 junction 且指向 `D:\AI\attndepth\data`
- ⑦3 `research_project op=query record=entity` → 实体条数

## 最后输出（三部分）

1. 一张表：`编号 | 验收项 | 通过/失败 | 关键证据（一行）`
2. 一段「异常 / 与文档不符处」：只写你**实际观察到**的差异（例如 D3 的状态取值、lesson 文件命名、拒绝文本措辞、生成器是否校验危险模板）
3. 你新增 / 修改 / 删除了哪些文件（完整清单）

## 禁止

- 删除任何 `.pth` / `.png` / `.txt` / `.ipynb`
- 修改 `.kb/notes/` 里已有的笔记（新增 lesson 可以）
- 把 `hold-probe` 以外的测试模板留在 `project.yaml` 里
- 启动任何训练（cifar*.py / cifar5.py）
