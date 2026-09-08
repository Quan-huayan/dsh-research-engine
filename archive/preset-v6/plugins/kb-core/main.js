// kb-core ④ —— 知识库 + 报告插件
// research-engine preset 内嵌插件。拥有数据：.kb/notes/*.md（frontmatter 自校验）+
// .kb/index.yaml；报告 _report/{runs.csv, summary.json}。
// 工具：kb_use_learn / kb_use_context / kb_use_report / kb_index（+ 服务 research.kbCore）。
// 唯一知识写入口：agent 改知识只能走 kb_use_learn（不能拿通用文件工具随手改笔记）。
// 笔记校验仿 dsh parseSkillFile：name + description 必填非空、name 须 kebab-case，违规整档丢弃。

import { createRequire } from 'node:module';
import { join, dirname, resolve, relative, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, readdir, stat, rename } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';

const dshHome = process.env.DSH_HOME || join(os.homedir(), '.dsh');
const requireFromHarness = createRequire(join(dshHome, 'profiles', 'node_modules', 'js-yaml', 'package.json'));
const yaml = requireFromHarness('js-yaml');

export const name = 'kb-core';
export const inject = ['tools'];

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

// ---------- frontmatter 解析/校验（仿 parseSkillFile）----------
function parseNote(raw, file) {
  const lines = String(raw).split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { ok: false, reason: '缺少 --- 起始行' };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end < 0) return { ok: false, reason: 'frontmatter 未闭合（缺 --- 结束行）' };
  let meta;
  try { meta = yaml.load(lines.slice(1, end).join('\n')); } catch (e) { return { ok: false, reason: `frontmatter YAML 解析失败: ${e.message}` }; }
  if (!meta || typeof meta !== 'object') return { ok: false, reason: 'frontmatter 必须是映射' };
  const name = meta.name, description = meta.description;
  if (typeof name !== 'string' || name.length === 0 || typeof description !== 'string' || description.length === 0) {
    return { ok: false, reason: 'frontmatter 要求 name 与 description（非空字符串）' };
  }
  if (!NAME_RE.test(name)) return { ok: false, reason: `name 非法（须 kebab-case）：${name}` };
  return { ok: true, meta, name, description, body: lines.slice(end + 1).join('\n').trim() };
}
function renderNote(meta, body) {
  const head = {};
  for (const k of ['name', 'description', 'type', 'tags', 'stage']) if (meta[k] !== undefined) head[k] = meta[k];
  return '---\n' + yaml.dump(head, { lineWidth: 120, noRefs: true, skipInvalid: true }).trimEnd() + '\n---\n\n' + (body || '') + '\n';
}

// ---------- kb 目录 ----------
async function kbDirs(root) {
  const notesDir = join(root, '.kb', 'notes');
  const indexFile = join(root, '.kb', 'index.yaml');
  await ensureDir(notesDir);
  return { notesDir, indexFile };
}
async function rebuildIndex(root) {
  const { notesDir, indexFile } = await kbDirs(root);
  const files = [];
  try { files.push(...(await readdir(notesDir)).filter((f) => f.endsWith('.md')).sort()); } catch {}
  const notes = [];
  const invalid = [];
  for (const f of files) {
    const raw = await readFile(join(notesDir, f), 'utf8').catch(() => '');
    const parsed = parseNote(raw, f);
    if (!parsed.ok) { invalid.push({ file: f, reason: parsed.reason }); continue; }
    notes.push({
      name: parsed.name,
      description: parsed.description,
      file: f,
      ...(parsed.meta.type ? { type: parsed.meta.type } : {}),
      ...(Array.isArray(parsed.meta.tags) && parsed.meta.tags.length ? { tags: parsed.meta.tags } : {}),
      ...(parsed.meta.stage ? { stage: parsed.meta.stage } : {}),
    });
  }
  const index = { generated: iso(), count: notes.length, invalidCount: invalid.length, notes, invalid };
  await atomicWrite(indexFile, yaml.dump(index, { lineWidth: 120, noRefs: true, skipInvalid: true }));
  return index;
}
async function readIndex(root) {
  const { indexFile } = await kbDirs(root);
  if (!(await pathExists(indexFile))) return await rebuildIndex(root);
  try { return yaml.load(await readFile(indexFile, 'utf8')) || {}; } catch { return await rebuildIndex(root); }
}
async function readProjectDoc(root) {
  const p = join(root, 'project.yaml');
  if (!(await pathExists(p))) return null;
  try { return yaml.load(await readFile(p, 'utf8')); } catch { return null; }
}

