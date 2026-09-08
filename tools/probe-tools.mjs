// §6.1 自动检查：把五个插件按 cordis 语义装进一个假 ctx，逐个调用 21 个工具，
// 对**每次**返回断言：
//   1) 返回值恰好只有声明字段 {text}（output.schema 严格匹配）；
//   2) 返回文本（正常 + 拒绝路径）扫描 git|commit|HEAD|diff|hash|sha|.git 零命中；
//   3) 拒绝路径必须给出「为什么 + 怎么修」；
// 再跑一遍守卫 / 证据 / 权威 / 派生四组判据。
//
// 用法：node tools/probe-tools.mjs
import { pathToFileURL } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { readFile, writeFile, mkdir, rm, stat, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
// 默认读仓库里的 preset（唯一真源）；RESEARCH_ENGINE_PRESET 可指向别处（例如已安装的副本）。
const PRESET = process.env.RESEARCH_ENGINE_PRESET || join(REPO, 'presets', 'research-engine');
const SCRATCH = join(REPO, 'fixtures', '_probe-project');
const FORBIDDEN = /git|commit|HEAD|diff|hash|sha|\.git/i;

const results = [];
let failures = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

// ---------- 假 ctx（cordis 语义子集）----------
const services = new Map();
const tools = [];
const ctx = {
  tools: { register: (d) => { tools.push(d); } },
  provide: (n, s) => services.set(n, s),
  get: (n) => services.get(n),
  effect: () => {},
};

// 后台执行：立即跑完（不真起进程），但走完整 settle 路径
let jobSeq = 0;
const fakeProc = () => ({
  exitCode: 0,
  sandbox: null,
  done: Promise.resolve(),
  readOutput: () => ({ delta: 'probe stdout\n' }),
  kill: () => {},
});
services.set('shell', { sandboxMode: undefined, resolve: (r) => r, start: () => fakeProc() });
services.set('shellEnv', { collect: () => ({}) });
services.set('jobs', {
  start: (spec) => {
    jobSeq += 1;
    const id = `probe.job-${jobSeq}`;
    void Promise.resolve().then(() => spec.run()).then((h) => h?.done);
    return id;
  },
});

for (const p of ['engine-git', 'exp-ledger', 'stage-ctrl', 'task-dispatch', 'kb-core']) {
  const mod = await import(pathToFileURL(join(PRESET, 'plugins', p, 'main.js')).href);
  mod.apply(ctx);
}
const byName = new Map(tools.map((t) => [t.name, t]));

// ---------- 调用包装 + 断言 ----------
const sha = (s) => createHash('sha256').update(s).digest('hex');
let fakeAskCallId = 'call_probe_ask_1';
const sessionEvents = [];
// 伪造一次 ask_user_question 的会话事件，供用户权威回查（E 与 D2 都用）
sessionEvents.push({ type: 'tool/call', seq: 1, time: Date.now(), data: { callId: fakeAskCallId, name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'tol', question: '参数差异阈值取多少？' }] }) } });
sessionEvents.push({ type: 'tool/result', seq: 2, time: Date.now(), data: { message: { content: [{ type: 'tool-result', toolCallId: fakeAskCallId, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'tol', selected: ['必须 <10%'], custom: '按 <10% 走' }] }) }] }] } } });
function makeExec(cwd) {
  return {
    callId: 'call_probe', name: 'probe', arguments: {}, signal: undefined,
    agent: { session: { header: { cwd, id: 'session-probe' }, events: sessionEvents } },
  };
}
async function call(name, args, cwd) {
  const tool = byName.get(name);
  if (!tool) { check(`工具存在：${name}`, false, '未注册'); return { text: '' }; }
  let out;
  try {
    out = await tool.execute(args, makeExec(cwd));
  } catch (e) {
    check(`${name} 不抛异常`, false, e.message);
    return { text: '' };
  }
  const keys = Object.keys(out ?? {});
  const shapeOk = keys.length === 1 && typeof out.text === 'string';
  check(`${name} 返回值只含声明字段`, shapeOk, shapeOk ? '' : `实际字段 ${keys.join(',')}`);
  const text = String(out?.text ?? '');
  const hit = FORBIDDEN.exec(text);
  check(`${name} 返回文本无版本库词汇`, hit === null, hit ? `命中 ${JSON.stringify(hit[0])}` : '');
  return out;
}
async function reject(name, args, cwd, label) {
  const out = await call(name, args, cwd);
  const t = String(out?.text ?? '');
  const isReject = /拒绝|无法|尚未|不能/.test(t);
  const hasFix = /修法|下一步|用法/.test(t);
  check(`${label ?? name} 被拒且给出修法`, isReject && hasFix, isReject ? (hasFix ? '' : '缺修法') : '未拒绝');
  return out;
}

