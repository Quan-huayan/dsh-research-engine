// research-facade ⑤ —— 外观插件（薄壳：只路由，无实现）
// research-engine preset 内嵌插件。实现全部在四插件（①exp-ledger ②stage-ctrl
// ③task-dispatch ④kb-core）里；本插件按入参 ctx.get() 调四插件服务并透传返回。
// 对外入口：research_project → ①；research_go → ②+③；research_memo → ④。
// 可剥离：去掉本插件，四插件各自工具照用，只是没有统一入口。
// 不发服务（不 provide），仅消费同一 isolate realm 内四个服务；不把任何服务漏出 realm。

export const name = 'research-facade';
export const inject = ['tools', 'research.expLedger', 'research.stageCtrl', 'research.taskDispatch', 'research.kbCore'];

const svcMap = {
  project: 'research.expLedger',
  go: { read: 'research.stageCtrl', define: 'research.stageCtrl', goto: 'research.stageCtrl', templates: 'research.taskDispatch', template: 'research.taskDispatch', draft: 'research.taskDispatch', launch: 'research.taskDispatch' },
  memo: 'research.kbCore',
};
const methodByOp = {
  project: { load: 'load', init: 'init', query: 'query', write: 'write' },
  go: { read: 'read', define: 'define', goto: 'goto', templates: 'templates', template: 'template', draft: 'draft', launch: 'launch' },
  memo: { learn: 'learn', context: 'context', report: 'report', index: 'index' },
};

/** UI 呈现辅助：按 op 映射类别与跟随文件（kind:'edit' + locations → deliverables 文件行）。 */
function opCall(title, kind, paths) {
  return { card: 'generic', title, kind, ...(paths && paths.length ? { locations: paths.map((p) => ({ path: p })) } : {}) };
}
const PROJECT_MAP = {
  load: ['read', ['project.yaml']],
  init: ['edit', ['project.yaml', 'registry.jsonl']],
  query: ['read', ['registry.jsonl']],
  write: ['edit', ['registry.jsonl']],
};
const GO_MAP = {
  read: ['read', ['project.yaml']],
  define: ['edit', ['project.yaml']],
  goto: ['edit', ['.research/state.json', 'project.yaml']],
  templates: ['read', ['project.yaml']],
  template: ['edit', ['project.yaml']],
  draft: ['edit', ['registry.jsonl']],
  launch: ['execute', ['registry.jsonl']],
};
const MEMO_MAP = {
  learn: ['edit', ['.kb/index.yaml']],
  context: ['read', ['.kb/index.yaml']],
  report: ['edit', ['_report/runs.csv', '_report/summary.json']],
  index: ['edit', ['.kb/index.yaml']],
};

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

function route(ctx, exec, group, op, args) {
  const table = methodByOp[group];
  if (!table || !(op in table)) {
    return Promise.resolve({ ok: false, text: `research_${group}：未知 op=${op}。支持：${Object.keys(table || {}).join('/')}（请走 research_* 外观，不直接调 ①–④）。` });
  }
  const target = group === 'go'
    ? (svcMap.go[op] === 'research.stageCtrl' ? 'research.stageCtrl' : 'research.taskDispatch')
    : svcMap[group];
  const service = ctx.get(target);
  if (!service) return Promise.resolve({ ok: false, text: `外观路由失败：服务 ${target} 未就绪（四插件未同 realm 载入？）。` });
  const method = table[op];
  if (typeof service[method] !== 'function') return Promise.resolve({ ok: false, text: `服务 ${target} 缺少方法 ${method}。` });
  const rest = { ...args };
  delete rest.op;
  return Promise.resolve(service[method](rest, exec)).catch((e) => ({ ok: false, text: `${method} 执行失败: ${e?.message || e}` }));
}

