// 迁移自检：造一个「旧式工程」，跑 project_init mode=migrate，核对阶段 6 的六项产出。
// 用法：node tools/probe-migrate.mjs
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { readFile, writeFile, mkdir, rm, stat, readdir } from 'node:fs/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
// 默认读仓库里的 preset（唯一真源）；RESEARCH_ENGINE_PRESET 可指向别处（例如已安装的副本）。
const PRESET = process.env.RESEARCH_ENGINE_PRESET || join(REPO, 'presets', 'research-engine');
const ROOT = join(REPO, 'fixtures', '_probe-migrate');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
};
const exists = async (p) => stat(p).then(() => true, () => false);

const services = new Map(); const tools = [];
const ctx = { tools: { register: (d) => tools.push(d) }, provide: (n, s) => services.set(n, s), get: (n) => services.get(n), effect: () => {} };
services.set('shell', { sandboxMode: undefined, resolve: (r) => r, start: () => ({ exitCode: 0, sandbox: null, done: Promise.resolve(), readOutput: () => ({ delta: '' }), kill: () => {} }) });
services.set('shellEnv', { collect: () => ({}) });
services.set('jobs', { start: (s) => { void Promise.resolve().then(() => s.run()).then((h) => h?.done); return 'j1'; } });
for (const p of ['engine-git', 'exp-ledger', 'stage-ctrl', 'task-dispatch', 'kb-core']) {
  const m = await import(pathToFileURL(join(PRESET, 'plugins', p, 'main.js')).href); m.apply(ctx);
}
const byName = new Map(tools.map((t) => [t.name, t]));
const exec = { agent: { session: { header: { cwd: ROOT, id: 's' }, events: [] } } };
const call = async (n, a) => (await byName.get(n).execute(a, exec)).text;

// ---------- 造旧式工程 ----------
await rm(ROOT, { recursive: true, force: true });
await mkdir(join(ROOT, 'scripts'), { recursive: true });
await mkdir(join(ROOT, '.kb', 'notes'), { recursive: true });
await mkdir(join(ROOT, '.dsh', 'skills', 'old-domain'), { recursive: true });
await mkdir(join(ROOT, 'experiments', 'old-run-1', 'raw'), { recursive: true });
await mkdir(join(ROOT, 'history'), { recursive: true });
await writeFile(join(ROOT, 'history', 'curve.png'), 'legacy', 'utf8');
await writeFile(join(ROOT, 'train_legacy.py'), 'print("train")\n', 'utf8');
await writeFile(join(ROOT, 'experiments', 'old-run-1', 'config.json'), JSON.stringify({ runId: 'old-run-1', template: 'legacy-main', params: { seed: 0 } }, null, 2));
await writeFile(join(ROOT, 'experiments', 'old-run-1', 'raw', 'train.log'), 'val_acc 31.20\n', 'utf8');
await writeFile(join(ROOT, '.kb', 'notes', 'conclusion-old.md'), '---\nname: conclusion-old\ndescription: 旧结论\ntype: conclusion\ntags: [conclusion]\nstage: compare\n---\n\ncifar3.txt 首跑参数量差异 29.17%。\n');
await writeFile(join(ROOT, '.kb', 'notes', 'lesson-old.md'), '---\nname: lesson-old\ndescription: 旧教训\ntype: lesson\n---\n\n后台任务必须带执行策略。\n');
await writeFile(join(ROOT, '.dsh', 'skills', 'old-domain', 'SKILL.md'), '---\nname: old-domain\n---\n旧工程笔记\n');
const oldProject = {
  project: { id: 'legacy-proj', name: '旧式工程', domain: 'cifar100' },
  kb: { types: ['dataset', 'model', 'lesson'] },
  entities: [{ id: 'cifar100', kind: 'dataset', name: 'CIFAR-100' }],
  stages: [{ id: 'dataset', name: '数据' }, { id: 'compare', name: '比较' }],
  pipeline: { entry: 'dataset', edges: [{ from: 'dataset', to: 'compare' }] },
  templates: {
    'legacy-main': {
      description: '旧主对比',
      parameters: { type: 'object', properties: { seed: { type: 'integer' } }, required: ['seed'] },
      command: { allow: ['python'], script: 'train_legacy.py', args: '--seed {{seed}}' },
    },
  },
  legacy: { note: '旧产物只登记不删除', keep: [{ pattern: '**/*.png', count: 1 }], protectedAreas: ['history'] },
};
const yamlMod = await import('node:module');
const require_ = yamlMod.createRequire(join(DSH_HOME, 'profiles', 'node_modules', 'js-yaml', 'package.json'));
const yaml = require_('js-yaml');
await writeFile(join(ROOT, 'project.yaml'), yaml.dump(oldProject, { lineWidth: -1 }));
const oldRegistry = [
  JSON.stringify({ record: 'entity', id: 'cifar100', kind: 'dataset', ts: '2026-01-01T00:00:00.000Z' }),
  JSON.stringify({ record: 'run', runId: 'old-run-1', template: 'legacy-main', status: 'done', params: { seed: 0 }, ts: '2026-01-02T00:00:00.000Z' }),
];
await writeFile(join(ROOT, 'registry.jsonl'), `${oldRegistry.join('\n')}\n`);

