// task-dispatch —— 实例 / 执行 / 证据（7 工具）
//
// 拥有数据：templates.yaml（环境：可执行声明）、scripts/*（环境：辅助脚本 + *.meta.json）、
// experiments/<runId>/{config,manifest,observations}.json（证据与证据权威）。
// raw/ 由进程写，run_launch 登记并归档；observations.json 只能由 run_observe 从已登记文件里提取。
//
// 后台执行与 dsh-tool-pwsh 同构：dshEnv + sandboxPolicy 必须一起给，否则受限执行器起不来（exit 127 现场教训）。

import { join, dirname, resolve, relative, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, stat, rename, readdir } from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';

const dshHome = process.env.DSH_HOME || join(os.homedir(), '.dsh');
// 依赖解析：先按插件自身位置解析（npm/pnpm 随包安装的 node_modules），
// 再回退到 harness profile 的扁平安装 —— 把 preset 目录直接拷进 $DSH_HOME/.agent-presets 时没有自己的 node_modules。
const REQUIRE_ANCHORS = [
  import.meta.url,
  join(dshHome, 'profiles', 'node_modules', 'js-yaml', 'package.json'),
  join(dshHome, 'profiles', 'web', 'package.json'),
];
function loadDep(id) {
  let last = null;
  for (const anchor of REQUIRE_ANCHORS) {
    try { return createRequire(anchor)(id); } catch (error) { last = error; }
  }
  throw new Error(`缺少依赖 ${id}：请在该 preset 所在位置安装它，或让 $DSH_HOME/profiles/node_modules 里存在它（${last && last.message}）`);
}
const yaml = loadDep('js-yaml');
let Ajv2020 = null;
try { Ajv2020 = loadDep('ajv/dist/2020'); } catch { Ajv2020 = null; }

const SCHEMA_VERSION = 3;
const TEMPLATES_YAML = 'templates.yaml';
const REGISTRY = 'registry.jsonl';
// 词边界替换：不误伤用户数据里的同形子串（如 usergit-probe / shanghai），但独立出现的版本库词汇一律替换。
const SCRUB = /(^|[^A-Za-z0-9_-])(git|commit|HEAD|diff|hash|sha)(?![A-Za-z0-9_-])/gi;
const RESERVED = ['__raw__', '__runId__', '__project__'];

export const name = 'task-dispatch';
export const inject = ['tools'];

function iso() { return new Date().toISOString(); }
function sha256(s) { return createHash('sha256').update(s).digest('hex'); }
function scrub(t) { return String(t ?? '').replace(SCRUB, (_m, pre) => `${pre}·`); }
function rand3() { return randomBytes(2).toString('hex').slice(0, 3); }
function posix(p) { return String(p).replace(/\\/g, '/'); }
function isWithin(root, p) {
  const rel = relative(resolve(root), resolve(p));
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..');
}
async function pathExists(p) { try { await stat(p); return true; } catch { return false; } }
async function ensureDir(p) { await mkdir(p, { recursive: true }); }
async function atomicWrite(p, body) {
  await ensureDir(dirname(p));
  const tmp = `${p}.tmp-${sha256(iso() + Math.random()).slice(0, 8)}`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, p);
}
function tsCompact(ts) {
  return ts.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace(/[TZ]/g, (m) => (m === 'T' ? '-' : ''));
}
function placeholdersIn(template) {
  if (typeof template !== 'string' || template === '') return [];
  return [...new Set([...template.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)].map((m) => m[1]))];
}
function interpFor(p, allow) {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(String(p))?.[1] ?? '').toLowerCase();
  const map = { py: 'python', js: 'node', sh: 'bash', ps1: 'pwsh', bat: 'cmd', cmd: 'cmd' };
  return map[ext] ?? (Array.isArray(allow) && allow.length ? allow[0] : 'python');
}
function quoteToken(t) { return /^[A-Za-z0-9_./:\\-]+$/.test(t) ? t : JSON.stringify(t); }
function roleOf(rel) {
  const n = basename(rel).toLowerCase();
  const ext = (/\.([a-z0-9]+)$/.exec(n)?.[1] ?? '');
  if (n === 'stdout.log' || n === 'stderr.log') return 'stdout';
  if (['log', 'txt', 'out', 'err'].includes(ext)) return 'log';
  if (['json', 'yaml', 'yml', 'csv'].includes(ext)) return 'result';
  if (['png', 'jpg', 'jpeg', 'svg', 'pdf'].includes(ext)) return 'figure';
  if (['pth', 'pt', 'ckpt', 'npz', 'bin'].includes(ext)) return 'checkpoint';
  return 'raw';
}