// ---------- 服务 research.kbCore ----------
function buildService() {
  return {
    async learn(args, exec) {
      const root = await projectRootOf(args, exec);
      const name = typeof args?.name === 'string' ? args.name.trim() : '';
      const description = typeof args?.description === 'string' ? args.description.trim() : '';
      if (!NAME_RE.test(name)) return { ok: false, text: `kb_use_learn 拒绝：name 须 kebab-case（${name || '(空)'}）。` };
      if (!description) return { ok: false, text: 'kb_use_learn 拒绝：description 必填非空（仿 skill frontmatter）。' };
      const body = typeof args?.content === 'string' ? args.content.trim() : '';
      if (!body) return { ok: false, text: 'kb_use_learn 拒绝：content 为空（知识正文必填）。' };
      const doc = await readProjectDoc(root);
      const type = typeof args?.type === 'string' && args.type.trim() ? args.type.trim() : undefined;
      const typeWarn = [];
      if (type && doc && Array.isArray(doc?.kb?.types) && doc.kb.types.length) {
        if (!doc.kb.types.includes(type)) typeWarn.push(`type ${type} 不在 kb.types 白名单 [${doc.kb.types.join(', ')}] 内（内容开放，仅提示）`);
      }
      let tags;
      if (Array.isArray(args?.tags)) tags = args.tags.map(String);
      else if (typeof args?.tags === 'string' && args.tags.trim()) tags = args.tags.split(',').map((s) => s.trim()).filter(Boolean);
      const meta = { name, description };
      if (type) meta.type = type;
      if (tags && tags.length) meta.tags = tags;
      if (typeof args?.stage === 'string' && args.stage.trim()) meta.stage = args.stage.trim();
      const { notesDir } = await kbDirs(root);
      const file = name + '.md';
      const existed = await pathExists(join(notesDir, file));
      await atomicWrite(join(notesDir, file), renderNote(meta, body));
      await rebuildIndex(root);
      const lines = [
        `kb_use_learn ${existed ? '更新' : '新增'} 笔记：.kb/notes/${file}`,
        `  name=${name}\n  description=${description}`,
        ...(typeWarn.length ? typeWarn.map((w) => '  [warn] ' + w) : []),
        'index.yaml 已重建。知识只经此写入口修改。',
      ];
      return { ok: true, text: lines.join('\n'), data: { root, file, name, updated: existed } };
    },
    async context(args, exec) {
      const root = await projectRootOf(args, exec);
      const index = await readIndex(root);
      const notes = Array.isArray(index.notes) ? index.notes : [];
      if (!notes.length) return { ok: true, text: `kb_use_context：知识库为空（${root}/.kb）——先 kb_use_learn 写入结论。`, data: { root, hits: [] } };
      let list = notes;
      if (typeof args?.type === 'string' && args.type.trim()) list = list.filter((n) => n.type === args.type);
      if (Array.isArray(args?.tags) && args.tags.length) list = list.filter((n) => (n.tags || []).some((t) => args.tags.includes(t)));
      if (typeof args?.stage === 'string' && args.stage.trim()) list = list.filter((n) => n.stage === args.stage);
      const q = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : '';
      if (q) {
        const toks = q.split(/[\s,，。、]+/).filter(Boolean);
        const score = (n) => {
          const hay = (n.description + ' ' + (n.type || '') + ' ' + (n.tags || []).join(' ')).toLowerCase();
          return toks.reduce((a, t) => a + (hay.includes(t) ? 1 : 0), 0);
        };
        list = list.map((n) => ({ n, s: score(n) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.n);
      }
      const limit = Number.isFinite(Number(args?.limit)) && Number(args.limit) > 0 ? Number(args.limit) : 8;
      list = list.slice(0, limit);
      const out = [];
      for (const n of list) {
        const raw = await readFile(join(root, '.kb', 'notes', n.file), 'utf8').catch(() => '');
        const parsed = parseNote(raw, n.file);
        if (!parsed.ok) continue;
        const bodyExcerpt = parsed.body.length > 900 ? parsed.body.slice(0, 900) + '…' : parsed.body;
        out.push(`## ${parsed.name}${parsed.meta.type ? ' [' + parsed.meta.type + ']' : ''}${parsed.meta.stage ? ' @' + parsed.meta.stage : ''}\n${parsed.description}\n\n${bodyExcerpt}`);
      }
      const head = [`kb_use_context：跨会话检索命中 ${out.length} 条（root=${root}${q ? '，query=' + JSON.stringify(q) : ''}）`, '注：检索的是策展笔记（.kb/notes + index.yaml），非会话日志，跨会话确定性可读。', ''];
      return { ok: true, text: head.concat(out).join('\n'), data: { root, hits: out.length, names: list.map((n) => n.name) } };
    },
    async report(args, exec) {
      const root = await projectRootOf(args, exec);
      const regPath = join(root, 'registry.jsonl');
      const runs = [];
      if (await pathExists(regPath)) {
        for (const line of (await readFile(regPath, 'utf8')).split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          try { const r = JSON.parse(t); if (r && r.record === 'run') runs.push(r); } catch {}
        }
      }
      let sel = runs;
      if (typeof args?.template === 'string' && args.template.trim()) sel = sel.filter((r) => r.template === args.template);
      if (typeof args?.stage === 'string' && args.stage.trim()) sel = sel.filter((r) => r.stage === args.stage);
      if (typeof args?.status === 'string' && args.status.trim()) sel = sel.filter((r) => r.status === args.status);
      if (typeof args?.kind === 'string' && args.kind.trim()) sel = sel.filter((r) => r.kind === args.kind);
      if (Array.isArray(args?.runIds) && args.runIds.length) sel = sel.filter((r) => args.runIds.includes(r.runId));
      sel = [...sel].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      const reportDir = join(root, '_report');
      await ensureDir(reportDir);
      const cols = ['runId', 'kind', 'stage', 'template', 'status', 'ts', 'configPath', 'resultPath', 'detail', 'params'];
      const csvRow = (r) => cols.map((c) => {
        const v = c === 'params' ? JSON.stringify(r.params ?? {}) : r[c];
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
      const csv = [cols.join(','), ...sel.map(csvRow)].join('\n') + '\n';
      await atomicWrite(join(reportDir, 'runs.csv'), csv);
      const countsByStatus = {};
      const countsByTemplate = {};
      for (const r of sel) {
        countsByStatus[r.status || '?'] = (countsByStatus[r.status || '?'] || 0) + 1;
        countsByTemplate[r.template || '?'] = (countsByTemplate[r.template || '?'] || 0) + 1;
      }
      const summary = {
        generated: iso(),
        root,
        filter: {
          ...(typeof args?.template === 'string' && args.template.trim() ? { template: args.template } : {}),
          ...(typeof args?.stage === 'string' && args.stage.trim() ? { stage: args.stage } : {}),
          ...(typeof args?.status === 'string' && args.status.trim() ? { status: args.status } : {}),
          ...(Array.isArray(args?.runIds) && args.runIds.length ? { runIds: args.runIds } : {}),
        },
        runCount: sel.length,
        totalRunCount: runs.length,
        countsByStatus,
        countsByTemplate,
        rows: sel,
      };
      await atomicWrite(join(reportDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
      const lines = [
        `kb_use_report：聚合 ${sel.length}/${runs.length} 条 run → _report/`,
        `  runs.csv：${join(reportDir, 'runs.csv')}`,
        `  summary.json：${join(reportDir, 'summary.json')}`,
        `按状态：${Object.entries(countsByStatus).map(([k, v]) => `${k}=${v}`).join(' ') || '无'}`,
        `按模板：${Object.entries(countsByTemplate).map(([k, v]) => `${k}=${v}`).join(' ') || '无'}`,
        '口径说明：多 run/seed 聚合以模板/阶段/status 为键；未来按 entity_extends 归并种子。',
      ];
      return { ok: true, text: lines.join('\n'), data: { root, runCount: sel.length, files: ['runs.csv', 'summary.json'] } };
    },
    async index(args, exec) {
      const root = await projectRootOf(args, exec);
      const index = await rebuildIndex(root);
      const lines = [
        `kb_index 重建完成：${root}/.kb/index.yaml`,
        `  笔记 ${index.count} 条${index.invalidCount ? '，无效丢弃 ' + index.invalidCount + ' 条' : ''}`,
        ...(index.invalid.length ? index.invalid.map((i) => `  [invalid] ${i.file}: ${i.reason}`) : []),
        ...(index.notes.length ? ['', ...index.notes.map((n) => `- ${n.name}${n.type ? ' [' + n.type + ']' : ''} — ${n.description}`)] : []),
      ];
      return { ok: true, text: lines.join('\n'), data: { root, count: index.count, invalid: index.invalidCount } };
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
  ctx.provide('research.kbCore', service);

  registerTextTool(ctx, {
    name: 'kb_use_learn',
    description: '知识唯一写入口：写一条策展笔记到 .kb/notes/<name>.md。自校验必填 frontmatter（仿 skill 解析）：name 须 kebab-case、description 必填非空；违规拒绝。写完自动重建 index.yaml。',
    properties: {
      project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      name: { type: 'string', description: '笔记名（kebab-case，必填）。' },
      description: { type: 'string', description: '一句话摘要（必填非空）。' },
      type: { type: 'string', description: '笔记类型（kb.types 白名单；内容开放仅提示），如 conclusion/lesson/result/method。' },
      tags: { type: 'string', description: '逗号分隔标签。' },
      stage: { type: 'string', description: '关联阶段 id。' },
      content: { type: 'string', description: '知识正文（必填非空）。' },
    },
    required: ['name', 'description', 'content'],
    execute: async (args, exec) => service.learn(args, exec),
    presentCall: (args) => genericCall(`写知识 ${args.name ?? '?'}`, 'edit', [underProject(args.project, join('.kb', 'notes', (args.name ?? 'note') + '.md')), underProject(args.project, '.kb/index.yaml')]),
  });

  registerTextTool(ctx, {
    name: 'kb_use_context',
    description: '跨会话检索：读 .kb/index.yaml 定位策展笔记并返回正文摘要（可按 type/tags/stage/query 过滤）。用于阶段进入时注入旧结论（读的是工程文件，非会话日志）。',
    properties: {
      project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      query: { type: 'string', description: '关键词检索（可选）。' },
      type: { type: 'string', description: '按笔记类型过滤。' },
      tags: { type: 'array', description: '按标签过滤。' },
      stage: { type: 'string', description: '按阶段过滤。' },
      limit: { type: 'number', description: '返回条数上限（默认 8）。' },
    },
    execute: async (args, exec) => service.context(args, exec),
    presentCall: (args) => genericCall(`检索知识${args.query ? ' ' + args.query : ''}`, 'read', [underProject(args.project, '.kb/index.yaml')]),
  });

  registerTextTool(ctx, {
    name: 'kb_use_report',
    description: '报告整合：聚合 registry.jsonl 的运行记录（可按 runIds/template/stage/status/kind 过滤）→ 写 _report/{runs.csv, summary.json}。报告是知识的产物，归于 kb。',
    properties: {
      project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      runIds: { type: 'array', description: '指定 runId 集合（可选）。' },
      template: { type: 'string', description: '按模板过滤。' },
      stage: { type: 'string', description: '按阶段过滤。' },
      status: { type: 'string', description: '按状态过滤（draft/running/done/failed/…）。' },
      kind: { type: 'string', description: '按运行类别过滤。' },
    },
    execute: async (args, exec) => service.report(args, exec),
    presentCall: (args) => genericCall('聚合 run 生成报告', 'edit', [underProject(args.project, join('_report', 'runs.csv')), underProject(args.project, join('_report', 'summary.json'))]),
  });

  registerTextTool(ctx, {
    name: 'kb_index',
    description: '生成/重建 .kb/index.yaml（扫描笔记、校验 frontmatter，无效笔记整档丢弃并列出），保证写出的知识可被 kb_use_context 检索到。',
    properties: { project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' } },
    execute: async (args, exec) => service.index(args, exec),
    presentCall: (args) => genericCall('重建知识索引', 'edit', [underProject(args.project, '.kb/index.yaml')]),
  });
}

export { apply };
