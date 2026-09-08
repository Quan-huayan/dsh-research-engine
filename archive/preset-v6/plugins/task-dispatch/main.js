// task-dispatch ③ —— 任务模板/派发插件
// research-engine preset 内嵌插件。拥有数据：project.yaml 的 run_templates；
// 写 experiments/<runId>/config.json，登记 registry.jsonl 运行记录 {runId,kind,stage,template,params,status,...}。
// 工具：run_templates / run_template / run_draft / run_launch（+ 服务 research.taskDispatch）。
// run_launch 双点拦截：①本插件安全闸（脚本在工程内、命令前缀 ∈ 模板 allow 白名单、参数不写工程外）
// → 命中返回拒绝文本并记 kb-core 教训；②宿主 shell/sandbox 兜底（ctx.shell.start 走会话策略）。
// 后台经 ctx.jobs.start（kind='research.run'，producer 形态，绝不 fork 训练进程、不阻塞本轮）。

import { createRequire } from 'node:module';
import { join, dirname, resolve, relative, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';

const dshHome = process.env.DSH_HOME || join(os.homedir(), '.dsh');
const requireFromHarness = createRequire(join(dshHome, 'profiles', 'node_modules', 'js-yaml', 'package.json'));
const yaml = requireFromHarness('js-yaml');

export const name = 'task-dispatch';
export const inject = ['tools'];

function iso() { return new Date().toISOString(); }
function sha1(s) { return createHash('sha1').update(String(s)).digest('hex'); }
function rand3() { return randomBytes(2).toString('hex').slice(0, 3); }
async function pathExists(p) { try { await stat(p); return true; } catch { return false; } }
async function ensureDir(p) { await mkdir(p, { recursive: true }); }
async function atomicWrite(p, body) {
  await ensureDir(dirname(p));
  const tmp = p + '.tmp-' + sha1(iso() + Math.random()).slice(0, 8);
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, p);
}
function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
}
async function projectRootOf(args, exec) {
  if (typeof args?.project === 'string' && args.project.trim() !== '') return resolve(sessionCwd(exec), args.project);
  return sessionCwd(exec);
}
function isWithin(root, p) {
  const rel = relative(resolve(root), resolve(p));
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..');
}
function tsCompact(ts) { return ts.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace(/[TZ]/g, (m) => (m === 'T' ? '-' : '')); }
/** 提取 args 模板里的 {{key}} 占位符（去重）。 */
function placeholdersIn(template) {
  if (typeof template !== 'string' || template === '') return [];
  return [...new Set([...template.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)].map((m) => m[1]))];
}

// ---------- 工程/registry 数据 ----------
async function readProjectDoc(root) {
  const p = join(root, 'project.yaml');
  if (!(await pathExists(p))) { const e = new Error(`工程缺少 project.yaml（${p}）。先 project_init。`); e.code = 'PROJECT_MISSING'; throw e; }
  let doc;
  try { doc = yaml.load(await readFile(p, 'utf8')); } catch (err) { throw new Error(`project.yaml 解析失败: ${err.message}`); }
  return doc && typeof doc === 'object' ? doc : {};
}
async function writeProjectDoc(root, doc) {
  await atomicWrite(join(root, 'project.yaml'), yaml.dump(doc, { lineWidth: 120, noRefs: true, skipInvalid: true }));
}
async function readRegistry(root) {
  const p = join(root, 'registry.jsonl');
  if (!(await pathExists(p))) return [];
  const out = [];
  for (const line of (await readFile(p, 'utf8')).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch {}
  }
  return out;
}
async function writeRegistry(root, rows) {
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  await atomicWrite(join(root, 'registry.jsonl'), body);
}
async function updateRun(root, runId, patch) {
  const rows = await readRegistry(root);
  const idx = rows.findIndex((r) => r && r.record === 'run' && r.runId === runId);
  if (idx < 0) return null;
  rows[idx] = { ...rows[idx], ...patch, ts: iso() };
  await writeRegistry(root, rows);
  return rows[idx];
}
function templateList(doc) {
  const t = doc?.templates;
  return t && typeof t === 'object' ? t : {};
}

