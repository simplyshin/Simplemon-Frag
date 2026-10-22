import { getApiKey, loadConfig } from '../config/index.js';
import {
  createAnthropicLlm,
  createOpenAICompatibleLlm,
  type LlmProvider,
} from './providers.js';

/**
 * LLM Provider 注册与工厂。
 * - openai / deepseek / zhipu 走 OpenAI 兼容协议适配器（不同 baseUrl/model/key）
 * - anthropic 走独立适配器
 * - 未配置 key 时返回 null：调用方（P4 生成类功能）优雅降级，不阻塞其他功能
 */

const PRESETS: Record<string, { baseUrl: string; model: string; apiKeyEnv: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' },
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', apiKeyEnv: 'ZHIPU_API_KEY' },
};

let cached: LlmProvider | null | undefined;

export function getLlm(): LlmProvider | null {
  if (cached !== undefined) return cached;
  cached = createLlm(loadConfig().llm);
  return cached;
}

/** 测试/配置热切换用 */
export function resetLlm(): void {
  cached = undefined;
}

export function createLlm(llmConfig: {
  provider: string;
  options: Record<string, Record<string, string | undefined>>;
}): LlmProvider | null {
  const name = llmConfig.provider;
  const opts = llmConfig.options?.[name] ?? {};

  if (name === 'anthropic') {
    const apiKey = getApiKey(String(opts.apiKeyEnv ?? 'ANTHROPIC_API_KEY'));
    if (!apiKey) return null;
    return createAnthropicLlm({
      name,
      baseUrl: String(opts.baseUrl ?? 'https://api.anthropic.com'),
      model: String(opts.model ?? 'claude-sonnet-4-5'),
      apiKey,
    });
  }

  const preset = PRESETS[name];
  if (!preset) return null;
  const apiKey = getApiKey(String(opts.apiKeyEnv ?? preset.apiKeyEnv));
  if (!apiKey) return null;
  return createOpenAICompatibleLlm({
    name,
    baseUrl: String(opts.baseUrl ?? preset.baseUrl),
    model: String(opts.model ?? preset.model),
    apiKey,
  });
}
