// Only trusted local engine code can be reloaded. No request controls this path.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export function createEngineLoader(url = new URL('./reader-engine.mjs', import.meta.url)) {
  let latestHash = '', latestEngine;
  return async () => {
    const source = await readFile(url, 'utf8');
    const hash = createHash('sha256').update(source).digest('hex');
    if (hash !== latestHash) {
      const target = new URL(url); target.searchParams.set('revision', hash);
      const engine = await import(target.href);
      if (typeof engine.explain !== 'function' || typeof engine.inspectSyntheticAnswer !== 'function') throw new Error('本地解释引擎缺少入口。');
      latestHash = hash; latestEngine = engine;
    }
    return latestEngine;
  };
}
export const loadEngine = createEngineLoader();