// ---------- 服务 research.taskDispatch ----------
function buildService(ctxRef) {
  const kbCore = async (exec) => {
    try { return ctxRef.get('research.kbCore'); } catch { return null; }
  };
  const currentStage = async (exec, root) => {
    try {
      const ctrl = ctxRef.get('research.stageCtrl');
      if (!ctrl) return null;
      const r = await ctrl.read({ project: root }, exec);
      return r?.data?.state?.stage ?? null;
    } catch { return null; }
  };

  return {
    async templates(args, exec) {
      const root = await projectRootOf(args, exec);
      const doc = await readProjectDoc(root);
      const list = Object.entries(templateList(doc));
      if (!list.length) return { ok: true, text: `run_templates：工程没有模板（${root}）。用 run_template 生成。`, data: { root, templates: [] } };
      const lines = list.map(([id, t]) => `- ${id}  ${t?.description || ''}${t?.command?.allow ? '  allow=' + JSON.stringify(t.command.allow) : ''}`);
      return { ok: true, text: `run_templates（${root}）共 ${list.length} 个：\n` + lines.join('\n'), data: { root, templates: list.map(([id, t]) => ({ id, ...t })) } };
    },
    async template(args, exec) {
      const root = await projectRootOf(args, exec);
      const doc = await readProjectDoc(root);
      const id = typeof args?.id === 'string' && args.id.trim() ? args.id.trim() : null;
      if (!id) return { ok: false, text: 'run_template 缺少必填 id。' };
      const overwrite = args?.overwrite === true;
      const tpls = templateList(doc);
      if (!overwrite && Object.hasOwn(tpls, id)) return { ok: false, text: `模板已存在（${id}）。如要覆盖请加 overwrite:true。` };
      const allow = Array.isArray(args?.allow) && args.allow.length
        ? args.allow.map(String)
        : (Array.isArray(args?.command?.allow) && args.command.allow.length ? args.command.allow.map(String) : ['python']);
      const command = {
        allow,
        ...(typeof args?.script === 'string' && args.script.trim() ? { script: args.script.trim() } : {}),
        ...(typeof args?.args === 'string' && args.args.trim() ? { args: args.args.trim() } : {}),
      };
      if (typeof args?.command === 'object' && args.command && typeof args.command.script === 'string') command.script = args.command.script;
      const tpl = {
        description: typeof args?.description === 'string' ? args.description : '',
        parameters: args?.parameters && typeof args.parameters === 'object' ? args.parameters : { type: 'object', properties: {} },
        command,
      };
      tpls[id] = tpl;
      doc.templates = tpls;
      await writeProjectDoc(root, doc);
      return { ok: true, text: `run_template 已写入：${id}（allow=${JSON.stringify(command.allow)} script=${command.script || '(无)'}）。\n工程: ${root}\n安全闸将以 allow 前缀白名单约束 run_launch。`, data: { root, id, template: tpl } };
    },
    async draft(args, exec) {
      const root = await projectRootOf(args, exec);
      const doc = await readProjectDoc(root);
      const id = typeof args?.template === 'string' && args.template.trim() ? args.template.trim() : null;
      if (!id) return { ok: false, text: 'run_draft 缺少必填 template id。' };
      const tpl = templateList(doc)[id];
      if (!tpl) return { ok: false, text: `模板不存在：${id}。可用 run_templates 查看。` };
      const params = args?.params && typeof args.params === 'object' && !Array.isArray(args.params) ? args.params : {};
      const req = Array.isArray(tpl?.parameters?.required) ? tpl.parameters.required : [];
      const missing = req.filter((k) => !(k in params));
      if (missing.length) return { ok: false, text: `run_draft 参数不完整：缺少 ${missing.join(', ')}（模板 ${id} 要求）。` };
      // 占位符完整性：args 里出现的 {{key}} 必须在 params 中提供，否则会被展开为空、命令行残缺
      //（现场教训 lesson-smoke-hello-seed-placeholder：`--seed {{seed}}` + 空 params → `--seed` 无值 → exit 1）。
      const needed = placeholdersIn(tpl?.command?.args);
      const missingPh = needed.filter((k) => !(k in params));
      if (missingPh.length) {
        return { ok: false, text: `run_draft 拒绝：模板 ${id} 的 command.args 需要参数 ${missingPh.join(', ')}（未提供会把 {{…}} 展开为空、命令行残缺）。\n请补 params，或在模板 parameters.required 中声明这些键。` };
      }
      const kind = typeof args?.kind === 'string' && args.kind.trim() ? args.kind.trim() : 'run';
      const runId = `${String(doc?.project?.id || basename(root) || 'project').toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-${id}-${tsCompact(iso())}-${rand3()}`;
      const stage = typeof args?.stage === 'string' && args.stage ? args.stage : ((await currentStage(exec, root)) ?? null);
      const cfgPath = join('experiments', runId, 'config.json');
      const config = { runId, projectId: doc?.project?.id ?? null, template: id, kind, stage, params, ts: iso() };
      await ensureDir(join(root, 'experiments', runId));
      await atomicWrite(join(root, cfgPath), JSON.stringify(config, null, 2) + '\n');
      const rows = await readRegistry(root);
      rows.push({
        record: 'run', runId, kind, stage, template: id, params,
        status: 'draft', configPath: cfgPath, resultPath: null, ts: iso(),
      });
      await writeRegistry(root, rows);
      return { ok: true, text: `run_draft 完成：${runId}\nconfig: ${join(root, cfgPath)}\nregistry: 已登记（status=draft）\n下一步 run_launch runId=${runId} 启动后台任务。`, data: { root, runId, configPath: cfgPath, stage } };
    },
    async launch(args, exec) {
      const root = await projectRootOf(args, exec);
      // 1) 确定 runId（可直接指定，或用 template+params 先 draft）
      let runId = typeof args?.runId === 'string' && args.runId.trim() ? args.runId.trim() : null;
      if (!runId) {
        const d = await this.draft(args, exec);
        if (!d.ok) return d;
        runId = d.data.runId;
      }
      const rows = await readRegistry(root);
      const rec = rows.find((r) => r && r.record === 'run' && r.runId === runId);
      if (!rec) return { ok: false, text: `run_launch：registry 找不到 runId=${runId}（先 run_draft）。` };
      // config.json 是运行的权威定义（可能被手改或来自旧 draft）；registry 行仅作台账。
      const cfgPathAbs = join(root, rec.configPath || join('experiments', runId, 'config.json'));
      let cfg = null;
      try { cfg = JSON.parse(await readFile(cfgPathAbs, 'utf8')); } catch { cfg = null; }
      const params = cfg && cfg.params && typeof cfg.params === 'object' && !Array.isArray(cfg.params) ? cfg.params : (rec.params || {});
      const templateId = cfg && typeof cfg.template === 'string' && cfg.template.trim() ? cfg.template.trim() : rec.template;
      const doc = await readProjectDoc(root);
      const tpl = templateList(doc)[templateId];
      if (!tpl) {
        await updateRun(root, runId, { status: 'invalidated' });
        return { ok: false, text: `run_launch：模板 ${templateId} 已不存在 → 该 run 标为 invalidated（不物理删除）。` };
      }
      // 2) 组装命令 + 安全闸（双点拦截之一）
      const allow = Array.isArray(tpl?.command?.allow) ? tpl.command.allow.map(String) : [];
      const script = typeof tpl?.command?.script === 'string' && tpl.command.script.trim() ? tpl.command.script.trim() : null;
      const argsTpl = typeof tpl?.command?.args === 'string' ? tpl.command.args.trim() : '';
      if (!allow.length) return { ok: false, text: `安全闸：模板 ${templateId} 未声明 command.allow 白名单，拒绝启动。` };
      // 占位符完整性（纵深防御：runId 可能来自旧 draft / 手改 config）
      const needPh = placeholdersIn(tpl?.command?.args);
      const missPh = needPh.filter((k) => !(k in params));
      if (missPh.length) {
        return { ok: false, text: `run_launch 拒绝：run ${runId} 的模板 args 需要参数 ${missPh.join(', ')}，但 config.json/台账里缺失 → 命令行会残缺（如 --seed 无值）。请重新 run_draft 带齐参数。` };
      }
      const projectId = doc?.project?.id ?? basename(root);
      const tokens = [];
      const extOf = (p) => { const m = /\.([A-Za-z0-9]+)$/.exec(p); return m ? m[1].toLowerCase() : ''; };
      if (script) {
        const scriptAbs = resolve(root, script);
        if (!isWithin(root, scriptAbs)) return { ok: false, text: `安全闸：模板脚本不在工程内（${script}），拒绝启动。` };
        const interpByExt = { py: 'python', js: 'node', sh: 'bash', ps1: 'pwsh' };
        const interp = interpByExt[extOf(script)] || allow[0] || 'python';
        tokens.push(interp); // 解释器前缀，由 allow 白名单校验
        tokens.push(script);
      }
      // 渲染模板参数（只允许模板 args 模板里出现过的 {{key}} 占位进入命令行）
      const render = (s) => String(s).replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_m, k) => (k in params ? String(params[k]) : ''));
      const quote = (t) => (/^[A-Za-z0-9_./:\\-]+$/.test(t) ? t : JSON.stringify(t));
      if (argsTpl) for (const part of render(argsTpl).split(/\s+/).filter(Boolean)) tokens.push(part);
      if (!tokens.length) return { ok: false, text: `安全闸：模板 ${templateId} 无脚本也无 args 参数，无法构造命令。` };
      const command = tokens.map(quote).join(' ');
      const firstTok = command.split(/\s+/)[0] || '';
      const allowHit = allow.some((a) => firstTok === a || firstTok.startsWith(a + '='));
      if (!allowHit) {
        const detail = `run_launch 安全闸拦截：命令前缀 ${JSON.stringify(firstTok)} 不在模板 ${templateId} 的 allow 白名单 ${JSON.stringify(allow)} 内（runId=${runId}）`;
        const kb = await kbCore(exec);
        if (kb && typeof kb.learn === 'function') {
          try { await kb.learn({ project: root, type: 'lesson', name: `lesson-${runId}`, description: detail, content: detail + '。run 状态保持 draft，未启动任何进程。' }, exec); } catch {}
        }
        return { ok: false, text: `安全闸拦截：命令前缀 ${JSON.stringify(firstTok)} 不在 allow 白名单 ${JSON.stringify(allow)}。\n已按 §9③ 记入 kb-core 教训（lesson-${runId}）。run 状态保持 draft。` };
      }
      // 3) 后台任务（producer 形态，不 fork）
      //    请求必须与 dsh-tool-pwsh 完全同构：dshEnv（托管环境/PATH）+ sandboxPolicy（会话策略），
      //    否则受限执行器拿不到环境与策略 → 进程起不来（exit 127、无输出）。
      const jobs = ctxRef.get('jobs');
      if (jobs === void 0) return { ok: false, text: 'background jobs 不可用（缺 dsh-jobs-local/dsh-tool-jobs）。' };
      const shellSvc = ctxRef.get('shell');
      if (shellSvc === void 0) return { ok: false, text: 'shell 执行器不可用（宿主缺 ctx.shell），无法启动后台进程。' };
      const shellEnvSvc = ctxRef.get('shellEnv');
      const confining = shellSvc.sandboxMode !== void 0;
      const policySvc = confining ? ctxRef.get('sandboxPolicy') : void 0;
      if (confining && policySvc === void 0) return { ok: false, text: '沙箱执行器已挂载但 ctx.sandboxPolicy 缺失（组合不完整），拒绝启动后台任务。' };
      const sandboxPolicy = policySvc ? policySvc.resolve(exec.agent ? { session: exec.agent.session } : {}) : void 0;
      const workdir = root;
      const cmdLabel = command.length > 120 ? command.slice(0, 120) + '…' : command;
      const request = {
        command,
        workdir,
        ...(shellEnvSvc ? { dshEnv: shellEnvSvc.collect(exec) } : {}),
        ...(sandboxPolicy !== void 0 ? { sandboxPolicy } : {}),
      };
      const resultRel = join('experiments', runId, 'result.json');
      const startedAt = iso();
      await updateRun(root, runId, { status: 'queued', ts: startedAt });
      let jobId = null;
      try {
        jobId = jobs.start({
          kind: 'research.run',
          label: cmdLabel,
          ...(exec.agent ? { owner: exec.agent } : {}),
          run: () => {
            const proc = shellSvc.start(shellSvc.resolve(request));
            const settle = async () => {
              let code = null; let sb = null;
              try { code = proc.exitCode ?? null; } catch {}
              try { sb = proc.sandbox ?? null; } catch {}
              const runnerFailed = sb?.runnerFailed === true;
              const okRun = !runnerFailed && (code === null || code === 0);
              let hasResult = false;
              if (okRun) { try { hasResult = (await stat(join(root, resultRel))) !== void 0; } catch { hasResult = false; } }
              const detail = runnerFailed
                ? `sandbox runner failed（mode=${sb?.mode ?? '?'}，命令未运行）`
                : (code === null ? 'completed' : `exit code: ${code}`);
              try {
                await updateRun(root, runId, {
                  status: okRun ? 'done' : 'failed',
                  resultPath: hasResult ? resultRel : null,
                  detail,
                });
              } catch {}
              return { status: okRun ? 'completed' : 'failed', detail };
            };
            return {
              cancel: () => { try { proc.kill(); } catch {} },
              done: proc.done.then(settle, settle),
              // proc.readOutput() 返回 {delta, lossy, stdoutSpillPath, ...}（不是字符串），
              // 且 proc.sandbox 带 runnerFailed/denied —— 与 dsh-tool-pwsh 的渲染同构，否则日志永远为空。
              readOutput: () => {
                try {
                  const read = proc.readOutput();
                  const delta = typeof read?.delta === 'string' ? read.delta : '';
                  const notices = [];
                  if (read?.lossy) {
                    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((p) => typeof p === 'string' && p.length > 0);
                    notices.push(`[部分输出已丢弃；完整输出：${paths.length ? paths.join(', ') : '(不可用)'}]`);
                  }
                  const sb = proc.sandbox;
                  if (sb?.runnerFailed) notices.push(`[sandbox: 沙箱运行器自身失败（mode=${sb?.mode ?? '?'}）——命令未运行，这是沙箱问题而非命令失败]`);
                  else if (sb?.denied) notices.push(`[sandbox: 被拒绝（mode=${sb?.mode ?? '?'}）]`);
                  if (!notices.length) return delta;
                  return delta + (delta.length > 0 && !delta.endsWith('\n') ? '\n' : '') + notices.join('\n');
                } catch { return ''; }
              },
            };
          },
        });
      } catch (err) {
        await updateRun(root, runId, { status: 'failed', resultPath: null, detail: String(err?.message || err) });
        return { ok: false, text: `run_launch 启动失败：${err?.message || err}\nrunId=${runId} 已标 failed（config 保留于 ${cfgPathAbs}）。` };
      }
      await updateRun(root, runId, { status: 'running', jobId, ts: iso() });
      const lines = [
        `run_launch 已启动后台任务：${runId}`,
        `jobId=${jobId}  模板=${templateId}  阶段=${(cfg?.stage ?? rec.stage) ?? '—'}`,
        `command: ${command}`,
        `工程根: ${root}`,
        `执行环境：shell sandboxMode=${shellSvc.sandboxMode ?? '(无沙箱)'}｜dshEnv=${shellEnvSvc ? '已注入' : '缺失'}｜sandboxPolicy=${sandboxPolicy !== void 0 ? '已解析' : '未提供'}`,
        '说明：不 fork 训练进程、不阻塞本轮；完成后 registry 状态自动置 done/failed。',
        `日志读取：job_output(job_id=...)（输出含 stderr 与沙箱提示）、取消 job_kill；结果路径 ${resultRel}（进程写入，成功且存在才登记）。`,
      ];
      return { ok: true, text: lines.join('\n'), data: { root, runId, jobId, command } };
    },
  };
}