// ---------- 迁移 ----------
const out = await call('project_init', { root: ROOT, mode: 'migrate' });
check('迁移返回成功', /迁移完成/.test(out), out.split('\n')[0]);
check('旧文件已归档', await exists(join(ROOT, '.research', 'legacy', 'project-v2.yaml')));
check('工程根没有 .git', !(await exists(join(ROOT, '.git'))));
const newDoc = yaml.load(await readFile(join(ROOT, 'project.yaml'), 'utf8'));
check('project.yaml 已是 v3', newDoc.schemaVersion === 3 && !('stages' in newDoc) && !('templates' in newDoc) && !('entities' in newDoc) && !('kb' in newDoc), JSON.stringify(Object.keys(newDoc)));
check('身份不丢', newDoc.project.id === 'legacy-proj' && newDoc.project.name === '旧式工程');
check('词汇表迁移自旧 kb.types', Array.isArray(newDoc.vocabulary?.entityKinds) && newDoc.vocabulary.entityKinds.includes('dataset'));
check('遗留登记保留', (newDoc.legacy?.keep ?? []).some((k) => k.pattern === '**/*.png'));
const pl = yaml.load(await readFile(join(ROOT, 'pipeline.yaml'), 'utf8'));
check('pipeline.yaml 逐项迁移', pl.stages.length === 2 && pl.edges.length === 1 && pl.entry === 'dataset' && pl.graphVersion === 1, JSON.stringify(pl));
const tp = yaml.load(await readFile(join(ROOT, 'templates.yaml'), 'utf8'));
check('templates.yaml 逐项迁移', Object.keys(tp.templates).length === 1 && tp.templates['legacy-main'].observables.length === 0, '');
check('脚本以 adopt 收编（不改文件）', tp.templates['legacy-main'].scriptRef.mode === 'adopt' && tp.templates['legacy-main'].scriptRef.path === 'train_legacy.py', '');
check('脚本元数据落盘', await exists(join(ROOT, 'scripts', 'train-legacy.meta.json')));
check('既有 run 补了证据清单', await exists(join(ROOT, 'experiments', 'old-run-1', 'manifest.json')));
const man = JSON.parse(await readFile(join(ROOT, 'experiments', 'old-run-1', 'manifest.json'), 'utf8'));
check('清单登记了 raw 产出并带指纹', man.entries.some((e) => e.path.endsWith('raw/train.log') && /^[0-9a-f]{64}$/.test(e.sha256)), '');
const note1 = await readFile(join(ROOT, '.kb', 'notes', 'conclusion-old.md'), 'utf8');
check('笔记补 v3 结构头', /schemaVersion: 3/.test(note1) && /kind: claim/.test(note1) && /status: proposed/.test(note1), '');
check('笔记原文保留', /29\.17/.test(note1));
check('旧 frontmatter 存在 legacy 下', /legacy:/.test(note1));
const note2 = await readFile(join(ROOT, '.kb', 'notes', 'lesson-old.md'), 'utf8');
check('教训按 accepted/evidence 归类', /kind: lesson/.test(note2) && /status: accepted/.test(note2), '');
check('旧工程笔记已移出环境位置', !(await exists(join(ROOT, '.dsh', 'skills', 'old-domain', 'SKILL.md'))) && await exists(join(ROOT, '.research', 'legacy', 'skills', 'old-domain', 'SKILL.md')));
const regLines = (await readFile(join(ROOT, 'registry.jsonl'), 'utf8')).split('\n').filter(Boolean);
check('旧台账行数不减少且追加迁移事件', regLines.length >= 3 && regLines[0] === oldRegistry[0] && regLines[1] === oldRegistry[1], `行数 ${regLines.length}`);
check('遗留文件零删除', await exists(join(ROOT, 'history', 'curve.png')));

const v = await call('project_verify', { root: ROOT, scope: 'all' });
check('迁移后体检 clean', /通过（clean）/.test(v), v.replace(/\n/g, ' | ').slice(0, 300));
const again = await call('project_init', { root: ROOT, mode: 'migrate' });
check('重复迁移走修复复检（不重写环境）', /修复复检完成/.test(again), again.split('\n')[0]);
const plAfter = yaml.load(await readFile(join(ROOT, 'pipeline.yaml'), 'utf8'));
check('修复复检不改动已声明的阶段机', plAfter.graphVersion === pl.graphVersion && plAfter.stages.length === pl.stages.length, '');
const ld = await call('project_load', { root: ROOT });
check('project_load 全绿可读', /阶段机：2 个阶段/.test(ld) && /模板：legacy-main@1/.test(ld), '');

console.log(`\n迁移自检失败 ${failures} 项`);
process.exit(failures ? 1 : 0);
