// 插件静态自检：能加载、导出契约正确、工具名合法且全局唯一、schema 落在 dsh-tools 支持子集内。
// 用法：node tools/check-plugins.mjs
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
// 默认读仓库里的 preset（唯一真源）；RESEARCH_ENGINE_PRESET 可指向别处（例如已安装的副本）。
const PRESET = process.env.RESEARCH_ENGINE_PRESET || join(REPO, 'presets', 'research-engine');
const PLUGINS = ['engine-git', 'exp-ledger', 'stage-ctrl', 'task-dispatch', 'kb-core'];
const NAME_RE = /^[a-zA-Z0-9_-]+$/;
// 用宿主真正的 schema 校验器验「parameters / output.schema 落在支持子集内」（§6.1-1）
let assertSupportedJsonSchema = null;
let validateJsonSchemaValue = null;
for (const p of [
  join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'),
  'E:/node/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
]) {
  try {
    const m = await import(pathToFileURL(p).href);
    assertSupportedJsonSchema = m.assertSupportedJsonSchema;
    validateJsonSchemaValue = m.validateJsonSchemaValue;
    break;
  } catch { /* 试下一个 */ }
}

const registered = [];
const fakeCtx = {
  tools: { register: (def) => { registered.push(def); } },
  provide: (n) => { registered.push({ __service: n }); },
  get: () => undefined,
  effect: () => {},
};

let bad = 0;
const services = [];
for (const p of PLUGINS) {
  const url = pathToFileURL(join(PRESET, 'plugins', p, 'main.js')).href;
  try {
    const mod = await import(url);
    const missing = ['name', 'apply'].filter((k) => !(k in mod));
    if (missing.length) { console.log(`✗ ${p}: 缺导出 ${missing.join(',')}`); bad += 1; continue; }
    const before = registered.length;
    mod.apply(fakeCtx);
    const mine = registered.slice(before).filter((d) => !d.__service);
    const svc = registered.slice(before).filter((d) => d.__service).map((d) => d.__service);
    services.push(...svc);
    console.log(`✓ ${p}: 工具 ${mine.length} 个${svc.length ? `，服务 ${svc.join(',')}` : ''}`);
    for (const d of mine) {
      const nm = d.name;
      if (!NAME_RE.test(nm)) { console.log(`  ✗ 工具名非法（provider 只接受 [a-zA-Z0-9_-]）：${nm}`); bad += 1; }
      if (typeof d.description !== 'string' || !d.description) { console.log(`  ✗ ${nm}: 缺 description`); bad += 1; }
      if (!d.parameters || d.parameters.type !== 'object') { console.log(`  ✗ ${nm}: parameters 必须是 object 根`); bad += 1; }
      if (!d.output || !d.output.schema || typeof d.output.render !== 'function') { console.log(`  ✗ ${nm}: output 必须是 {schema, render}`); bad += 1; }
      const outSchema = d.output?.schema;
      if (outSchema && (outSchema.additionalProperties !== false || !outSchema.required?.includes('text'))) {
        console.log(`  ✗ ${nm}: output.schema 必须严格 {text:string}（additionalProperties:false + required:['text']）`); bad += 1;
      }
      if (assertSupportedJsonSchema) {
        for (const [what, node] of [['parameters', d.parameters], ['output.schema', outSchema]]) {
          try { assertSupportedJsonSchema(node); } catch (e) {
            console.log(`  ✗ ${nm}: ${what} 超出 dsh-tools 支持子集 —— ${e.message}`); bad += 1;
          }
        }
      }
      // 输出契约自洽：{text:'x'} 必须通过自己的 output.schema
      if (validateJsonSchemaValue && outSchema) {
        const errs = validateJsonSchemaValue(outSchema, { text: 'x' });
        if (errs.length) { console.log(`  ✗ ${nm}: 返回样例不过 output.schema —— ${errs.join('; ')}`); bad += 1; }
      }
    }
  } catch (e) {
    console.log(`✗ ${p}: 加载失败 ${e.message}`);
    bad += 1;
  }
}

const names = registered.filter((d) => !d.__service).map((d) => d.name);
const dup = names.filter((n, i) => names.indexOf(n) !== i);
if (dup.length) { console.log(`✗ 工具名重复：${[...new Set(dup)].join(', ')}`); bad += 1; }
console.log(`\n工具总数：${names.length}（模型面 21 + 内部服务不计）`);
console.log(names.sort().join('  '));

// 22 工具名契约核对
const EXPECTED = ['project_init', 'project_load', 'project_verify', 'project_reconcile', 'entity_declare', 'entity_query', 'convention_declare',
  'stage_declare', 'stage_read', 'stage_goto',
  'template_declare', 'script_declare', 'run_draft', 'run_launch', 'run_observe', 'run_query', 'run_close',
  'note_write', 'note_adjudicate', 'note_query', 'view_render'];
const missing = EXPECTED.filter((e) => !names.includes(e));
const extra = names.filter((n) => !EXPECTED.includes(n));
if (missing.length) { console.log(`\n✗ 缺工具：${missing.join(', ')}`); bad += 1; }
if (extra.length) { console.log(`\n✗ 多余工具：${extra.join(', ')}`); bad += 1; }
if (!missing.length && !extra.length) console.log('\n21 个模型面工具齐备（+ 内部 ledger_append 服务）');

// 返回文本 / 描述里不得出现版本库词汇
const FORBIDDEN = /git|commit|HEAD|diff|hash|sha|\.git/i;
for (const d of registered.filter((x) => !x.__service)) {
  if (FORBIDDEN.test(d.description)) { console.log(`✗ ${d.name}: description 含版本库词汇`); bad += 1; }
}
console.log(`\n服务：${services.join(', ')}`);
process.exit(bad ? 1 : 0);
