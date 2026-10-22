/**
 * LLM Provider 抽象（P4 生成类功能的底层，P2 仅实现与注册）。
 * OpenAI / DeepSeek / 智谱 均为 OpenAI 兼容协议，共用一个适配器；
 * Anthropic（Claude）消息结构不同，单独适配。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmProvider {
  name: string;
  model: string;
  chat(messages: ChatMessage[], opts?: { maxTokens?: number; temperature?: number }): Promise<string>;
}

export interface LlmEndpoint {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** OpenAI 兼容协议（OpenAI / DeepSeek / 智谱 通用） */
export function createOpenAICompatibleLlm(endpoint: LlmEndpoint): LlmProvider {
  return {
    name: endpoint.name,
    model: endpoint.model,
    async chat(messages, opts) {
      const res = await fetch(`${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${endpoint.apiKey}`,
        },
        body: JSON.stringify({
          model: endpoint.model,
          messages,
          max_tokens: opts?.maxTokens ?? 2048,
          temperature: opts?.temperature ?? 0.3,
        }),
      });
      if (!res.ok) {
        throw new Error(`LLM 请求失败(${endpoint.name}): ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
      }
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return json.choices?.[0]?.message?.content ?? '';
    },
  };
}

/** Anthropic Messages API（Claude） */
export function createAnthropicLlm(endpoint: LlmEndpoint): LlmProvider {
  return {
    name: endpoint.name,
    model: endpoint.model,
    async chat(messages, opts) {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      const rest = messages.filter((m) => m.role !== 'system');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': endpoint.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: endpoint.model,
          max_tokens: opts?.maxTokens ?? 2048,
          temperature: opts?.temperature ?? 0.3,
          ...(system ? { system } : {}),
          messages: rest,
        }),
      });
      if (!res.ok) {
        throw new Error(`LLM 请求失败(${endpoint.name}): ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
      }
      const json = (await res.json()) as { content?: { text?: string }[] };
      return json.content?.map((c) => c.text ?? '').join('') ?? '';
    },
  };
}