// ---------- 环境准备 ----------
await rm(SCRATCH, { recursive: true, force: true });
await mkdir(SCRATCH, { recursive: true });
await writeFile(join(SCRATCH, 'legacy_note.txt'), 'legacy content\n', 'utf8');
await mkdir(join(SCRATCH, 'history'), { recursive: true });
await writeFile(join(SCRATCH, 'history', 'curve.png'), 'not-a-real-png', 'utf8');

// ---------- §6.1-1 工具面 ----------
const EXPECTED = ['project_init', 'project_load', 'project_verify', 'project_reconcile', 'entity_declare', 'entity_query', 'convention_declare',
  'stage_declare', 'stage_read', 'stage_goto', 'template_declare', 'script_declare', 'run_draft', 'run_launch', 'run_observe',
  'run_query', 'run_close', 'note_write', 'note_adjudicate', 'note_query', 'view_render'];
check('21 个工具齐备且命名合法', EXPECTED.every((n) => byName.has(n)) && byName.size === EXPECTED.length, `实际 ${byName.size} 个`);
check('工具名只含 [A-Za-z0-9_-]', [...byName.keys()].every((n) => /^[A-Za-z0-9_-]+$/.test(n)));

// ---------- A 接入 ----------
const initOut = await call('project_init', { root: SCRATCH, id: 'probe-proj', name: '探针工程' }, SCRATCH);
check('project_init 登记了遗留文件', /legacy_note\.txt|\.txt×1/.test(initOut.text) || /遗留登记/.test(initOut.text), '');
await reject('project_init', { root: SCRATCH, id: 'again' }, SCRATCH, 'project_init 拒绝重复接入');
await call('project_load', { root: SCRATCH }, SCRATCH);
const v0 = await call('project_verify', { root: SCRATCH, scope: 'all' }, SCRATCH);
check('project_init 后体检 clean', /通过（clean）/.test(v0.text), v0.text.split('\n')[0]);

// ---------- B 阶段机 ----------
await call('stage_declare', { root: SCRATCH, action: 'stage', id: 'data', name: '数据', entry: 'data' }, SCRATCH);
await call('stage_declare', { root: SCRATCH, action: 'stage', id: 'train', name: '训练' }, SCRATCH);
await call('stage_declare', { root: SCRATCH, action: 'stage', id: 'report', name: '报告' }, SCRATCH);
await call('stage_declare', { root: SCRATCH, action: 'edge', from: 'data', to: 'train' }, SCRATCH);
await call('stage_declare', { root: SCRATCH, action: 'edge', from: 'train', to: 'report' }, SCRATCH);
await reject('stage_declare', { root: SCRATCH, action: 'edge', from: 'data', to: 'nope' }, SCRATCH, 'stage_declare 拒绝未知端点');
await reject('stage_declare', { root: SCRATCH, action: 'edge', from: 'data', to: 'data' }, SCRATCH, 'stage_declare 拒绝自环');
const sr = await call('stage_read', { root: SCRATCH }, SCRATCH);
check('stage_read 显示当前阶段=入口', /当前阶段：data/.test(sr.text), '');
await call('stage_goto', { root: SCRATCH, to: 'train' }, SCRATCH);
const sr2 = await call('stage_read', { root: SCRATCH }, SCRATCH);
check('stage_goto 后当前阶段=train', /当前阶段：train/.test(sr2.text), '');
await reject('stage_goto', { root: SCRATCH, to: 'data' }, SCRATCH, 'stage_goto 拒绝未声明的边');

