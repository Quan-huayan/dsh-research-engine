// exp-ledger ① —— 项目/实体 ledger 插件
// research-engine preset 内嵌插件（相对路径行加载，免安装、免重启）。
// 拥有数据：project.yaml（骨架过 contract/project.schema.json）+ registry.jsonl。
// 工具：project_load / project_init / entity_query / entity_write（+ 服务 research.expLedger）。
// 自包含：不 import 兄弟插件文件，可单独拷进其它 preset 使用（read+write 成对）。
// 模块加载：本文件位于用户主目录 preset 内，Node 向上查找 node_modules 够不到 harness，
// 故用 createRequire 锚定 $DSH_HOME/profiles/node_modules（DSH 维护的扁平回退目录）取 js-yaml/ajv。

import { createRequire } from 'node:module';
import { join, dirname, resolve, relative, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, readdir, stat, rename } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';

const dshHome = process.env.DSH_HOME || join(os.homedir(), '.dsh');
const flatRoot = join(dshHome, 'profiles', 'node_modules');
const requireFromHarness = createRequire(join(flatRoot, 'js-yaml', 'package.json'));
const yaml = requireFromHarness('js-yaml');
let Ajv2020 = null;
try { Ajv2020 = requireFromHarness('ajv/dist/2020'); } catch { Ajv2020 = null; }

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const PRESET_ROOT = resolve(PLUGIN_DIR, '..', '..');
const CONTRACT_DIR = join(PRESET_ROOT, 'contract');
const SCHEMA_PATH = join(CONTRACT_DIR, 'project.schema.json');
const TEMPLATE_PATH = join(CONTRACT_DIR, 'template-project.yaml');
const REGISTRY = 'registry.jsonl';
const PROJECT_YAML = 'project.yaml';
// legacy 零删除：只登记这些旧产物类型，绝不删除
const LEGACY_EXTS = new Set(['.pth', '.png', '.txt', '.txt~', '.ipynb']);
const SKIP_DIRS = new Set(['.research', '.kb', 'experiments', '.git', 'node_modules', '__pycache__']);

export const name = 'exp-ledger';
export const inject = ['tools'];

// ---------- 小工具 ----------
function slugify(s) {
  const out = String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || 'project';
}
function iso() { return new Date().toISOString(); }
function sha1(s) { return createHash('sha1').update(String(s)).digest('hex'); }
function isWithin(root, p) {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !resolve(p).startsWith(root + sep));
}
async function pathExists(p) { try { await stat(p); return true; } catch { return false; } }
async function ensureDir(p) { await mkdir(p, { recursive: true }); }

// ---------- 工程根解析（会话 cwd 兜底）----------
function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
}
async function projectRootOf(args, exec) {
  let root;
  if (typeof args?.project === 'string' && args.project.trim() !== '') {
    root = resolve(sessionCwd(exec), args.project);
  } else {
    root = sessionCwd(exec);
  }
  if (!isWithin(root, resolve(root, PROJECT_YAML)) === false) { /* noop guard */ }
  return root;
}

// ---------- registry.jsonl ----------
async function readRegistry(root) {
  const p = join(root, REGISTRY);
  if (!(await pathExists(p))) return [];
  const raw = await readFile(p, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 跳过损坏行 */ }
  }
  return out;
}
async function writeRegistry(root, rows) {
  await ensureDir(root);
  const p = join(root, REGISTRY);
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  const tmp = p + '.tmp-' + sha1(iso() + Math.random()).slice(0, 8);
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, p);
}

// ---------- project.yaml 读写 ----------
async function readProjectDoc(root) {
  const p = join(root, PROJECT_YAML);
  if (!(await pathExists(p))) {
    const err = new Error(`project.yaml 不存在于 ${root}。先用 project_init 生成骨架（或检查工程路径）。`);
    err.code = 'PROJECT_MISSING';
    throw err;
  }
  const raw = await readFile(p, 'utf8');
  let doc;
  try { doc = yaml.load(raw); } catch (e) { throw new Error(`project.yaml 解析失败: ${e.message}`); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('project.yaml 顶层必须是 YAML 映射对象。');
  return doc;
}
async function writeProjectDoc(root, doc) {
  await ensureDir(root);
  const p = join(root, PROJECT_YAML);
  const body = yaml.dump(doc, { lineWidth: 120, noRefs: true, skipInvalid: true });
  const tmp = p + '.tmp-' + sha1(iso() + Math.random()).slice(0, 8);
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, p);
}

