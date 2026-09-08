// stage-ctrl ② —— 非线性阶段图插件
// research-engine preset 内嵌插件。拥有数据：project.yaml 的 stages / pipeline（entry + edges）。
// 工具：stage_read / stage_define / stage_goto（+ 服务 research.stageCtrl）。
// 自包含、可单独拷用：只吃一份阶段数据，可入参直给（不硬依赖 exp-ledger）。
// 图语义（确定性规则，见 SKILL）：fatal 违规拒绝写（define/goto 返回拒绝文本而非报错）；
// warn 仅由 read 报告：①fatal：阶段 id 重复 / 边端点未知 / 边重复 / 自环 / entry 未知 / entry 有入边；
// ②warn：有边但未设 entry / 从 entry 不可达 / 孤立占位阶段。终点（无出边）合法，如 report 阶段。

import { createRequire } from 'node:module';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';

const dshHome = process.env.DSH_HOME || join(os.homedir(), '.dsh');
const requireFromHarness = createRequire(join(dshHome, 'profiles', 'node_modules', 'js-yaml', 'package.json'));
const yaml = requireFromHarness('js-yaml');

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const PRESET_ROOT = resolve(PLUGIN_DIR, '..', '..');
const CONTRACT_DIR = join(PRESET_ROOT, 'contract');

export const name = 'stage-ctrl';
export const inject = ['tools'];

function iso() { return new Date().toISOString(); }
function sha1(s) { return createHash('sha1').update(String(s)).digest('hex'); }
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
  const r = resolve(root);
  const q = resolve(p);
  const rel = relative(r, q);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..');
}

// ---------- 工程 graph 读写 ----------
async function readProjectGraph(root) {
  const p = join(root, 'project.yaml');
  if (!(await pathExists(p))) {
    const e = new Error(`工程缺少 project.yaml（${p}）。先用 research_project op=init 生成骨架。`);
    e.code = 'PROJECT_MISSING';
    throw e;
  }
  let doc;
  try { doc = yaml.load(await readFile(p, 'utf8')); } catch (err) { throw new Error(`project.yaml 解析失败: ${err.message}`); }
  const stages = Array.isArray(doc?.stages) ? doc.stages.filter((s) => s && typeof s === 'object') : [];
  const edges = Array.isArray(doc?.pipeline?.edges) ? doc.pipeline.edges.filter((e) => e && typeof e === 'object') : [];
  const entry = doc?.pipeline?.entry ?? null;
  return { doc, stages, edges, entry: entry === '' ? null : entry, root };
}
async function writeProjectGraph(root, doc) {
  const body = yaml.dump(doc, { lineWidth: 120, noRefs: true, skipInvalid: true });
  await atomicWrite(join(root, 'project.yaml'), body);
}