// ---------- C 脚本 + 模板 ----------
const scriptBody = 'import argparse\nap = argparse.ArgumentParser()\nap.add_argument("--seed", type=int, default=0)\nap.add_argument("--out", required=True)\na = ap.parse_args()\nwith open(a.out, "w", encoding="utf-8") as fh:\n    fh.write("val_acc 12.34\\n")\nprint("val_acc 12.34", flush=True)\n';
await call('script_declare', { root: SCRATCH, name: 'probe', mode: 'create', purpose: '探针', allowlist: ['python'], content: scriptBody }, SCRATCH);
await reject('script_declare', { root: SCRATCH, name: 'probe2', mode: 'adopt', purpose: 'x', allowlist: ['python'], source: '../outside.py' }, SCRATCH, 'script_declare 拒绝工程外路径');
await reject('template_declare', { root: SCRATCH, id: 't1', allow: ['python'], scriptRef: 'nope', observables: [] }, SCRATCH, 'template_declare 拒绝未声明脚本');
await reject('template_declare', { root: SCRATCH, id: 't1', allow: [], scriptRef: 'probe', observables: [] }, SCRATCH, 'template_declare 拒绝空 allow');
await reject('template_declare', { root: SCRATCH, id: 't1', allow: ['python'], scriptRef: 'probe' }, SCRATCH, 'template_declare 拒绝缺 observables');
await call('template_declare', {
  root: SCRATCH, id: 'probe-tpl', description: '探针模板', allow: ['python'], scriptRef: 'probe',
  args: '--seed {{seed}} --out {{__raw__}}/out.log',
  paramsSchema: { type: 'object', properties: { seed: { type: 'integer' } }, required: ['seed'] },
  observables: [{ field: 'val_acc', role: 'log', pattern: 'val_acc\\s+([0-9.]+)', unit: '%' }],
}, SCRATCH);