function buildService(ctx) {
  const led = () => ctx.get('research.expLedger');
  const eg = () => ctx.get('research.engineGit');

  async function readTemplatesDoc(root) {
    const p = join(root, TEMPLATES_YAML);
    if (!(await pathExists(p))) return { schemaVersion: SCHEMA_VERSION, templates: {} };
    try {
      const d = yaml.load(await readFile(p, 'utf8'));
      return d && typeof d === 'object' ? d : { schemaVersion: SCHEMA_VERSION, templates: {} };
    } catch (e) { throw new Error(`${TEMPLATES_YAML} 解析失败（${e.message}）`); }
  }
  async function readScriptMeta(root, name) {
    const p = join(root, 'scripts', `${name}.meta.json`);
    if (!(await pathExists(p))) return null;
    try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
  }
  async function resolveScript(root, meta) {
    if (!meta) return null;
    const rel = posix(meta.mode === 'adopt' ? meta.source : join('scripts', `${meta.name}.py`));
    const abs = join(root, rel);
    if (!(await pathExists(abs))) return null;
    const sha = eg().sha256File(abs);
    return { rel, abs, sha256: sha, meta };
  }
  function validateParams(schema, params) {
    if (!Ajv2020) return [];
    try {
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      const v = ajv.compile(schema ?? { type: 'object' });
      if (v(params)) return [];
      return (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
    } catch (e) { return [`参数契约无法编译：${e.message}`]; }
  }
  function renderCommand(root, runId, tpl, params, scriptRel) {
    const allow = Array.isArray(tpl?.allow) ? tpl.allow.map(String) : [];
    const tokens = [];
    if (scriptRel) { tokens.push(interpFor(scriptRel, allow)); tokens.push(scriptRel); }
    else tokens.push(allow[0]);
    const raw = posix(join('experiments', runId, 'raw'));
    const sub = (s) => String(s).replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_m, k) => {
      if (k === '__raw__') return raw;
      if (k === '__runId__') return runId;
      if (k === '__project__') return root;
      return k in params ? String(params[k]) : '';
    });
    const argsTpl = typeof tpl?.args === 'string' ? tpl.args.trim() : '';
    if (argsTpl) for (const part of sub(argsTpl).split(/\s+/).filter(Boolean)) tokens.push(part);
    return tokens.map(quoteToken).join(' ');
  }

  return {
    readTemplatesDoc, readScriptMeta, resolveScript, validateParams, renderCommand, roleOf,

    /** 生成/刷新 manifest：把 raw/ 下所有产出登记（含指纹）。 */
    async refreshManifest(root, runId, { producer = 'process' } = {}) {
      const dir = join(root, 'experiments', runId);
      await ensureDir(dir);
      const manPath = join(dir, 'manifest.json');
      let man = { schemaVersion: SCHEMA_VERSION, runId, entries: [], complete: true };
      if (await pathExists(manPath)) {
        try { man = JSON.parse(await readFile(manPath, 'utf8')); } catch { /* 重建 */ }
      }
      const known = new Map((man.entries ?? []).map((e) => [posix(e.path), e]));
      const files = [];
      for (const f of eg().listFiles(root, `experiments/${runId}/raw`)) files.push(f);
      for (const f of [`experiments/${runId}/config.json`]) if (await pathExists(join(root, f))) files.push(f);
      const entries = [];
      let missing = 0;
      for (const f of files) {
        const rel = posix(f);
        const abs = join(root, rel);
        const sha = eg().sha256File(abs);
        if (sha === null) { missing += 1; continue; }
        const st = eg().sizeMtime(abs);
        const prev = known.get(rel);
        entries.push({
          path: rel,
          role: rel.endsWith('config.json') ? 'config' : roleOf(rel),
          sha256: sha,
          bytes: st?.bytes ?? 0,
          producer: prev?.producer ?? producer,
          ts: prev?.ts ?? iso(),
          stored: man.entries?.[0]?.stored === 'hash-only' ? 'hash-only' : 'versioned',
        });
      }
      for (const [p, e] of known) if (!files.some((f) => posix(f) === p)) entries.push(e);
      man.entries = entries;
      man.complete = missing === 0;
      man.updatedAt = iso();
      await atomicWrite(manPath, JSON.stringify(man, null, 2) + '\n');
      return man;
    },
  };
}

function genericCall(title, kind, paths) {
  return { card: 'generic', title, kind, ...(paths && paths.length ? { locations: paths.map((p) => ({ path: p })) } : {}) };
}
function registerTextTool(ctx, tool) {
  ctx.tools.register({
    name: tool.name,
    description: tool.description,
    parameters: { type: 'object', properties: tool.properties || {}, ...(tool.required?.length ? { required: tool.required } : {}) },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    ...(tool.presentCall ? { presentCall: tool.presentCall } : {}),
    execute: async (args, exec) => {
      const r = await tool.execute(args, exec);
      return { text: scrub(typeof r?.text === 'string' ? r.text : String(r?.text ?? '')) };
    },
  });
}

