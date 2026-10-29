import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../config/index.js';

/**
 * Web 界面自动构建：web/dist 缺失时自动补建（npm install + npm run build）。
 * - 必须在 app.listen 前同步完成（@fastify/static 禁止监听后注册）；
 *   stdio --web 模式下 MCP 已先行连接，构建期间 MCP 正常可用
 * - 子进程输出重定向到 stderr：stdio 模式 stdout 专用于 MCP 协议
 * - 失败仅告警降级（API/MCP 不受影响），不阻断启动
 * - NODE_ENV=test（vitest）或 WEB_AUTO_BUILD=off 时跳过
 */

const BUILD_TIMEOUT_MS = 10 * 60_000;

function runNpm(args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('npm', args, {
      cwd,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, BUILD_TIMEOUT_MS);
    child.stdout?.pipe(process.stderr);
    child.stderr?.pipe(process.stderr);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** 确保 web/dist 存在；不存在则尝试自动构建。返回 true 表示 dist 可用于静态托管 */
export async function ensureWebDistBuilt(info: (msg: string) => void): Promise<boolean> {
  const webRoot = join(PROJECT_ROOT, 'web');
  const distDir = join(webRoot, 'dist');
  if (existsSync(distDir)) return true;
  if (process.env.NODE_ENV === 'test' || process.env.WEB_AUTO_BUILD === 'off') return false;
  if (!existsSync(join(webRoot, 'package.json'))) {
    info('web/ 源码目录不存在，跳过 Web 界面自动构建');
    return false;
  }

  info('web/dist 不存在，开始自动构建 Web 界面（首次运行需安装依赖，可能需要几分钟）...');
  if (!existsSync(join(webRoot, 'node_modules'))) {
    info('[web] npm install ...');
    if (!(await runNpm(['install'], webRoot))) {
      info('[web] npm install 失败，跳过静态托管（可手动执行 cd web && npm install && npm run build）');
      return false;
    }
  }
  info('[web] npm run build ...');
  if (!(await runNpm(['run', 'build'], webRoot)) || !existsSync(distDir)) {
    info('[web] 构建失败，跳过静态托管（可手动执行 cd web && npm run build）');
    return false;
  }
  info('[web] Web 界面构建完成，静态托管已启用');
  return true;
}