// ---------- D 执行与证据 ----------
await reject('run_draft', { root: SCRATCH, template: 'probe-tpl', params: {} }, SCRATCH, 'run_draft 拒绝缺占位参数');
await reject('run_draft', { root: SCRATCH, template: 'probe-tpl', params: { seed: 'x' } }, SCRATCH, 'run_draft 拒绝参数类型不符');
const dr = await call('run_draft', { root: SCRATCH, template: 'probe-tpl', params: { seed: 0 } }, SCRATCH);
const runId = /runId=([A-Za-z0-9._-]+)/.exec(dr.text)?.[1];
check('run_draft 返回 runId', Boolean(runId), runId ?? '');
// 安全闸：越权改受管文件 → 应被守卫拦住
const tplPath = join(SCRATCH, 'templates.yaml');
const tplRaw = await readFile(tplPath, 'utf8');
await writeFile(tplPath, `${tplRaw}\n# rogue\n`, 'utf8');
const g1 = await call('run_launch', { root: SCRATCH, runId }, SCRATCH);
check('越权改受管文件后写类工具被拒', /受管区已被工程外部的改动覆盖/.test(g1.text), g1.text.split('\n')[0]);
const vDirty = await call('project_verify', { root: SCRATCH }, SCRATCH);
check('project_verify 点名 templates.yaml', /templates\.yaml/.test(vDirty.text), '');
// 受管区脏时，任何写类工具（含 stage_declare）都必须被拒（§6.1-3）
const dirtyStage = await call('stage_declare', { root: SCRATCH, action: 'stage', id: 'rogue', name: '越权' }, SCRATCH);
check('脏工程时 stage_declare 也被拒', /拒绝/.test(dirtyStage.text), dirtyStage.text.split('\n')[0]);
await call('project_reconcile', { root: SCRATCH, paths: ['templates.yaml'], mode: 'restore', reason: '探针：越权还原' }, SCRATCH);
const vClean = await call('project_verify', { root: SCRATCH }, SCRATCH);
check('restore 后体检 clean', /通过（clean）/.test(vClean.text), vClean.text.split('\n')[0]);
// 安全闸命中：声明一个白名单不匹配的模板
await call('template_declare', {
  root: SCRATCH, id: 'danger', description: '白名单不匹配', allow: ['python3'], scriptRef: 'probe',
  args: '--seed {{seed}} --out {{__raw__}}/out.log',
  paramsSchema: { type: 'object', properties: { seed: { type: 'integer' } }, required: ['seed'] },
  observables: [],
}, SCRATCH);
const dDraft = await call('run_draft', { root: SCRATCH, template: 'danger', params: { seed: 0 } }, SCRATCH);
const dangerRun = /runId=([A-Za-z0-9._-]+)/.exec(dDraft.text)?.[1];
const dLaunch = await call('run_launch', { root: SCRATCH, runId: dangerRun }, SCRATCH);
check('安全闸拦截不在白名单的命令前缀', /安全闸/.test(dLaunch.text) && /拒绝/.test(dLaunch.text), dLaunch.text.split('\n')[0]);
const notesAfterGate = await readdir(join(SCRATCH, '.kb', 'notes')).catch(() => []);
check('安全闸命中记入教训库', notesAfterGate.some((n) => n.startsWith('lesson-blocked-')), notesAfterGate.join(','));
// 正常启动（假执行器）：settle 会登记 raw/
await mkdir(join(SCRATCH, 'experiments', runId, 'raw'), { recursive: true });
await writeFile(join(SCRATCH, 'experiments', runId, 'raw', 'out.log'), 'val_acc 12.34\n', 'utf8');
await call('run_launch', { root: SCRATCH, runId }, SCRATCH);
let q1 = { text: '' };
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  q1 = await call('run_query', { root: SCRATCH, runId }, SCRATCH);
  if (/done|failed/.test(q1.text)) break;
}
check('run_launch 后状态 done', /done/.test(q1.text), q1.text.split('\n')[1] ?? '');
// 进程输出必须无条件落盘为证据（不依赖模型是否先读过日志）
const stdoutLog = join(SCRATCH, 'experiments', runId, 'raw', 'stdout.log');
check('进程输出落盘为 stdout.log', await stat(stdoutLog).then(() => true, () => false));
const manAfter = JSON.parse(await readFile(join(SCRATCH, 'experiments', runId, 'manifest.json'), 'utf8'));
check('stdout.log 已登记且角色为 stdout', manAfter.entries.some((e) => e.path.endsWith('/raw/stdout.log') && e.role === 'stdout'));
await reject('run_observe', { root: SCRATCH, runId, fields: ['nope'] }, SCRATCH, 'run_observe 拒绝未声明字段');
const obs = await call('run_observe', { root: SCRATCH, runId }, SCRATCH);
check('run_observe 提取到声明字段并给出文件:行', /val_acc = 12\.34/.test(obs.text) && /out\.log:1/.test(obs.text), obs.text.split('\n')[1] ?? '');
// 证据被篡改 → 拒绝提取
await writeFile(join(SCRATCH, 'experiments', runId, 'raw', 'out.log'), 'val_acc 99.99\n', 'utf8');
await reject('run_observe', { root: SCRATCH, runId }, SCRATCH, 'run_observe 拒绝哈希不符的产出');
await call('project_reconcile', { root: SCRATCH, paths: [`experiments/${runId}/raw/out.log`], mode: 'restore', reason: '探针：证据还原' }, SCRATCH);
const obs2 = await call('run_observe', { root: SCRATCH, runId }, SCRATCH);
check('证据还原后重新提取成功', /val_acc = 12\.34/.test(obs2.text), '');
// 未登记产出 → verify unknown
await writeFile(join(SCRATCH, 'experiments', runId, 'raw', 'stray.log'), 'stray\n', 'utf8');
const vUnknown = await call('project_verify', { root: SCRATCH, scope: 'evidence' }, SCRATCH);
check('未登记产出被体检点名', /stray\.log/.test(vUnknown.text), '');
await call('project_reconcile', { root: SCRATCH, paths: [`experiments/${runId}/raw/stray.log`], mode: 'ignore', reason: '探针：非证据文件' }, SCRATCH);

