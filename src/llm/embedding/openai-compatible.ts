import { getApiKey } from '../../config/index.js';
import type { Embedder } from './local.js';

/** OpenAI 兼容 /embeddings 协议（OpenAI text-embedding-3 / 智谱 embedding-3 等） */
export function createOpenAIEmbedder(cfg: {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
}): Embedder {
  const apiKey = getApiKey(cfg.apiKeyEnv);
  if (!apiKey) {
    throw new Error(
      `Embedding provider 为 openai-compatible 但缺少 API key：请在 .env 设置 ${cfg.apiKeyEnv}，或将 embedding.provider 改为 "local"（零 key）`,
    );
  }

  const embedder: Embedder = {
    fingerprint: `openai-compatible:${cfg.baseUrl}/${cfg.model}`,
    dim: -1, // 维度未知，首次调用后确定
    async embedPassages(texts: string[]): Promise<number[][]> {
      return request(texts);
    },
    async embedQuery(text: string): Promise<number[]> {
      return (await request([text]))[0];
    },
  };

  async function request(input: string[]): Promise<number[][]> {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: cfg.model, input }),
    });
    if (!res.ok) {
      throw new Error(`Embedding 请求失败: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
    }
    const json = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
    const data = [...(json.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== input.length) {
      throw new Error(`Embedding 返回数量不匹配: 期望 ${input.length}，得到 ${data.length}`);
    }
    if (embedder.dim === -1 && data[0]?.embedding) {
      embedder.dim = data[0].embedding.length;
    }
    return data.map((d) => d.embedding);
  }

  return embedder;
}
