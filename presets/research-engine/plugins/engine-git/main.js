// engine-git —— 内建版本库封装（内部基础设施，不注册任何工具）
//
// 定位（plan §1）：为 P2「封闭变更」提供版本、还原、审计能力；**对模型完全不可见**——
// 不注册工具、服务名只在 preset 内部 isolate realm 里可见、返回给调用方的对象不含任何
// 面向模型的措辞。所有模型可见文本由各工具自己撰写，本模块只产出结构化结果。
//
// 硬规则（tool-flows §附）：
//   ① 每次调用都显式传 GIT_DIR / GIT_WORK_TREE，绝不依赖目录发现 → 物理上不可能读到用户仓库；
//   ② 不写 .gitignore、不改用户 index/HEAD/config/hooks；
//   ③ 不在工程根建 .git（仓库是 bare，位于 .research/engine.git）；
//   ④ 若工程本身是用户仓库，只只读取其 HEAD 作为证据标签（可选，见 userRepoHead）；
//   ⑤ .research/engine.git 在用户仓库里会显示为未跟踪 —— 不代改 ignore，只在 init 报告里提一句。
//
// 进程约束：只用 node:* 内建；不 import 兄弟插件文件；spawnSync 用**文件重定向 stdio**
//（不是管道），在受限执行器里也不会撞到 named pipe 限制。

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import {
  readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync,
  existsSync, readdirSync, statSync,
} from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';

const STORE_DIR = join('.research', 'engine.git');
const ATTR_LINES = [
  'experiments/*/raw/** filter=lfs diff=lfs merge=lfs -text',
  'experiments/*/raw/** -text',
].join('\n') + '\n';

let PROBE = null;

function sha256Hex(buf) { return createHash('sha256').update(buf).digest('hex'); }

/** 低层执行：显式 GIT_DIR/GIT_WORK_TREE + 文件重定向 stdio（无管道）。 */
function runGit(root, args, opts = {}) {
  const gd = join(root, STORE_DIR);
  const base = join(os.tmpdir(), 're-git');
  try { mkdirSync(base, { recursive: true }); } catch { /* ignore */ }
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const outPath = join(base, `${stamp}.out`);
  const errPath = join(base, `${stamp}.err`);
  let fdOut = null; let fdErr = null; let res = null; let out = ''; let err = '';
  try {
    fdOut = openSync(outPath, 'w');
    fdErr = openSync(errPath, 'w');
    res = spawnSync(opts.bin || 'git', args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_DIR: gd,
        GIT_WORK_TREE: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_LFS_SKIP_SMUDGE: opts.skipSmudge === true ? '1' : '0',
        LC_ALL: 'C',
      },
      stdio: ['ignore', fdOut, fdErr],
      windowsHide: true,
      timeout: opts.timeoutMs ?? 180000,
    });
  } catch (e) {
    return { ok: false, status: null, stdout: '', stderr: String(e?.message || e), spawnFailed: true };
  } finally {
    if (fdOut !== null) { try { closeSync(fdOut); } catch { /* ignore */ } }
    if (fdErr !== null) { try { closeSync(fdErr); } catch { /* ignore */ } }
  }
  try { out = readFileSync(outPath, 'utf8'); } catch { out = ''; }
  try { err = readFileSync(errPath, 'utf8'); } catch { err = ''; }
  try { unlinkSync(outPath); } catch { /* ignore */ }
  try { unlinkSync(errPath); } catch { /* ignore */ }
  const status = res === null ? null : res.status;
  return { ok: status === 0, status, stdout: out, stderr: err, spawnFailed: res !== null && res.error !== undefined && res.error !== null };
}