// ---------- D2 派生状态：陈旧/形状不对必须被点名，且能用重放物化修 ----------
// 伪造一个旧式派生状态（这正是 attndepth 迁移后的真实情形）
await writeFile(join(SCRATCH, '.research', 'state.json'), JSON.stringify({ stage: 'train', history: [], from: 'data', updatedAt: '2020-01-01T00:00:00.000Z' }, null, 2) + '\n', 'utf8');
const vStale = await call('project_verify', { root: SCRATCH, scope: 'all' }, SCRATCH);
check('陈旧派生状态被体检点名', /派生状态/.test(vStale.text) && /state\.json/.test(vStale.text), vStale.text.split('\n').find((l) => l.includes('派生状态')) ?? '');
const stageEventsBefore = (await call('entity_query', { root: SCRATCH, record: 'decision' }, SCRATCH)).text;
// 冲突时重放必须先由用户裁决（P3：两个来源矛盾，裁决权不在工具）
await reject('stage_goto', { root: SCRATCH, replay: true }, SCRATCH, '冲突重放拒绝无裁决');
const replay = await call('stage_goto', { root: SCRATCH, replay: true, decision: { askCallId: fakeAskCallId, answer: '必须 <10%' } }, SCRATCH);
check('带裁决的重放物化成功', /重放物化/.test(replay.text) && /没有推进阶段/.test(replay.text), replay.text.split('\n')[0]);
const stRaw = JSON.parse(await readFile(join(SCRATCH, '.research', 'state.json'), 'utf8'));
check('重放后派生状态形状合规', stRaw.derived === true && stRaw.source === 'registry.jsonl' && Number.isInteger(stRaw.graphVersion) && Array.isArray(stRaw.history), JSON.stringify(Object.keys(stRaw)));
check('重放后 stage 与台账一致', stRaw.stage === 'train', `stage=${stRaw.stage}`);
const vAfterReplay = await call('project_verify', { root: SCRATCH, scope: 'all' }, SCRATCH);
check('重放后体检不再点名派生状态', !/派生状态/.test(vAfterReplay.text), vAfterReplay.text.split('\n')[0]);
check('重放不产生转移事件（台账里仍只有 1 次转移）', /历史转移 1 次/.test(replay.text), replay.text.split('\n')[1] ?? '');
void stageEventsBefore;

// ---------- E 用户权威 ----------
await reject('convention_declare', { root: SCRATCH, statement: '无裁决', source: 'x', decision: {} }, SCRATCH, 'convention_declare 拒绝无裁决引用');
await reject('convention_declare', { root: SCRATCH, statement: '必须 <10%', source: 'x', decision: { askCallId: 'call_bogus', answer: '必须 <10%' } }, SCRATCH, 'convention_declare 拒绝查不到的提问标识');
await reject('convention_declare', { root: SCRATCH, statement: '参数差异必须 <5%', source: 'x', decision: { askCallId: fakeAskCallId, answer: '必须 <10%' } }, SCRATCH, 'convention_declare 拒绝与答复矛盾的条文');
const conv = await call('convention_declare', { root: SCRATCH, statement: '参数差异必须 <10%', source: '探针会话', decision: { askCallId: fakeAskCallId, answer: '必须 <10%' } }, SCRATCH);
check('convention_declare 强校验通过并落盘', /约定已生效/.test(conv.text), conv.text.split('\n')[1] ?? '');
const askList = await call('entity_query', { root: SCRATCH, record: 'ask' }, SCRATCH);
check('entity_query record=ask 暴露提问标识', askList.text.includes(fakeAskCallId), '');
await call('entity_declare', { root: SCRATCH, kind: 'dataset', id: 'cifar100', name: 'CIFAR-100', source: 'project.yaml' }, SCRATCH);
await reject('entity_declare', { root: SCRATCH, kind: 'dataset', id: 'bad', source: 'nope/missing.py' }, SCRATCH, 'entity_declare 拒绝无法解析的来源');