function apply(ctx) {
  const svc = buildService(ctx);
  ctx.provide('research.taskDispatch', svc);

  // ---------- script_declare ----------
  registerTextTool(ctx, {
    name: 'script_declare',
    description: '声明辅助脚本：mode=create 写入 scripts/<name>.py + 元数据；mode=adopt 只登记工程内既有脚本（不改文件、只写元数据）。两者都要求 allowlist 非空。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      name: { type: 'string', description: '脚本名（kebab-case，不含扩展名）。' },
      mode: { type: 'string', enum: ['create', 'adopt'], description: '缺省 create。' },
      purpose: { type: 'string', description: '用途说明（必填）。' },
      entrypoint: { type: 'string', description: '入口形式（如 `python scripts/x.py --seed 0`）。' },
      allowlist: { type: 'array', items: { type: 'string' }, description: '允许的命令前缀白名单（必填、非空）。' },
      source: { type: 'string', description: 'mode=adopt：工程内既有脚本的相对路径。' },
      content: { type: 'string', description: 'mode=create：脚本正文。' },
      owner: { type: 'string', description: '脚本属主（人/角色）。' },
      overwrite: { type: 'boolean', description: '允许覆盖同名脚本。' },
    },
    required: ['name', 'purpose', 'allowlist'],
    execute: async (args, exec) => {
      const led = ctx.get('research.expLedger');
      const eg = () => ctx.get('research.engineGit');
      const root = led.root(args, exec);
      try { await led.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const name = led.slugify(args?.name ?? '');
      if (!name) return { text: '拒绝：脚本名非法。\n修法：用 kebab-case（小写字母、数字、连字符）。' };
      const mode = args?.mode === 'adopt' ? 'adopt' : 'create';
      const purpose = typeof args?.purpose === 'string' ? args.purpose.trim() : '';
      if (!purpose) return { text: '拒绝：缺少 purpose。' };
      const allowlist = Array.isArray(args?.allowlist) ? args.allowlist.map(String).filter(Boolean) : [];
      if (!allowlist.length) return { text: '拒绝：allowlist 为空。\n修法：至少给出一个允许的命令前缀（如 python）。' };
      const guard = led.guard(root, ['scripts/**']);
      if (!guard.ok) return { text: guard.text };
      const metaPath = join(root, 'scripts', `${name}.meta.json`);
      const existed = await pathExists(metaPath);
      if (existed && args?.overwrite !== true) {
        return { text: `拒绝：脚本 ${name} 已声明。\n修法：加 overwrite=true 覆盖，或换名。` };
      }
      let sourceRel = null; let sha = null;
      if (mode === 'create') {
        const content = typeof args?.content === 'string' ? args.content : '';
        if (!content.trim()) return { text: '拒绝：mode=create 必须提供 content（脚本正文）。\n修法：把正文写进 content；要收编磁盘上已有的脚本，用 mode=adopt。' };
        sourceRel = posix(join('scripts', `${name}.py`));
        await atomicWrite(join(root, sourceRel), content.endsWith('\n') ? content : `${content}\n`);
        sha = eg().sha256File(join(root, sourceRel));
      } else {
        const src = typeof args?.source === 'string' ? posix(args.source.trim()) : '';
        if (!src) return { text: '拒绝：mode=adopt 必须提供 source（工程内既有脚本路径）。' };
        if (/^[A-Za-z]:/.test(src) || src.startsWith('/') || src.split('/').includes('..')) {
          return { text: `拒绝：source 越出工程范围：${src}。\n修法：只收编工程内的脚本。` };
        }
        const abs = join(root, src);
        if (!(await pathExists(abs))) return { text: `拒绝：工程内没有这个脚本：${src}。` };
        sourceRel = src; sha = eg().sha256File(abs);
      }
      const meta = {
        schemaVersion: SCHEMA_VERSION, name, mode, purpose,
        entrypoint: typeof args?.entrypoint === 'string' ? args.entrypoint : '',
        allowlist, owner: typeof args?.owner === 'string' && args.owner.trim() ? args.owner.trim() : 'user',
        ...(mode === 'adopt' ? { source: sourceRel } : {}),
        sha256: sha, version: existed ? (JSON.parse(await readFile(metaPath, 'utf8')).version ?? 1) + 1 : 1,
        createdAt: iso(),
      };
      await atomicWrite(metaPath, JSON.stringify(meta, null, 2) + '\n');
      const paths = [posix(join('scripts', `${name}.meta.json`)), ...(mode === 'create' ? [sourceRel] : [])];
      const stored = eg().record(root, paths, `script_declare: ${name} (${mode})`);
      const rec = await led.ledgerAppend(root, { record: 'note', name: `script-${name}`, kind: 'script', status: 'active', authority: 'user', mode, source: sourceRel }, { commit: stored.commit ?? undefined });
      return {
        text: [
          `脚本已声明：${name}（${mode === 'create' ? '新建' : '收编既有文件'}）`,
          `路径：${sourceRel}　指纹：${sha}　版本：${meta.version}`,
          `用途：${purpose}`,
          `命令白名单：${allowlist.join('、')}`,
          `台账第 ${rec.seq} 行。下一步：template_declare 引用它。`,
        ].join('\n'),
      };
    },
    presentCall: (args) => genericCall(`声明脚本 ${args?.name ?? ''}`.trim(), 'edit', [`scripts/${args?.name ?? ''}.meta.json`]),
  });

  // ---------- template_declare ----------
  registerTextTool(ctx, {
    name: 'template_declare',
    description: '声明可执行模板：命令白名单 allow、参数契约 paramsSchema、脚本引用 scriptRef、可提取字段 observables。缺 allow 或 observables 未显式给出即拒绝。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      id: { type: 'string', description: '模板 id（kebab-case）。' },
      description: { type: 'string', description: '模板说明。' },
      allow: { type: 'array', items: { type: 'string' }, description: '命令前缀白名单（非空）。' },
      scriptRef: { type: 'string', description: '已声明脚本的名字。' },
      args: { type: 'string', description: '参数模板，支持 {{key}} 与 {{__raw__}}/{{__runId__}}/{{__project__}}。' },
      paramsSchema: { type: 'object', description: '参数 JSON Schema（object 根）。' },
      observables: {
        type: 'array',
        description: '可提取字段声明（可空数组，但必须显式给出）。',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string' },
            role: { type: 'string', description: '从 manifest 中哪个角色的产出里提取（log/stdout/result/figure/raw…）。' },
            pattern: { type: 'string', description: '正则，第 1 个捕获组 = 数值。' },
            unit: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
      overwrite: { type: 'boolean', description: '覆盖同名模板（版本递增）。' },
    },
    required: ['id', 'allow', 'scriptRef', 'observables'],
    execute: async (args, exec) => {
      const led = ctx.get('research.expLedger');
      const eg = () => ctx.get('research.engineGit');
      const root = led.root(args, exec);
      try { await led.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const id = led.slugify(args?.id ?? '');
      if (!id) return { text: '拒绝：模板 id 非法。' };
      const allow = Array.isArray(args?.allow) ? args.allow.map(String).filter(Boolean) : [];
      if (!allow.length) return { text: '拒绝：allow 为空。\n修法：至少给出一个允许的命令前缀（如 python）。' };
      const refName = led.slugify(args?.scriptRef ?? '');
      const meta = await svc.readScriptMeta(root, refName);
      if (!meta) return { text: `拒绝：脚本 ${refName} 尚未声明。\n修法：先 script_declare（create 新建 / adopt 收编既有文件）。` };
      const resolved = await svc.resolveScript(root, meta);
      if (!resolved) return { text: `拒绝：脚本 ${refName} 的文件不存在（${meta.mode === 'adopt' ? meta.source : `scripts/${refName}.py`}）。` };
      if (!Array.isArray(args?.observables)) {
        return { text: '拒绝：observables 必须显式给出（可为空数组）。\n修法：列出本模板允许提取的字段；没有就写 []。这一条防「事后挑数字」。' };
      }
      const observables = [];
      const seen = new Set();
      for (const o of args.observables) {
        const field = typeof o?.field === 'string' ? o.field.trim() : '';
        const role = typeof o?.role === 'string' ? o.role.trim() : '';
        const pattern = typeof o?.pattern === 'string' ? o.pattern : '';
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) return { text: `拒绝：可提取字段名非法：${JSON.stringify(field)}。` };
        if (seen.has(field)) return { text: `拒绝：可提取字段重复：${field}。` };
        seen.add(field);
        if (!role) return { text: `拒绝：字段 ${field} 缺少 role。` };
        try { new RegExp(pattern); } catch (e) { return { text: `拒绝：字段 ${field} 的正则无法编译（${e.message}）。` }; }
        observables.push({ field, role, pattern, ...(o?.unit ? { unit: String(o.unit) } : {}), ...(o?.description ? { description: String(o.description) } : {}) });
      }
      const guard = led.guard(root, [TEMPLATES_YAML]);
      if (!guard.ok) return { text: guard.text };
      const doc = await svc.readTemplatesDoc(root);
      const tpls = doc.templates && typeof doc.templates === 'object' ? doc.templates : {};
      const existed = Object.hasOwn(tpls, id);
      if (existed && args?.overwrite !== true) {
        return { text: `拒绝：模板 ${id} 已存在（v${tpls[id].version}）。\n修法：加 overwrite=true 覆盖（版本会递增），或换 id。` };
      }
      const paramsSchema = (args?.paramsSchema && typeof args.paramsSchema === 'object' && !Array.isArray(args.paramsSchema))
        ? args.paramsSchema : { type: 'object', properties: {} };
      const argsTpl = typeof args?.args === 'string' ? args.args.trim() : '';
      const tpl = {
        version: existed ? (tpls[id].version ?? 1) + 1 : 1,
        status: 'active',
        description: typeof args?.description === 'string' ? args.description : '',
        allow,
        scriptRef: { name: refName, mode: meta.mode, path: resolved.rel, sha256: resolved.sha256, version: meta.version },
        ...(argsTpl ? { args: argsTpl } : {}),
        paramsSchema,
        observables,
        updatedAt: iso(),
      };
      tpls[id] = tpl;
      doc.schemaVersion = SCHEMA_VERSION;
      doc.templates = tpls;
      await led.writeYamlFile(join(root, TEMPLATES_YAML), doc);
      const stored = eg().record(root, [TEMPLATES_YAML], `template_declare: ${id} v${tpl.version}`);
      const rec = await led.ledgerAppend(root, { record: 'note', name: `template-${id}`, kind: 'template', status: 'active', authority: 'user', version: tpl.version }, { commit: stored.commit ?? undefined });
      return {
        text: [
          `模板已声明：${id}@v${tpl.version}`,
          `脚本：${refName}（${resolved.rel}）　命令白名单：${allow.join('、')}`,
          `可提取字段：${observables.length ? observables.map((o) => `${o.field}[${o.role}]`).join('、') : '（无）'}`,
          `参数契约：${(paramsSchema.required ?? []).length ? `必填 ${(paramsSchema.required ?? []).join('、')}` : '无必填项'}`,
          `台账第 ${rec.seq} 行。下一步：run_draft。`,
        ].join('\n'),
      };
    },
    presentCall: (args) => genericCall(`声明模板 ${args?.id ?? ''}`.trim(), 'edit', [TEMPLATES_YAML]),
  });

  // ---------- run_draft ----------
  registerTextTool(ctx, {
    name: 'run_draft',
    description: '冻结一次运行实例：校验参数与占位符 → 写 experiments/<runId>/config.json（模板版本/参数/完整命令/脚本指纹/阶段/图版本）→ 写证据清单初稿 → 台账 status=draft。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      template: { type: 'string', description: '模板 id。' },
      params: { type: 'object', description: '模板参数。' },
      stage: { type: 'string', description: '所属阶段；缺省 = 当前阶段。' },
      kind: { type: 'string', description: '运行类别（train/eval/smoke…），缺省 run。' },
      from: { type: 'string', description: '复现某个已有 run 的参数（runId）。' },
    },
    required: ['template'],
    execute: async (args, exec) => {
      const led = ctx.get('research.expLedger');
      const eg = () => ctx.get('research.engineGit');
      const root = led.root(args, exec);
      try { await led.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const tplId = led.slugify(args?.template ?? '');
      if (!tplId) return { text: '拒绝：缺少 template。' };
      const guard = led.guardAll(root);
      if (!guard.ok) return { text: `拒绝：工程有未修复的受管改动，不能新建实例。\n${guard.text}` };
      let doc;
      try { doc = await svc.readTemplatesDoc(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const tpl = doc.templates?.[tplId];
      if (!tpl) return { text: `拒绝：模板不存在：${tplId}。\n修法：project_load 看已有模板，或 template_declare 声明。` };
      if ((tpl.status ?? 'active') !== 'active') return { text: `拒绝：模板 ${tplId} 已停用。` };
      const meta = await svc.readScriptMeta(root, tpl.scriptRef?.name ?? '');
      const resolved = await svc.resolveScript(root, meta);
      if (!resolved) return { text: `拒绝：模板 ${tplId} 引用的脚本不可用（${tpl.scriptRef?.name}）。` };
      if (tpl.scriptRef?.sha256 && resolved.sha256 !== tpl.scriptRef.sha256) {
        return { text: `拒绝：脚本内容已变化（${resolved.rel}）。\n修法：script_declare overwrite=true 重新声明，再 template_declare overwrite=true 更新引用。` };
      }
      let params = (args?.params && typeof args.params === 'object' && !Array.isArray(args.params)) ? args.params : {};
      if (typeof args?.from === 'string' && args.from.trim()) {
        const fold = await led.ledgerFold(root);
        const src = fold.runs.get(args.from.trim());
        if (!src) return { text: `拒绝：找不到要复现的 run：${args.from}。` };
        params = { ...(src.params ?? {}), ...params };
      }
      const errs = svc.validateParams(tpl.paramsSchema, params);
      if (errs.length) return { text: `拒绝：参数不符合模板契约：\n${errs.map((e) => `  - ${e}`).join('\n')}\n修法：补齐/改正 params。` };
      const needed = placeholdersIn(tpl.args).filter((k) => !RESERVED.includes(k));
      const missing = needed.filter((k) => !(k in params));
      if (missing.length) {
        return { text: `拒绝：模板 ${tplId} 的参数模板需要 ${missing.join('、')}，但 params 里没有。\n修法：补齐这些键——缺参会把占位符展开为空、命令行残缺。` };
      }
      const state = await led.state(root);
      const stage = (typeof args?.stage === 'string' && args.stage.trim()) ? args.stage.trim() : (state.stage ?? null);
      const pipeline = await led.readPipeline(root);
      if (stage && pipeline && !(pipeline.stages ?? []).some((s) => s.id === stage)) {
        return { text: `拒绝：阶段 ${stage} 未声明。\n修法：stage_declare 声明它，或换一个已声明的阶段。` };
      }
      const kind = typeof args?.kind === 'string' && args.kind.trim() ? args.kind.trim() : 'run';
      const projectId = (await led.readProject(root)).project?.id ?? basename(root);
      const runId = `${projectId}-${tplId}-${tsCompact(iso())}-${rand3()}`;
      const command = svc.renderCommand(root, runId, tpl, params, resolved.rel);
      const config = {
        schemaVersion: SCHEMA_VERSION,
        runId, projectId,
        template: tplId, templateVersion: tpl.version,
        params, paramsHash: sha256(JSON.stringify(params)),
        stage, kind,
        graphVersion: pipeline?.graphVersion ?? null,
        command,
        scriptRef: { name: tpl.scriptRef?.name, mode: meta?.mode ?? 'create', path: resolved.rel, sha256: resolved.sha256 },
        interpreter: interpFor(resolved.rel, tpl.allow),
        workdir: root,
        envExpectation: { seed: params?.seed ?? null, device: params?.device ?? null, probed: false },
        ts: iso(),
      };
      await ensureDir(join(root, 'experiments', runId, 'raw'));
      await atomicWrite(join(root, 'experiments', runId, 'config.json'), JSON.stringify(config, null, 2) + '\n');
      await svc.refreshManifest(root, runId, { producer: 'run_draft' });
      const stored = eg().record(root, [`experiments/${runId}/config.json`, `experiments/${runId}/manifest.json`], `run_draft: ${runId}`);
      const rec = await led.ledgerAppend(root, {
        record: 'run', runId, template: tplId, templateVersion: tpl.version,
        stage, kind, status: 'draft', params, paramsHash: config.paramsHash,
        graphVersion: pipeline?.graphVersion ?? null,
      }, { commit: stored.commit ?? undefined });
      return {
        text: [
          `实例已冻结：runId=${runId}`,
          `模板：${tplId}@v${tpl.version}　阶段：${stage ?? '(未进入阶段)'}　类别：${kind}`,
          `命令：${command}`,
          `参数：${JSON.stringify(params)}`,
          `台账第 ${rec.seq} 行（status=draft）。下一步：run_launch runId=${runId}。`,
        ].join('\n'),
      };
    },
    presentCall: (args) => genericCall(`冻结实例 ${args?.template ?? ''}`.trim(), 'edit', ['experiments/']),
  });

  // ---------- run_launch ----------
  registerTextTool(ctx, {
    name: 'run_launch',
    description: '安全闸 + 后台派发：以冻结的 config 为权威 → 校验命令前缀与脚本位置 → 起后台任务（不阻塞本轮）→ 结束时登记 raw/ 产出并归档 → 台账 done/failed。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      runId: { type: 'string', description: '已冻结的 runId。' },
    },
    required: ['runId'],
    execute: async (args, exec) => {
      const led = ctx.get('research.expLedger');
      const eg = () => ctx.get('research.engineGit');
      const root = led.root(args, exec);
      try { await led.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const runId = typeof args?.runId === 'string' ? args.runId.trim() : '';
      if (!runId) return { text: '拒绝：缺少 runId。' };
      const guard = led.guardAll(root);
      if (!guard.ok) return { text: `拒绝：工程有未修复的受管改动，不能启动。\n${guard.text}` };
      const fold = await led.ledgerFold(root);
      const rec = fold.runs.get(runId);
      if (!rec) return { text: `拒绝：台账里没有 runId=${runId}。\n修法：先 run_draft。` };
      if (rec.status !== 'draft') return { text: `拒绝：run ${runId} 当前状态是 ${rec.status}，只有 draft 可以启动。` };
      const cfgPath = join(root, 'experiments', runId, 'config.json');
      let config;
      try { config = JSON.parse(await readFile(cfgPath, 'utf8')); } catch { return { text: `拒绝：读不到冻结的实例定义（experiments/${runId}/config.json）。` }; }
      let doc;
      try { doc = await svc.readTemplatesDoc(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const tpl = doc.templates?.[config.template];
      if (!tpl) return { text: `拒绝：模板 ${config.template} 已不存在 → 该 run 不能启动。\n修法：重新声明模板后 run_draft 新实例。` };
      const allow = Array.isArray(tpl.allow) ? tpl.allow.map(String) : [];
      if (!allow.length) return { text: `拒绝（安全闸）：模板 ${config.template} 没有命令白名单。` };
      const command = String(config.command ?? '');
      const firstTok = command.split(/\s+/)[0] ?? '';
      const allowHit = allow.some((a) => firstTok === a || firstTok.startsWith(`${a}=`));
      const scriptPath = config.scriptRef?.path ?? '';
      const scriptAbs = scriptPath ? resolve(root, scriptPath) : null;
      const inside = scriptAbs === null || isWithin(root, scriptAbs);
      if (!allowHit || !inside) {
        const why = !allowHit
          ? `命令前缀 ${JSON.stringify(firstTok)} 不在白名单 ${JSON.stringify(allow)} 内`
          : `脚本位置越出工程：${scriptPath}`;
        const kb = ctx.get('research.kbCore');
        if (kb && typeof kb.recordLesson === 'function') {
          try { await kb.recordLesson({ root, name: `lesson-blocked-${runId}`, description: `安全闸拦截：${why}`, statement: `安全闸拦截：${why}。run 保持 draft，未启动任何进程。` }, exec); } catch { /* 教训写失败不阻断拒绝 */ }
        }
        return { text: `拒绝（安全闸）：${why}。\nrun ${runId} 保持 draft，未启动任何进程；已记入教训库。\n修法：修正模板白名单或脚本位置，重新 run_draft。` };
      }
      const jobs = ctx.get('jobs');
      const shellSvc = ctx.get('shell');
      if (jobs === undefined) return { text: '拒绝：后台任务能力不可用，无法启动。' };
      if (shellSvc === undefined) return { text: '拒绝：命令执行器不可用，无法启动。' };
      const shellEnvSvc = ctx.get('shellEnv');
      const confining = shellSvc.sandboxMode !== undefined;
      const policySvc = confining ? ctx.get('sandboxPolicy') : undefined;
      if (confining && policySvc === undefined) return { text: '拒绝：沙箱执行器已挂载但策略服务缺失（组合不完整）。' };
      const sandboxPolicy = policySvc ? policySvc.resolve(exec.agent ? { session: exec.agent.session } : {}) : undefined;
      // Windows 宿主用 PowerShell 5.1 跑命令，它会把任何非零退出码归一为 1。
      // 显式回传真实退出码，否则失败 run 的 detail 会失真（现场验收 D4 观察到 3 被记成 1）。
      const execCommand = process.platform === 'win32' ? `${command}; exit $LASTEXITCODE` : command;
      const request = {
        command: execCommand,
        workdir: root,
        ...(shellEnvSvc ? { dshEnv: shellEnvSvc.collect(exec) } : {}),
        ...(sandboxPolicy !== undefined ? { sandboxPolicy } : {}),
      };
      await led.ledgerAppend(root, { record: 'run', runId, status: 'queued', template: config.template, stage: config.stage, kind: config.kind, paramsHash: config.paramsHash, graphVersion: config.graphVersion });
      const label = command.length > 120 ? `${command.slice(0, 120)}…` : command;
      const captured = [];
      let jobId = null;
      try {
        jobId = jobs.start({
          kind: 'research.run',
          label,
          ...(exec.agent ? { owner: exec.agent } : {}),
          run: () => {
            const proc = shellSvc.start(shellSvc.resolve(request));
            const settle = async () => {
              let code = null; let sb = null;
              try { code = proc.exitCode ?? null; } catch { /* ignore */ }
              try { sb = proc.sandbox ?? null; } catch { /* ignore */ }
              const runnerFailed = sb?.runnerFailed === true;
              // 进程输出落盘为证据（stdout.log）：先把尚未被读走的部分读干净，
              // 否则证据是否落盘取决于模型有没有先 job_output（时序不确定）。
              try {
                const rest = proc.readOutput();
                if (typeof rest?.delta === 'string' && rest.delta) captured.push(rest.delta);
              } catch { /* ignore */ }
              try {
                if (captured.length) {
                  await atomicWrite(join(root, 'experiments', runId, 'raw', 'stdout.log'), captured.join(''));
                }
              } catch { /* ignore */ }
              const man = await svc.refreshManifest(root, runId, { producer: 'process' });
              const paths = [`experiments/${runId}/manifest.json`, ...man.entries.map((e) => e.path).filter((p) => p.includes('/raw/'))];
              const stored = eg().record(root, paths, `run_launch settle: ${runId}`);
              const okRun = !runnerFailed && (code === null || code === 0);
              const detail = runnerFailed
                ? `沙箱运行器失败（mode=${sb?.mode ?? '?'}，命令未运行）`
                : (code === null ? '已结束' : `退出码 ${code}`);
              await led.ledgerAppend(root, {
                record: 'run', runId, status: okRun ? 'done' : 'failed', detail,
                jobId, outputs: man.entries.length, complete: man.complete,
              }, { commit: stored.commit ?? undefined });
              return { status: okRun ? 'completed' : 'failed', detail };
            };
            return {
              cancel: () => { try { proc.kill(); } catch { /* ignore */ } },
              done: proc.done.then(settle, settle),
              readOutput: () => {
                try {
                  const read = proc.readOutput();
                  const delta = typeof read?.delta === 'string' ? read.delta : '';
                  if (delta) captured.push(delta);
                  const notices = [];
                  if (read?.lossy) notices.push('[部分输出已丢弃]');
                  const sb = proc.sandbox;
                  if (sb?.runnerFailed) notices.push(`[沙箱运行器自身失败（mode=${sb?.mode ?? '?'}）——命令未运行]`);
                  else if (sb?.denied) notices.push(`[沙箱拒绝（mode=${sb?.mode ?? '?'}）]`);
                  if (!notices.length) return delta;
                  return delta + (delta.length > 0 && !delta.endsWith('\n') ? '\n' : '') + notices.join('\n');
                } catch { return ''; }
              },
            };
          },
        });
      } catch (err) {
        await led.ledgerAppend(root, { record: 'run', runId, status: 'failed', detail: `启动失败：${String(err?.message ?? err).slice(0, 200)}` });
        return { text: `拒绝：启动失败 —— ${String(err?.message ?? err).slice(0, 200)}\nrun ${runId} 已标 failed，冻结的实例定义仍保留。` };
      }
      await led.ledgerAppend(root, { record: 'run', runId, status: 'running', jobId, template: config.template, stage: config.stage, kind: config.kind, paramsHash: config.paramsHash, graphVersion: config.graphVersion });
      return {
        text: [
          `已在后台启动：${runId}`,
          `任务标识：${jobId}　模板：${config.template}@v${config.templateVersion}　阶段：${config.stage ?? '(未进入阶段)'}`,
          `命令：${command}`,
          `执行环境：沙箱模式=${shellSvc.sandboxMode ?? '(无沙箱)'}｜环境变量=${shellEnvSvc ? '已注入' : '缺失'}｜策略=${sandboxPolicy !== undefined ? '已解析' : '未提供'}`,
          '说明：不阻塞本轮；结束后自动登记产出并把状态置 done/failed。',
          `运行中读日志：job_output(job_id="${jobId}")；取消：job_kill(job_id="${jobId}")。`,
          `完整输出（含 stderr）在结束后会被收进证据：experiments/${runId}/raw/stdout.log；任务结束后优先读它（job_output 可能已被引擎收空）。`,
        ].join('\n'),
      };
    },
    presentCall: (args) => genericCall(`启动后台任务 ${args?.runId ?? ''}`.trim(), 'execute', [REGISTRY]),
  });

  // ---------- run_observe ----------
  registerTextTool(ctx, {
    name: 'run_observe',
    description: '从已登记的产出文件里提取数值，形成证据权威：字段必须由模板声明、来源文件必须已登记且指纹一致。可对比另一 run。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      runId: { type: 'string', description: '目标 run。' },
      fields: { type: 'array', items: { type: 'string' }, description: '要提取的字段；缺省 = 模板全部可提取字段。' },
      compareTo: { type: 'string', description: '与之对比的 runId。' },
      tolerancePct: { type: 'number', description: '对比容差（百分比，缺省 0）。' },
    },
    required: ['runId'],
    execute: async (args, exec) => {
      const led = ctx.get('research.expLedger');
      const eg = () => ctx.get('research.engineGit');
      const root = led.root(args, exec);
      try { await led.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const runId = typeof args?.runId === 'string' ? args.runId.trim() : '';
      if (!runId) return { text: '拒绝：缺少 runId。' };
      const fold = await led.ledgerFold(root);
      const rec = fold.runs.get(runId);
      if (!rec) return { text: `拒绝：台账里没有 runId=${runId}。` };
      if (!['done', 'failed'].includes(rec.status)) {
        return { text: `拒绝：run ${runId} 状态是 ${rec.status}，还没结束，不能提取。\n修法：等任务结束（job_output 看日志）后再提取。` };
      }
      const cfgPath = join(root, 'experiments', runId, 'config.json');
      let config = null;
      try { config = JSON.parse(await readFile(cfgPath, 'utf8')); } catch { /* 允许缺 config */ }
      const doc = await svc.readTemplatesDoc(root);
      const tpl = doc.templates?.[config?.template ?? rec.template];
      if (!tpl) return { text: `拒绝：找不到 run 对应的模板声明（${config?.template ?? rec.template}）。` };
      const obsDecl = Array.isArray(tpl.observables) ? tpl.observables : [];
      const want = Array.isArray(args?.fields) && args.fields.length ? args.fields.map(String) : obsDecl.map((o) => o.field);
      const undeclared = want.filter((f) => !obsDecl.some((o) => o.field === f));
      if (undeclared.length) {
        return { text: `拒绝：这些字段没有在模板里声明过：${undeclared.join('、')}。\n模板声明：${obsDecl.map((o) => o.field).join('、') || '（无）'}\n修法：先用 template_declare 声明可提取字段（防事后挑数字）。` };
      }
      const manPath = join(root, 'experiments', runId, 'manifest.json');
      let man = null;
      try { man = JSON.parse(await readFile(manPath, 'utf8')); } catch { man = null; }
      if (!man) return { text: `拒绝：run ${runId} 缺少证据清单（manifest.json）。\n修法：证据不完整的 run 不能据此下结论。` };
      const guard = led.guard(root, [`experiments/${runId}/manifest.json`, `experiments/${runId}/observations.json`]);
      if (!guard.ok) return { text: guard.text };
      const results = []; const problems = [];
      for (const f of want) {
        const decl = obsDecl.find((o) => o.field === f);
        const candidates = (man.entries ?? []).filter((e) => e.role === decl.role);
        if (!candidates.length) { problems.push(`字段 ${f}：清单里没有角色为 ${decl.role} 的产出文件`); continue; }
        let hit = null;
        for (const cand of candidates) {
          const abs = join(root, cand.path);
          const now = eg().sha256File(abs);
          if (now === null) { problems.push(`字段 ${f}：产出文件缺失 ${cand.path}`); continue; }
          if (now !== cand.sha256) { problems.push(`字段 ${f}：产出文件已被改动 ${cand.path}`); continue; }
          let text = '';
          try { text = await readFile(abs, 'utf8'); } catch { continue; }
          const re = new RegExp(decl.pattern);
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i += 1) {
            const m = re.exec(lines[i]);
            if (!m) continue;
            const rawVal = m[1] ?? m[0];
            const num = Number(String(rawVal).replace(/[^0-9eE+\-.]/g, ''));
            hit = {
              field: f,
              value: Number.isFinite(num) && /[0-9]/.test(String(rawVal)) ? num : String(rawVal).trim(),
              ...(decl.unit ? { unit: decl.unit } : {}),
              file: posix(cand.path), line: i + 1, sha256: cand.sha256, extractedAt: iso(),
            };
            break;
          }
          if (hit) break;
        }
        if (hit) results.push(hit);
        else problems.push(`字段 ${f}：按声明的规则在角色 ${decl.role} 的产出里没有匹配到`);
      }
      if (!results.length) {
        return { text: `拒绝：没有提取到任何字段。\n${problems.map((p) => `  - ${p}`).join('\n')}\n修法：确认产出文件已由 run_launch 登记且未被外部改动；若文件被改，用 project_reconcile mode=restore 取回，再重新提取。` };
      }
      // 对比
      if (typeof args?.compareTo === 'string' && args.compareTo.trim()) {
        const other = args.compareTo.trim();
        const otherPath = join(root, 'experiments', other, 'observations.json');
        let otherObs = null;
        try { otherObs = JSON.parse(await readFile(otherPath, 'utf8')); } catch { otherObs = null; }
        const tol = Number.isFinite(Number(args?.tolerancePct)) ? Number(args.tolerancePct) : 0;
        for (const o of results) {
          const ref = (otherObs?.observations ?? []).find((x) => x.field === o.field);
          if (!ref) { o.compareTo = { runId: other, verdict: 'missing', otherValue: null, delta: null, deltaPct: null, tolerancePct: tol }; continue; }
          const a = Number(o.value); const b = Number(ref.value);
          if (!Number.isFinite(a) || !Number.isFinite(b)) {
            o.compareTo = { runId: other, verdict: a === b ? 'match' : 'mismatch', otherValue: ref.value, delta: null, deltaPct: null, tolerancePct: tol };
            continue;
          }
          const delta = a - b;
          const pct = b === 0 ? null : Math.abs(delta / b) * 100;
          o.compareTo = { runId: other, verdict: (pct === null ? (delta === 0 ? 'match' : 'mismatch') : (pct <= tol ? 'match' : 'mismatch')), otherValue: ref.value, delta, deltaPct: pct, tolerancePct: tol };
        }
      }
      const obsPath = join(root, 'experiments', runId, 'observations.json');
      let store = { schemaVersion: SCHEMA_VERSION, runId, observations: [] };
      if (await pathExists(obsPath)) {
        try { store = JSON.parse(await readFile(obsPath, 'utf8')); } catch { /* 重建 */ }
      }
      const byField = new Map((store.observations ?? []).map((o) => [o.field, o]));
      for (const o of results) byField.set(o.field, o);
      store.observations = [...byField.values()];
      store.updatedAt = iso();
      await atomicWrite(obsPath, JSON.stringify(store, null, 2) + '\n');
      const stored = eg().record(root, [`experiments/${runId}/observations.json`], `run_observe: ${runId}`);
      const ev = await led.ledgerAppend(root, {
        record: 'observe', runId, fields: results.map((o) => o.field),
        ...(args?.compareTo ? { compareTo: args.compareTo } : {}),
      }, { commit: stored.commit ?? undefined });
      const lines = [
        `已提取 ${results.length} 个字段（来源均为已登记产出）：`,
        ...results.map((o) => `  - ${o.field} = ${o.value}${o.unit ? ` ${o.unit}` : ''}　来源：${o.file}:${o.line}`
          + (o.compareTo ? `　对比 ${o.compareTo.runId}：${o.compareTo.verdict}${o.compareTo.deltaPct !== null && o.compareTo.deltaPct !== undefined ? `（偏差 ${Number(o.compareTo.deltaPct).toFixed(2)}%）` : ''}` : '')),
        ...(problems.length ? ['未能提取：', ...problems.map((p) => `  - ${p}`)] : []),
        `台账第 ${ev.seq} 行。`,
      ];
      return { text: lines.join('\n') };
    },
    presentCall: (args) => genericCall(`提取观察值 ${args?.runId ?? ''}`.trim(), 'edit', [`experiments/${args?.runId ?? ''}/observations.json`]),
  });

  // ---------- run_query ----------
  registerTextTool(ctx, {
    name: 'run_query',
    description: '只读查询运行台账与产出清单（可按 runId/模板/阶段/状态过滤）。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      runId: { type: 'string', description: '按 runId 过滤。' },
      template: { type: 'string', description: '按模板过滤。' },
      stage: { type: 'string', description: '按阶段过滤。' },
      status: { type: 'string', description: '按状态过滤（draft/queued/running/done/failed/invalidated/archived）。' },
      limit: { type: 'number', description: '返回条数上限（默认 50）。' },
    },
    execute: async (args, exec) => {
      const led = ctx.get('research.expLedger');
      const eg = () => ctx.get('research.engineGit');
      const root = led.root(args, exec);
      try { await led.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const fold = await led.ledgerFold(root);
      let list = [...fold.runs.values()];
      if (typeof args?.runId === 'string') list = list.filter((r) => r.runId === args.runId);
      if (typeof args?.template === 'string') list = list.filter((r) => r.template === args.template);
      if (typeof args?.stage === 'string') list = list.filter((r) => r.stage === args.stage);
      if (typeof args?.status === 'string') list = list.filter((r) => r.status === args.status);
      const limit = Number.isFinite(Number(args?.limit)) && Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 50;
      list = list.slice(-limit);
      if (!list.length) return { text: '没有匹配的运行记录。' };
      const lines = [];
      for (const r of list) {
        let outs = 0; let obs = 0;
        const manPath = join(root, 'experiments', r.runId, 'manifest.json');
        if (await pathExists(manPath)) {
          try { outs = (JSON.parse(await readFile(manPath, 'utf8')).entries ?? []).length; } catch { outs = 0; }
        }
        const obsPath = join(root, 'experiments', r.runId, 'observations.json');
        if (await pathExists(obsPath)) {
          try { obs = (JSON.parse(await readFile(obsPath, 'utf8')).observations ?? []).length; } catch { obs = 0; }
        }
        const size = await pathExists(join(root, 'experiments', r.runId)) ? (eg().listFiles(root, `experiments/${r.runId}/raw`).length) : 0;
        lines.push(`- ${r.runId}　${r.template ?? '?'}　阶段 ${r.stage ?? '—'}　${r.status}　参数 ${JSON.stringify(r.params ?? {})}　产出 ${outs}（raw ${size}）　观察 ${obs}${r.detail ? `　${r.detail}` : ''}`);
      }
      return { text: `运行记录 ${list.length} 条：\n${lines.join('\n')}` };
    },
    presentCall: (args) => genericCall('查询运行台账', 'read', [REGISTRY]),
  });

  // ---------- run_close ----------
  registerTextTool(ctx, {
    name: 'run_close',
    description: '把 run 标记为作废（invalidated）或归档（archived）：只改状态、不删除任何产出。归档需要用户裁决。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      runId: { type: 'string', description: '目标 run。' },
      status: { type: 'string', enum: ['invalidated', 'archived'], description: '目标状态。' },
      reason: { type: 'string', description: '原因（必填）。' },
      decision: {
        type: 'object',
        description: 'archived 必填：用户裁决引用。',
        properties: { askCallId: { type: 'string' }, answer: { type: 'string' }, attested: { type: 'boolean' } },
      },
    },
    required: ['runId', 'status', 'reason'],
    execute: async (args, exec) => {
      const led = ctx.get('research.expLedger');
      const root = led.root(args, exec);
      try { await led.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const runId = typeof args?.runId === 'string' ? args.runId.trim() : '';
      const status = args?.status;
      const reason = typeof args?.reason === 'string' ? args.reason.trim() : '';
      if (!runId) return { text: '拒绝：缺少 runId。' };
      if (!['invalidated', 'archived'].includes(status)) return { text: '拒绝：status 只能是 invalidated 或 archived。' };
      if (!reason) return { text: '拒绝：缺少 reason。' };
      const fold = await led.ledgerFold(root);
      const rec = fold.runs.get(runId);
      if (!rec) return { text: `拒绝：台账里没有 runId=${runId}。` };
      if (['invalidated', 'archived'].includes(rec.status)) return { text: `无需处理：run ${runId} 已是 ${rec.status}。` };
      let decision = null;
      if (status === 'archived') {
        const v = led.verifyDecision(exec, args?.decision ?? {});
        if (!v.ok) return { text: `${v.text}\n（归档需要用户裁决。）` };
        decision = v.decision;
      }
      const guard = led.guard(root, [REGISTRY]);
      if (!guard.ok) return { text: guard.text };
      const ev = await led.ledgerAppend(root, {
        record: 'run', runId, status, reason,
        ...(decision ? { decision } : {}),
      }, { actor: decision ? 'user' : 'engine' });
      if (decision) {
        await led.ledgerAppend(root, {
          record: 'decision', kind: 'run-archive', id: runId,
          askCallId: decision.askCallId, question: decision.question, answer: decision.answer,
          sessionId: decision.sessionId, ...(decision.attested ? { attested: true } : {}),
        }, { actor: 'user' });
      }
      return { text: `run ${runId} 已标记为 ${status}。\n原因：${reason}\n产出与观察值一律保留，未删除任何文件。\n台账第 ${ev.seq} 行。` };
    },
    presentCall: (args) => genericCall(`关闭 run（${args?.status ?? '?'}）`, 'edit', [REGISTRY]),
  });
}

export { apply };
