import { loadConfig } from '../../config/index.js';
import { createLocalEmbedder, type Embedder } from './local.js';
import { createOpenAIEmbedder } from './openai-compatible.js';

/**
 * Embedding Provider 工厂：local（默认零 key）| openai-compatible（可选）。
 * 进程内单例；测试通过 setEmbedderForTests 注入假实现。
 */

let cached: Embedder | null = null;
let testOverride: Embedder | null | undefined;

export function getEmbedder(): Embedder {
  if (testOverride) return testOverride;
  if (cached) return cached;
  cached = createEmbedder(loadConfig().embedding);
  return cached;
}

export function createEmbedder(cfg: {
  provider: string;
  local: { model: string };
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
}): Embedder {
  if (cfg.provider === 'local') {
    return createLocalEmbedder(cfg.local?.model);
  }
  if (cfg.provider === 'openai-compatible') {
    return createOpenAIEmbedder(cfg);
  }
  throw new Error(`未知的 embedding provider: ${cfg.provider}（可选 local / openai-compatible）`);
}

/** 测试注入（传 null 恢复默认） */
export function setEmbedderForTests(embedder: Embedder | null): void {
  testOverride = embedder ?? undefined;
}

/** 配置热切换用（P3 设置页保存后调用）：下次 getEmbedder 按新配置重建 */
export function resetEmbedder(): void {
  cached = null;
}