// ---------- schema 校验（骨架）----------
let validatorCache = null;
async function skeletonValidator() {
  if (validatorCache) return validatorCache;
  if (!Ajv2020) return null;
  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  validatorCache = { validate: ajv.compile(schema), ajv };
  return validatorCache;
}

// 结构业务校验（内容开放区做唯一性合并校验，§6.1④）
function structuralIssues(doc) {
  const issues = [];
  const stages = Array.isArray(doc?.stages) ? doc.stages : [];
  const seenStage = new Set();
  for (const s of stages) {
    const id = s?.id;
    if (typeof id !== 'string' || id === '') { issues.push(`stages 中存在缺少 id 的阶段条目（name=${JSON.stringify(s?.name)}）`); continue; }
    if (seenStage.has(id)) issues.push(`阶段 id 重复: ${id}`);
    seenStage.add(id);
  }
  const entities = Array.isArray(doc?.entities) ? doc.entities : [];
  const seenEntity = new Set();
  for (const e of entities) {
    if (typeof e?.id !== 'string' || e.id === '') { issues.push('entities 中存在缺少 id 的条目'); continue; }
    if (seenEntity.has(e.id)) issues.push(`实体 id 重复: ${e.id}`);
    seenEntity.add(e.id);
  }
  const kbTypes = Array.isArray(doc?.kb?.types) ? doc.kb.types : [];
  const seenType = new Set();
  for (const t of kbTypes) {
    if (typeof t !== 'string') { issues.push('kb.types 中的条目必须是字符串'); continue; }
    if (seenType.has(t)) issues.push(`kb.types 重复: ${t}`);
    seenType.add(t);
  }
  const edges = Array.isArray(doc?.pipeline?.edges) ? doc.pipeline.edges : [];
  const seenEdge = new Set();
  for (const e of edges) {
    if (typeof e?.from !== 'string' || typeof e?.to !== 'string') { issues.push('pipeline.edges 条目必须含 from/to 字符串'); continue; }
    const key = e.from + '->' + e.to;
    if (seenEdge.has(key)) issues.push(`pipeline.edges 重复: ${key}`);
    seenEdge.add(key);
    if (seenStage.size > 0 && !seenStage.has(e.from)) issues.push(`边起点不是已知阶段: ${key}`);
    if (seenStage.size > 0 && !seenStage.has(e.to)) issues.push(`边终点不是已知阶段: ${key}`);
  }
  const entry = doc?.pipeline?.entry;
  if (typeof entry === 'string' && entry !== '' && seenStage.size > 0 && !seenStage.has(entry)) {
    issues.push(`pipeline.entry 不是已知阶段: ${entry}`);
  }
  if (!Array.isArray(doc?.stages) || !doc.project || !doc.pipeline) {
    issues.push('骨架缺失：project/stages/pipeline 必须存在（请用 project_init 重建）');
  }
  return issues;
}

function summarize(doc) {
  return {
    id: doc?.project?.id ?? null,
    name: doc?.project?.name ?? null,
    stages: Array.isArray(doc?.stages) ? doc.stages.length : 0,
    edges: Array.isArray(doc?.pipeline?.edges) ? doc.pipeline.edges.length : 0,
    entry: doc?.pipeline?.entry ?? null,
    templates: doc?.templates && typeof doc.templates === 'object' ? Object.keys(doc.templates).length : 0,
    entities: Array.isArray(doc?.entities) ? doc.entities.length : 0,
    kbTypes: Array.isArray(doc?.kb?.types) ? doc.kb.types.length : 0,
  };
}

// ---------- 目录内 legacy 扫描（只登记不删除）----------
async function scanLegacy(root) {
  const counts = new Map(); // ext -> count
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) { await walk(full); continue; }
      const ext = ent.name.includes('.') ? extname(ent.name).toLowerCase() : '';
      if (LEGACY_EXTS.has(ext)) counts.set(ext, (counts.get(ext) || 0) + 1);
    }
  }
  await walk(root);
  return counts;
}
function extname(p) { const m = /(\.[^.\\/]+)$/.exec(p); return m ? m[1] : ''; }

