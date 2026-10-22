import type { FastifyInstance } from 'fastify';
import { getApiKey, loadConfig, saveConfig } from '../../config/index.js';
import { resetLlm } from '../../llm/registry.js';
import { resetEmbedder } from '../../llm/embedding/index.js';

/**
 * REST：Provider 设置（P3 Web 设置页）。
 * key 从不落 config.json（只存环境变量名引用），GET 仅返回
 * hasKey + keyHint（末 4 位）用于页面展示，绝不回传明文。
 */
function maskKey(envName?: string): { apiKeyEnv: string; hasKey: boolean; keyHint: string } {
  const key = envName ? getApiKey(envName) : undefined;
  return {
    apiKeyEnv: envName ?? '',
    hasKey: !!key,
    keyHint: key ? `***${key.slice(-4)}` : '',
  };
}

export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get('/api/settings', async () => {
    const cfg = loadConfig();
    return {
      llm: {
        provider: cfg.llm.provider,
        providers: Object.fromEntries(
          Object.entries(cfg.llm.options).map(([name, opts]) => [name, {
            baseUrl: opts.baseUrl ?? '',
            model: opts.model ?? '',
            ...maskKey(opts.apiKeyEnv),
          }]),
        ),
      },
      embedding: {
        provider: cfg.embedding.provider,
        local: cfg.embedding.local,
        baseUrl: cfg.embedding.baseUrl,
        model: cfg.embedding.model,
        ...maskKey(cfg.embedding.apiKeyEnv),
      },
      chunking: cfg.chunking,
    };
  });

  app.put('/api/settings', async (request, reply) => {
    const body = (request.body ?? {}) as {
      llm?: unknown;
      embedding?: unknown;
      chunking?: unknown;
    };
    const patch: Record<string, unknown> = {};
    if (body.llm) patch.llm = body.llm;
    if (body.embedding) patch.embedding = body.embedding;
    if (body.chunking) patch.chunking = body.chunking;
    if (!Object.keys(patch).length) {
      return reply.code(400).send({ error: '无可保存的配置（llm/embedding/chunking 至少一项）' });
    }
    saveConfig(patch);
    // 配置热切换：下次调用按新配置重建 provider（向量模型切换会触发指纹重建向量表）
    resetLlm();
    resetEmbedder();
    return { saved: true };
  });
}
