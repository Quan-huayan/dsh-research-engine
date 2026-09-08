// 用宿主自己的 preset 发现器验证仓库里 research-engine preset 的合成文件（含 !!js 表达式）。
// 用法：node tools/check-preset.mjs
//   RESEARCH_ENGINE_PRESET 可指向别处（例如已安装的副本）。
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
const PRESET = process.env.RESEARCH_ENGINE_PRESET || join(REPO, 'presets', 'research-engine');
const mod = await import(pathToFileURL(join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'lib', 'index.js')).href);
const presets = await mod.discoverPresets([{ path: dirname(PRESET), trust: 'system' }]);
let bad = 0;
for (const p of presets) {
  const problem = p.problem ?? p.broken ?? null;
  console.log(`${problem ? '✗' : '✓'} ${p.id}: name=${JSON.stringify(p.metadata?.name ?? p.name ?? null)}${problem ? ` —— ${problem}` : ''}`);
  if (problem) bad += 1;
}
if (!presets.length) { console.log('✗ 未发现任何 preset'); bad += 1; }
console.log(`\npreset 发现 ${presets.length} 个，问题 ${bad} 个`);
process.exit(bad ? 1 : 0);
