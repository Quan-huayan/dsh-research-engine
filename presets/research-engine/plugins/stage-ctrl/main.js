// stage-ctrl —— 状态机（3 工具）
//
// 拥有数据：pipeline.yaml（环境：阶段机）、.research/state.json（派生状态，由 stage_goto 物化）。
// 台账事件由 exp-ledger 的 ledger_append 服务追加（跨域只走服务）。
// 改名策略：旧 id 只 deprecated + replacedBy，永不删除（否则历史 run 的 stage 引用会断）。

import { join, dirname } from 'node:path';
import { readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
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
const PIPELINE_YAML = 'pipeline.yaml';
const REGISTRY = 'registry.jsonl';
const STATE = '.research/state.json';
// 词边界替换：不误伤用户数据里的同形子串（如 usergit-probe / shanghai），但独立出现的版本库词汇一律替换。
const SCRUB = /(^|[^A-Za-z0-9_-])(git|commit|HEAD|diff|hash|sha)(?![A-Za-z0-9_-])/gi;

export const name = 'stage-ctrl';
export const inject = ['tools'];

function iso() { return new Date().toISOString(); }
function sha256(s) { return createHash('sha256').update(s).digest('hex'); }
function scrub(t) { return String(t ?? '').replace(SCRUB, (_m, pre) => `${pre}·`); }
async function pathExists(p) { try { await stat(p); return true; } catch { return false; } }
async function ensureDir(p) { await mkdir(p, { recursive: true }); }
async function atomicWrite(p, body) {
  await ensureDir(dirname(p));
  const tmp = `${p}.tmp-${sha256(iso() + Math.random()).slice(0, 8)}`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, p);
}

function emptyPipeline() {
  return { schemaVersion: SCHEMA_VERSION, graphVersion: 0, entry: null, stages: [], edges: [] };
}

function applyGraph(doc, args) {
  const next = JSON.parse(JSON.stringify(doc));
  const action = args?.action;
  const fatal = [];
  if (action === 'stage') {
    const id = typeof args?.id === 'string' ? args.id.trim() : '';
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) fatal.push(`阶段 id 非法：${JSON.stringify(id)}（只允许小写字母/数字/下划线/连字符）`);
    const existing = next.stages.find((s) => s.id === id);
    if (args?.deprecate === true) {
      if (!existing) fatal.push(`要停用的阶段不存在：${id}`);
      else {
        existing.status = 'deprecated';
        if (typeof args?.replacedBy === 'string' && args.replacedBy.trim()) existing.replacedBy = args.replacedBy.trim();
        existing.deprecatedAt = iso();
      }
    } else if (existing && args?.overwrite !== true) {
      fatal.push(`阶段已存在：${id}（改名请用「新 id + 旧 id deprecate」；确实要改显示名用 overwrite）`);
    } else {
      const name = typeof args?.name === 'string' && args.name.trim() ? args.name.trim() : id;
      if (existing) { existing.name = name; existing.status = 'active'; }
      else next.stages.push({ id, name, status: 'active' });
    }
  } else if (action === 'edge') {
    const from = typeof args?.from === 'string' ? args.from.trim() : '';
    const to = typeof args?.to === 'string' ? args.to.trim() : '';
    if (!from || !to) fatal.push('边需要 from 与 to');
    else if (!next.stages.some((s) => s.id === from)) fatal.push(`边起点未声明：${from}`);
    else if (!next.stages.some((s) => s.id === to)) fatal.push(`边终点未声明：${to}`);
    else if (from === to) fatal.push(`自环：${from}->${to}`);
    else if (next.edges.some((e) => e.from === from && e.to === to)) fatal.push(`边重复：${from}->${to}`);
    else next.edges.push({ from, to, ...(typeof args?.note === 'string' && args.note.trim() ? { note: args.note.trim() } : {}) });
  } else {
    fatal.push(`action 必须是 stage 或 edge（收到 ${JSON.stringify(action)}）`);
  }
  if (typeof args?.entry === 'string' && args.entry.trim()) {
    const e = args.entry.trim();
    if (!next.stages.some((s) => s.id === e)) fatal.push(`入口不是已知阶段：${e}`);
    else if (next.edges.some((x) => x.to === e)) fatal.push(`入口阶段有入边：${e}`);
    else next.entry = e;
  }
  return { next, fatal };
}

