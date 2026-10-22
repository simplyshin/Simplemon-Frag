/** 模拟 AI 客户端调用链路：list_projects → list_documents → get_document */
const BASE = 'http://localhost:3210/mcp';
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
  return JSON.parse(json.result.content[0].text);
}

console.log('=== Step 1: list_projects ===');
const projects = await callTool('list_projects');
for (const p of projects) console.log(`- ${p.name} (${p.id}) ${p.description}`);

const demo = projects.find((p) => p.name === '演示项目');
if (!demo) throw new Error('演示项目不存在，请先运行 node scripts/seed-mock.mjs');

console.log(`\n=== Step 2: list_documents(演示项目) ===`);
const docs = await callTool('list_documents', { project_id: demo.id });
for (const d of docs) console.log(`- ${d.title} v${d.version_no} (${d.id})`);

console.log(`\n=== Step 3: get_document(需求说明) ===`);
const doc = await callTool('get_document', { project_id: demo.id, title: '需求说明' });
console.log(`标题: ${doc.title} | 版本: v${doc.version_no} | 章节路径:`);
for (const h of doc.heading_paths) console.log(`  - ${h}`);
console.log('\n--- 退款流程部分（AI 据此回答） ---');
const start = doc.content.indexOf('### 退款流程');
const end = doc.content.indexOf('## 通知模块');
console.log(doc.content.slice(start, end).trim());
