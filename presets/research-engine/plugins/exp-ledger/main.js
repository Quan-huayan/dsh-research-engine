// exp-ledger —— 环境 / 台账 / 校验（8 工具，其中 ledger_append 为内部服务）
//
// 拥有数据：project.yaml（环境：身份/受管区/legacy/约定）、registry.jsonl（状态与事件，append-only）。
// 对外服务 research.expLedger：跨域只走服务，不直接写别人的文件（tools.md §2「跨域只走 id 与属主提供的服务」）。
//
// 模型可见文本铁律：返回/描述/错误一律不出现版本库词汇（见 §6.1-2 的自动扫描），
// 末尾统一过 scrub() 兜底。

import { createRequire } from 'node:module';
import { join, dirname, resolve, relative, sep, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, readdir, stat, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';

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

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const PRESET_ROOT = resolve(PLUGIN_DIR, '..', '..');
const CONTRACT_DIR = join(PRESET_ROOT, 'contract');
const SCHEMA_VERSION = 3;
const REGISTRY = 'registry.jsonl';
const PROJECT_YAML = 'project.yaml';
const STATE_REL = '.research/state.json';
const PIPELINE_YAML = 'pipeline.yaml';
const TEMPLATES_YAML = 'templates.yaml';
const LEGACY_EXTS = new Set(['.pth', '.png', '.txt', '.txt~', '.ipynb', '.zip', '.bin', '.npz', '.pt']);
const SKIP_DIRS = new Set(['.research', '.kb', '.git', 'node_modules', '__pycache__', '.dsh', 'engine.git']);
// 词边界替换：不误伤用户数据里的同形子串（如 usergit-probe / shanghai），但独立出现的版本库词汇一律替换。
const SCRUB = /(^|[^A-Za-z0-9_-])(git|commit|HEAD|diff|hash|sha)(?![A-Za-z0-9_-])/gi;

export const name = 'exp-ledger';
export const inject = ['tools'];

// ---------- 小工具 ----------
function iso() { return new Date().toISOString(); }
function sha256(s) { return createHash('sha256').update(s).digest('hex'); }
function slugify(s) {
  const out = String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || '';
}
function scrub(text) { return String(text ?? '').replace(SCRUB, (_m, pre) => `${pre}·`); }
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
function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
}
function sessionIdOf(exec) {
  const h = exec?.agent?.session?.header;
  return (h && typeof h.id === 'string') ? h.id : '';
}
function posix(p) { return String(p).replace(/\\/g, '/'); }

