import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { PROJECT_ROOT, type AppConfig } from '../config/index.js';
import { getDb } from '../db/index.js';
import { startPendingRetryLoop } from '../services/embedding.js';
import { registerMcpRoutes } from '../mcp/server.js';
import { registerApiRoutes } from '../api/routes/index.js';

/**
 * HTTP 应用（Web 后台 + REST + Streamable HTTP MCP）：
 * - 默认 HTTP 模式（server.ts）与 stdio 内嵌模式（--web / server.webInStdio）共用，
 *   同进程共享 getDb() 单例 SQLite 连接，避免双进程 SQLITE_BUSY。
 * - stdio 模式下 stdout 专用于 MCP 协议，日志必须重定向到 stderr。
 */
export interface HttpAppOptions {
  /** stdio 内嵌模式：Fastify 日志写 stderr（默认走 stdout，仅 HTTP 独立模式使用） */
  logToStderr?: boolean;
}

export async function createHttpApp(
  config: AppConfig,
  options: HttpAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logToStderr
      ? { level: 'info', stream: process.stderr }
      : { level: 'info', transport: undefined },
  });

  // 上传解析（Web 后台 multipart）
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  // MCP/REST 统一鉴权：
  // - /health 与静态页面（web/dist）免鉴权（页面本身无敏感数据，数据走 /api）
  // - /api：本机（127.0.0.1/::1）免 Bearer（Web 后台开箱即用），远程访问需 Bearer
  // - /mcp：始终需要 Bearer（AI 客户端按配置接入）
  const LOCAL_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (path.startsWith('/health') || (!path.startsWith('/api') && !path.startsWith('/mcp'))) return;
    if (path.startsWith('/api') && LOCAL_IPS.has(request.ip)) return;
    const auth = request.headers.authorization;
    if (auth !== `Bearer ${config.server.authToken}`) {
      await reply.code(401).send({ error: 'Unauthorized: 缺少或错误的 Bearer token' });
    }
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'frag-mcp-server',
    version: '0.1.0',
  }));

  registerMcpRoutes(app);
  registerApiRoutes(app);

  // 托管 Web 后台静态文件（web/dist 存在时启用；SPA fallback 由前端路由接管）
  const webDist = join(PROJECT_ROOT, 'web', 'dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/mcp')) {
        return reply.code(404).send({ error: 'Not Found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.log.info('web/dist 不存在，跳过静态托管（cd web && npm run build 后自动启用）');
  }

  return app;
}

/** 创建并监听端口，启动待向量化补算循环；失败时退出进程（独立 HTTP 模式）或抛出（stdio 内嵌模式） */
export async function startHttpApp(
  config: AppConfig,
  options: HttpAppOptions = {},
): Promise<FastifyInstance> {
  const app = await createHttpApp(config, options);
  await app.listen({ port: config.server.port, host: '0.0.0.0' });
  // 定期补算失败遗留的待向量化 chunk（依赖注记：embedding 失败降级 + 待补算队列）
  startPendingRetryLoop(getDb());
  return app;
}
