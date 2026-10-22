/**
 * P2 语义检索验收（可重复执行）：node scripts/smoke-rag.mjs
 * 前提：服务已启动（HTTP 模式），data 中已有 seed-mock 的演示项目。
 *
 * 验收标准（方案 P2）：中文语义查询能命中关键词搜不到的文档。
 * 查询「钱怎么退回来」不含任何 chunk 的连续子串（FTS/LIKE 都搜不到），
 * 只有向量语义召回能命中「退款流程」相关段落。
 *
 * 首次运行会触发本地 embedding 模型下载（~100MB），请耐心等待。
 */
const BASE = process.env.MCP_URL ?? 'http://localhost:3210/mcp';
const TOKEN = process.env.AUTH_TOKEN ?? 'dev-token-123575885';
const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  Authorization: `Bearer ${TOKEN}`,
};
let id = 0;
async function callTool(name, args = {}) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  const raw = json.result.content[0].text;
  const isError = !!json.result.isError;
  let data = raw;
  if (!isError) { try { data = JSON.parse(raw); } catch { /* 保留原文 */ } }
  return { isError, data };
}

const projects = await callTool('list_projects');
const demo = projects.data.find((p) => p.name === '演示项目');
if (!demo) { console.log('FAIL  演示项目不存在，请先启动服务并运行 seed-mock'); process.exit(1); }

// 首次运行时模型下载 + 首轮向量化需要时间，轮询等待向量路就绪
const QUERY = '钱怎么退回来';
let result = null;
const maxAttempts = 60; // 60 × 5s = 5 分钟
for (let i = 1; i <= maxAttempts; i++) {
  result = await callTool('search_documents', { project_id: demo.id, query: QUERY });
  if (!result.isError && result.data?.meta?.vector && result.data?.total > 0) break;
  if (i % 6 === 0) console.log(`  ...等待 embedding 模型就绪/向量化完成（第 ${i} 次探测）`);
  await new Promise((r) => setTimeout(r, 5000));
}

console.log(`查询: "${QUERY}"`);
console.log(`向量路可用: ${result.data?.meta?.vector}`);
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const hits = result?.data?.hits ?? [];
check('语义查询命中结果（FTS/LIKE 均无法匹配此短语）', hits.length > 0,
  hits.map((h) => `${h.document_title}>${h.heading_path || '?'} [${h.source}]`).join(' ; '));
check('命中来源为向量召回', hits[0]?.source === 'vector');
check('命中内容与退款相关（语义正确）', hits[0]?.content.includes('退款'));
check('结果带章节路径', !!hits[0]?.heading_path);

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
