/**
 * stdio transport 冒烟测试（可重复执行）：node scripts/smoke-stdio.mjs
 * 以子进程方式启动 `node dist/server.js --stdio`，
 * 通过 stdin/stdout 走 JSON-RPC 验证 initialize / tools/list。
 * 同时验证：stdout 无任何非协议输出（日志污染会导致协议解析失败）。
 */
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['dist/server.js', '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

let stdoutBuf = '';
let protocolLines = [];
let noise = [];
child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString('utf-8');
  // LSP 风格：MCP stdio 使用换行分隔 JSON
  let idx;
  while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    if (line.startsWith('{')) protocolLines.push(JSON.parse(line));
    else noise.push(line);
  }
});
let stderrLog = '';
child.stderr.on('data', (c) => { stderrLog += c.toString(); });

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}
const waitFor = (pred, timeoutMs = 8000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const timer = setInterval(() => {
    const found = protocolLines.find(pred);
    if (found) { clearInterval(timer); resolve(found); }
    else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); reject(new Error('等待响应超时')); }
  }, 50);
});

try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'stdio-smoke', version: '0.0.1' } } });
  const init = await waitFor((m) => m.id === 1);
  check('stdio initialize 成功', !!init.result?.serverInfo, JSON.stringify(init.result?.serverInfo ?? {}));

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = await waitFor((m) => m.id === 2);
  const names = list.result?.tools?.map((t) => t.name) ?? [];
  check('stdio tools/list 返回全部 tools', names.length >= 10, names.join(','));

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'server_info', arguments: {} } });
  const call = await waitFor((m) => m.id === 3);
  check('stdio tools/call 正常', call.result?.content?.[0]?.text?.includes('doc-mcp-server'));

  // stdio 下无鉴权（本地子进程可信），直接可调用业务 tool
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_projects', arguments: {} } });
  const projects = await waitFor((m) => m.id === 4);
  check('stdio 调用业务 tool（list_projects）', !projects.result?.isError);
} catch (e) {
  check('stdio 流程', false, e.message);
}

check('stdout 无非协议输出（无日志污染）', noise.length === 0, noise.join(' | ').slice(0, 100));

child.kill();
const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
