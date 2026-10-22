/** MCP tool 返回值工具：统一 JSON 文本输出与错误包装 */

export interface ToolResult {
  // SDK 的 CallToolResult 允许扩展字段（如 _meta），需索引签名兼容
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export function ok(data: unknown): ToolResult {
  // Promise 误传检测：JSON.stringify(Promise) === "{}"，曾导致 search_documents 返回空对象。
  // async service 必须 await 后再传给 ok()。带调用栈日志，方便定位是哪个工具误传。
  if (data instanceof Promise || typeof (data as { then?: unknown } | null | undefined)?.then === 'function') {
    console.error('[tool] ok() 收到 Promise 而非实际数据，序列化结果将是 "{}"——请在调用前 await。调用栈:\n'
      + new Error('ok(Promise) 调用栈').stack);
  }
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** 统一异常包装：业务错误以 isError 文本返回给 AI，不抛断连接 */
export async function handle(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(err);
  }
}
