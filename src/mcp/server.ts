import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { registerAllTools } from './tools/index.js';

const SERVER_INFO = { name: 'frag-mcp-server', version: '0.1.0' } as const;

/** 创建 MCP Server 实例并注册全部 tools（无状态模式下每请求新建） */
export function createMcpServer(): McpServer {
  const mcp = new McpServer(SERVER_INFO);
  registerAllTools(mcp);
  return mcp;
}

/**
 * 将 MCP Streamable HTTP 端点挂载到 Fastify（POST/GET/DELETE /mcp）。
 *
 * 采用无状态模式（sessionIdGenerator: undefined）：
 * - 每个请求创建独立的 transport + McpServer 实例，不做会话保持
 * - 单用户自托管场景足够，省去会话表与过期清理
 * - GET(SSE)/DELETE 返回 405，客户端走 POST + JSON 响应模式
 * - 鉴权复用 server.ts 的全局 Bearer token 钩子
 */
export function registerMcpRoutes(app: FastifyInstance): void {
  // 无状态模式下不支持独立 SSE 流(GET)与会话终止(DELETE)，
  // 显式返回 405，避免客户端 GET 打开悬挂连接（MCP 规范允许）
  app.get('/mcp', async (_req, reply) => {
    await reply.code(405).header('Allow', 'POST').send({
      error: 'Method Not Allowed: 无状态模式仅支持 POST /mcp',
    });
  });
  app.delete('/mcp', async (_req, reply) => {
    await reply.code(405).header('Allow', 'POST').send({
      error: 'Method Not Allowed: 无状态模式无会话可终止',
    });
  });

  app.post('/mcp', async (request, reply) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcp = createMcpServer();

    reply.raw.on('close', () => {
      void transport.close();
      void mcp.close();
    });

    // hijack 后由 transport 直接写入原生 res（JSON 响应模式）
    reply.hijack();
    await mcp.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
}