// ---------- F 知识与裁决 ----------
await reject('note_write', { root: SCRATCH, kind: 'claim', name: 'no-ev', description: 'x', statement: 'y', evidence: [], scope: 'z' }, SCRATCH, 'note_write 拒绝无证据 claim');
await reject('note_write', { root: SCRATCH, kind: 'claim', name: 'bad-ev', description: 'x', statement: 'y', evidence: [{ type: 'run', ref: 'no-such-run' }], scope: 'z' }, SCRATCH, 'note_write 拒绝解析不了的证据');
await call('note_write', { root: SCRATCH, kind: 'claim', name: 'val-ok', description: '探针可提取', statement: '探针模板能稳定提取 val_acc。', evidence: [{ type: 'observation', ref: `${runId}#val_acc` }], scope: 'probe-tpl v1' }, SCRATCH);
const adj = await call('note_adjudicate', { root: SCRATCH, note: 'val-ok', action: 'accept' }, SCRATCH);
check('note_adjudicate 依证据生效', /accepted（权威：evidence）/.test(adj.text), '');
await call('note_write', { root: SCRATCH, kind: 'proposal', name: 'p1', description: '提议', statement: '建议下一步跑三种种子。' }, SCRATCH);
await reject('note_adjudicate', { root: SCRATCH, note: 'p1', action: 'accept' }, SCRATCH, 'note_adjudicate 拒绝无裁决生效提议');
const nq = await call('note_query', { root: SCRATCH }, SCRATCH);
check('note_query 默认只列生效结论', /生效结论 \d+ 条/.test(nq.text) && /待裁决/.test(nq.text) && /val-ok/.test(nq.text), '');

// ---------- G 派生视图 ----------
await call('view_render', { root: SCRATCH, kind: 'report' }, SCRATCH);
await call('view_render', { root: SCRATCH, kind: 'notes-skill' }, SCRATCH);
await call('view_render', { root: SCRATCH, kind: 'index' }, SCRATCH);
const skillRaw = await readFile(join(SCRATCH, 'skills', 'probe-proj', 'SKILL.md'), 'utf8');
check('工程笔记标注为派生视图', /派生视图/.test(skillRaw), '');
check('工程笔记不含版本库词汇', !FORBIDDEN.test(skillRaw));
check('工程笔记不含内部工具名', !/ledger_append|engine-git|run_draft|view_render|stage_declare|note_write/.test(skillRaw), '');
// 手改派生视图 → dirty → 重新渲染恢复
await writeFile(join(SCRATCH, '_report', 'summary.json'), '{"rogue":true}\n', 'utf8');
const vRogue = await call('project_verify', { root: SCRATCH }, SCRATCH);
check('手改派生视图被体检点名', /_report\/summary\.json/.test(vRogue.text), '');
await call('view_render', { root: SCRATCH, kind: 'report' }, SCRATCH);
const vFinal = await call('project_verify', { root: SCRATCH, scope: 'all' }, SCRATCH);
check('重新渲染后体检 clean', /通过（clean）/.test(vFinal.text), vFinal.text.replace(/\n/g, ' | ').slice(0, 400));

// ---------- H 收尾 ----------
await call('run_close', { root: SCRATCH, runId, status: 'invalidated', reason: '探针收尾' }, SCRATCH);
await reject('run_close', { root: SCRATCH, runId: dangerRun, status: 'archived', reason: 'x' }, SCRATCH, 'run_close 归档拒绝无裁决');
const qEnd = await call('run_query', { root: SCRATCH }, SCRATCH);
check('作废后产出仍在（run 记录保留）', /invalidated/.test(qEnd.text), '');
const legacyStill = await stat(join(SCRATCH, 'history', 'curve.png')).then(() => true, () => false);
check('遗留文件零删除', legacyStill, '');

console.log(`\n合计 ${results.length} 项，失败 ${failures} 项`);
process.exit(failures ? 1 : 0);
