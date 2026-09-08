// research-engine 组合包的提供方行（profile 层，非 preset 层）。
//
// 职责只有一件事：把「本包自带的 preset 根」暴露成一个服务，供 cordis.patch.yml 里
// agent-presets 行的 !!js 配置读取 —— 这样 roots 的路径来自本包自己的 import.meta.url，
// 不依赖 cwd，也不依赖加载器把 baseUrl 指向哪里。
//
// 不注册工具、不写文件、不依赖任何 @deepseek-ai/* 包（只用 node: 内建）。

import { fileURLToPath } from 'node:url';

export const name = 'research-engine-bundle';

/** 本 preset 的 id（目录名），与 presets/ 下的目录名一致。 */
export const PRESET_ID = 'research-engine';

export function apply(ctx) {
  const packageRoot = fileURLToPath(new URL('.', import.meta.url));
  const presetsDir = fileURLToPath(new URL('presets/', import.meta.url));
  ctx.provide('researchEngineBundle', {
    packageRoot,
    presetsDir,
    presetId: PRESET_ID,
  });
}
