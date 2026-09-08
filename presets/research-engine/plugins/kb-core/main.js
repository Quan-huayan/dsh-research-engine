// kb-core —— 知识 / 裁决 / 渲染（4 工具）
//
// 拥有数据：.kb/notes/*.md（提议与结论）、skills/<project>/SKILL.md、_report/*、.kb/index.yaml（三者都是派生视图）。
// 权威分离：agent 提议只能 status=proposed；升级只有两条路——证据可解析（→证据权威）或用户裁决（→用户权威）。
// 位置即权威：提议只放数据位置（.kb/），不得放环境位置（project.yaml / skills 由工具渲染）。

import { join, dirname, basename, relative, resolve, sep } from 'node:path';
import { readFile, writeFile, mkdir, stat, rename, readdir } from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
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
const SCHEMA_VERSION = 3;
const NOTES = '.kb/notes';
const REGISTRY = 'registry.jsonl';
// 词边界替换：不误伤用户数据里的同形子串（如 usergit-probe / shanghai），但独立出现的版本库词汇一律替换。
const SCRUB = /(^|[^A-Za-z0-9_-])(git|commit|HEAD|diff|hash|sha)(?![A-Za-z0-9_-])/gi;

export const name = 'kb-core';
export const inject = ['tools'];

function iso() { return new Date().toISOString(); }
function sha256(s) { return createHash('sha256').update(s).digest('hex'); }
function scrub(t) { return String(t ?? '').replace(SCRUB, (_m, pre) => `${pre}·`); }
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
async function readJson(p, fallback) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; } }

function parseNote(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { front: null, body: raw };
  let front = null;
  try { front = yaml.load(m[1]); } catch { front = null; }
  return { front: front && typeof front === 'object' ? front : null, body: m[2] };
}
function renderNote(front, body) {
  return `---\n${yaml.dump(front, { lineWidth: -1, noRefs: true, skipInvalid: true })}---\n\n${String(body ?? '').replace(/^\n+/, '')}\n`;
}