/** UI 呈现辅助：generic 卡片（kind:'edit' + locations → deliverables 文件行）。 */
function genericCall(title, kind, paths) {
  return { card: 'generic', title, kind, ...(paths && paths.length ? { locations: paths.map((p) => ({ path: p })) } : {}) };
}
function underProject(root, name) {
  return typeof root === 'string' && root.trim() !== '' ? join(root, name) : name;
}

function registerTextTool(ctx, tool) {
  ctx.tools.register({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'object',
      properties: tool.properties || {},
      ...(tool.required && tool.required.length ? { required: tool.required } : {}),
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    ...(tool.presentCall ? { presentCall: tool.presentCall } : {}),
    ...(tool.presentResult ? { presentResult: tool.presentResult } : {}),
    execute: async (args, exec) => {
      const result = await tool.execute(args, exec);
      return { text: typeof result?.text === 'string' ? result.text : String(result?.text ?? '') };
    },
  });
}

function apply(ctx) {
  const service = buildService(ctx);
  ctx.provide('research.taskDispatch', service);

  registerTextTool(ctx, {
    name: 'run_templates',
    description: '列出工程 project.yaml 中的任务模板（id、description、allow 白名单）。',
    properties: { project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' } },
    execute: async (args, exec) => service.templates(args, exec),
    presentCall: (args) => genericCall('列出任务模板', 'read', [underProject(args.project, 'project.yaml')]),
  });

  registerTextTool(ctx, {
    name: 'run_template',
    description: '任务模板生成器：按参数 schema 向 project.yaml 写入一个合规模板 {description, parameters, command:{allow 前缀白名单, script, args}}。模板内容开放，仅骨架受检。',
    properties: {
      project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      id: { type: 'string', description: '模板 id（唯一，必填）。' },
      description: { type: 'string', description: '模板说明。' },
      allow: { type: 'array', description: '命令前缀白名单，如 ["python"]；缺省 ["python"]。' },
      script: { type: 'string', description: '工程内可执行脚本相对路径，如 cifar3.py 或 x/cifar4.py。' },
      args: { type: 'string', description: '追加参数模板，支持 {{key}} 占位（来自 params）。' },
      overwrite: { type: 'boolean', description: 'true 时允许覆盖同名模板。' },
    },
    required: ['id'],
    execute: async (args, exec) => service.template(args, exec),
    presentCall: (args) => genericCall(`写模板 ${args.id ?? '?'}`, 'edit', [underProject(args.project, 'project.yaml')]),
  });

  registerTextTool(ctx, {
    name: 'run_draft',
    description: '按模板展开草稿：参数校验 → 写 experiments/<runId>/config.json → registry.jsonl 登记（status=draft）。返回 runId 供 run_launch。',
    properties: {
      project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      template: { type: 'string', description: '模板 id（必填）。' },
      kind: { type: 'string', description: '运行类别（train/eval/compare/smoke…），默认 run。' },
      stage: { type: 'string', description: '所属阶段；缺省取当前阶段。' },
      params: { type: 'object', description: '模板参数（对象）。' },
    },
    required: ['template'],
    execute: async (args, exec) => service.draft(args, exec),
    presentCall: (args) => genericCall(`展开草稿 ${args.template ?? ''}`.trim(), 'edit', [underProject(args.project, 'registry.jsonl')]),
    presentResult: (_args, result) => {
      const m = /run_draft 完成：([A-Za-z0-9._-]+)/.exec(result?.text ?? '');
      const cfg = /config: (.+)$/m.exec(result?.text ?? '');
      const locations = [];
      if (cfg) locations.push({ path: cfg[1].trim() });
      if (!m) return { card: 'generic', ...(locations.length ? { content: [{ type: 'text', text: result.text }] } : {}) };
      return { card: 'generic', title: `run_draft → ${m[1]}`, ...(locations.length ? { content: [{ type: 'text', text: result.text }] } : {}) };
    },
  });

  registerTextTool(ctx, {
    name: 'run_launch',
    description: '安全闸 + 后台派发：校验命令前缀 ∈ 模板 allow、脚本在工程内 → ctx.jobs.start(kind=research.run) 起后台任务（不 fork），返回 jobId；registry 状态 queued→running→done/failed。安全闸命中返回拒绝文本并记 kb-core 教训；模板缺失标 run invalidated 不物理删。',
    properties: {
      project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      runId: { type: 'string', description: '已 draft 的 runId；缺省时用 template+params 自动 draft。' },
      template: { type: 'string', description: 'runId 缺省时使用：模板 id。' },
      params: { type: 'object', description: 'runId 缺省时使用：模板参数。' },
      kind: { type: 'string', description: 'runId 缺省时使用：运行类别。' },
      stage: { type: 'string', description: 'runId 缺省时使用：所属阶段。' },
    },
    execute: async (args, exec) => service.launch(args, exec),
    presentCall: (args) => genericCall(`启动后台任务 ${args.runId ?? args.template ?? ''}`.trim(), 'execute', [underProject(args.project, 'registry.jsonl')]),
    presentResult: (_args, result) => {
      const m = /jobId=([A-Za-z0-9._-]+)/.exec(result?.text ?? '');
      return m ? { card: 'generic', title: `run_launch → job ${m[1]}` } : { card: 'generic' };
    },
  });
}

export { apply };