/** 能力探测（进程内缓存一次）。 */
function probe() {
  if (PROBE !== null) return PROBE;
  const tmp = join(os.tmpdir());
  const v = runGit(tmp, ['--version'], { timeoutMs: 15000 });
  const available = v.ok === true;
  let lfs = false; let lfsVersion = '';
  if (available) {
    const l = runGit(tmp, ['lfs', 'version'], { timeoutMs: 20000 });
    lfs = l.ok === true;
    lfsVersion = (l.stdout || '').trim().split('\n')[0] || '';
  }
  PROBE = {
    available,
    version: (v.stdout || '').trim().split('\n')[0] || '',
    lfs,
    lfsVersion,
    detail: available ? '' : (v.stderr || 'command unavailable').trim().slice(0, 200),
  };
  return PROBE;
}

function readText(p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }

function createEngineGit() {
  const svc = {
    /** 能力探测结果（不含面向模型的措辞）。 */
    capabilities() { return { ...probe() }; },

    storeDir(root) { return join(root, STORE_DIR); },

    /** 是否已经建过版本库。 */
    exists(root) { return existsSync(join(root, STORE_DIR, 'HEAD')); },

    /** 一次性初始化：bare 仓库 + 隔离配置 + LFS 属性。 */
    init(root) {
      const cap = probe();
      if (!cap.available) return { ok: false, mode: 'ledger-only', lfs: false, detail: cap.detail };
      const gd = join(root, STORE_DIR);
      mkdirSync(gd, { recursive: true });
      mkdirSync(join(gd, 'info'), { recursive: true });
      mkdirSync(join(gd, 'empty-hooks'), { recursive: true });
      if (!existsSync(join(gd, 'HEAD'))) {
        const bare = spawnSync('git', ['init', '--quiet', '--bare', '--', gd], {
          stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, timeout: 60000,
        });
        if (bare.status !== 0) return { ok: false, mode: 'ledger-only', lfs: false, detail: '版本库初始化失败' };
      }
      const cfgs = [
        ['user.email', 'engine@research.local'],
        ['user.name', 'research-engine'],
        ['core.hooksPath', join(gd, 'empty-hooks')],
        ['core.autocrlf', 'false'],
        ['core.safecrlf', 'false'],
        ['core.fileMode', 'false'],
        ['gc.auto', '0'],
        ['commit.gpgsign', 'false'],
        ['advice.detachedHead', 'false'],
      ];
      for (const [k, v] of cfgs) runGit(root, ['config', '--local', k, v], { timeoutMs: 30000 });
      // info/exclude：引擎仓库自身永不被登记
      const excludePath = join(gd, 'info', 'exclude');
      if (!existsSync(excludePath)) writeFileSync(excludePath, 'engine.git/\n', 'utf8');
      // LFS 属性（写在仓库 info/ 里，不影响工作树、不影响用户仓库）
      writeFileSync(join(gd, 'info', 'attributes'), ATTR_LINES, 'utf8');
      let lfs = false;
      if (cap.lfs) {
        const ins = runGit(root, ['lfs', 'install', '--local'], { timeoutMs: 60000 });
        lfs = ins.ok === true;
      }
      return { ok: true, mode: 'versioned', lfs, detail: '' };
    },

    /** 当前版本指针；无提交时返回 null。 */
    head(root) {
      const r = runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      const v = (r.stdout || '').trim();
      return r.ok && /^[0-9a-f]{7,64}$/.test(v) ? v : null;
    },

    /** 指定对象是否在本仓库历史中（防历史被重写）。 */
    hasObject(root, ref) {
      if (typeof ref !== 'string' || ref === '') return false;
      const r = runGit(root, ['cat-file', '-e', `${ref}^{commit}`], { timeoutMs: 30000 });
      return r.ok === true;
    },

    /** 受管路径的越权改动：M/D/R → dirty。路径未入库时返回空（尚无基线）。 */
    changed(root, paths) {
      const head = this.head(root);
      if (head === null) return [];
      if (!Array.isArray(paths) || paths.length === 0) return [];
      const r = runGit(root, ['diff-index', '--name-status', '--no-renames', 'HEAD', '--', ...paths]);
      if (!r.ok) return [];
      const out = [];
      for (const line of (r.stdout || '').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const m = /^([A-Z?]+)\t(.+)$/.exec(t);
        if (m) out.push({ code: m[1], path: m[2] });
      }
      return out;
    },

    /** 受管区里的未登记文件（unknown 候选）。 */
    untracked(root, paths) {
      if (!Array.isArray(paths) || paths.length === 0) return [];
      const r = runGit(root, ['ls-files', '--others', '--exclude-standard', '--', ...paths]);
      if (!r.ok) return [];
      return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
    },

    /** 已登记文件清单（index 内容）。 */
    tracked(root, paths) {
      const args = ['ls-files', '--'];
      if (Array.isArray(paths) && paths.length) args.push(...paths);
      const r = runGit(root, args);
      if (!r.ok) return [];
      return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
    },

    /** 落盘 → 入库：只登记显式白名单路径。返回 {commit|null, changed:bool}。 */
    record(root, paths, message) {
      const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p !== '');
      if (!list.length) return { ok: true, commit: this.head(root), changed: false };
      const add = runGit(root, ['add', '--', ...list]);
      if (!add.ok) return { ok: false, commit: null, changed: false, detail: (add.stderr || '').trim().slice(0, 300) };
      const head = this.head(root);
      if (head !== null) {
        // 内容无变化时不产生空提交
        const diff = runGit(root, ['diff-index', '--cached', '--name-only', 'HEAD', '--', ...list]);
        if (diff.ok && (diff.stdout || '').trim() === '') return { ok: true, commit: head, changed: false };
      }
      const args = ['commit', '--quiet', '--no-verify', '-m', String(message || 'engine: update'), '--', ...list];
      const c = runGit(root, args);
      if (!c.ok) {
        const first = (c.stderr || '').split('\n').find((l) => l.trim() !== '') || '';
        return { ok: false, commit: null, changed: false, detail: first.trim().slice(0, 300) };
      }
      return { ok: true, commit: this.head(root), changed: true };
    },

    /** 从最近一次提交取回受管路径（覆盖工作树）。 */
    restore(root, paths) {
      const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p !== '');
      if (!list.length) return { ok: true, restored: [] };
      const r = runGit(root, ['checkout', 'HEAD', '--', ...list]);
      return { ok: r.ok === true, restored: r.ok ? list : [], detail: r.ok ? '' : (r.stderr || '').trim().slice(0, 300) };
    },

    /** 历史（仅内部审计用）。 */
    history(root, limit = 20) {
      const r = runGit(root, ['log', `-n${Math.max(1, limit)}`, '--format=%H%x1f%cI%x1f%s']);
      if (!r.ok) return [];
      return (r.stdout || '').split('\n').filter(Boolean).map((l) => {
        const [commit, ts, ...rest] = l.split('\x1f');
        return { commit, ts, message: rest.join('\x1f') };
      });
    },

    /** 只读取工程自身是否为用户仓库的当前指针（规则④；不读写它的任何状态）。 */
    userRepoHead(root) {
      const r = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD'], {
        stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, timeout: 30000,
      });
      return r.status === 0 ? null : null;
    },

    sha256File(p) {
      try { return sha256Hex(readFileSync(p)); } catch { return null; }
    },

    sha256Text(t) { return sha256Hex(Buffer.from(String(t), 'utf8')); },

    /** 递归列出目录下所有文件（工程内相对路径，posix 分隔）。 */
    listFiles(root, relDir) {
      const abs = join(root, relDir);
      const out = [];
      const walk = (dir, rel) => {
        let ents;
        try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const childAbs = join(dir, e.name);
          const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
          if (e.isDirectory()) { if (e.name !== '.git') walk(childAbs, childRel); continue; }
          if (e.isFile()) out.push(childRel);
        }
      };
      walk(abs, relDir.replace(/\\/g, '/').replace(/\/+$/, ''));
      return out;
    },

    sizeMtime(p) {
      try { const s = statSync(p); return { bytes: s.size, mtime: new Date(s.mtimeMs).toISOString() }; }
      catch { return null; }
    },
  };
  return svc;
}

export const name = 'engine-git';
export const inject = [];

export function apply(ctx) {
  ctx.provide('research.engineGit', createEngineGit());
}