// ---------- 契约校验 ----------
let ajvCache = null;
async function contractAjv() {
  if (ajvCache) return ajvCache;
  if (!Ajv2020) return null;
  const files = ['project.schema.json', 'pipeline.schema.json', 'templates.schema.json',
    'conventions.schema.json', 'manifest.schema.json', 'observations.schema.json', 'note.schema.json'];
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const f of files) {
    try {
      const doc = JSON.parse(await readFile(join(CONTRACT_DIR, f), 'utf8'));
      ajv.addSchema(doc, doc.$id);
    } catch { /* 缺一份就少一份校验能力，不阻断引擎 */ }
  }
  ajvCache = ajv;
  return ajv;
}
async function validateContract(file, doc) {
  const ajv = await contractAjv();
  if (!ajv) return ['契约校验器不可用（跳过结构校验）'];
  const v = ajv.getSchema(`https://research-engine.local/contract/${file}`);
  if (!v) return [`契约缺失：${file}`];
  if (v(doc)) return [];
  return (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

// ---------- 图校验（stage-ctrl 与 verify 共用）----------
function checkGraph(doc) {
  const fatal = []; const warn = [];
  const stages = Array.isArray(doc?.stages) ? doc.stages : [];
  const edges = Array.isArray(doc?.edges) ? doc.edges : [];
  const ids = new Set();
  for (const s of stages) {
    const id = s?.id;
    if (typeof id !== 'string' || id === '') { fatal.push('存在缺少 id 的阶段'); continue; }
    if (ids.has(id)) fatal.push(`阶段 id 重复：${id}`);
    ids.add(id);
  }
  const seen = new Set();
  for (const e of edges) {
    if (typeof e?.from !== 'string' || typeof e?.to !== 'string') { fatal.push('边必须含 from/to'); continue; }
    const key = `${e.from}->${e.to}`;
    if (seen.has(key)) fatal.push(`边重复：${key}`);
    seen.add(key);
    if (!ids.has(e.from)) fatal.push(`边起点未声明：${e.from}`);
    if (!ids.has(e.to)) fatal.push(`边终点未声明：${e.to}`);
    if (e.from === e.to) fatal.push(`自环：${key}`);
  }
  const entry = doc?.entry;
  if (entry !== undefined && entry !== null && entry !== '') {
    if (!ids.has(entry)) fatal.push(`入口不是已知阶段：${entry}`);
    else if (edges.some((e) => e?.to === entry)) fatal.push(`入口阶段有入边：${entry}`);
  }
  const active = new Set(stages.filter((s) => (s?.status ?? 'active') === 'active').map((s) => s.id));
  if (active.size > 0 && (entry === undefined || entry === null || entry === '')) {
    warn.push('有阶段但未设入口（entry）');
  }
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    adj.get(e.from).add(e.to);
  }
  const reach = new Set();
  const stack = entry ? [entry] : [];
  while (stack.length) {
    const n = stack.pop();
    if (reach.has(n)) continue;
    reach.add(n);
    for (const t of adj.get(n) ?? []) stack.push(t);
  }
  for (const s of stages) if (!reach.has(s.id)) warn.push(`阶段不可达（从入口出发）：${s.id}`);
  return { fatal, warn };
}

// ---------- 工程文件读写 ----------
async function readYamlFile(p) {
  const raw = await readFile(p, 'utf8');
  let doc;
  try { doc = yaml.load(raw); } catch (e) { throw new Error(`${basename(p)} 解析失败（${e.message}）`); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${basename(p)} 顶层必须是映射对象`);
  return doc;
}
async function writeYamlFile(p, doc) {
  await atomicWrite(p, yaml.dump(doc, { lineWidth: -1, noRefs: true, skipInvalid: true }));
}

// ---------- registry.jsonl ----------
async function readRegistryRows(root) {
  const p = join(root, REGISTRY);
  if (!(await pathExists(p))) return [];
  const raw = await readFile(p, 'utf8');
  const rows = [];
  const lines = raw.split(/\r?\n/);
  let prevHash = 'genesis';
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!t) continue;
    let obj = null;
    try { obj = JSON.parse(t); } catch { obj = null; }
    rows.push({ lineNo: rows.length + 1, raw: t, obj, prevHashOfPrevious: prevHash });
    prevHash = sha256(t);
  }
  return rows;
}
function foldLedger(rows) {
  const runs = new Map(); const entities = new Map(); const decisions = []; const stages = [];
  const verifies = []; const notes = new Map(); const renders = [];
  let currentStage = null; let graphVersion = null;
  for (const r of rows) {
    const o = r.obj;
    if (!o || typeof o !== 'object') continue;
    switch (o.record) {
      case 'run': if (o.runId) runs.set(o.runId, { ...(runs.get(o.runId) ?? {}), ...o }); break;
      case 'entity': if (o.id) entities.set(o.id, o); break;
      case 'decision': decisions.push(o); break;
      case 'stage':
        stages.push(o);
        if (typeof o.to === 'string') currentStage = o.to;
        if (Number.isInteger(o.graphVersion)) graphVersion = o.graphVersion;
        break;
      case 'verify': verifies.push(o); break;
      case 'note': if (o.name) notes.set(o.name, { ...(notes.get(o.name) ?? {}), ...o }); break;
      case 'render': renders.push(o); break;
      default: break;
    }
  }
  return { runs, entities, decisions, stages, verifies, notes, renders, currentStage, graphVersion };
}

// ---------- 服务 ----------
function buildService(ctx) {
  const eg = () => ctx.get('research.engineGit');
  let chain = Promise.resolve();
  const serial = (fn) => { const next = chain.then(fn, fn); chain = next.catch(() => {}); return next; };

  const svc = {
    // --- 根解析 ---
    root(args, exec) {
      const base = sessionCwd(exec);
      const r = (typeof args?.root === 'string' && args.root.trim() !== '')
        ? resolve(base, args.root.trim()) : resolve(base);
      return r;
    },
    async requireProject(root) {
      const p = join(root, PROJECT_YAML);
      if (!(await pathExists(p))) {
        const e = new Error(`这不是研究工程：${root} 下没有 ${PROJECT_YAML}。\n修法：若这是新工程，先 project_init；若工程在别处，把工作区切到工程根或传 root。`);
        e.code = 'PROJECT_MISSING';
        throw e;
      }
      return p;
    },
    async readProject(root) { await this.requireProject(root); return readYamlFile(join(root, PROJECT_YAML)); },
    async readPipeline(root) {
      const p = join(root, PIPELINE_YAML);
      if (!(await pathExists(p))) return null;
      return readYamlFile(p);
    },
    async readTemplates(root) {
      const p = join(root, TEMPLATES_YAML);
      if (!(await pathExists(p))) return null;
      return readYamlFile(p);
    },
    readYamlFile, writeYamlFile,
    async writeProject(root, doc) { await writeYamlFile(join(root, PROJECT_YAML), doc); },
    contractErrors: validateContract,
    checkGraph,
    sha256, iso, slugify, scrub, isWithin, atomicWrite, pathExists, posix, sessionIdOf, sessionCwd,
    ledgerFold: foldLedger,

    // --- 台账（单写者）---
    async ledgerRead(root) { return readRegistryRows(root); },
    async ledgerFold(root) { return foldLedger(await readRegistryRows(root)); },
    /** 追加一行；调用方负责在此之前把文件写好（写文件 → 入库 → 追加台账）。 */
    ledgerAppend(root, event, opts = {}) {
      return serial(async () => {
        const rows = await readRegistryRows(root);
        const last = rows[rows.length - 1] ?? null;
        const seq = rows.length + 1;
        const prev = last ? sha256(last.raw) : 'genesis';
        const row = {
          ...event,
          seq,
          prev,
          actor: opts.actor ?? 'engine',
          ts: opts.ts ?? iso(),
        };
        if (opts.commit) row.commit = opts.commit;
        const line = JSON.stringify(row);
        const body = rows.map((r) => r.raw).join('\n') + (rows.length ? '\n' : '') + line + '\n';
        await atomicWrite(join(root, REGISTRY), body);
        // 台账本身也是受管文件：写完立刻入库，否则每次追加都会把工程留成 dirty。
        eg().record(root, [REGISTRY], `ledger: ${event.record}${event.action ? ` ${event.action}` : ''}`);
        return { seq, prev, row, line };
      });
    },
    /** 写文件 → 入库 → 台账，三步一体（崩溃只会留下 dirty，由 reconcile 修）。 */
    async commitAndLog(root, paths, message, event, opts = {}) {
      const r = eg().record(root, paths, message);
      const rec = await this.ledgerAppend(root, event, { ...opts, commit: r.commit ?? undefined });
      return { ...r, seq: rec.seq };
    },

    // --- 守卫（写类工具前置）---
    managedPaths(root) {
      return [
        PROJECT_YAML, PIPELINE_YAML, TEMPLATES_YAML, REGISTRY,
        'scripts/**', '.kb/**', 'skills/*/SKILL.md', '_report/**',
        '.research/state.json', '.research/managed.json', '.research/ignored.json',
        'experiments/*/config.json', 'experiments/*/manifest.json', 'experiments/*/observations.json',
      ];
    },
    /** 被显式忽略的路径（project_reconcile mode=ignore）：verify 不再把它们当未知。 */
    async ignoredSet(root) {
      try {
        const doc = JSON.parse(await readFile(join(root, '.research', 'ignored.json'), 'utf8'));
        return new Set((doc?.paths ?? []).map((e) => posix(typeof e === 'string' ? e : e?.path)).filter(Boolean));
      } catch { return new Set(); }
    },
    async addIgnored(root, paths, reason) {
      const p = join(root, '.research', 'ignored.json');
      let doc = { schemaVersion: SCHEMA_VERSION, paths: [] };
      try { doc = JSON.parse(await readFile(p, 'utf8')); } catch { /* 新建 */ }
      const have = new Set((doc.paths ?? []).map((e) => posix(typeof e === 'string' ? e : e?.path)));
      for (const raw of paths) {
        const rel = posix(raw);
        if (have.has(rel)) continue;
        doc.paths.push({ path: rel, reason, ts: iso() });
        have.add(rel);
      }
      doc.schemaVersion = SCHEMA_VERSION;
      await atomicWrite(p, JSON.stringify(doc, null, 2) + '\n');
      return doc.paths.length;
    },
    /** 把路径重新纳入常规管辖（工具已经能产出它时调用）。 */
    async removeIgnored(root, paths) {
      const p = join(root, '.research', 'ignored.json');
      if (!(await pathExists(p))) return 0;
      let doc = { schemaVersion: SCHEMA_VERSION, paths: [] };
      try { doc = JSON.parse(await readFile(p, 'utf8')); } catch { return 0; }
      const drop = new Set((Array.isArray(paths) ? paths : []).map(posix));
      const before = (doc.paths ?? []).length;
      doc.paths = (doc.paths ?? []).filter((e) => !drop.has(posix(typeof e === 'string' ? e : e?.path)));
      if (doc.paths.length === before) return 0;
      doc.schemaVersion = SCHEMA_VERSION;
      await atomicWrite(p, JSON.stringify(doc, null, 2) + '\n');
      eg().record(root, ['.research/ignored.json'], 'reconcile: 重新纳入管辖');
      return before - doc.paths.length;
    },
    /** 守卫：受管区任何文件与已登记版本不一致即拒绝（§6.1-3「一律拒绝」）。 */
    guard(root) {
      const e = eg();
      if (!e.capabilities().available || !e.exists(root)) return { ok: true, dirty: [], degraded: true };
      const dirty = e.changed(root, this.managedPaths(root));
      if (dirty.length) {
        const list = dirty.map((d) => `  - ${d.path}（${d.code === 'D' ? '被删除' : '被外部修改'}）`).join('\n');
        return {
          ok: false, dirty,
          text: `拒绝写入：受管区已被工程外部的改动覆盖，当前内容与已登记版本不一致。\n${list}\n`
            + '修法：project_reconcile mode=restore（默认，取回已登记版本）；确实要保留外部改动，则 mode=adopt 并附用户裁决。',
        };
      }
      return { ok: true, dirty: [] };
    },
    /** 与 guard 同义（历史命名）。 */
    guardAll(root) { return this.guard(root); },

    // --- 用户权威回查 ---
    verifyDecision(exec, input) {
      const askCallId = typeof input?.askCallId === 'string' ? input.askCallId.trim() : '';
      const claimed = typeof input?.answer === 'string' ? input.answer.trim() : '';
      if (!askCallId) {
        return { ok: false, text: '拒绝：缺少 decision.askCallId。\n修法：先用 ask_user_question 向用户提问，再把返回的调用标识与用户答复原文一起传进来。' };
      }
      if (!claimed) {
        return { ok: false, text: '拒绝：缺少 decision.answer。\n修法：把用户答复原文（不要转述、不要润色）填入 decision.answer。' };
      }
      const session = exec?.agent?.session;
      const sessionId = sessionIdOf(exec);
      const events = Array.isArray(session?.events) ? session.events : null;
      if (!events) {
        if (input?.attested === true) {
          return { ok: true, decision: { askCallId, answer: claimed, sessionId, ts: iso(), attested: true } };
        }
        return { ok: false, text: '拒绝：无法回查会话记录，不能确认这条答复确实来自用户。\n修法：若用户确认「原文在案但无法回源」，显式加 decision.attested=true 再提交（记录会标 attested）。' };
      }
      let call = null; let result = null;
      for (const ev of events) {
        if (ev?.type === 'tool/call' && ev.data?.callId === askCallId) call = ev;
        if (ev?.type === 'tool/result') {
          const blk = Array.isArray(ev.data?.message?.content) ? ev.data.message.content[0] : null;
          if (blk && blk.type === 'tool-result' && blk.toolCallId === askCallId) result = ev;
        }
      }
      if (!call) {
        return { ok: false, text: `拒绝：本会话里找不到标识为 ${askCallId} 的提问记录。\n修法：先运行 entity_query record=ask 取回本会话的真实提问标识，再把它填进 decision.askCallId（问题自己的 id 不是这个标识）。` };
      }
      if (call.data?.name !== 'ask_user_question') {
        return { ok: false, text: `拒绝：标识 ${askCallId} 对应的是一次 ${call.data?.name ?? '未知'} 调用，不是向用户提问。\n修法：用户权威只能来自 ask_user_question。` };
      }
      if (!result) {
        return { ok: false, text: `拒绝：标识 ${askCallId} 的提问还没有用户答复。\n修法：等用户答复后再提交。` };
      }
      let question = '';
      try {
        const a = JSON.parse(String(call.data?.arguments ?? '{}'));
        const qs = Array.isArray(a?.questions) ? a.questions : [];
        question = qs.map((q) => `${q?.id ?? ''}: ${q?.question ?? ''}`).join(' | ');
      } catch { question = ''; }
      const blk = result.data?.message?.content?.[0];
      const text = Array.isArray(blk?.content)
        ? blk.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
      let answers = null;
      try { const v = JSON.parse(text); if (v && Array.isArray(v.answers)) answers = v.answers; } catch { answers = null; }
      if (!answers || answers.length === 0) {
        return { ok: false, text: '拒绝：该提问的答复为空，不构成用户权威。\n修法：重新提问并取得明确答复。' };
      }
      const recorded = answers.map((a) => {
        const sel = Array.isArray(a.selected) ? a.selected.join(' / ') : '';
        return `${a.id ?? ''}: ${sel}${a.custom ? ` ｜ 补充：${a.custom}` : ''}`;
      }).join('; ').trim();
      const norm = (s) => String(s).toLowerCase().replace(/[\s，。、,.;；:：!！?？"'“”‘’()（）[\]【】-]/g, '');
      const b = norm(claimed);
      // 一致性：允许「原样拷贝规范串」或「包含选项值/补充说明的自然复述」两种写法。
      const parts = [
        ...answers.flatMap((x) => (Array.isArray(x.selected) ? x.selected : [])),
        ...answers.map((x) => x.custom).filter(Boolean),
      ].map(norm).filter((x) => x.length >= 1);
      const a = norm(recorded);
      const consistent = b !== '' && (
        a.includes(b) || b.includes(a)
        || parts.some((p) => b.includes(p) || p.includes(b))
      );
      if (!consistent) {
        return { ok: false, text: `拒绝：提交的答复与用户实际答复不一致。\n用户实际答复：${recorded}\n修法：原样拷贝用户答复原文（不得推断、润色、代答）。` };
      }
      return {
        ok: true,
        decision: {
          askCallId, question, answer: recorded,
          selected: answers.flatMap((x) => x.selected ?? []),
          ...(answers.some((x) => x.custom) ? { custom: answers.map((x) => x.custom).filter(Boolean).join(' ') } : {}),
          sessionId, ts: iso(),
        },
      };
    },

    // --- 受管白名单 ---
    async managedList(root) {
      try {
        const m = JSON.parse(await readFile(join(CONTRACT_DIR, 'managed.json'), 'utf8'));
        if (Array.isArray(m.managed) && m.managed.length) return m.managed;
      } catch { /* fall through */ }
      return this.managedPaths(root);
    },
    async reservedPlaceholders() {
      try {
        const m = JSON.parse(await readFile(join(CONTRACT_DIR, 'managed.json'), 'utf8'));
        return m.reservedPlaceholders ?? {};
      } catch { return {}; }
    },

    // --- 台账折叠视图 ---
    async state(root) {
      const fold = await this.ledgerFold(root);
      const pipeline = await this.readPipeline(root);
      const runs = [...fold.runs.values()];
      const counts = { queued: 0, running: 0, done: 0, failed: 0, draft: 0, invalidated: 0, archived: 0 };
      for (const r of runs) if (r.status && counts[r.status] !== undefined) counts[r.status] += 1;
      return {
        stage: fold.currentStage ?? pipeline?.entry ?? null,
        graphVersion: fold.graphVersion ?? pipeline?.graphVersion ?? null,
        runs, counts, fold,
      };
    },
  };
  return svc;
}

// ---------- 工具注册 ----------
function genericCall(title, kind, paths) {
  return { card: 'generic', title, kind, ...(paths && paths.length ? { locations: paths.map((p) => ({ path: p })) } : {}) };
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
    execute: async (args, exec) => {
      const r = await tool.execute(args, exec);
      return { text: scrub(typeof r?.text === 'string' ? r.text : String(r?.text ?? '')) };
    },
  });
}

function apply(ctx) {
  const svc = buildService(ctx);
  ctx.provide('research.expLedger', svc);

  // ---------- project_init ----------
  registerTextTool(ctx, {
    name: 'project_init',
    description: '把一个目录接入研究工程：发现现状 → 建版本库与受管白名单 → 分类登记遗留文件（只登记不删）→ 写 project.yaml 骨架 → 初始化台账 → 首次体检。已存在 project.yaml 时默认拒绝；mode=migrate 用于把旧式单文件工程就地升级（原文先归档，绝不丢内容）。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      id: { type: 'string', description: '工程 id（kebab-case）；缺省取目录名。' },
      name: { type: 'string', description: '工程显示名。' },
      domain: { type: 'string', description: '领域关键词（逗号分隔）。' },
      description: { type: 'string', description: '工程说明。' },
      mode: { type: 'string', enum: ['init', 'migrate'], description: 'init（默认）接新工程；migrate 升级既有旧式工程。' },
      confirm_no_version_store: { type: 'boolean', description: '版本库不可用时，显式确认以「仅台账」模式接入。' },
    },
    execute: async (args, exec) => {
      const root = svc.root(args, exec);
      await ensureDir(root);
      if (args?.mode === 'migrate') return migrateProject(ctx, svc, root);
      if (await pathExists(join(root, PROJECT_YAML))) {
        return { text: `拒绝：${root} 下已有 ${PROJECT_YAML}，不覆盖。\n修法：project_load 查看现状；若这是旧式单文件工程要升级，用 mode=migrate。` };
      }
      const dirName = basename(root) || 'project';
      const id = slugify(args?.id ?? dirName);
      if (!id) return { text: '拒绝：工程 id 非法。\n修法：用 kebab-case（小写字母、数字、连字符）。' };
      const eg = ctx.get('research.engineGit');
      const cap = eg.capabilities();
      if (!cap.available && args?.confirm_no_version_store !== true) {
        return { text: `拒绝：本机没有可用的版本库工具，接入后只能保留台账、无法还原。\n修法：安装后重试；或由用户确认后加 confirm_no_version_store=true（届时 verify 会标注降级状态）。` };
      }
      // 1) 发现现状
      const found = [];
      for (const probe of [PROJECT_YAML, PIPELINE_YAML, TEMPLATES_YAML, REGISTRY, 'scripts', '.kb', 'experiments', '_report', '.research', '.dsh']) {
        if (await pathExists(join(root, probe))) found.push(probe);
      }
      // 2) 遗留文件分类登记
      const legacyCounts = new Map();
      let scriptCount = 0; let dataDirs = 0; let sessionZips = 0;
      const walk = async (dir, depth) => {
        if (depth > 6) return;
        let ents; try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (SKIP_DIRS.has(e.name)) continue;
          const full = join(dir, e.name);
          if (e.isDirectory()) { await walk(full, depth + 1); continue; }
          const ext = /(\.[^.\\/]+)$/.exec(e.name)?.[1]?.toLowerCase() ?? '';
          if (LEGACY_EXTS.has(ext)) legacyCounts.set(ext, (legacyCounts.get(ext) || 0) + 1);
          if (ext === '.py') scriptCount += 1;
          if (e.name.startsWith('dsh-session-') && ext === '.zip') sessionZips += 1;
        }
      };
      await walk(root, 0);
      const protectedAreas = [];
      for (const d of ['data', 'history', 'x', 'x1', 'x2']) {
        if (await pathExists(join(root, d))) { protectedAreas.push(d); dataDirs += 1; }
      }
      // 3) 基础设施
      const store = eg.init(root);
      const managed = await svc.managedList(root);
      await ensureDir(join(root, '.research'));
      await atomicWrite(join(root, '.research', 'managed.json'), JSON.stringify({
        version: SCHEMA_VERSION,
        mode: store.ok ? 'versioned' : 'ledger-only',
        rawArchive: store.lfs ? 'enabled' : 'hash-only',
        managed,
        note: '受管白名单的工程内副本；契约定义在 preset 的 contract/managed.json。',
      }, null, 2) + '\n');
      // 4) project.yaml
      const doc = {
        schemaVersion: SCHEMA_VERSION,
        project: {
          id,
          name: (typeof args?.name === 'string' && args.name.trim()) ? args.name.trim() : dirName,
          ...(typeof args?.domain === 'string' && args.domain.trim() ? { domain: args.domain.trim() } : {}),
          ...(typeof args?.description === 'string' && args.description.trim() ? { description: args.description.trim() } : {}),
        },
        managed,
        conventions: [],
        vocabulary: { entityKinds: [], noteKinds: ['proposal', 'claim', 'lesson', 'question'], observableRoles: ['log', 'stdout', 'result', 'metrics', 'figure'] },
        ...(legacyCounts.size ? {
          legacy: {
            note: '遗留区只登记 size/mtime，不改、不删、不入库。',
            keep: [...legacyCounts.entries()].sort().map(([ext, count]) => ({ pattern: `**/*${ext}`, count })),
            protectedAreas,
          },
        } : {}),
      };
      await svc.writeProject(root, doc);
      if (!(await pathExists(join(root, REGISTRY)))) await atomicWrite(join(root, REGISTRY), '');
      // 5) 首次入库 + 台账
      const first = [PROJECT_YAML, REGISTRY, '.research/managed.json'];
      const rec = eg.record(root, first, 'project_init: 接入研究工程');
      await svc.ledgerAppend(root, { record: 'project', action: 'init', id, root }, { commit: rec.commit ?? undefined });
      const lines = [
        `工程已接入：${root}`,
        `工程 id：${id}　显示名：${doc.project.name}`,
        `版本能力：${store.ok ? (store.lfs ? '可用（原始产出可还原）' : '可用（原始产出仅记指纹）') : '不可用（仅台账）'}`,
        `遗留登记：${[...legacyCounts.entries()].map(([e, c]) => `${e}×${c}`).join('、') || '（无）'}${sessionZips ? `；对话副本 ${sessionZips} 份（不参与证据）` : ''}`,
        `发现：${found.join('、') || '（空目录）'}；未声明脚本 ${scriptCount} 个`,
        '下一步：stage_declare 声明阶段机 → script_declare 收编/新建脚本 → template_declare 声明模板（含 observables）。',
      ];
      return { text: lines.join('\n') };
    },
    presentCall: (args) => genericCall(`接入工程 ${args?.id ?? args?.root ?? ''}`.trim(), 'edit', [join(args?.root ?? '', PROJECT_YAML)]),
  });

  // ---------- project_load ----------
  registerTextTool(ctx, {
    name: 'project_load',
    description: '只读载入工程全貌：身份、阶段机摘要、模板（含可提取字段）、生效约定（含裁决引文）、受管区、遗留摘要、最近一次体检状态。',
    properties: { root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' } },
    execute: async (args, exec) => {
      const root = svc.root(args, exec);
      let doc;
      try { doc = await svc.readProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const pipeline = await svc.readPipeline(root);
      const templates = await svc.readTemplates(root);
      const fold = await svc.ledgerFold(root);
      const state = await svc.state(root);
      const schemaErrors = await validateContract('project.schema.json', doc);
      const graph = pipeline ? checkGraph(pipeline) : { fatal: ['尚未声明阶段机（pipeline.yaml 缺失）'], warn: [] };
      const tpls = Object.entries(templates?.templates ?? {});
      const convs = Array.isArray(doc.conventions) ? doc.conventions : [];
      const active = convs.filter((c) => (c.status ?? 'active') === 'active');
      const lastVerify = fold.verifies[fold.verifies.length - 1] ?? null;
      const lines = [
        `工程：${doc.project.id} —— ${doc.project.name}`,
        doc.project.domain ? `领域：${doc.project.domain}` : '',
        `阶段机：${pipeline ? `${(pipeline.stages ?? []).length} 个阶段 / ${(pipeline.edges ?? []).length} 条边 / 入口 ${pipeline.entry ?? '(未设)'} / 图版本 ${pipeline.graphVersion}` : '未声明'}`,
        `当前阶段：${state.stage ?? '(未进入任何阶段)'}`,
        `模板：${tpls.length ? tpls.map(([id, t]) => `${id}@${t.version}${(t.observables ?? []).length ? `（可提取 ${t.observables.map((o) => o.field).join('/')}）` : ''}`).join('；') : '（无）'}`,
        `约定：${active.length ? active.map((c) => `${c.id}「${c.statement}」〔裁决 ${c.decision?.askCallId ?? '缺失'}〕`).join('；') : '（无生效约定）'}`,
        `受管区：${(doc.managed ?? []).length} 条规则；遗留登记：${(doc.legacy?.keep ?? []).map((k) => `${k.pattern}×${k.count}`).join('、') || '（无）'}`,
        `运行台账：共 ${state.runs.length} 条（done ${state.counts.done} / failed ${state.counts.failed} / running ${state.counts.running} / draft ${state.counts.draft}）`,
        `最近体检：${lastVerify ? `${lastVerify.status}（${lastVerify.ts}）` : '尚未体检'}`,
        `结构校验：${schemaErrors.length === 0 ? '通过' : `${schemaErrors.length} 项待修`}`,
        graph.fatal.length ? `阶段机 fatal：${graph.fatal.join('；')}` : '',
      ].filter(Boolean);
      for (const e of schemaErrors.slice(0, 10)) lines.push(`  [结构] ${e}`);
      return { text: lines.join('\n') };
    },
    presentCall: (args) => genericCall('载入工程', 'read', [join(args?.root ?? '', PROJECT_YAML)]),
  });

  // ---------- project_verify ----------
  registerTextTool(ctx, {
    name: 'project_verify',
    description: '体检（只读 + 记一条体检结果）：受管区越权改动、台账与版本互证、结构契约、阶段机 fatal、每个 run 的证据完整性、用户权威回查。永远返回报告，不修任何东西。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      scope: { type: 'string', description: 'all（默认）/ environment / evidence / authority', enum: ['all', 'environment', 'evidence', 'authority'] },
    },
    execute: async (args, exec) => {
      const root = svc.root(args, exec);
      try { await svc.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const scope = ['all', 'environment', 'evidence', 'authority'].includes(args?.scope) ? args.scope : 'all';
      const eg = ctx.get('research.engineGit');
      const cap = eg.capabilities();
      const managed = await svc.managedList(root);
      const dirty = []; const unknown = []; const problems = []; const attested = [];
      if (cap.available && eg.exists(root)) {
        for (const d of eg.changed(root, managed)) dirty.push(`${d.path}（${d.code === 'D' ? '被删除' : '被外部修改'}）`);
        for (const u of eg.untracked(root, managed)) unknown.push(u);
      }
      // 结构 + 阶段机
      let doc = null; let pipeline = null; let templates = null;
      try { doc = await svc.readProject(root); } catch (e) { problems.push(e.message); }
      try { pipeline = await svc.readPipeline(root); } catch (e) { problems.push(e.message); }
      try { templates = await svc.readTemplates(root); } catch (e) { problems.push(e.message); }
      if (doc) for (const e of await validateContract('project.schema.json', doc)) problems.push(`project.yaml ${e}`);
      if (pipeline) {
        for (const e of await validateContract('pipeline.schema.json', pipeline)) problems.push(`pipeline.yaml ${e}`);
        for (const f of checkGraph(pipeline).fatal) problems.push(`阶段机：${f}`);
      }
      if (templates) for (const e of await validateContract('templates.schema.json', templates)) problems.push(`templates.yaml ${e}`);
      // 台账链 + 互证
      const rows = await svc.ledgerRead(root);
      let chainBroken = 0; let missingRef = 0;
      let prevHash = 'genesis';
      for (const r of rows) {
        if (!r.obj) { chainBroken += 1; continue; }
        if (r.obj.prev !== undefined && r.obj.prev !== prevHash) chainBroken += 1;
        prevHash = sha256(r.raw);
        if (r.obj.commit && cap.available && eg.exists(root) && !eg.hasObject(root, r.obj.commit)) missingRef += 1;
      }
      if (chainBroken) problems.push(`台账有 ${chainBroken} 行与前一行的指纹不连续（可能被外部改写）`);
      if (missingRef) problems.push(`台账有 ${missingRef} 条事件引用的历史节点已不存在（历史可能被改写）`);
      // 证据完整性
      const fold = await svc.ledgerFold(root);
      const ignored = await svc.ignoredSet(root);
      // 派生状态不得与台账矛盾（派生视图永远不是事实来源）
      const expectedStage = fold.currentStage ?? pipeline?.entry ?? null;
      const statePath = join(root, STATE_REL);
      if (await pathExists(statePath)) {
        let st = null;
        try { st = JSON.parse(await readFile(statePath, 'utf8')); } catch { st = null; }
        const shapeOk = st !== null && st.derived === true && typeof st.generatedAt === 'string'
          && st.source === 'registry.jsonl' && Number.isInteger(st.graphVersion) && Array.isArray(st.history);
        if (st === null) problems.push(`派生状态文件解析失败：${STATE_REL}（修法：stage_goto replay=true 重放物化）`);
        else if (!shapeOk) problems.push(`派生状态文件形状不符合 v3：${STATE_REL}（修法：stage_goto replay=true 重放物化）`);
        else if ((st.stage ?? null) !== expectedStage) {
          problems.push(`派生状态与台账矛盾：${STATE_REL} 写的是 stage=${st.stage ?? '(空)'}，台账重放得到 ${expectedStage ?? '(未进入阶段)'}（修法：stage_goto replay=true 重放物化）`);
        }
      }
      if (scope === 'all' || scope === 'evidence') {
        for (const run of fold.runs.values()) {
          const dir = join(root, 'experiments', run.runId);
          const man = await pathExists(join(dir, 'manifest.json'));
          const rawDir = join(dir, 'raw');
          if (!man) { problems.push(`run ${run.runId}：缺少证据清单（manifest.json）`); continue; }
          let m = null;
          try { m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')); } catch { problems.push(`run ${run.runId}：证据清单解析失败`); continue; }
          for (const e of await validateContract('manifest.schema.json', m)) {
            problems.push(`run ${run.runId} manifest ${e}（修法：project_reconcile mode=restore paths=["experiments/${run.runId}/manifest.json"]）`);
          }
          const registered = new Set((m.entries ?? []).map((x) => posix(x.path)));
          if (await pathExists(rawDir)) {
            const files = eg.listFiles(root, `experiments/${run.runId}/raw`);
            for (const f of files) {
              const rel = posix(f);
              if (registered.has(rel) || ignored.has(rel)) continue;
              unknown.push(`${rel}（产出未登记）`);
            }
          }
          for (const entry of m.entries ?? []) {
            const abs = join(root, entry.path);
            const got = eg.sha256File(abs);
            if (got === null) problems.push(`run ${run.runId}：登记文件缺失 ${entry.path}`);
            else if (got !== entry.sha256) problems.push(`run ${run.runId}：登记文件已被改动 ${entry.path}`);
          }
        }
      }
      // 用户权威回查
      if (scope === 'all' || scope === 'authority') {
        const convs = Array.isArray(doc?.conventions) ? doc.conventions : [];
        for (const c of convs) {
          if (!c?.decision?.askCallId) problems.push(`约定 ${c?.id ?? '?'}：缺少用户裁决引用`);
          else if (c.decision.attested === true) attested.push(`约定 ${c.id}`);
        }
        for (const d of fold.decisions) if (d.attested === true) attested.push(`裁决 ${d.kind ?? ''} ${d.id ?? ''}`.trim());
      }
      const status = (dirty.length || unknown.length || problems.length) ? 'dirty' : 'clean';
      const todo = [];
      if (!pipeline) todo.push('尚未声明阶段机：stage_declare action=stage → action=edge → entry');
      else if ((pipeline.stages ?? []).length === 0) todo.push('阶段机是空的：stage_declare action=stage');
      if (!templates || Object.keys(templates.templates ?? {}).length === 0) todo.push('尚未声明任何模板：template_declare');
      if (!(Array.isArray(doc?.conventions) ? doc.conventions.length : 0)) todo.push('尚无生效约定（需要时：ask_user_question → convention_declare）');
      await svc.ledgerAppend(root, {
        record: 'verify', status,
        dirty: dirty.map((s) => s.split('（')[0]),
        unknown: unknown.map((s) => s.split('（')[0]),
        attested,
        scope,
      });
      const head = [`体检结果：${status === 'clean' ? '通过（clean）' : status === 'unknown' ? '存在未登记文件（unknown）' : '存在待修问题（dirty）'}`];
      if (!cap.available) head.push('版本能力：不可用 —— 本次体检只能核对台账与结构，无法比对文件版本');
      const body = [];
      if (dirty.length) body.push('受管文件被工程外部改动：', ...dirty.map((d) => `  - ${d}`), '  修法：project_reconcile mode=restore（取回已登记版本）；确需保留外部改动则 mode=adopt + 用户裁决。');
      if (unknown.length) body.push('未登记文件：', ...unknown.map((d) => `  - ${d}`), '  修法：属于证据的用 run_launch 补登记；其余用 project_reconcile mode=ignore 并说明原因。');
      if (problems.length) body.push('结构 / 证据 / 权威问题：', ...problems.map((d) => `  - ${d}`));
      if (todo.length) body.push('待声明（不算 dirty，但工程还不完整）：', ...todo.map((d) => `  - ${d}`));
      if (attested.length) body.push(`降级记录（原文在案、无法回源）：${attested.join('；')}`);
      if (!body.length) body.push('没有发现问题。');
      return { text: [...head, '', ...body].join('\n') };
    },
    presentCall: (args) => genericCall('工程体检', 'read', [join(args?.root ?? '', REGISTRY)]),
  });

  // ---------- project_reconcile ----------
  registerTextTool(ctx, {
    name: 'project_reconcile',
    description: '修复受管区与已登记版本不一致的九种情景：restore（默认，取回已登记版本）/ adopt（接受外部改动，需用户裁决，语义文件除外）/ ignore（登记为有意忽略）。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      paths: { type: 'array', items: { type: 'string' }, description: '要处理的工程内相对路径。' },
      mode: { type: 'string', enum: ['restore', 'adopt', 'ignore'], description: '缺省 restore。' },
      reason: { type: 'string', description: '本次处理的原因（必填，会记入台账）。' },
      decision: {
        type: 'object',
        description: 'adopt 必填：用户裁决引用。',
        properties: {
          askCallId: { type: 'string' },
          answer: { type: 'string' },
          attested: { type: 'boolean' },
        },
      },
    },
    required: ['paths', 'reason'],
    execute: async (args, exec) => {
      const root = svc.root(args, exec);
      try { await svc.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const mode = ['restore', 'adopt', 'ignore'].includes(args?.mode) ? args.mode : 'restore';
      const reason = typeof args?.reason === 'string' ? args.reason.trim() : '';
      if (!reason) return { text: '拒绝：缺少 reason。\n修法：写清为什么这些路径会与登记版本不一致。' };
      const paths = (Array.isArray(args?.paths) ? args.paths : []).map((p) => posix(String(p).trim())).filter(Boolean);
      if (!paths.length) return { text: '拒绝：paths 为空。\n修法：先用 project_verify 看有哪些路径需要处理。' };
      for (const p of paths) {
        if (isAbsolute(p) || p.split('/').includes('..')) {
          return { text: `拒绝：${p} 越出工程范围。\n修法：只处理工程内相对路径。` };
        }
      }
      const eg = ctx.get('research.engineGit');
      const cap = eg.capabilities();
      const managed = await svc.managedList(root);
      const dirty = cap.available && eg.exists(root) ? eg.changed(root, paths) : [];
      const untracked = cap.available && eg.exists(root) ? eg.untracked(root, paths) : paths;
      if (!dirty.length && !untracked.length) {
        return { text: `无需处理：这些路径当前与已登记版本一致。\n（若怀疑体检结论，请重跑 project_verify）` };
      }
      const semantic = new Set([PROJECT_YAML, PIPELINE_YAML, TEMPLATES_YAML]);
      if (mode === 'adopt') {
        const v = svc.verifyDecision(exec, args?.decision ?? {});
        if (!v.ok) return { text: `${v.text}\n（adopt 会把这些改动接受为新版本，必须由用户裁决。）` };
        const blocked = paths.filter((p) => semantic.has(p) || p.startsWith('scripts/') || p === '.research/managed.json');
        if (blocked.length) {
          return { text: `拒绝：这些是语义文件，不能在 reconcile 里改语义：${blocked.join('、')}。\n修法：用对应的声明工具重新声明（project_init/convention_declare/stage_declare/template_declare/script_declare）。` };
        }
      }
      const done = []; const left = [];
      if (mode === 'restore') {
        const tracked = new Set(eg.tracked(root, paths));
        const restorable = paths.filter((p) => tracked.has(p));
        const notRestorable = paths.filter((p) => !tracked.has(p));
        if (restorable.length) {
          const r = eg.restore(root, restorable);
          if (r.ok) done.push(...restorable.map((p) => `${p}（已还原）`));
          else left.push(...restorable.map((p) => `${p}（还原失败）`));
        }
        for (const p of notRestorable) left.push(`${p}（尚无登记版本：需 adopt 或 ignore）`);
      } else if (mode === 'adopt') {
        done.push(...paths.map((p) => `${p}（已接受为新版本）`));
      } else {
        done.push(...paths.map((p) => `${p}（已登记为有意忽略）`));
        await svc.addIgnored(root, paths, reason);
      }
      const commit = mode === 'restore'
        ? eg.head(root)
        : (eg.record(root, [...paths, '.research/ignored.json'], `project_reconcile: ${reason}`).commit ?? null);
      await svc.ledgerAppend(root, {
        record: 'reconcile', mode, paths, reason,
        ...(mode === 'adopt' ? { decision: args.decision } : {}),
      }, { commit: commit ?? undefined, actor: mode === 'adopt' ? 'user' : 'engine' });
      const lines = [
        `处理方式：${mode === 'restore' ? '取回已登记版本' : mode === 'adopt' ? '接受外部改动为新版本' : '登记为有意忽略'}`,
        `原因：${reason}`,
        ...(done.length ? ['已处理：', ...done.map((d) => `  - ${d}`)] : []),
        ...(left.length ? ['仍需处理：', ...left.map((d) => `  - ${d}`)] : []),
        '下一步：project_verify 复检。',
      ];
      return { text: lines.join('\n') };
    },
    presentCall: (args) => genericCall(`修复受管区（${args?.mode ?? 'restore'}）`, 'edit', (args?.paths ?? []).map(String)),
  });

  // ---------- entity_declare ----------
  registerTextTool(ctx, {
    name: 'entity_declare',
    description: '声明一个研究对象（数据集/方法/模型/产物/遗留区等）到台账，必须带可解析的来源。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      kind: { type: 'string', description: '类别：dataset/method/model/output/legacy/…' },
      id: { type: 'string', description: '实体 id；缺省由 name 生成。' },
      name: { type: 'string', description: '显示名。' },
      props: { type: 'object', description: '开放属性。' },
      source: { type: 'string', description: '来源（必填）：文件:行 / runId / 实测时间+命令。' },
      note: { type: 'string', description: '备注。' },
    },
    required: ['kind', 'source'],
    execute: async (args, exec) => {
      const root = svc.root(args, exec);
      try { await svc.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const kind = typeof args?.kind === 'string' ? args.kind.trim() : '';
      if (!kind) return { text: '拒绝：缺少 kind。\n修法：给出类别（dataset/method/model/output/legacy…）。' };
      const source = typeof args?.source === 'string' ? args.source.trim() : '';
      if (!source) return { text: '拒绝：缺少 source。\n修法：写明依据来源（文件:行 / runId / 实测命令），没有来源的声明不算登记。' };
      const chk = await checkSource(root, source);
      if (!chk.ok) return { text: `拒绝：来源无法解析 —— ${chk.why}\n修法：给出工程内真实存在的文件与行号，或一个已登记的 runId。` };
      const id = slugify(args?.id ?? args?.name ?? '');
      if (!id) return { text: '拒绝：实体 id 非法。\n修法：用 kebab-case，或给出可生成 id 的 name。' };
      const guard = svc.guard(root, [REGISTRY]);
      if (!guard.ok) return { text: guard.text };
      const rec = await svc.ledgerAppend(root, {
        record: 'entity', id, kind,
        ...(typeof args?.name === 'string' && args.name.trim() ? { name: args.name.trim() } : {}),
        ...(args?.props && typeof args.props === 'object' && !Array.isArray(args.props) ? { props: args.props } : {}),
        source,
        ...(typeof args?.note === 'string' && args.note.trim() ? { note: args.note.trim() } : {}),
      });
      const fold = await svc.ledgerFold(root);
      const same = [...fold.entities.values()].filter((e) => e.kind === kind).length;
      return { text: `已登记实体：${id}（kind=${kind}）\n来源：${source}\n同类实体现有 ${same} 个；台账第 ${rec.seq} 行。` };
    },
    presentCall: (args) => genericCall(`声明实体 ${args?.id ?? args?.name ?? ''}`.trim(), 'edit', [REGISTRY]),
  });

  // ---------- entity_query ----------
  registerTextTool(ctx, {
    name: 'entity_query',
    description: '只读查询台账：record=entity（实体）/ record=decision（已登记的用户裁决，含问答原文）/ record=ask（本会话里发生过的提问与答复，用于取得提问标识）。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      record: { type: 'string', enum: ['entity', 'decision', 'ask'], description: '缺省 entity。' },
      id: { type: 'string', description: '按 id 过滤。' },
      kind: { type: 'string', description: '按类别过滤。' },
      limit: { type: 'number', description: '返回条数上限（默认 50）。' },
    },
    execute: async (args, exec) => {
      const root = svc.root(args, exec);
      try { await svc.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const record = ['decision', 'ask'].includes(args?.record) ? args.record : 'entity';
      const limit = Number.isFinite(Number(args?.limit)) && Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 50;
      if (record === 'ask') {
        const events = Array.isArray(exec?.agent?.session?.events) ? exec.agent.session.events : null;
        if (!events) return { text: '本会话读不到对话记录，无法列出提问。\n修法：确认会话处于活动状态。' };
        const calls = new Map();
        for (const ev of events) {
          if (ev?.type === 'tool/call' && ev.data?.name === 'ask_user_question') calls.set(ev.data.callId, ev);
        }
        if (!calls.size) return { text: '本会话还没有向用户提过问题。\n修法：需要用户拍板时先用 ask_user_question。' };
        const lines = [];
        for (const [callId, call] of [...calls.entries()].slice(-limit)) {
          let qs = [];
          try { qs = JSON.parse(String(call.data?.arguments ?? '{}')).questions ?? []; } catch { qs = []; }
          let answers = null;
          for (const ev of events) {
            const blk = Array.isArray(ev?.data?.message?.content) ? ev.data.message.content[0] : null;
            if (ev?.type === 'tool/result' && blk?.type === 'tool-result' && blk.toolCallId === callId) {
              const text = (blk.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
              try { const v = JSON.parse(text); answers = Array.isArray(v?.answers) ? v.answers : null; } catch { answers = null; }
            }
          }
          lines.push(`- 提问标识：${callId}`);
          lines.push(`  问题：${qs.map((q) => `[${q?.id ?? ''}] ${q?.question ?? ''}`).join(' | ')}`);
          lines.push(`  用户答复：${answers ? answers.map((a) => `${a.id}: ${(a.selected ?? []).join(' / ')}${a.custom ? ` ｜ 补充：${a.custom}` : ''}`).join('; ') : '（尚未答复）'}`);
        }
        return { text: `本会话提问 ${calls.size} 次（最近 ${Math.min(calls.size, limit)} 次）：\n${lines.join('\n')}\n\n用法：把「提问标识」填进 convention_declare / note_adjudicate / run_close 的 decision.askCallId。` };
      }
      const fold = await svc.ledgerFold(root);
      if (record === 'decision') {
        let list = fold.decisions;
        if (typeof args?.id === 'string') list = list.filter((d) => d.id === args.id);
        if (typeof args?.kind === 'string') list = list.filter((d) => d.kind === args.kind);
        list = list.slice(-limit);
        if (!list.length) return { text: '台账里没有匹配的用户裁决记录。' };
        return {
          text: `用户裁决 ${list.length} 条：\n` + list.map((d) => `- [${d.kind ?? '?'}] ${d.id ?? ''}　提问：${d.question ?? '（未记录）'}\n  答复原文：${d.answer}${d.attested ? '　（attested：原文在案、无法回源）' : ''}　@${d.ts}`).join('\n'),
        };
      }
      let list = [...fold.entities.values()];
      if (typeof args?.id === 'string') list = list.filter((e) => e.id === args.id);
      if (typeof args?.kind === 'string') list = list.filter((e) => e.kind === args.kind);
      list = list.slice(-limit);
      if (!list.length) return { text: '台账里没有匹配的实体记录。' };
      return {
        text: `实体 ${list.length} 条：\n` + list.map((e) => `- ${e.id}　kind=${e.kind}${e.name ? `　${e.name}` : ''}　来源：${e.source ?? '（缺）'}`).join('\n'),
      };
    },
    presentCall: (args) => genericCall(`查询台账 ${args?.record ?? 'entity'}`, 'read', [REGISTRY]),
  });

  // ---------- convention_declare ----------
  registerTextTool(ctx, {
    name: 'convention_declare',
    description: '把一次用户裁决写成工程约定（用户权威的唯一写入口）：必须带 askCallId 与用户答复原文，写入时回查会话强校验。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      statement: { type: 'string', description: '约定条文（与用户答复不矛盾）。' },
      scope: { type: 'string', description: '生效范围；缺省 = 全工程。' },
      source: { type: 'string', description: '依据来源（文件:行 / runId / 实测命令）。' },
      decision: {
        type: 'object',
        properties: {
          askCallId: { type: 'string', description: 'ask_user_question 的调用标识。' },
          answer: { type: 'string', description: '用户答复原文。' },
          attested: { type: 'boolean', description: '会话记录不可读时，由用户显式确认后置 true。' },
        },
      },
    },
    required: ['statement', 'source', 'decision'],
    execute: async (args, exec) => {
      const root = svc.root(args, exec);
      try { await svc.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const statement = typeof args?.statement === 'string' ? args.statement.trim() : '';
      const source = typeof args?.source === 'string' ? args.source.trim() : '';
      if (!statement) return { text: '拒绝：缺少 statement。' };
      if (!source) return { text: '拒绝：缺少 source。\n修法：写明这条约定的依据来源。' };
      const v = svc.verifyDecision(exec, args?.decision ?? {});
      if (!v.ok) return { text: v.text };
      const guard = svc.guard(root, [PROJECT_YAML]);
      if (!guard.ok) return { text: guard.text };
      const doc = await svc.readProject(root);
      const convs = Array.isArray(doc.conventions) ? doc.conventions : [];
      // 答复里的硬约束必须体现在 statement 里（只从选项值/补充说明里抽，不掺 id 前缀）
      const hard = extractHardConstraints(v.decision);
      const flatStatement = statement.replace(/\s+/g, '');
      const missing = hard.filter((h) => !flatStatement.includes(h.replace(/\s+/g, '')));
      if (missing.length) {
        return { text: `拒绝：条文与用户答复不一致 —— 答复里的硬约束没有体现：${missing.join('、')}。\n修法：把答复里的硬约束原样写进 statement。` };
      }
      const wantPolarity = polarityOf(`${(v.decision.selected ?? []).join(' ')} ${v.decision.custom ?? ''}`);
      if (wantPolarity.length && !wantPolarity.some((w) => statement.includes(w))) {
        return { text: `拒绝：条文与用户答复不一致 —— 答复用了「${wantPolarity.join('/')}」这类硬约束词，条文里必须保留同样的约束方向。\n修法：把约束原样写进 statement。` };
      }
      const baseSlug = slugify(statement.slice(0, 24));
      const base = (/^[a-z][a-z0-9-]{3,}$/.test(baseSlug) ? baseSlug : 'convention');
      let id = base; let n = 2;
      while (convs.some((c) => c.id === id)) { id = `${base}-${n}`; n += 1; }
      const entry = {
        id, statement,
        ...(typeof args?.scope === 'string' && args.scope.trim() ? { scope: args.scope.trim() } : {}),
        authority: 'user', status: 'active', source,
        decision: v.decision,
        createdAt: iso(),
      };
      doc.conventions = [...convs, entry];
      await svc.writeProject(root, doc);
      const eg = ctx.get('research.engineGit');
      const stored = eg.record(root, [PROJECT_YAML], `convention_declare: ${id}`);
      const rec = await svc.ledgerAppend(root, {
        record: 'decision', kind: 'convention', id,
        askCallId: v.decision.askCallId, question: v.decision.question,
        answer: v.decision.answer, sessionId: v.decision.sessionId,
        ...(v.decision.attested ? { attested: true } : {}),
      }, { actor: 'user', commit: stored.commit ?? undefined });
      return {
        text: `约定已生效：${id}\n条文：${statement}\n生效范围：${entry.scope ?? '全工程'}\n用户答复原文：${v.decision.answer}${v.decision.attested ? '（attested）' : ''}\n台账第 ${rec.seq} 行。`,
      };
    },
    presentCall: (args) => genericCall('声明工程约定', 'edit', [PROJECT_YAML]),
  });
}

/** 答复里的硬约束：只从「选项值 + 补充说明」里抽，绝不把序列化串的 id 前缀带进来。 */
function extractHardConstraints(decision) {
  const out = new Set();
  const text = [
    ...(Array.isArray(decision?.selected) ? decision.selected : []),
    typeof decision?.custom === 'string' ? decision.custom : '',
  ].join(' ').trim();
  if (!text) return [];
  for (const m of text.matchAll(/\d+(?:\.\d+)?\s*%?/g)) out.add(m[0].replace(/\s+/g, ''));
  for (const m of text.matchAll(/[「“"']([^「」“”"']{2,})[」”"']/g)) out.add(m[1]);
  return [...out].filter((x) => x.length >= 2).slice(0, 6);
}

/** 极性词：答复里出现「必须/不得/…」，条文里至少要保留一个，防止把约束写成反义。 */
const POLARITY = ['必须', '不得', '禁止', '不要', '不能', '只能', '一律', '至少', '最多', '不超过'];
function polarityOf(text) { return POLARITY.filter((w) => String(text ?? '').includes(w)); }

/** 旧式单文件工程 → v3 就地升级（阶段 6 迁移）。
 *  顺序遵守「先归档、再迁移」：旧 project.yaml 原文完整落到 .research/legacy/，任何一项都不丢。 */
async function migrateProject(ctx, svc, root) {
  const eg = ctx.get('research.engineGit');
  const pjPath = join(root, PROJECT_YAML);
  if (!(await pathExists(pjPath))) {
    return { text: `拒绝：${root} 下没有 ${PROJECT_YAML}，没有可迁移的旧式工程。\n修法：接新工程用 mode=init（默认）。` };
  }
  const oldRaw = await readFile(pjPath, 'utf8');
  let old;
  try { old = yaml.load(oldRaw); } catch (e) { return { text: `拒绝：旧 ${PROJECT_YAML} 解析失败（${e.message}）。` }; }
  if (!old || typeof old !== 'object') return { text: '拒绝：旧工程文件顶层不是映射对象。' };
  const isLegacy = Array.isArray(old.stages) || old.pipeline !== undefined || old.templates !== undefined || old.entities !== undefined || old.kb !== undefined;
  const alreadyV3 = !isLegacy && old.schemaVersion === SCHEMA_VERSION;
  const cap = eg.capabilities();
  const notes = []; const skipped = [];

  // 1) 归档旧文件（零丢失）——仅首次迁移
  if (!alreadyV3) {
    await ensureDir(join(root, '.research', 'legacy'));
    await atomicWrite(join(root, '.research', 'legacy', 'project-v2.yaml'), oldRaw);
  }
  // 2) 基础设施
  const store = eg.init(root);
  const managed = await svc.managedList(root);
  await atomicWrite(join(root, '.research', 'managed.json'), JSON.stringify({
    version: SCHEMA_VERSION, mode: store.ok ? 'versioned' : 'ledger-only',
    rawArchive: store.lfs ? 'enabled' : 'hash-only', managed,
    note: '受管白名单的工程内副本；契约定义在 preset 的 contract/managed.json。',
  }, null, 2) + '\n');
  const touched = [PROJECT_YAML, REGISTRY, '.research/managed.json'];
  let doc = old;
  if (!alreadyV3) {
    // 3) project.yaml（身份 + 受管区 + 约定 + 词汇 + 遗留登记）
    doc = {
      schemaVersion: SCHEMA_VERSION,
      project: {
        id: slugify(old.project?.id ?? basename(root)) || 'project',
        name: old.project?.name ?? basename(root),
        ...(old.project?.domain ? { domain: String(old.project.domain) } : {}),
        ...(old.project?.description ? { description: String(old.project.description) } : {}),
      },
      managed,
      conventions: Array.isArray(old.conventions) ? old.conventions : [],
      vocabulary: {
        entityKinds: Array.isArray(old.kb?.types) ? old.kb.types.map(String) : [],
        noteKinds: ['proposal', 'claim', 'lesson', 'question'],
        observableRoles: ['log', 'stdout', 'result', 'figure', 'raw'],
      },
      ...(old.legacy ? { legacy: old.legacy } : {}),
    };
    await svc.writeProject(root, doc);
    touched.push('.research/legacy/project-v2.yaml');
  }

  // 4) pipeline.yaml（把旧 stages/pipeline 逐项搬过来，图版本从 1 起）——仅首次迁移
  if (!alreadyV3 && Array.isArray(old.stages) && old.stages.length) {
    const pipeline = {
      schemaVersion: SCHEMA_VERSION,
      graphVersion: 1,
      entry: old.pipeline?.entry ?? old.stages[0]?.id ?? null,
      stages: old.stages.map((s) => ({ id: String(s?.id ?? ''), name: String(s?.name ?? s?.id ?? ''), status: 'active' })),
      edges: Array.isArray(old.pipeline?.edges) ? old.pipeline.edges.map((e) => ({ from: String(e?.from ?? ''), to: String(e?.to ?? '') })) : [],
    };
    await svc.writeYamlFile(join(root, PIPELINE_YAML), pipeline);
    touched.push(PIPELINE_YAML);
    await svc.ledgerAppend(root, {
      record: 'pipeline', action: 'migrate', entry: pipeline.entry, graphVersion: 1,
      stages: pipeline.stages.map((s) => s.id), edges: pipeline.edges.map((e) => `${e.from}->${e.to}`),
    });
    notes.push(`阶段机：${pipeline.stages.length} 个阶段 / ${pipeline.edges.length} 条边（图版本 1）`);
  } else if (!alreadyV3) { skipped.push('旧工程没有 stages/pipeline，未生成 pipeline.yaml'); }

  // 5) templates.yaml + 脚本收编（mode=adopt，绝不改既有脚本）——仅首次迁移
  const oldTpls = (!alreadyV3 && old.templates && typeof old.templates === 'object') ? old.templates : {};
  const tpls = {};
  let adopted = 0;
  for (const [id, t] of Object.entries(oldTpls)) {
    const scriptRel = typeof t?.command?.script === 'string' ? posix(t.command.script) : '';
    if (!scriptRel) { skipped.push(`模板 ${id}：没有 command.script，未迁移`); continue; }
    const abs = join(root, scriptRel);
    if (!(await pathExists(abs))) { skipped.push(`模板 ${id}：脚本不存在（${scriptRel}），未迁移`); continue; }
    const name = slugify(basename(scriptRel).replace(/\.[^.]+$/, '')) || 'script';
    const metaPath = join(root, 'scripts', `${name}.meta.json`);
    const meta = {
      schemaVersion: SCHEMA_VERSION, name, mode: 'adopt',
      purpose: String(t?.description ?? `${id} 的脚本`),
      entrypoint: `python ${scriptRel} ${String(t?.command?.args ?? '')}`.trim(),
      allowlist: Array.isArray(t?.command?.allow) && t.command.allow.length ? t.command.allow.map(String) : ['python'],
      owner: 'user', source: scriptRel, sha256: eg.sha256File(abs), version: 1, createdAt: iso(),
    };
    await atomicWrite(metaPath, JSON.stringify(meta, null, 2) + '\n');
    touched.push(posix(join('scripts', `${name}.meta.json`)));
    adopted += 1;
    tpls[String(id)] = {
      version: 1, status: 'active',
      description: String(t?.description ?? ''),
      allow: meta.allowlist,
      scriptRef: { name, mode: 'adopt', path: scriptRel, sha256: meta.sha256, version: 1 },
      ...(typeof t?.command?.args === 'string' && t.command.args.trim() ? { args: t.command.args } : {}),
      paramsSchema: (t?.parameters && typeof t.parameters === 'object') ? t.parameters : { type: 'object', properties: {} },
      observables: [],
      updatedAt: iso(),
    };
  }
  if (Object.keys(tpls).length) {
    await svc.writeYamlFile(join(root, TEMPLATES_YAML), { schemaVersion: SCHEMA_VERSION, templates: tpls });
    touched.push(TEMPLATES_YAML);
    notes.push(`模板：${Object.keys(tpls).length} 个（observables 全部为空，需 template_declare 声明可提取字段）`);
  } else if (!alreadyV3) { skipped.push('旧工程没有可迁移的模板'); }

  // 6) 既有 run 补证据清单
  const runDirs = [];
  try {
    for (const e of await readdir(join(root, 'experiments'), { withFileTypes: true })) if (e.isDirectory()) runDirs.push(e.name);
  } catch { /* 无 experiments 目录 */ }
  let manifests = 0; let incomplete = 0;
  for (const runId of runDirs) {
    const dirRel = posix(join('experiments', runId));
    const files = [];
    if (await pathExists(join(root, dirRel, 'config.json'))) files.push(`${dirRel}/config.json`);
    for (const f of eg.listFiles(root, `${dirRel}/raw`)) files.push(posix(f));
    for (const extra of ['result.json', 'observations.json']) if (await pathExists(join(root, dirRel, extra))) files.push(`${dirRel}/${extra}`);
    const entries = [];
    for (const rel of files) {
      const sha = eg.sha256File(join(root, rel));
      if (sha === null) continue;
      const st = eg.sizeMtime(join(root, rel));
      entries.push({
        path: rel, role: rel.endsWith('config.json') ? 'config' : roleOfPath(rel),
        sha256: sha, bytes: st?.bytes ?? 0, producer: rel.endsWith('config.json') ? 'run_draft' : 'process',
        ts: st?.mtime ?? iso(), stored: store.lfs ? 'versioned' : 'hash-only',
      });
    }
    const complete = entries.some((e) => e.role !== 'config' && !e.path.endsWith('observations.json'));
    await atomicWrite(join(root, dirRel, 'manifest.json'), JSON.stringify({
      schemaVersion: SCHEMA_VERSION, runId, entries, complete, updatedAt: iso(),
    }, null, 2) + '\n');
    touched.push(`${dirRel}/manifest.json`);
    for (const e of entries) touched.push(e.path);
    manifests += 1;
    if (!complete) incomplete += 1;
  }
  if (manifests) notes.push(`既有 run：${manifests} 个已补证据清单，其中 ${incomplete} 个证据不完整（complete=false，不得据此下结论）`);

  // 6b) 既有派生文件：登记进版本库，否则迁移后立刻是 unknown
  for (const rel of ['.kb/index.yaml', '.research/state.json']) {
    if (await pathExists(join(root, rel))) touched.push(rel);
  }
  for (const f of eg.listFiles(root, '_report')) touched.push(posix(f));
  for (const f of eg.listFiles(root, 'skills')) if (posix(f).endsWith('SKILL.md')) touched.push(posix(f));

  // 6c) 旧实体补 source（旧台账的实体事件没有这个必填字段）
  const legacyRows = await svc.ledgerRead(root);
  const seenEntity = new Set();
  let entityFixed = 0;
  for (const r of legacyRows) {
    const o = r.obj;
    if (o?.record !== 'entity' || !o.id || seenEntity.has(o.id)) continue;
    seenEntity.add(o.id);
    if (typeof o.source === 'string' && o.source.trim()) continue;
    await svc.ledgerAppend(root, {
      record: 'entity', id: o.id, kind: o.kind ?? 'other',
      ...(o.name ? { name: o.name } : {}),
      ...(o.props ? { props: o.props } : {}),
      source: '.research/legacy/project-v2.yaml',
      note: '迁移补齐来源（原声明在旧式工程文件里）',
    });
    entityFixed += 1;
  }
  if (entityFixed) notes.push(`实体：${entityFixed} 条补齐了来源指针`);

  // 7) 笔记补 v3 结构头（不删原文）
  let noteCount = 0;
  try {
    for (const f of (await readdir(join(root, '.kb', 'notes'))).filter((x) => x.endsWith('.md'))) {
      const rel = posix(join('.kb', 'notes', f));
      const raw = await readFile(join(root, rel), 'utf8');
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
      const legacyFront = m ? (yaml.load(m[1]) ?? {}) : {};
      const body = m ? m[2] : raw;
      if (m && legacyFront.schemaVersion === SCHEMA_VERSION) continue; // 已经是 v3
      const name = slugify(legacyFront.name ?? f.replace(/\.md$/, '')) || 'note';
      const oldType = String(legacyFront.type ?? legacyFront.kind ?? '');
      const kind = oldType === 'conclusion' ? 'claim' : (['lesson', 'question', 'proposal', 'claim'].includes(oldType) ? oldType : 'proposal');
      const evidence = [];
      for (const mm of body.matchAll(/[\w./-]+\.(?:py|txt|csv|json|log|md|ipynb|png|pth)/g)) {
        const ref = posix(mm[0]);
        if (ref.split('/').includes('..')) continue;
        if (await pathExists(join(root, ref))) evidence.push({ type: 'file', ref });
      }
      const uniq = [...new Map(evidence.map((e) => [e.ref, e])).values()].slice(0, 5);
      const front = {
        schemaVersion: SCHEMA_VERSION, name, kind,
        status: kind === 'lesson' ? 'accepted' : 'proposed',
        authority: kind === 'lesson' ? 'evidence' : 'agent',
        description: String(legacyFront.description ?? `迁移自旧笔记 ${f}`),
        evidence: uniq,
        ...(legacyFront.stage ? { scope: String(legacyFront.stage) } : (kind === 'claim' ? { scope: '迁移：范围待补' } : {})),
        ...(Array.isArray(legacyFront.tags) ? { tags: legacyFront.tags.map(String) } : {}),
        ...(legacyFront.stage ? { stage: String(legacyFront.stage) } : {}),
        legacy: legacyFront,
        createdAt: iso(), updatedAt: iso(),
      };
      await atomicWrite(join(root, rel), `---\n${yaml.dump(front, { lineWidth: -1, noRefs: true, skipInvalid: true })}---\n\n${String(body).replace(/^\n+/, '')}\n`);
      touched.push(rel);
      noteCount += 1;
    }
  } catch { /* 无 .kb/notes */ }
  if (noteCount) notes.push(`笔记：${noteCount} 条补了 v3 结构头（原文保留，旧字段存在 legacy 下）`);

  // 8) 旧工程笔记 SKILL 移出环境位置（保留为历史，不再被加载）
  const retired = [];
  try {
    for (const d of await readdir(join(root, '.dsh', 'skills'), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const src = join(root, '.dsh', 'skills', d.name, 'SKILL.md');
      if (!(await pathExists(src))) continue;
      const dst = join(root, '.research', 'legacy', 'skills', d.name, 'SKILL.md');
      await ensureDir(dirname(dst));
      await atomicWrite(dst, await readFile(src, 'utf8'));
      await rm(src, { force: true });
      retired.push(d.name);
      touched.push(posix(join('.research', 'legacy', 'skills', d.name, 'SKILL.md')));
    }
  } catch { /* 无 .dsh/skills */ }
  if (retired.length) notes.push(`旧工程笔记已移出环境位置（保留为历史）：${retired.join('、')}`);

  // 9) 入库 + 台账
  const stored = eg.record(root, touched, alreadyV3 ? 'project_init: 迁移修复复检' : 'project_init: 迁移旧式工程');
  const rec = await svc.ledgerAppend(root, {
    record: 'project', action: alreadyV3 ? 'repair' : 'migrate', id: doc.project.id, root,
    archive: '.research/legacy/project-v2.yaml',
  }, { commit: stored.commit ?? undefined });

  const lines = [
    `${alreadyV3 ? '修复复检完成（工程已是 v3，只补齐派生文件 / 证据清单 / 实体来源）' : '迁移完成'}：${root}`,
    `工程 id：${doc.project.id}　显示名：${doc.project.name}`,
    ...(alreadyV3 ? [] : ['旧文件已归档：.research/legacy/project-v2.yaml（原文完整保留，可逐项核对）']),
    `版本能力：${store.ok ? (store.lfs ? '可用（原始产出可还原）' : '可用（原始产出仅记指纹）') : '不可用（仅台账）'}`,
    ...notes.map((n) => `· ${n}`),
    ...(skipped.length ? ['未能迁移（需人工确认）：', ...skipped.map((s) => `  - ${s}`)] : []),
    `台账第 ${rec.seq} 行。`,
    '下一步：project_verify 复检 → template_declare overwrite 补 observables → view_render(report/notes-skill/index)。',
  ];
  return { text: lines.join('\n') };
}

/** 旧产物角色推断（迁移用；与 task-dispatch 的 roleOf 同规则）。 */
function roleOfPath(rel) {
  const n = basename(rel).toLowerCase();
  const ext = (/\.([a-z0-9]+)$/.exec(n)?.[1] ?? '');
  if (n === 'stdout.log' || n === 'stderr.log') return 'stdout';
  if (['log', 'txt', 'out', 'err'].includes(ext)) return 'log';
  if (['json', 'yaml', 'yml', 'csv'].includes(ext)) return 'result';
  if (['png', 'jpg', 'jpeg', 'svg', 'pdf'].includes(ext)) return 'figure';
  if (['pth', 'pt', 'ckpt', 'npz', 'bin'].includes(ext)) return 'checkpoint';
  return 'raw';
}

/** source 解析：文件:行 / runId / 实测命令。 */
async function checkSource(root, source) {
  const s = source.trim();
  const fileLike = /^([^:]+?)(?::(\d+))?$/.exec(s);
  if (fileLike && /[.\\/]/.test(fileLike[1])) {
    const rel = posix(fileLike[1]);
    if (isAbsolute(rel) || rel.split('/').includes('..')) return { ok: false, why: '来源路径越出工程范围' };
    const abs = join(root, rel);
    if (!(await pathExists(abs))) return { ok: false, why: `工程内没有这个文件：${rel}` };
    if (fileLike[2]) {
      const line = Number(fileLike[2]);
      const text = await readFile(abs, 'utf8').catch(() => '');
      const total = text === '' ? 0 : text.split(/\r?\n/).length;
      if (line < 1 || line > total) return { ok: false, why: `${rel} 只有 ${total} 行，取不到第 ${line} 行` };
    }
    return { ok: true };
  }
  if (/^[a-z0-9][a-z0-9-]*$/i.test(s)) {
    const rows = await readRegistryRows(root);
    const hit = rows.some((r) => r.obj?.record === 'run' && r.obj.runId === s);
    if (hit) return { ok: true };
    return { ok: false, why: `台账里没有 runId=${s}` };
  }
  if (s.length >= 4) return { ok: true };
  return { ok: false, why: '来源太短或格式不明' };
}

export { apply };
