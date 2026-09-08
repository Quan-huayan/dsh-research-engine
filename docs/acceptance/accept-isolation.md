你是「研究引擎」验收执行者。本组验收目标：**工程本身就是用户自己的 git 仓库时，引擎绝不碰用户仓库**（§6.2-J）。

工作区 = `D:\CCNI\expHarness\scratch-usergit`（已由人准备好：一个真实的用户 git 仓库，含已跟踪文件、一处未提交改动、一个未跟踪文件）。

**开始前先记录基线**（用 pwsh，原样贴出输出）：
```powershell
cd D:\CCNI\expHarness\scratch-usergit
git rev-parse HEAD
git status --porcelain
git ls-files | Measure-Object -Line
```

然后**严格按序**执行下面 6 组，每步原样贴出工具返回文本：

## A 接入
- A1 `project_init` root=`D:\CCNI\expHarness\scratch-usergit` id=usergit-probe name=用户仓库隔离探针
- A2 `project_load`
- A3 `project_verify`

## B 声明环境
- B1 `stage_declare` action=stage id=data name=数据 entry=data
- B2 `stage_declare` action=stage id=train name=训练
- B3 `stage_declare` action=edge from=data to=train
- B4 `script_declare` mode=create name=probe purpose=隔离探针 allowlist=["python"] content=`print("probe ok", flush=True)`
- B5 `template_declare` id=probe description=隔离探针 allow=["python"] scriptRef=probe args=`--out {{__raw__}}/probe.log` observables=`[{"field":"ok","role":"stdout","pattern":"probe ok"}]` paramsSchema=`{"type":"object","properties":{}}`

## C 执行一次
- C1 `run_draft` template=probe params={} → 记下 runId
- C2 `run_launch` runId=<C1>
- C3 等 15 秒 → `run_query`
- C4 `run_observe` runId=<C1>

## D 知识与派生
- D1 `note_write` kind=lesson name=isolation-probe description=隔离探针 lesson statement=「在用户仓库里跑引擎，用户仓库的文件与历史不受影响。」
- D2 `view_render` kind=report
- D3 `view_render` kind=index
- D4 `view_render` kind=notes-skill
- D5 `project_verify`

## E 关键隔离断言（用 pwsh，原样贴出输出）
```powershell
cd D:\CCNI\expHarness\scratch-usergit
git rev-parse HEAD
git status --porcelain
```
- E1 与基线对比：HEAD 必须**完全不变**
- E2 已跟踪文件不得出现 ` M` / ` D` / `R ` 之类状态（新增的未跟踪引擎文件可以出现，这是设计允许的：引擎不代改 `.gitignore`）
- E3 确认工程根**没有**生成 `.git`（Test-Path）
- E4 确认用户的 `.gitignore`、`.git\config`、`.git\HEAD` 内容与基线一致（贴出对比）

## F 结论
回答三问：
1. 用户仓库的 HEAD 是否变化？
2. 用户已跟踪文件是否有任何被修改/删除？
3. 引擎的文件是否全部落在未跟踪区（允许），且没有改写用户的 `.gitignore`？

## 最后输出
1. **用 write 工具把报告写入 `D:\CCNI\expHarness\accept-isolation.report.md`**（表格：编号/验收项/通过-失败/关键证据）
2. 回复里给不超过 10 行摘要

## 禁止
- 不要 `git commit` / `git add` / `git checkout` / `git stash` / `git reset` 用户仓库
- 不要修改用户的已跟踪文件
- 不要删除任何文件