function apply(ctx) {
  registerTextTool(ctx, {
    name: 'research_project',
    description: '外观入口 → exp-ledger（工程/实体 ledger）。op: load（载入校验 project.yaml）/ init（生成合规骨架 + legacy 零删除登记）/ query（entity_query：record=entity 实体台账 或 record=run 运行台账）/ write（entity_write）。参数与对应底层工具一致（去掉 op 外其余照传）。',
    properties: {
      op: { type: 'string', description: 'load | init | query | write', enum: ['load', 'init', 'query', 'write'] },
      project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      id: { type: 'string', description: 'init/write 用：id；query(record=run) 用：runId。' },
      name: { type: 'string', description: 'init 用：工程名。' },
      record: { type: 'string', description: 'query 用：entity（默认）| run | all。', enum: ['entity', 'run', 'all'] },
      kind: { type: 'string', description: 'query/write 用：实体或 run 类别。' },
      extends: { type: 'string', description: 'query(record=entity) 用：extends 过滤。' },
      stage: { type: 'string', description: 'query(record=run) 用：阶段过滤。' },
      template: { type: 'string', description: 'query(record=run) 用：模板过滤。' },
      status: { type: 'string', description: 'query(record=run) 用：状态过滤。' },
      props: { type: 'object', description: 'write 用：开放属性。' },
      note: { type: 'string', description: 'write 用：备注。' },
    },
    required: ['op'],
    execute: (args, exec) => route(ctx, exec, 'project', args.op, args),
    presentCall: (args) => {
      const [kind, paths] = PROJECT_MAP[args.op] ?? ['other', []];
      return opCall(`research_project ${args.op}`, kind, paths);
    },
  });

  registerTextTool(ctx, {
    name: 'research_go',
    description: '外观入口 → stage-ctrl + task-dispatch（阶段导航 + 任务派发）。op: read（阶段图）/ define（加阶段或边）/ goto（沿合法边导航，非法边拒绝）/ templates（模板列表）/ template（生成模板）/ draft（草稿）/ launch（安全闸+后台任务）。',
    properties: {
      op: { type: 'string', description: 'read | define | goto | templates | template | draft | launch', enum: ['read', 'define', 'goto', 'templates', 'template', 'draft', 'launch'] },
      project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      action: { type: 'string', description: 'define 用：stage | edge。' },
      id: { type: 'string', description: 'define(stage)/template 用：阶段或模板 id。' },
      from: { type: 'string', description: 'edge/define/goto 用：起点。' },
      to: { type: 'string', description: 'goto/edge 用：目标。' },
      entry: { type: 'string', description: 'define 用：入口阶段。' },
      template: { type: 'string', description: 'draft/launch 用：模板 id。' },
      runId: { type: 'string', description: 'launch 用：已 draft 的 runId。' },
      params: { type: 'object', description: 'draft/launch 用：模板参数。' },
      kind: { type: 'string', description: 'draft/launch 用：运行类别。' },
      stage: { type: 'string', description: 'draft/launch 用：所属阶段。' },
      description: { type: 'string', description: 'define(stage)/template 用：说明。' },
    },
    required: ['op'],
    execute: (args, exec) => route(ctx, exec, 'go', args.op, args),
    presentCall: (args) => {
      const [kind, paths] = GO_MAP[args.op] ?? ['other', []];
      const extra = args.id ?? (args.from && args.to ? args.from + '→' + args.to : '') ?? '';
      return opCall(`research_go ${args.op}${extra ? ' ' + extra : ''}`, kind, paths);
    },
  });

  registerTextTool(ctx, {
    name: 'research_memo',
    description: '外观入口 → kb-core（知识写/检索/报告）。op: learn（唯一知识写入口，frontmatter 自校验）/ context（跨会话检索，注入旧结论）/ report（聚合 run → _report/{runs.csv,summary.json}）/ index（重建 .kb/index.yaml）。',
    properties: {
      op: { type: 'string', description: 'learn | context | report | index', enum: ['learn', 'context', 'report', 'index'] },
      project: { type: 'string', description: '工程根目录；缺省 = 会话工作区。' },
      name: { type: 'string', description: 'learn 用：笔记名（kebab-case）。' },
      description: { type: 'string', description: 'learn 用：摘要。' },
      content: { type: 'string', description: 'learn 用：正文。' },
      type: { type: 'string', description: 'learn/context 用：笔记类型。' },
      tags: { type: 'string', description: 'learn/context 用：标签。' },
      stage: { type: 'string', description: 'learn/context 用：阶段。' },
      query: { type: 'string', description: 'context 用：关键词。' },
      template: { type: 'string', description: 'report 用：模板过滤。' },
      status: { type: 'string', description: 'report 用：状态过滤。' },
      runIds: { type: 'array', description: 'report 用：runId 集合。' },
    },
    required: ['op'],
    execute: (args, exec) => route(ctx, exec, 'memo', args.op, args),
    presentCall: (args) => {
      const [kind, paths] = MEMO_MAP[args.op] ?? ['other', []];
      const all = args.op === 'learn' && args.name ? [`.kb/notes/${args.name}.md`, ...paths] : paths;
      return opCall(`research_memo ${args.op}${args.name ? ' ' + args.name : ''}`, kind, all);
    },
  });
}

export { apply };