function checkGraph(doc) {
  const fatal = []; const warn = [];
  const stages = Array.isArray(doc?.stages) ? doc.stages : [];
  const edges = Array.isArray(doc?.edges) ? doc.edges : [];
  const ids = new Set();
  for (const s of stages) {
    if (typeof s?.id !== 'string' || s.id === '') { fatal.push('存在缺少 id 的阶段'); continue; }
    if (ids.has(s.id)) fatal.push(`阶段 id 重复：${s.id}`);
    ids.add(s.id);
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
  if (stages.length > 0 && (entry === undefined || entry === null || entry === '')) warn.push('有阶段但未设入口（entry）');
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    adj.get(e.from).add(e.to);
  }
  const reach = new Set(); const stack = entry ? [entry] : [];
  while (stack.length) {
    const n = stack.pop();
    if (reach.has(n)) continue;
    reach.add(n);
    for (const t of adj.get(n) ?? []) stack.push(t);
  }
  for (const s of stages) if (!reach.has(s.id)) warn.push(`阶段不可达（从入口出发）：${s.id}`);
  return { fatal, warn };
}

function buildService(ctx) {
  const led = () => ctx.get('research.expLedger');
  return {
    async readPipeline(root) {
      const p = join(root, PIPELINE_YAML);
      if (!(await pathExists(p))) return null;
      try { const d = yaml.load(await readFile(p, 'utf8')); return d && typeof d === 'object' ? d : null; } catch { return null; }
    },
    async view(args, exec) {
      const root = led().root(args, exec);
      const pipeline = await this.readPipeline(root);
      const fold = await led().ledgerFold(root);
      const current = fold.currentStage ?? pipeline?.entry ?? null;
      const graph = pipeline ? checkGraph(pipeline) : { fatal: [], warn: [] };
      return { root, pipeline, current, graph, fold };
    },
    async goto(root, from, to) {
      const pipeline = await this.readPipeline(root);
      if (!pipeline) return { ok: false, text: '拒绝：尚未声明阶段机（pipeline.yaml 缺失）。\n修法：先用 stage_declare 声明阶段与边。' };
      const edges = Array.isArray(pipeline.edges) ? pipeline.edges : [];
      const legal = edges.filter((e) => e.from === from).map((e) => e.to);
      if (!edges.some((e) => e.from === from && e.to === to)) {
        return {
          ok: false,
          text: `拒绝：${from} → ${to} 不是已声明的边。\n合法去向：${legal.length ? legal.join('、') : '（无，当前阶段是终点）'}\n`
            + '修法：走合法边；若这条转移确实该存在，先用 stage_declare action=edge 声明它。',
        };
      }
      return { ok: true, legal };
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
  ctx.provide('research.stageCtrl', svc);

  registerTextTool(ctx, {
    name: 'stage_declare',
    description: '声明阶段机：action=stage 增改阶段、action=edge 增边；可同时设 entry。图有 fatal 违规时整体拒绝，图版本每次成功声明递增。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      action: { type: 'string', enum: ['stage', 'edge'], description: 'stage=声明阶段；edge=声明转移边。' },
      id: { type: 'string', description: 'action=stage：阶段 id。' },
      name: { type: 'string', description: 'action=stage：阶段显示名。' },
      from: { type: 'string', description: 'action=edge：起点阶段 id。' },
      to: { type: 'string', description: 'action=edge：终点阶段 id。' },
      entry: { type: 'string', description: '设入口阶段（必须是已知阶段且无入边）。' },
      deprecate: { type: 'boolean', description: 'action=stage：停用该阶段（保留历史引用）。' },
      replacedBy: { type: 'string', description: 'deprecate 时：替代它的新阶段 id。' },
      overwrite: { type: 'boolean', description: 'action=stage：允许覆盖已存在阶段的显示名。' },
      note: { type: 'string', description: 'action=edge：边备注。' },
    },
    required: ['action'],
    execute: async (args, exec) => {
      const led = ctx.get('research.expLedger');
      const eg = ctx.get('research.engineGit');
      const root = led.root(args, exec);
      try { await led.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const guard = led.guard(root, [PIPELINE_YAML, REGISTRY]);
      if (!guard.ok) return { text: guard.text };
      const current = (await svc.readPipeline(root)) ?? emptyPipeline();
      const { next, fatal } = applyGraph(current, args ?? {});
      if (fatal.length) return { text: `拒绝：${fatal.join('；')}\n修法：先声明缺失的阶段，再声明边；改名用「新 id + 旧 id deprecate」。` };
      const graph = checkGraph(next);
      if (graph.fatal.length) return { text: `拒绝（图有致命违规）：\n${graph.fatal.map((f) => `  - ${f}`).join('\n')}\n修法：先修正这些条目再提交。` };
      next.graphVersion = (Number.isInteger(current.graphVersion) ? current.graphVersion : 1) + 1;
      await led.writeYamlFile(join(root, PIPELINE_YAML), next);
      const stored = eg.record(root, [PIPELINE_YAML], `stage_declare: ${args.action}`);
      // 声明事件用 record:'pipeline'（不是 'stage'）——只有 stage_goto 产生真正的转移，
      // 否则 fold 会把声明边误当成「当前阶段」。
      const rec = await led.ledgerAppend(root, {
        record: 'pipeline', action: args.action,
        ...(args.action === 'stage' ? { stage: args.id ?? null, deprecated: args.deprecate === true } : {}),
        ...(args.action === 'edge' ? { edgeFrom: args.from ?? null, edgeTo: args.to ?? null } : {}),
        entry: next.entry ?? null,
        graphVersion: next.graphVersion,
      }, { commit: stored.commit ?? undefined });
      const lines = [
        `阶段机已更新（图版本 ${next.graphVersion}）：${args.action === 'stage' ? `阶段 ${args.deprecate ? '停用' : '声明'} ${args.id}` : `边 ${args.from} → ${args.to}`}`,
        `当前图：${next.stages.length} 个阶段 / ${next.edges.length} 条边 / 入口 ${next.entry ?? '(未设)'}`,
        ...(graph.warn.length ? [`提示：${graph.warn.join('；')}`] : []),
        `台账第 ${rec.seq} 行。`,
      ];
      return { text: lines.join('\n') };
    },
    presentCall: (args) => genericCall(`声明阶段机（${args?.action ?? '?'}）`, 'edit', [PIPELINE_YAML]),
  });

  registerTextTool(ctx, {
    name: 'stage_read',
    description: '只读阶段机视图：阶段、边、入口、当前节点、合法去向、fatal/warn。',
    properties: { root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' } },
    execute: async (args, exec) => {
      const led = ctx.get('research.expLedger');
      const root = led.root(args, exec);
      try { await led.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const v = await svc.view(args, exec);
      if (!v.pipeline) return { text: '阶段机尚未声明（pipeline.yaml 缺失）。\n修法：stage_declare action=stage 声明第一个阶段，再用 action=edge 连边。' };
      const legal = (v.pipeline.edges ?? []).filter((e) => e.from === v.current).map((e) => e.to);
      const lines = [
        `阶段（${v.pipeline.stages.length}）：${v.pipeline.stages.map((s) => `${s.id}${s.status === 'deprecated' ? '(已停用)' : ''}`).join('、')}`,
        `边（${v.pipeline.edges.length}）：${v.pipeline.edges.map((e) => `${e.from}→${e.to}`).join('、') || '（无）'}`,
        `入口：${v.pipeline.entry ?? '(未设)'}　图版本：${v.pipeline.graphVersion}`,
        `当前阶段：${v.current ?? '(未进入任何阶段)'}`,
        `合法去向：${legal.length ? legal.join('、') : '（无）'}`,
        ...(v.graph.fatal.length ? [`致命问题：${v.graph.fatal.join('；')}`] : []),
        ...(v.graph.warn.length ? [`提示：${v.graph.warn.join('；')}`] : []),
      ];
      return { text: lines.join('\n') };
    },
    presentCall: (args) => genericCall('读阶段机', 'read', [PIPELINE_YAML]),
  });

  registerTextTool(ctx, {
    name: 'stage_goto',
    description: '推进阶段（沿已声明的边）或重放物化派生状态：replay=true 时只用台账重放重建 .research/state.json，不产生任何转移。若重放会改变派生状态当前断言的值（两个来源互相矛盾），必须由用户裁决。',
    properties: {
      root: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      from: { type: 'string', description: '起点阶段；缺省 = 当前阶段。' },
      to: { type: 'string', description: '目标阶段；replay=true 时可省略。' },
      replay: { type: 'boolean', description: 'true = 只按台账重放物化派生状态，不推进阶段（派生状态丢了/旧了/形状不对时用）。' },
      decision: {
        type: 'object',
        description: '重放与现有派生状态冲突时必须提供：用户裁决引用。',
        properties: { askCallId: { type: 'string' }, answer: { type: 'string' }, attested: { type: 'boolean' } },
      },
    },
    required: [],
    execute: async (args, exec) => {
      const led = ctx.get('research.expLedger');
      const eg = ctx.get('research.engineGit');
      const root = led.root(args, exec);
      try { await led.requireProject(root); } catch (e) { return { text: `拒绝：${e.message}` }; }
      const v = await svc.view(args, exec);
      if (!v.pipeline) return { text: '拒绝：尚未声明阶段机。\n修法：先 stage_declare。' };
      const replay = args?.replay === true;
      // 重放是「渲染派生视图」，属于修复路径：不受脏区拦截（它只重写并提交派生状态本身）。
      if (!replay) {
        const guard = led.guard(root, [STATE, REGISTRY]);
        if (!guard.ok) return { text: guard.text };
      }
      const foldBefore = await led.ledgerFold(root);
      const currentAt = foldBefore.currentStage ?? v.pipeline.entry ?? null;
      const to = typeof args?.to === 'string' ? args.to.trim() : '';
      if (!replay && !to) return { text: '拒绝：缺少 to。\n修法：给出目标阶段；只想重建派生状态就加 replay=true。' };

      // 重放前先看「现有派生状态断言了什么」：与台账重放值不同 = 两个来源矛盾。
      // 冲突的裁决权不在工具也不在 agent（P3），必须由用户拍板。
      let decision = null;
      if (replay) {
        let existing = null; let exists = false;
        try { existing = JSON.parse(await readFile(join(root, STATE), 'utf8')); exists = true; } catch { exists = await pathExists(join(root, STATE)); existing = null; }
        const claimed = existing && typeof existing === 'object' ? (existing.stage ?? null) : undefined;
        const malformed = exists && (existing === null || existing.derived !== true);
        const conflict = exists && (malformed || claimed !== currentAt);
        if (conflict) {
          const what = malformed
            ? `派生状态文件形状不符合 v3（断言不出可靠值）`
            : `派生状态文件断言 stage=${claimed ?? '(空)'}`;
          const vv = led.verifyDecision(exec, args?.decision ?? {});
          if (!vv.ok) {
            return {
              text: `拒绝：重放会改变派生状态当前断言的值，这属于两个来源互相矛盾，需要用户裁决。\n`
                + `  - 现有文件：${what}\n  - 台账重放：stage=${currentAt ?? '(未进入阶段)'}（转移记录 ${foldBefore.stages.length} 次）\n`
                + `${vv.text}\n`
                + `修法二选一：① 用户确认「以台账为准」后带 decision 重放（把文件改成台账值）；② 若研究实际已推进，用 stage_goto to=<真实阶段> 记录一次真实转移。`,
            };
          }
          decision = vv.decision;
        }
      }

      let from = currentAt ?? '';
      let history;
      if (replay) {
        history = foldBefore.stages.map((s) => ({ from: s.from, to: s.to, ts: s.ts }));
      } else {
        from = (typeof args?.from === 'string' && args.from.trim()) ? args.from.trim() : (currentAt ?? '');
        if (!from) return { text: '拒绝：当前没有所处阶段，且未提供 from。\n修法：给出 from，或用 stage_declare 设 entry 后重试。' };
        const chk = await svc.goto(root, from, to);
        if (!chk.ok) return { text: chk.text };
        history = [...foldBefore.stages.map((s) => ({ from: s.from, to: s.to, ts: s.ts })), { from, to, ts: iso() }];
      }
      const stageNow = replay ? (currentAt ?? null) : to;
      const state = {
        derived: true, generatedAt: iso(), source: 'registry.jsonl',
        graphVersion: v.pipeline.graphVersion, stage: stageNow, history,
      };
      await atomicWrite(join(root, STATE), JSON.stringify(state, null, 2) + '\n');
      eg.record(root, [STATE], replay ? 'stage_goto: replay' : `stage_goto: ${from} -> ${to}`);
      const unignored = await led.removeIgnored(root, [STATE]);
      let rec;
      if (replay) {
        rec = await led.ledgerAppend(root, { record: 'render', kind: 'state', paths: [STATE], count: 1, replay: true, ...(decision ? { decidedBy: true } : {}) });
        if (decision) {
          await led.ledgerAppend(root, {
            record: 'decision', kind: 'state-replay', id: 'research-state',
            askCallId: decision.askCallId, question: decision.question, answer: decision.answer,
            sessionId: decision.sessionId, ...(decision.attested ? { attested: true } : {}),
          }, { actor: 'user' });
        }
      } else {
        rec = await led.ledgerAppend(root, { record: 'stage', from, to, currentAt, graphVersion: v.pipeline.graphVersion });
        await led.ledgerAppend(root, { record: 'render', kind: 'state', paths: [STATE], count: 1 });
      }
      const lines = replay
        ? [
          `派生状态已按台账重放物化：${STATE}`,
          `当前阶段：${stageNow ?? '(未进入阶段)'}　图版本：${v.pipeline.graphVersion}　历史转移 ${history.length} 次`,
          '本次没有推进阶段（未产生转移事件）。',
          ...(decision ? [`依据用户裁决：${decision.answer}`] : []),
          ...(unignored ? [`同时把它从「有意忽略」清单里移出（${unignored} 条）。`] : []),
          `台账第 ${rec.seq} 行。`,
        ]
        : [
          `阶段已推进：${from} → ${to}`,
          `当前阶段：${to}　图版本：${v.pipeline.graphVersion}`,
          ...(currentAt !== null && currentAt !== from ? [`注意：本次显式给出的起点 ${from} 与推进前的当前阶段 ${currentAt} 不一致，台账已同时记录两者。`] : []),
          ...(unignored ? [`派生状态已重新纳入常规管辖（从「有意忽略」清单移出 ${unignored} 条）。`] : []),
          `历史转移 ${history.length} 次；台账第 ${rec.seq} 行。`,
        ];
      return { text: lines.join('\n') };
    },
    presentCall: (args) => genericCall(args?.replay === true ? '重放物化派生状态' : `推进阶段 → ${args?.to ?? ''}`.trim(), 'edit', [STATE]),
  });
}

export { apply };
