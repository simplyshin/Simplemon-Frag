import { FlagEmbedding, EmbeddingModel } from 'fastembed';
import { join } from 'node:path';
import { DATA_DIR } from '../../config/index.js';

/** fastembed 本地模型（默认零 key）。fastembed 动态加载，模型首次 embed 时下载 */

export interface Embedder {
  /** 模型指纹：变更时向量表需重建 */
  fingerprint: string;
  /** 向量维度（local 模型固定已知；openai-compatible 首次调用后填充） */
  dim: number;
  embedPassages(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export function createLocalEmbedder(modelKey = 'bge-small-zh-v1.5'): Embedder {
  const isZh = modelKey.includes('zh');
  const model = isZh ? EmbeddingModelName.BGESmallZH : EmbeddingModelName.BGESmallEN;
  // in-flight 去重：并发调用共享同一次 init，避免多路同时下载模型互相破坏 .part 文件
  let initPromise: Promise<FastEmbedding> | null = null;

  const getInstance = (): Promise<FastEmbedding> => {
    if (!initPromise) {
      initPromise = (async () => {
        const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
        return FlagEmbedding.init({
          model: EmbeddingModel[model],
          cacheDir: join(DATA_DIR, 'models'),
        });
      })();
      initPromise.catch(() => { initPromise = null; }); // 失败后允许重试
    }
    return initPromise;
  };

  return {
    fingerprint: `local:${model}`,
    dim: 512,
    async embedPassages(texts: string[]): Promise<number[][]> {
      const emb = await getInstance();
      const out: number[][] = [];
      for await (const batch of emb.passageEmbed(texts, 32)) out.push(...batch);
      return out;
    },
    async embedQuery(text: string): Promise<number[]> {
      const emb = await getInstance();
      return emb.queryEmbed(text);
    },
  };
}

/** fastembed 模型枚举键名（与包内 EmbeddingModel 对应） */
enum EmbeddingModelName {
  BGESmallZH = 'BGESmallZH',
  BGESmallEN = 'BGESmallEN',
}
type FastEmbedding = import('fastembed').FlagEmbedding;