// ---------- 服务 research.expLedger ----------
function buildService(ctx) {
  return {
    async load(args, exec) {
      const root = await projectRootOf(args, exec);
      let doc;
      try { doc = await readProjectDoc(root); } catch (e) {
        return { ok: false, text: String(e.message), data: { root, code: e.code || 'ERR' } };
      }
      const schemaErrors = [];
      const sv = await skeletonValidator();
      if (sv) {
        const okv = sv.validate(doc);
        if (!okv) for (const er of sv.validate.errors || []) schemaErrors.push(`${er.instancePath || '/'} ${er.message}`);
      } else {
        schemaErrors.push('ajv 不可用：跳过 JSON-schema 骨架校验（结构业务校验仍执行）');
      }
      const biz = structuralIssues(doc);
      const sum = summarize(doc);
      const valid = schemaErrors.length === 0 && biz.length === 0;
      const lines = [
        `project.yaml 载入：${root}`,
        `骨架过 schema：${schemaErrors.length === 0 ? '通过' : '失败 (' + schemaErrors.length + ')'}`,
        `结构业务校验：${biz.length === 0 ? '通过' : biz.length + ' 项'}`,
        `总览：stages=${sum.stages} edges=${sum.edges} entry=${sum.entry || '(未设)'} templates=${sum.templates} entities=${sum.entities} kb.types=${sum.kbTypes}`,
      ];
      for (const s of schemaErrors) lines.push(`  [schema] ${s}`);
      for (const b of biz) lines.push(`  [结构] ${b}`);
      lines.push(valid ? '结论：骨架合规，可进入 stage-ctrl / task-dispatch / kb-core 使用。' : '结论：存在待修问题，但未阻止读取（内容开放区仅提示）。');
      return { ok: true, text: lines.join('\n'), data: { root, valid, summary: sum, schemaErrors, issues: biz } };
    },
    async init(args, exec) {
      const root = await projectRootOf(args, exec);
      await ensureDir(root);
      const ymlPath = join(root, PROJECT_YAML);
      if (await pathExists(ymlPath)) {
        const r = await this.load({ project: root }, exec);
        return { ok: true, text: `project.yaml 已存在（不覆盖）：${ymlPath}\n${r.text}`, data: { root, existed: true } };
      }
      // 读共享契约模板 → 合规骨架
      let templateText = '';
      try { templateText = await readFile(TEMPLATE_PATH, 'utf8'); } catch {}
      let doc;
      if (templateText) {
        try { doc = yaml.load(templateText); } catch {}
      }
      if (!doc || typeof doc !== 'object') {
        doc = { project: { id: 'new-project', name: '新研究工程', domain: '', description: '' }, kb: { types: [] }, entities: [], stages: [], pipeline: { entry: null, edges: [] }, templates: {}, legacy: {} };
      }
      const dirName = basename(root);
      const wantId = typeof args?.id === 'string' && args.id.trim() ? slugify(args.id) : slugify(dirName === '.' ? 'project' : dirName);
      doc.project.id = wantId;
      if (typeof args?.name === 'string' && args.name.trim()) doc.project.name = args.name.trim();
      // legacy 登记：扫描旧产物（.pth/.png/.txt/.ipynb），只记不删
      const counts = await scanLegacy(root);
      if (counts.size > 0) {
        const keep = [];
        for (const [ext, n] of [...counts.entries()].sort()) keep.push({ pattern: `**/*${ext}`, count: n });
        doc.legacy = {
          note: '旧产物零删除：只登记 keep+record，不删不改 .pth/.png/.txt/.ipynb',
          keep,
        };
      }
      await writeProjectDoc(root, doc);
      const regPath = join(root, REGISTRY);
      if (!(await pathExists(regPath))) await writeRegistry(root, []);
      const legacyCount = [...counts.values()].reduce((a, b) => a + b, 0);
      const lines = [
        `project_init 完成：${root}`,
        `project.yaml 已按契约模板生成（id=${doc.project.id}, name=${doc.project.name}）`,
        `registry.jsonl 已初始化`,
        legacyCount > 0 ? `legacy 登记：扫描到 ${legacyCount} 个旧产物文件（${[...counts.keys()].join('/')}），只登记未删除` : '目录干净：未发现旧 .pth/.png/.txt/.ipynb',
        '下一步：用 stage_define 建阶段图、run_template 建任务模板、kb_use_learn 写知识。',
      ];
      return { ok: true, text: lines.join('\n'), data: { root, id: doc.project.id, legacyCount } };
    },
    async query(args, exec) {
      const root = await projectRootOf(args, exec);
      const rows = await readRegistry(root);
      const record = args?.record === 'run' || args?.record === 'all' ? args.record : 'entity';
      let list = rows.filter((r) => r && (record === 'all' ? r.record === 'entity' || r.record === 'run' : r.record === record));
      if (record === 'run') {
        if (typeof args?.id === 'string') list = list.filter((r) => r.runId === args.id);
        if (typeof args?.kind === 'string') list = list.filter((r) => r.kind === args.kind);
        if (typeof args?.stage === 'string') list = list.filter((r) => r.stage === args.stage);
        if (typeof args?.template === 'string') list = list.filter((r) => r.template === args.template);
        if (typeof args?.status === 'string') list = list.filter((r) => r.status === args.status);
      } else {
        if (typeof args?.id === 'string') list = list.filter((r) => r.id === args.id);
        if (typeof args?.kind === 'string') list = list.filter((r) => r.kind === args.kind);
        if (typeof args?.extends === 'string') list = list.filter((r) => (Array.isArray(r.extends) ? r.extends : r.extends ? [r.extends] : []).includes(args.extends));
      }
      const limit = Number.isFinite(Number(args?.limit)) && Number(args.limit) > 0 ? Number(args.limit) : 100;
      list = list.slice(0, limit);
      const lines = list.length
        ? list.map((r) => (r.record === 'run'
          ? `- ${r.runId}  [run] kind=${r.kind} status=${r.status} template=${r.template} stage=${r.stage ?? '—'}  @${r.ts}`
          : `- ${r.id}  kind=${r.kind}${r.name ? ' name=' + JSON.stringify(r.name) : ''}${r.extends ? ' extends=' + JSON.stringify(r.extends) : ''}  @${r.ts}`))
        : [`（registry 中没有匹配的${record === 'run' ? '运行' : '实体'}记录）` +
           (record === 'entity' && typeof args?.kind === 'string' && args.kind === 'run'
             ? '\n提示：运行记录请用 record=run（或 research_memo op=report 聚合）；record=entity 只查实体台账。' : '')];
      return { ok: true, text: `entity_query 命中 ${list.length} 条（root=${root}，record=${record}）：\n` + lines.join('\n'), data: { root, count: list.length, rows: list } };
    },
    async write(args, exec) {
      const root = await projectRootOf(args, exec);
      const id = typeof args?.id === 'string' && args.id.trim() ? args.id.trim() : null;
      if (!id) return { ok: false, text: 'entity_write 缺少必填 id。' };
      const kind = typeof args?.kind === 'string' && args.kind.trim() ? args.kind.trim() : 'other';
      let ext = args?.extends;
      if (typeof ext === 'string') ext = ext.split(',').map((s) => s.trim()).filter(Boolean);
      if (!Array.isArray(ext)) ext = [];
      ext = [...new Set(ext)];
      const rec = {
        record: 'entity',
        id,
        kind,
        ts: iso(),
      };
      if (typeof args?.name === 'string' && args.name.trim()) rec.name = args.name.trim();
      if (ext.length) rec.extends = ext;
      if (args?.props && typeof args.props === 'object' && !Array.isArray(args.props)) rec.props = args.props;
      if (args?.note && typeof args.note === 'string') rec.note = args.note;
      const rows = await readRegistry(root);
      const idx = rows.findIndex((r) => r && r.record === 'entity' && r.id === id);
      const was = idx >= 0;
      if (idx >= 0) rows[idx] = rec; else rows.push(rec);
      await writeRegistry(root, rows);
      const hash = sha1(JSON.stringify(rec)).slice(0, 12);
      return {
        ok: true,
        text: `entity_write ${was ? '更新' : '新增'} ledger 记录：id=${id} kind=${kind}（root=${root}，sha1=${hash}）\nregistry.jsonl 现共 ${rows.filter((r) => r?.record === 'entity').length} 条实体。`,
        data: { root, id, kind, upserted: !was, ts: rec.ts, hash },
      };
    },
    // 供内部/兄弟插件复用
    registryPath: (root) => join(root, REGISTRY),
    readRegistry,
    readProjectDoc,
    writeProjectDoc,
    projectRootOf,
  };
}

