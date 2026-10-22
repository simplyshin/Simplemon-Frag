import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

/**
 * E2E：--stdio --web 同进程内嵌 Web 后台。
 * spawn 子进程并保持 stdin 打开（stdio 传输不退出），轮询 /health 后
 * 验证 REST 导出端点（走真实 data/app.db，只读 + 附加迁移）。
 * 需先 npm run build（依赖 dist/server.js）。
 */
const PORT = 3299;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForHealth(child: ChildProcess): Promise<{ status?: string }> {
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error(`子进程提前退出: code=${child.exitCode}`);
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return (await res.json()) as { status?: string };
    } catch { /* 未就绪，重试 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('等待 /health 超时（10s）');
}

describe('stdio + 内嵌 Web 后台（--web）', () => {
  it('同进程启动 Fastify：/health 可用，REST 导出端点返回 markdown 附件', async () => {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), 'dist', 'server.js'), '--stdio', '--web'],
      {
        env: { ...process.env, PORT: String(PORT), AUTH_TOKEN: 'test-stdio-web' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    // stderr 收集（stdio 模式日志必须走 stderr，不得污染 stdout 的 MCP 协议）
    const stderrChunks: string[] = [];
    child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d.toString()));

    try {
      const health = await waitForHealth(child);
      expect(health.status).toBe('ok');

      // 取真实库一个项目的第一篇文档，验证导出端点
      const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as { id: string }[];
      expect(projects.length).toBeGreaterThan(0);
      const docs = (await (await fetch(`${BASE}/api/projects/${projects[0].id}/documents`)).json()) as
        { id: string; title: string }[];
      expect(docs.length).toBeGreaterThan(0);

      const res = await fetch(`${BASE}/api/documents/${docs[0].id}/export`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/markdown');
      expect(res.headers.get('content-disposition')).toContain('attachment');
      const body = await res.text();
      expect(body.length).toBeGreaterThan(0);
    } finally {
      child.kill();
    }

    // stdio 模式下 HTTP 日志必须重定向到 stderr（stdout 专用于 MCP 协议）
    const stderrText = stderrChunks.join('');
    expect(stderrText).toContain('Server listening');
  }, 30_000);
});
