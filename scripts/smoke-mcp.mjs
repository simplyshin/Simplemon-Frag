/**
 * MCP 端点冒烟测试（可重复执行）：node scripts/smoke-mcp.mjs
 * 前提：服务已启动（AUTH_TOKEN 与本脚本 token 一致）
 * 验证：无状态 Streamable HTTP 的 initialize / tools/list / tools/call 全链路
 */
const BASE = process.env.MCP_URL ?? 'http://localhost:3210/mcp';
const TOKEN = process.env.AUTH_TOKEN ?? 'dev-token-123';

const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  Authorization: `Bearer ${TOKEN}`,
};

let idCounter = 0;
const nextId = () => ++idCounter;

async function post(body) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // SSE 响应：取 data 行
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    if (dataLine) json = JSON.parse(dataLine.slice(5).trim());
  }
  return { status: res.status, json, text };
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// 1. 鉴权拒绝
const noAuth = await fetch(BASE, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
});
check('无 token 请求被拒绝(401)', noAuth.status === 401, `status=${noAuth.status}`);

// 2. initialize
const init = await post({
  jsonrpc: '2.0',
  id: nextId(),
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '0.0.1' },
  },
});
const serverInfo = init.json?.result?.serverInfo;
check('initialize 成功', init.status === 200 && !!serverInfo, JSON.stringify(serverInfo ?? init.text.slice(0, 200)));

// 3. tools/list（无状态模式：初始化通知 + 请求合并为一次 batch 发送）
const listRes = await post([
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: nextId(), method: 'tools/list' },
]);
const tools = listRes.json?.find?.((r) => r.id && r.result)?.result?.tools
  ?? listRes.json?.result?.tools;
check('tools/list 返回 server_info', Array.isArray(tools) && tools.some((t) => t.name === 'server_info'),
  tools ? tools.map((t) => t.name).join(',') : listRes.text.slice(0, 200));

// 4. tools/call
const call = await post({
  jsonrpc: '2.0',
  id: nextId(),
  method: 'tools/call',
  params: { name: 'server_info', arguments: {} },
});
const callText = call.json?.result?.content?.[0]?.text;
check('tools/call server_info 返回服务信息', !!callText && callText.includes('frag-mcp-server'),
  callText?.slice(0, 80) ?? call.text.slice(0, 200));

// 5. GET /mcp 无状态模式应拒绝 SSE 流（405）
const getSse = await fetch(BASE, { method: 'GET', headers });
check('GET /mcp 返回 405（无状态模式不支持 SSE 流）', getSse.status === 405, `status=${getSse.status}`);

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