// ---------- 工具注册辅助 ----------
/** UI 呈现：generic 卡片（标题/类别/跟随文件）——kind:'edit' + locations 让 deliverables UI 折叠出可点击产出文件行。 */
function genericCall(title, kind, paths) {
  return { card: 'generic', title, kind, ...(paths && paths.length ? { locations: paths.map((p) => ({ path: p })) } : {}) };
}
function underProject(root, name) {
  return typeof root === 'string' && root.trim() !== '' ? join(root, name) : name;
}

function registerTextTool(ctx, tool) {
  const parameters = {
    type: 'object',
    properties: tool.properties || {},
    ...(tool.required && tool.required.length ? { required: tool.required } : {}),
  };
  ctx.tools.register({
    name: tool.name,
    description: tool.description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
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
  ctx.provide('research.expLedger', service);

  registerTextTool(ctx, {
    name: 'project_load',
    description: '载入并校验工程的 project.yaml：骨架过 contract/project.schema.json，扩展槽做唯一性/引用结构校验（内容开放仅提示）。入参 project 为工程根目录（相对当前会话 cwd 或绝对路径）；缺省取会话 cwd。',
    properties: {
      project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
    },
    execute: async (args, exec) => service.load(args, exec),
    presentCall: (args) => genericCall(`载入工程 ${args.project ?? '(会话工作区)'}`, 'read', [underProject(args.project, 'project.yaml')]),
  });

  registerTextTool(ctx, {
    name: 'project_init',
    description: '初始化工程：若 project.yaml 不存在则按契约模板生成合规骨架（含空 stages/edges/templates/kb.types），初始化 registry.jsonl；对旧杂乱目录扫描 .pth/.png/.txt/.ipynb 登记为 legacy keep+record，绝不删除不覆盖。已存在 project.yaml 时不覆盖并返回载入校验。',
    properties: {
      project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      id: { type: 'string', description: '可选 project.id（kebab-case）；缺省取目录名。' },
      name: { type: 'string', description: '可选工程显示名。' },
    },
    execute: async (args, exec) => service.init(args, exec),
    presentCall: (args) => genericCall(`初始化工程骨架 ${args.id ?? ''}`.trim(), 'edit', [underProject(args.project, 'project.yaml'), underProject(args.project, 'registry.jsonl')]),
  });

  registerTextTool(ctx, {
    name: 'entity_query',
    description: '查询 registry.jsonl 台账：record=entity（默认，实体记录，可按 id/kind/extends 过滤）或 record=run（运行记录，可按 id=runId/kind/stage/template/status 过滤）或 record=all。',
    properties: {
      project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      record: { type: 'string', description: 'entity（默认）| run | all。', enum: ['entity', 'run', 'all'] },
      id: { type: 'string', description: 'record=entity 时匹配实体 id；record=run 时匹配 runId。' },
      kind: { type: 'string', description: '类别过滤（实体类别或 run 类别）。' },
      extends: { type: 'string', description: 'record=entity：按 extends 引用的类型过滤。' },
      stage: { type: 'string', description: 'record=run：按阶段过滤。' },
      template: { type: 'string', description: 'record=run：按模板过滤。' },
      status: { type: 'string', description: 'record=run：按状态过滤（draft/running/done/failed/…）。' },
      limit: { type: 'number', description: '返回条数上限（默认 100）。' },
    },
    execute: async (args, exec) => service.query(args, exec),
    presentCall: (args) => genericCall(`查询台账 ${args.record ?? 'entity'}${args.kind ? ' kind=' + args.kind : ''}`, 'read', [underProject(args.project, 'registry.jsonl')]),
  });

  registerTextTool(ctx, {
    name: 'entity_write',
    description: '按 schema 生成/规范化一条 ledger 实体记录并写入 registry.jsonl（同 id 为更新不重复追加）。extends 可引用 kb.types 或任意外部类型（内容开放）。',
    properties: {
      project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      id: { type: 'string', description: '实体唯一 id（必填）。' },
      kind: { type: 'string', description: '实体类别（dataset/model/output/legacy/…），默认 other。' },
      name: { type: 'string', description: '可选显示名。' },
      extends: { type: 'string', description: '逗号分隔的引用类型列表，如 "dataset,cifar100"。' },
      props: { type: 'object', description: '开放附加属性（内容开放区）。' },
      note: { type: 'string', description: '可选备注。' },
    },
    required: ['id'],
    execute: async (args, exec) => service.write(args, exec),
    presentCall: (args) => genericCall(`写实体 ${args.id ?? '?'}`, 'edit', [underProject(args.project, 'registry.jsonl')]),
  });
}

export { apply };
