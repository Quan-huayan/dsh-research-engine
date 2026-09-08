#!/usr/bin/env node
// 把本包自带的 preset 同步到 $DSH_HOME/.agent-presets/research-engine。
//
// 什么时候用它：
//   * 你的 DSH 是 0.1.1-rc.x（启动器会把 agent-presets 的 roots 覆写为「仅随附根」，
//     cordis.patch.yml 注册的自带根不生效）；
//   * 或者你不想动 profile 组合，只想让这台机器上有「研究引擎」这个 preset。
//
// 用法：
//   node scripts/install.mjs                 # 目标不存在 → 安装；内容相同 → 跳过；不同 → 拒绝并提示
//   node scripts/install.mjs --force         # 先把已有副本备份成 research-engine.bak-<时间戳>，再覆盖
//   node scripts/install.mjs --dry-run       # 只报告将要做什么
//   node scripts/install.mjs --dir <目录>    # 指定 preset 根（默认 $DSH_HOME/.agent-presets）
//
// 退出码：0 成功/已是最新；1 需要 --force 或出错。

import { cp, mkdir, readFile, readdir, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const PRESET_ID = 'research-engine';
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(PACKAGE_ROOT, 'presets', PRESET_ID);

function parseArgs(argv) {
  const out = { force: false, dryRun: false, dir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--force' || a === '-f') out.force = true;
    else if (a === '--dry-run' || a === '-n') out.dryRun = true;
    else if (a === '--dir') { out.dir = argv[i + 1] ?? null; i += 1; }
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) { console.error(`未知参数：${a}`); process.exit(1); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('用法：node scripts/install.mjs [--force] [--dry-run] [--dir <preset 根目录>]');
  process.exit(0);
}

const dshHome = process.env.DSH_HOME || join(os.homedir(), '.dsh');
const presetRoot = resolve(args.dir ?? join(dshHome, '.agent-presets'));
const target = join(presetRoot, PRESET_ID);

/** 递归列出一个目录下所有文件的相对路径（排序，稳定）。 */
async function listFiles(root, prefix = '') {
  const out = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await listFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** 目录内容指纹：相对路径 + 内容，任一字节变化都会改变它。 */
async function fingerprint(root) {
  const hash = createHash('sha256');
  for (const rel of await listFiles(root)) {
    hash.update(rel).update('\0');
    hash.update(await readFile(join(root, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function exists(p) { return stat(p).then(() => true, () => false); }

if (!await exists(SOURCE)) {
  console.error(`✗ 找不到本包自带的 preset：${SOURCE}`);
  process.exit(1);
}

const sourceHash = await fingerprint(SOURCE);
const installed = await exists(target);
const installedHash = installed ? await fingerprint(target) : null;

console.log(`preset 根：${presetRoot}`);
console.log(`目标目录：${target}`);
console.log(`本包内容：${sourceHash.slice(0, 12)}`);

if (installedHash === sourceHash) {
  console.log('✓ 目标已是同一份内容，无需安装。');
  process.exit(0);
}

if (installed && !args.force) {
  console.log(`! 目标已存在且内容不同（现有 ${installedHash.slice(0, 12)}）。`);
  console.log('  可能是你本地改过的副本。确认要覆盖就加 --force（会先备份）。');
  process.exit(1);
}

const backup = installed ? `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}` : null;
if (args.dryRun) {
  console.log(`· 将创建目录 ${presetRoot}`);
  if (backup) console.log(`· 将备份 ${target} → ${backup}`);
  console.log(`· 将复制 ${SOURCE} → ${target}`);
  console.log('（--dry-run：未做任何改动）');
  process.exit(0);
}

await mkdir(presetRoot, { recursive: true });
if (backup) {
  await rename(target, backup);
  console.log(`· 已备份旧副本 → ${backup}`);
}
await cp(SOURCE, target, { recursive: true });
console.log(`✓ 已安装 ${PRESET_ID} → ${target}`);
console.log('');
console.log('下一步：在 DSH 里新建会话，选「研究引擎」preset（无需重启）。');
console.log('若选择器里没出现，先确认 $DSH_HOME 与 dsh 进程用的是同一个 home。');