// ---------- 图校验 ----------
function graphIssues(stages, entry, edges) {
  const fatal = [];
  const warn = [];
  const ids = stages.map((s) => s?.id).filter((x) => typeof x === 'string');
  const idSet = new Set();
  for (const id of ids) {
    if (idSet.has(id)) fatal.push(`阶段 id 重复: ${id}`);
    idSet.add(id);
  }
  const edgeKeys = new Set();
  for (const e of edges) {
    if (typeof e?.from !== 'string' || typeof e?.to !== 'string') { fatal.push('边缺少 from/to 字符串'); continue; }
    const key = `${e.from}->${e.to}`;
    if (edgeKeys.has(key)) fatal.push(`边重复: ${key}`);
    edgeKeys.add(key);
    if (e.from === e.to) fatal.push(`自环不允许: ${key}`);
    if (!idSet.has(e.from)) fatal.push(`边起点不是已知阶段: ${e.from}`);
    if (!idSet.has(e.to)) fatal.push(`边终点不是已知阶段: ${e.to}`);
  }
  if (entry != null && entry !== '') {
    if (!idSet.has(entry)) fatal.push(`entry 不是已知阶段: ${entry}`);
    else if (edges.some((e) => e.to === entry)) fatal.push(`entry 有入边（入口歧义）: ${entry}`);
  }
  if (edges.length > 0 && stages.length > 0 && (entry == null || entry === '')) {
    warn.push('已有边但未设置 pipeline.entry（建议指定入口阶段）');
  }
  if (entry && entry !== '' && idSet.has(entry) && edges.length > 0) {
    // 从 entry 沿有向边 BFS（允许环）
    const adj = new Map();
    for (const e of edges) {
      if (!adj.has(e.from)) adj.set(e.from, []);
      adj.get(e.from).push(e.to);
    }
    const seen = new Set([entry]);
    const queue = [entry];
    while (queue.length) {
      const cur = queue.shift();
      for (const next of adj.get(cur) || []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    for (const id of ids) {
      if (!seen.has(id)) {
        const hasIncident = edges.some((e) => e.from === id || e.to === id);
        if (hasIncident) warn.push(`从入口不可达的阶段: ${id}`);
        else warn.push(`孤立占位阶段（尚无任何边）: ${id} —— 属于构建期状态，接入边后解除`);
      }
    }
  }
  return { fatal, warn };
}
function graphText(root, { stages, edges, entry }, state, issues) {
  const lines = [];
  lines.push(`阶段图（root=${root}）`);
  lines.push(`入口: ${entry || '（未设置）'}   阶段 ${stages.length} 个   边 ${edges.length} 条`);
  if (state?.stage) lines.push(`当前阶段: ${state.stage}${state.updatedAt ? '（' + state.updatedAt.slice(0, 16).replace('T', ' ') + '）' : ''}`);
  for (const s of stages) lines.push(`  - ${s.id}  ${s.name || ''}${s.description ? ' — ' + s.description : ''}`);
  for (const e of edges) lines.push(`  edge: ${e.from} → ${e.to}`);
  if (issues.fatal.length) lines.push('fatal（需修复，写操作将被拒）:'); for (const f of issues.fatal) lines.push(`  [fatal] ${f}`);
  if (issues.warn.length) lines.push('warn（提示）:'); for (const w of issues.warn) lines.push(`  [warn] ${w}`);
  if (!issues.fatal.length && !issues.warn.length) lines.push('图合规：无 fatal、无 warn。');
  return lines.join('\n');
}

// ---------- 会话内当前阶段状态（持久于工程内 .research/state.json）----------
async function readState(root) {
  const p = join(root, '.research', 'state.json');
  if (!(await pathExists(p))) return { stage: null, history: [] };
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return { stage: null, history: [] }; }
}
async function writeState(root, state) {
  await atomicWrite(join(root, '.research', 'state.json'), JSON.stringify(state, null, 2));
}

// ---------- 服务 research.stageCtrl ----------
function buildService() {
  return {
    async read(args, exec) {
      // 最独立：入参直给（stages/edges/entry 提供即用，不落盘）
      if (args && (Array.isArray(args.stages) || Array.isArray(args.edges))) {
        const stages = Array.isArray(args.stages) ? args.stages : [];
        const edges = Array.isArray(args.edges) ? args.edges : [];
        const entry = typeof args.entry === 'string' && args.entry !== '' ? args.entry : null;
        const issues = graphIssues(stages, entry, edges);
        return { ok: true, text: graphText('(inline)', { stages, edges, entry }, null, issues), data: { inline: true, stages, edges, entry, issues } };
      }
      const root = await projectRootOf(args, exec);
      const { doc, stages, edges, entry } = await readProjectGraph(root);
      const issues = graphIssues(stages, entry, edges);
      const state = await readState(root);
      return { ok: true, text: graphText(root, { stages, edges, entry }, state, issues), data: { root, stages, edges, entry, state, issues } };
    },
    async define(args, exec) {
      const root = await projectRootOf(args, exec);
      const { doc, stages, edges, entry } = await readProjectGraph(root);
      const action = args?.action || 'stage';
      const changed = [];
      if (action === 'stage') {
        const id = typeof args?.id === 'string' && args.id.trim() ? args.id.trim() : null;
        if (!id) return { ok: false, text: 'stage_define (stage) 缺少必填 id（kebab-case）。' };
        if (stages.some((s) => s.id === id)) return { ok: false, text: `阶段已存在（id=${id}）：如需改名请先删除再定义。当前阶段图未改动。` };
        const name = typeof args?.name === 'string' && args.name.trim() ? args.name.trim() : id;
        stages.push({ id, name, ...(typeof args?.description === 'string' && args.description.trim() ? { description: args.description.trim() } : {}) });
        changed.push(`新增阶段 ${id}`);
      } else if (action === 'edge') {
        const from = typeof args?.from === 'string' ? args.from.trim() : '';
        const to = typeof args?.to === 'string' ? args.to.trim() : '';
        if (!from || !to) return { ok: false, text: 'stage_define (edge) 缺少 from/to。' };
        if (edges.some((e) => e.from === from && e.to === to)) return { ok: false, text: `边已存在（${from}->${to}）。` };
        edges.push({ from, to });
        changed.push(`新增边 ${from} → ${to}`);
      } else {
        return { ok: false, text: `未知 action：${action}（支持 stage / edge）。` };
      }
      const nextEntry = typeof args?.entry === 'string' && args.entry.trim() ? args.entry.trim() : entry;
      const issues = graphIssues(stages, nextEntry, edges);
      if (issues.fatal.length) {
        return { ok: false, text: `拒绝写入：载入即校验失败。\n${issues.fatal.map((f) => '  [fatal] ' + f).join('\n')}\n（当前阶段图未改动；请先修复或提供合法 entry。）` };
      }
      doc.stages = stages;
      doc.pipeline = { ...(doc.pipeline || {}), entry: nextEntry, edges };
      await writeProjectGraph(root, doc);
      const warns = issues.warn.length ? '\n' + issues.warn.map((w) => '  [warn] ' + w).join('\n') : '';
      return { ok: true, text: `已写入：${changed.join('；')}。图校验通过（fatal=0）。${warns ? '提示：' + warns : ''}`, data: { root, entry: nextEntry, warn: issues.warn } };
    },
    async goto(args, exec) {
      const root = await projectRootOf(args, exec);
      const { stages, edges } = await readProjectGraph(root);
      const to = typeof args?.to === 'string' && args.to.trim() ? args.to.trim() : null;
      if (!to) return { ok: false, text: 'stage_goto 缺少 to（目标阶段 id）。' };
      const state = await readState(root);
      const from = typeof args?.from === 'string' && args.from.trim() ? args.from.trim() : state?.stage || null;
      if (!from) return { ok: false, text: `无法跳转：当前阶段未知（${state?.stage ?? 'null'}）。先用 research_go op=read 查看，或显式传 from。` };
      const legal = edges.some((e) => e.from === from && e.to === to);
      if (!legal) {
        return { ok: false, text: `拒绝跳转：${from} → ${to} 不在 pipeline.edges 中（非法边不放行）。当前仍在 ${from}。合法去向：${edges.filter((e) => e.from === from).map((e) => e.to).join(', ') || '无'}。若确需该跳转，先用 stage_define action=edge from=${from} to=${to} 定义边。` };
      }
      state.stage = to;
      state.from = from;
      state.updatedAt = iso();
      state.history = Array.isArray(state.history) ? state.history : [];
      state.history.push({ from, to, ts: iso() });
      if (state.history.length > 200) state.history = state.history.slice(-200);
      await writeState(root, state);
      return { ok: true, text: `stage_goto：${from} → ${to} 已生效（合法边）。当前阶段：${to}。`, data: { root, from, to, stage: to } };
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
  const service = buildService();
  ctx.provide('research.stageCtrl', service);

  registerTextTool(ctx, {
    name: 'stage_read',
    description: '读取阶段图：阶段、可达边、入口、当前阶段与图校验（fatal/warn）。可从工程 project.yaml 读取，也可入参直给（stages/edges/entry，最独立用法，不落盘）。',
    properties: {
      project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      stages: { type: 'array', description: '可选内联阶段列表 [{id,name,description?}]（与 project 二选一）。' },
      edges: { type: 'array', description: '可选内联边列表 [{from,to}]。' },
      entry: { type: 'string', description: '可选内联入口阶段 id。' },
    },
    execute: async (args, exec) => service.read(args, exec),
    presentCall: (args) => genericCall(`读阶段图${args.project ? ' @' + args.project : ''}`, 'read', [underProject(args.project, 'project.yaml')]),
  });

  registerTextTool(ctx, {
    name: 'stage_define',
    description: '加阶段或加边（action=stage|edge），写出的图载入即校验；fatal 违规（id 重复/端点未知/边重复/自环/entry 未知/entry 有入边）→ 拒绝返回文本而不写入。新阶段可先进场（孤立占位仅 warn），再接边。可带 entry 声明入口。',
    properties: {
      project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      action: { type: 'string', description: 'stage（加阶段，默认）| edge（加边）。' },
      id: { type: 'string', description: 'action=stage 时的阶段 id（kebab-case）。' },
      name: { type: 'string', description: 'action=stage 时的显示名（默认=id）。' },
      description: { type: 'string', description: 'action=stage 时的说明。' },
      from: { type: 'string', description: 'action=edge 时的起点阶段 id。' },
      to: { type: 'string', description: 'action=edge 时的终点阶段 id。' },
      entry: { type: 'string', description: '可选：设置/更新 pipeline.entry（入口阶段）。' },
    },
    execute: async (args, exec) => service.define(args, exec),
    presentCall: (args) => genericCall(`阶段图 ${args.action ?? 'stage'} ${args.id ?? (args.from && args.to ? args.from + '→' + args.to : '')}`.trim(), 'edit', [underProject(args.project, 'project.yaml')]),
  });

  registerTextTool(ctx, {
    name: 'stage_goto',
    description: '非线性阶段导航：只放行 pipeline.edges 里存在的边（from→to）；非法边返回拒绝文本而非报错；合法回跳（沿已定义的反向/横向边）允许。成功后在工程内 .research/state.json 记录当前阶段与历史。',
    properties: {
      project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      from: { type: 'string', description: '起点阶段 id；缺省 = 当前阶段。' },
      to: { type: 'string', description: '目标阶段 id（必填）。' },
    },
    required: ['to'],
    execute: async (args, exec) => service.goto(args, exec),
    presentCall: (args) => genericCall(`阶段跳转 ${args.from ?? '当前'} → ${args.to}`, 'edit', [underProject(args.project, '.research/state.json'), underProject(args.project, 'project.yaml')]),
  });
}

export { apply };