function buildService(ctx) {
  const led = () => ctx.get('research.expLedger');
  const eg = () => ctx.get('research.engineGit');

  async function listNotes(root) {
    const dir = join(root, NOTES);
    const out = [];
    if (!(await pathExists(dir))) return out;
    let names = [];
    try { names = await readdir(dir); } catch { return out; }
    for (const n of names.filter((x) => x.endsWith('.md')).sort()) {
      const raw = await readFile(join(dir, n), 'utf8');
      const p = parseNote(raw);
      out.push({ file: n, name: n.replace(/\.md$/, ''), raw, front: p.front, body: p.body });
    }
    return out;
  }

  async function resolvePointer(root, ptr) {
    const type = ptr?.type; const ref = typeof ptr?.ref === 'string' ? ptr.ref.trim() : '';
    if (!ref) return { ok: false, why: '指针为空' };
    if (type === 'run') {
      const fold = await led().ledgerFold(root);
      if (!fold.runs.has(ref)) return { ok: false, why: `台账里没有 runId=${ref}` };
      return { ok: true, display: `运行 ${ref}` };
    }
    if (type === 'observation') {
      const [rid, field] = ref.split('#');
      const fold = await led().ledgerFold(root);
      if (!fold.runs.has(rid)) return { ok: false, why: `台账里没有 runId=${rid}` };
      const p = join(root, 'experiments', rid, 'observations.json');
      if (!(await pathExists(p))) return { ok: false, why: `run ${rid} 还没有观察值` };
      const obs = await readJson(p, null);
      if (field && !(obs?.observations ?? []).some((o) => o.field === field)) {
        return { ok: false, why: `run ${rid} 没有观察字段 ${field}` };
      }
      return { ok: true, display: `观察 ${ref}` };
    }
    if (type === 'file') {
      const [rel, line] = ref.split(':');
      const clean = posix(rel);
      if (!isWithin(root, join(root, clean))) return { ok: false, why: `指针越出工程：${clean}` };
      const abs = join(root, clean);
      if (!(await pathExists(abs))) return { ok: false, why: `工程内没有这个文件：${clean}` };
      if (line) {
        const text = await readFile(abs, 'utf8').catch(() => '');
        const total = text === '' ? 0 : text.split(/\r?\n/).length;
        if (Number(line) < 1 || Number(line) > total) return { ok: false, why: `${clean} 只有 ${total} 行，取不到第 ${line} 行` };
      }
      return { ok: true, display: `文件 ${ref}` };
    }
    return { ok: false, why: `指针类型必须是 run / file / observation（收到 ${JSON.stringify(type)}）` };
  }

  async function writeNote(root, name, front, body) {
    const rel = posix(join(NOTES, `${name}.md`));
    await atomicWrite(join(root, rel), renderNote(front, body));
    return rel;
  }

  return {
    listNotes, resolvePointer, writeNote, parseNote, renderNote,

    /** 安全闸命中等场景由 task-dispatch 调用的教训写入。 */
    async recordLesson(args, exec) {
      const root = led().root(args, exec);
      const name = led().slugify(args?.name ?? 'lesson') || 'lesson';
      const front = {
        schemaVersion: SCHEMA_VERSION, name,
        kind: 'lesson', status: 'accepted', authority: 'evidence',
        description: String(args?.description ?? '教训').slice(0, 200),
        evidence: [], scope: 'engine-safety',
        createdAt: iso(), updatedAt: iso(),
      };
      const rel = await writeNote(root, name, front, String(args?.statement ?? args?.description ?? ''));
      const stored = eg().record(root, [rel], `note_write: ${name}`);
      await led().ledgerAppend(root, { record: 'note', name, kind: 'lesson', status: 'accepted', authority: 'evidence' }, { commit: stored.commit ?? undefined });
      return { ok: true, name, path: rel };
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
  ctx.provide('research.kbCore', svc);

  // ---------- note_write ----------
  registerTextTool(ctx, {
    name: 'note_write',
    description: '写一条知识记录：kind=proposal/claim/lesson/question。claim 必须有可解析的 evidence 与 scope；与已生效结论同 scope 冲突时只能写 proposal。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      kind: { type: 'string', enum: ['proposal', 'claim', 'lesson', 'question'], description: '记录类型。' },
      name: { type: 'string', description: '笔记名（kebab-case）。' },
      description: { type: 'string', description: '一句话摘要。' },
      statement: { type: 'string', description: '正文（主张/提议/教训/问题）。' },
      evidence: {
        type: 'array',
        description: '证据指针（claim 必填）。',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['run', 'file', 'observation'] },
            ref: { type: 'string', description: 'runId / 工程内相对路径（可带 :行） / runId#字段。' },
            note: { type: 'string' },
          },
        },
      },
      scope: { type: 'string', description: '成立条件 / 适用范围（claim 必填）。' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签。' },
      stage: { type: 'string', description: '所属阶段。' },
      overwrite: { type: 'boolean', description: '允许覆盖同名笔记。' },
    },
    required: ['kind', 'name', 'description', 'statement'],
    execute: async (args, exec) => {
      const led = ctx.get('research.expLedger');
      const eg = () => ctx.get('research.engineGit');
      const root = led.root(args, exec);
      try { await led.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const kind = args?.kind;
      if (!['proposal', 'claim', 'lesson', 'question'].includes(kind)) {
        return { text: '拒绝：kind 只能是 proposal / claim / lesson / question。' };
      }
      const name = led.slugify(args?.name ?? '');
      if (!name) return { text: '拒绝：笔记名非法。\n修法：用 kebab-case（小写字母、数字、连字符）。' };
      const description = typeof args?.description === 'string' ? args.description.trim() : '';
      const statement = typeof args?.statement === 'string' ? args.statement.trim() : '';
      if (!description) return { text: '拒绝：缺少 description。' };
      if (!statement) return { text: '拒绝：缺少 statement。' };
      const notes = await svc.listNotes(root);
      if (notes.some((n) => n.name === name) && args?.overwrite !== true) {
        return { text: `拒绝：笔记 ${name} 已存在。\n修法：换名，或加 overwrite=true 覆盖（状态会重置为 proposed）。` };
      }
      const evidence = Array.isArray(args?.evidence) ? args.evidence : [];
      if (kind === 'claim') {
        if (!evidence.length) {
          return { text: '拒绝：claim 必须带 evidence。\n修法：指向可复现的证据（runId / 已登记文件:行 / runId#字段）；没有证据的推断写成 kind=proposal。' };
        }
        if (typeof args?.scope !== 'string' || !args.scope.trim()) {
          return { text: '拒绝：claim 必须带 scope（成立条件）。\n修法：写清这条结论在什么条件下成立。' };
        }
      }
      const resolved = [];
      for (const e of evidence) {
        const r = await svc.resolvePointer(root, e);
        if (!r.ok) return { text: `拒绝：证据指针无法解析 —— ${r.why}\n修法：先确认证据确实存在（run_query / project_load），再写结论。` };
        resolved.push({ type: e.type, ref: String(e.ref).trim(), ...(e.note ? { note: String(e.note) } : {}) });
      }
      const scope = typeof args?.scope === 'string' ? args.scope.trim() : '';
      if (kind === 'claim') {
        const conflict = notes.find((n) => n.front?.kind === 'claim' && n.front?.status === 'accepted' && (n.front?.scope ?? '') === scope && n.name !== name);
        if (conflict) {
          return { text: `拒绝：范围「${scope}」已有生效结论 ${conflict.name}。\n修法：新结果与它冲突时必须显式提出——写成 kind=proposal（再由 note_adjudicate 裁决），不得静默合并。` };
        }
      }
      const guard = led.guard(root, ['.kb/**']);
      if (!guard.ok) return { text: guard.text };
      const front = {
        schemaVersion: SCHEMA_VERSION, name, kind, status: 'proposed', authority: 'agent',
        description, evidence: resolved, ...(scope ? { scope } : {}),
        ...(Array.isArray(args?.tags) && args.tags.length ? { tags: args.tags.map(String) } : {}),
        ...(typeof args?.stage === 'string' && args.stage.trim() ? { stage: args.stage.trim() } : {}),
        createdAt: iso(), updatedAt: iso(),
      };
      const rel = await svc.writeNote(root, name, front, statement);
      const stored = eg().record(root, [rel], `note_write: ${name}`);
      const rec = await led.ledgerAppend(root, { record: 'note', name, kind, status: 'proposed', authority: 'agent', evidence: resolved.map((e) => e.ref) }, { commit: stored.commit ?? undefined });
      return {
        text: [
          `已写入笔记：${rel}`,
          `类型：${kind}　状态：proposed　权威：agent`,
          ...(resolved.length ? [`证据：${resolved.map((e) => e.ref).join('、')}`] : []),
          ...(scope ? [`范围：${scope}`] : []),
          `台账第 ${rec.seq} 行。`,
          (kind === 'claim' || kind === 'proposal') ? '下一步：note_adjudicate（有可解析证据的 claim 可依证据生效；proposal 需用户裁决）。' : '',
        ].filter(Boolean).join('\n'),
      };
    },
    presentCall: (args) => genericCall(`写笔记 ${args?.name ?? ''}`.trim(), 'edit', [`${NOTES}/${args?.name ?? ''}.md`]),
  });

  // ---------- note_adjudicate ----------
  registerTextTool(ctx, {
    name: 'note_adjudicate',
    description: '裁决一条笔记：accept（生效）/ retract（撤回）/ supersede（被取代）。有可解析证据的 claim 可依证据生效；撤回已生效结论或取代结论必须带用户裁决。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      note: { type: 'string', description: '笔记名（不含扩展名）。' },
      action: { type: 'string', enum: ['accept', 'retract', 'supersede'], description: '裁决动作。' },
      supersedes: { type: 'string', description: 'action=supersede 时：被取代的笔记名。' },
      decision: {
        type: 'object',
        description: '需要用户权威时必须提供。',
        properties: { askCallId: { type: 'string' }, answer: { type: 'string' }, attested: { type: 'boolean' } },
      },
    },
    required: ['note', 'action'],
    execute: async (args, exec) => {
      const led = ctx.get('research.expLedger');
      const eg = () => ctx.get('research.engineGit');
      const root = led.root(args, exec);
      try { await led.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const name = led.slugify(args?.note ?? '');
      const action = args?.action;
      if (!['accept', 'retract', 'supersede'].includes(action)) return { text: '拒绝：action 只能是 accept / retract / supersede。' };
      const notes = await svc.listNotes(root);
      const note = notes.find((n) => n.name === name);
      if (!note || !note.front) return { text: `拒绝：找不到带结构头的笔记 ${name}。` };
      const front = { ...note.front };
      const cur = front.status ?? 'proposed';
      if (['superseded', 'retracted'].includes(cur)) return { text: `拒绝：笔记 ${name} 已是 ${cur}，不能再次裁决（状态只前进，不回头）。` };
      let decision = null;
      const hasEvidence = Array.isArray(front.evidence) && front.evidence.length > 0;
      const needsUser = action === 'retract' || action === 'supersede'
        || (action === 'accept' && !hasEvidence);
      if (needsUser) {
        const v = led.verifyDecision(exec, args?.decision ?? {});
        if (!v.ok) {
          const why = action === 'accept'
            ? '这条笔记没有任何证据指针，生效只能由用户裁决'
            : action === 'retract' ? '撤回已生效结论必须由用户裁决' : '取代一条结论必须由用户裁决';
          return { text: `${v.text}\n（${why}。）` };
        }
        decision = v.decision;
      } else {
        for (const e of front.evidence ?? []) {
          const r = await svc.resolvePointer(root, e);
          if (!r.ok) return { text: `拒绝：证据已失效 —— ${r.why}\n修法：先补齐证据，再裁决。` };
        }
      }
      const guard = led.guard(root, ['.kb/**']);
      if (!guard.ok) return { text: guard.text };
      const touch = [posix(join(NOTES, `${name}.md`))];
      if (action === 'accept') {
        front.status = 'accepted';
        front.authority = decision ? 'user' : 'evidence';
        if (decision) front.decidedBy = decision;
      } else if (action === 'retract') {
        front.status = 'retracted';
        front.authority = 'user';
        front.decidedBy = decision;
      } else {
        const target = led.slugify(args?.supersedes ?? '');
        if (!target) return { text: '拒绝：supersede 必须给出 supersedes（被取代的笔记名）。' };
        const old = notes.find((n) => n.name === target);
        if (!old || !old.front) return { text: `拒绝：找不到被取代的笔记 ${target}。` };
        if ((old.front.status ?? 'proposed') !== 'accepted') return { text: `拒绝：${target} 当前不是 accepted，不能被取代。` };
        front.status = 'accepted';
        front.authority = 'user';
        front.decidedBy = decision;
        front.supersedes = [...new Set([...(front.supersedes ?? []), target])];
        const oldFront = { ...old.front, status: 'superseded', supersededBy: name, updatedAt: iso() };
        touch.push(await svc.writeNote(root, target, oldFront, old.body));
      }
      front.updatedAt = iso();
      const rel = await svc.writeNote(root, name, front, note.body);
      const stored = eg().record(root, [...new Set([rel, ...touch])], `note_adjudicate: ${name} ${action}`);
      const rec = await led.ledgerAppend(root, { record: 'note', name, kind: front.kind, status: front.status, authority: front.authority, ...(decision ? { decidedBy: decision } : {}) }, { commit: stored.commit ?? undefined, actor: decision ? 'user' : 'engine' });
      if (decision) {
        await led.ledgerAppend(root, {
          record: 'decision', kind: 'note', id: name,
          askCallId: decision.askCallId, question: decision.question, answer: decision.answer,
          sessionId: decision.sessionId, ...(decision.attested ? { attested: true } : {}),
        }, { actor: 'user' });
      }
      return {
        text: [
          `笔记 ${name} 状态：${cur} → ${front.status}（权威：${front.authority}）`,
          ...(decision ? [`用户答复原文：${decision.answer}`] : ['依据：证据逐条复核可解析']),
          ...(action === 'supersede' ? [`被取代：${args.supersedes}（状态置 superseded，内容保留）`] : []),
          '建议：view_render 重新生成派生视图。',
          `台账第 ${rec.seq} 行。`,
        ].join('\n'),
      };
    },
    presentCall: (args) => genericCall(`裁决笔记 ${args?.note ?? ''}`.trim(), 'edit', [`${NOTES}/${args?.note ?? ''}.md`]),
  });

  // ---------- note_query ----------
  registerTextTool(ctx, {
    name: 'note_query',
    description: '只读检索笔记：默认只列已生效（accepted）结论，proposed 单列并标状态；可按 kind/status/scope/证据过滤。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      kind: { type: 'string', description: '按类型过滤。' },
      status: { type: 'string', description: '按状态过滤；缺省只返回 accepted。' },
      scope: { type: 'string', description: '按范围过滤。' },
      evidence: { type: 'string', description: '按证据指针过滤（runId 或文件路径片段）。' },
      query: { type: 'string', description: '在名称/摘要/正文里做子串匹配。' },
      limit: { type: 'number', description: '返回条数上限（默认 30）。' },
    },
    execute: async (args, exec) => {
      const led = ctx.get('research.expLedger');
      const root = led.root(args, exec);
      try { await led.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const all = await svc.listNotes(root);
      const limit = Number.isFinite(Number(args?.limit)) && Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 30;
      const match = (n) => {
        const f = n.front ?? {};
        if (typeof args?.kind === 'string' && f.kind !== args.kind) return false;
        if (typeof args?.scope === 'string' && (f.scope ?? '') !== args.scope) return false;
        if (typeof args?.evidence === 'string') {
          if (!(f.evidence ?? []).some((e) => String(e?.ref ?? '').includes(args.evidence))) return false;
        }
        if (typeof args?.query === 'string' && args.query.trim()) {
          const q = args.query.trim().toLowerCase();
          if (!`${n.name} ${f.description ?? ''} ${n.body}`.toLowerCase().includes(q)) return false;
        }
        return true;
      };
      const pool = all.filter(match);
      const wanted = typeof args?.status === 'string' ? args.status : null;
      const accepted = wanted ? pool.filter((n) => (n.front?.status ?? 'proposed') === wanted) : pool.filter((n) => (n.front?.status ?? 'proposed') === 'accepted');
      const proposed = wanted ? [] : pool.filter((n) => (n.front?.status ?? 'proposed') === 'proposed');
      const other = wanted ? [] : pool.filter((n) => !['accepted', 'proposed'].includes(n.front?.status ?? 'proposed'));
      const fmt = (n) => {
        const f = n.front ?? {};
        return `- ${n.name}　[${f.kind ?? '?'} / ${f.status ?? '?'} / ${f.authority ?? '?'}]　${f.description ?? ''}`
          + ((f.evidence ?? []).length ? `　证据：${(f.evidence ?? []).map((e) => e.ref).join('、')}` : '')
          + (f.scope ? `　范围：${f.scope}` : '')
          + (f.decidedBy ? `　裁决：${f.decidedBy.answer}` : '');
      };
      const lines = [];
      if (wanted) {
        if (accepted.length) lines.push(`匹配 status=${wanted} 的笔记 ${accepted.length} 条：`, ...accepted.slice(0, limit).map(fmt));
        else lines.push(`没有 status=${wanted} 的笔记。`);
      } else {
        if (accepted.length) lines.push(`生效结论 ${accepted.length} 条：`, ...accepted.slice(0, limit).map(fmt));
        else lines.push('没有生效结论。');
        if (proposed.length) lines.push('', `待裁决（proposed，尚不生效、不得当规则引用）${proposed.length} 条：`, ...proposed.slice(0, limit).map(fmt));
        if (other.length) lines.push('', `已失效 / 被取代 ${other.length} 条：`, ...other.slice(0, limit).map(fmt));
      }
      return { text: lines.join('\n') };
    },
    presentCall: () => genericCall('检索知识库', 'read', [NOTES]),
  });

  // ---------- view_render ----------
  registerTextTool(ctx, {
    name: 'view_render',
    description: '渲染派生视图（唯一写入者）：kind=notes-skill 生成工程笔记；report 生成运行报表；index 生成笔记索引。三者头部都标「派生视图 + 生成时间 + 来源」。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      kind: { type: 'string', enum: ['notes-skill', 'report', 'index'], description: '派生视图类型。' },
    },
    required: ['kind'],
    execute: async (args, exec) => {
      const led = ctx.get('research.expLedger');
      const eg = () => ctx.get('research.engineGit');
      const root = led.root(args, exec);
      try { await led.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const kind = args?.kind;
      if (!['notes-skill', 'report', 'index'].includes(kind)) return { text: '拒绝：kind 只能是 notes-skill / report / index。' };
      const doc = await led.readProject(root);
      const projectId = doc.project?.id ?? basename(root);
      const notes = await svc.listNotes(root);
      const stamp = iso();
      let paths = []; let count = 0; let pending = 0;

      if (kind === 'notes-skill') {
        const convs = (Array.isArray(doc.conventions) ? doc.conventions : []).filter((c) => (c.status ?? 'active') === 'active');
        const claims = notes.filter((n) => n.front?.kind === 'claim' && n.front?.status === 'accepted');
        pending = notes.filter((n) => (n.front?.status ?? 'proposed') === 'proposed').length;
        const lines = [
          `# ${doc.project?.name ?? projectId} —— 工程笔记`,
          '',
          `> 派生视图：由工具从「生效约定 + 已生效结论」渲染，生成时间 ${stamp}，来源：工程约定与知识记录。`,
          '> 请勿手改本文件（手改会被体检点名）；知识变化后重新渲染即可。',
          '',
          '## 生效约定（用户权威）',
        ];
        if (!convs.length) lines.push('', '（暂无）');
        for (const c of convs) {
          lines.push('', `### ${c.statement}`, `- 范围：${c.scope ?? '全工程'}`, `- 来源：${c.source}`, `- 依据答复：${c.decision?.answer ?? '（缺失）'}`, `- 标识：${c.id}`);
        }
        lines.push('', '## 已生效结论（证据权威）');
        if (!claims.length) lines.push('', '（暂无）');
        for (const n of claims) {
          const f = n.front;
          lines.push('', `### ${f.description}`,
            `- 主张：${String(n.body).trim().split(/\r?\n/)[0] ?? ''}`,
            `- 成立条件：${f.scope ?? '（未写）'}`,
            `- 证据：${(f.evidence ?? []).map((e) => e.ref).join('、') || '（无）'}`,
            `- 标识：${n.name}`);
        }
        lines.push('', '## 待裁决', '', pending ? `共 ${pending} 条提议尚未裁决（不进本文件的结论区）。` : '（无）', '');
        const rel = posix(join('skills', projectId, 'SKILL.md'));
        await atomicWrite(join(root, rel), lines.join('\n'));
        paths = [rel]; count = convs.length + claims.length;
      } else if (kind === 'report') {
        const fold = await led.ledgerFold(root);
        const runs = [...fold.runs.values()];
        const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const rows = [['runId', '模板', '阶段', '状态', '参数', '产出数', '观察值', '说明'].join(',')];
        for (const r of runs) {
          const man = await readJson(join(root, 'experiments', r.runId, 'manifest.json'), { entries: [] });
          const obs = await readJson(join(root, 'experiments', r.runId, 'observations.json'), { observations: [] });
          rows.push([cell(r.runId), cell(r.template), cell(r.stage ?? ''), cell(r.status), cell(JSON.stringify(r.params ?? {})),
            cell((man.entries ?? []).length), cell((obs.observations ?? []).map((o) => `${o.field}=${o.value}`).join('; ')), cell(r.detail ?? '')].join(','));
        }
        await atomicWrite(join(root, '_report', 'runs.csv'), `\ufeff${rows.join('\n')}\n`);
        const proposals = notes.filter((n) => (n.front?.status ?? 'proposed') === 'proposed');
        pending = proposals.length;
        const summary = {
          derived: true, generatedAt: stamp, source: 'registry.jsonl',
          project: projectId,
          counts: {
            runs: runs.length,
            done: runs.filter((r) => r.status === 'done').length,
            failed: runs.filter((r) => r.status === 'failed').length,
            invalidated: runs.filter((r) => r.status === 'invalidated').length,
          },
          runs: runs.map((r) => ({ runId: r.runId, template: r.template, stage: r.stage ?? null, status: r.status, detail: r.detail ?? null })),
          pendingAdjudication: proposals.map((n) => ({ name: n.name, kind: n.front?.kind, description: n.front?.description })),
          conflicts: runs.filter((r) => r.status === 'failed').map((r) => ({ runId: r.runId, detail: r.detail ?? null })),
        };
        await atomicWrite(join(root, '_report', 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
        paths = ['_report/runs.csv', '_report/summary.json']; count = runs.length;
      } else {
        const items = notes.map((n) => ({
          name: n.name, kind: n.front?.kind ?? null, status: n.front?.status ?? null,
          authority: n.front?.authority ?? null, description: n.front?.description ?? null,
          scope: n.front?.scope ?? null,
          evidence: (n.front?.evidence ?? []).map((e) => e.ref),
          updatedAt: n.front?.updatedAt ?? null,
        }));
        const idx = {
          derived: true, generatedAt: stamp, source: '.kb/notes',
          count: items.length,
          byStatus: items.reduce((acc, i) => { const k = i.status ?? 'unknown'; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
          notes: items,
        };
        pending = items.filter((i) => i.status === 'proposed').length;
        await atomicWrite(join(root, '.kb', 'index.yaml'), yaml.dump(idx, { lineWidth: -1, noRefs: true }));
        paths = ['.kb/index.yaml']; count = items.length;
      }
      const stored = eg().record(root, paths, `view_render: ${kind}`);
      const rec = await led.ledgerAppend(root, { record: 'render', kind, paths, count }, { commit: stored.commit ?? undefined });
      return {
        text: [
          `已渲染派生视图（${kind}）：${paths.join('、')}`,
          `条目数：${count}${pending ? `　待裁决：${pending}` : ''}`,
          `生成时间：${stamp}（文件头已标注「派生视图」）`,
          `台账第 ${rec.seq} 行。`,
        ].join('\n'),
      };
    },
    presentCall: (args) => genericCall(`渲染派生视图（${args?.kind ?? '?'}）`, 'edit', []),
  });
}

export { apply };
