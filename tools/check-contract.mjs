// 契约自检（阶段 0 验收）：
// 1) 七份 schema 全部可编译；2) 互相引用无环；3) 用真实工程数据做"目标形态"校验并输出差距清单。
// 用法：node tools/check-contract.mjs [<目标工程根>]
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
// 默认读仓库里的 preset（唯一真源）；RESEARCH_ENGINE_PRESET 可指向别处（例如已安装的副本）。
const PRESET = process.env.RESEARCH_ENGINE_PRESET || join(REPO, 'presets', 'research-engine');
const CONTRACT = join(PRESET, 'contract');

const requireFromHarness = createRequire(join(DSH_HOME, 'profiles', 'node_modules', 'js-yaml', 'package.json'));
const Ajv2020 = requireFromHarness('ajv/dist/2020');
const yaml = requireFromHarness('js-yaml');

const SEVEN = [
  'project.schema.json',
  'pipeline.schema.json',
  'templates.schema.json',
  'conventions.schema.json',
  'manifest.schema.json',
  'observations.schema.json',
  'note.schema.json',
];

const problems = [];
const schemas = new Map();
for (const f of SEVEN) {
  let doc;
  try {
    doc = JSON.parse(await readFile(join(CONTRACT, f), 'utf8'));
  } catch (e) {
    problems.push(`[parse] ${f}: ${e.message}`);
    continue;
  }
  if (typeof doc.$id !== 'string') problems.push(`[id] ${f}: 缺少 $id`);
  schemas.set(f, doc);
}

// --- 引用图（跨文件 $ref）---
const edges = new Map();
for (const [f, doc] of schemas) {
  const refs = new Set();
  const walk = (n) => {
    if (n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    for (const [k, v] of Object.entries(n)) {
      if (k === '$ref' && typeof v === 'string' && !v.startsWith('#')) refs.add(v.split('#')[0]);
      else walk(v);
    }
  };
  walk(doc);
  edges.set(f, refs);
}
const byId = new Map([...schemas].map(([f, d]) => [d.$id, f]));
const cycle = (() => {
  const state = new Map();
  const stack = [];
  let found = null;
  const visit = (f) => {
    if (found) return;
    const st = state.get(f) ?? 0;
    if (st === 1) { found = [...stack.slice(stack.indexOf(f)), f]; return; }
    if (st === 2) return;
    state.set(f, 1); stack.push(f);
    for (const r of edges.get(f) ?? []) {
      const t = byId.get(r);
      if (t) visit(t);
      else problems.push(`[ref] ${f}: 引用未纳入契约集的 $id ${r}`);
    }
    stack.pop(); state.set(f, 2);
  };
  for (const f of schemas.keys()) visit(f);
  return found;
})();
if (cycle) problems.push(`[cycle] schema 引用成环：${cycle.join(' -> ')}`);

// --- 编译 ---
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validators = new Map();
for (const [f, doc] of schemas) ajv.addSchema(doc, doc.$id ?? f);
for (const [f, doc] of schemas) {
  try { validators.set(f, ajv.getSchema(doc.$id)); }
  catch (e) { problems.push(`[compile] ${f}: ${e.message}`); }
}

console.log(`契约自检：纳入 ${schemas.size}/${SEVEN.length} 份 schema`);
console.log(`跨文件引用：${[...edges].map(([f, r]) => `${f} -> ${r.size}`).join(' | ')}`);
console.log(cycle ? `引用成环：${cycle.join(' -> ')}` : '引用无环：OK');

// --- 真实数据目标形态校验（允许失败，只输出差距清单）---
const root = process.argv[2];
if (root) {
  const rd = async (p) => { try { return await readFile(join(root, p), 'utf8'); } catch { return null; } };
  const loadYaml = (t) => { try { return yaml.load(t); } catch (e) { problems.push(`[yaml] ${e.message}`); return null; } };
  const report = (label, file, doc) => {
    const v = validators.get(file);
    if (!v) { console.log(`\n== ${label} == 无校验器`); return; }
    if (doc === null) { console.log(`\n== ${label} == 文件缺失`); return; }
    const ok = v(doc);
    console.log(`\n== ${label} == ${ok ? '目标形态：通过' : `目标形态：${(v.errors ?? []).length} 项差距`}`);
    for (const e of (v.errors ?? []).slice(0, 40)) console.log(`   ${e.instancePath || '/'} ${e.message}`);
  };
  const pj = await rd('project.yaml');
  report('project.yaml', 'project.schema.json', pj ? loadYaml(pj) : null);
  const pl = await rd('pipeline.yaml');
  report('pipeline.yaml', 'pipeline.schema.json', pl ? loadYaml(pl) : null);
  const tp = await rd('templates.yaml');
  report('templates.yaml', 'templates.schema.json', tp ? loadYaml(tp) : null);
  // 约定 / 笔记 / run 目录（尽力而为）
  if (pj) {
    const doc = loadYaml(pj);
    if (doc && Array.isArray(doc.conventions) && doc.conventions.length) {
      const cv = validators.get('conventions.schema.json');
      let bad = 0;
      for (const c of doc.conventions) if (!cv({ schemaVersion: 3, ...c })) bad += 1;
      console.log(`\n== conventions[] == ${bad === 0 ? '通过' : bad + ' 条不符合目标形态'}`);
    }
  }
  try {
    const notes = await readdir(join(root, '.kb', 'notes'));
    const nv = validators.get('note.schema.json');
    let ok = 0, bad = 0, missing = 0;
    for (const n of notes.filter((x) => x.endsWith('.md'))) {
      const raw = await readFile(join(root, '.kb', 'notes', n), 'utf8');
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
      if (!m) { missing += 1; continue; }
      const fm = loadYaml(m[1]);
      if (nv({ schemaVersion: 3, ...fm })) ok += 1; else bad += 1;
    }
    console.log(`\n== .kb/notes == 目标形态通过 ${ok}｜不符合 ${bad}｜无 frontmatter ${missing}`);
  } catch { console.log('\n== .kb/notes == 目录缺失'); }
}

console.log('\n--- 问题清单 ---');
if (!problems.length) console.log('（无）');
for (const p of problems) console.log(' ' + p);
process.exit(problems.some((p) => /\[cycle\]|\[compile\]|\[parse\]|\[ref\]/.test(p)) ? 1 : 0);
