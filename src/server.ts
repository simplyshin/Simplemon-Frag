import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config/index.js';
import { getDb } from './db/index.js';
import { startHttpApp } from './http/app.js';
import { createMcpServer } from './mcp/server.js';
import { flushPendingRebuilds, scheduleStartupRebuilds } from './services/indexing.js';
import { startPendingRetryLoop } from './services/embedding.js';

/**
 * 双 transport 入口（依赖注记 4 备用方案）：
 * - 默认：HTTP 模式（Streamable HTTP + Bearer 鉴权，Trae/Claude 等用）
 * - `--stdio`：标准输入输出模式（Codex 等不支持 HTTP/headers 的客户端用）
 *   - 可叠加 `--web`（或配置 server.webInStdio=true）：同进程内嵌 Web 后台，
 *     与 MCP 共享同一 SQLite 连接（getDb 单例），不会出现双进程 SQLITE_BUSY
 */

if (process.argv.includes('--stdio')) {
  // stdio 模式：本地子进程天然可信，无需 token；
  // stdout 专用于 MCP 协议，任何日志都不得写入 stdout
  process.env.AUTH_TOKEN ||= 'stdio-local';
  const config = loadConfig();
  const mcp = createMcpServer();
  await mcp.connect(new StdioServerTransport());

  // 内嵌 Web 后台（可选）：--web 参数优先，其次配置文件 server.webInStdio
  // （补算循环 / 索引启动自愈 / onClose flush 均由 startHttpApp 注册）
  if (process.argv.includes('--web') || config.server.webInStdio) {
    await startHttpApp(config, { logToStderr: true });
  } else {
    // 纯 stdio：接入自动索引重建的后台任务（与 HTTP 模式行为对齐）
    // - retry loop：兜底补算 flush 跳过 embed 的索引文档 chunk
    // - 启动自愈：指纹预检，仅疑似滞后项目错峰重建
    startPendingRetryLoop(getDb());
    scheduleStartupRebuilds(getDb());
  }
  // MCP 会话结束（stdin 关闭 → 事件循环排空）时同步补齐未触发的重建；
  // 去抖定时器已 unref，不会阻止进程退出
  process.on('beforeExit', () => flushPendingRebuilds(getDb()));
} else {
  const config = loadConfig();
  try {
    await startHttpApp(config);
  } catch (err) {
    // 端口占用等启动失败：独立 HTTP 模式直接退出
    console.error('[server] HTTP 启动失败:', (err as Error).message);
    process.exit(1);
  }
}
