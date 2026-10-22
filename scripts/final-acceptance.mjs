/**
 * P1 终验脚本（可重复执行）：node scripts/final-acceptance.mjs
 * 模拟 AI 客户端全链路：建项目 → 加文档 → 搜索 → 改文档 → 查版本
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

const docContentV1 = `# 需求文档\n\n## 登录模块\n\n本系统支持手机号登录，验证码 5 分钟有效，同一手机号 60 秒内仅可发送一次。`;

// ---- 1. 新建测试项目 ----
console.log('═══ Step 1: create_project ═══');
const projects = await callTool('list_projects');
let pid = projects.data?.find((p) => p.name === '测试项目')?.id;
if (pid) {
  console.log(`项目「测试项目」已存在，复用 (${pid})`);
} else {
  const created = await callTool('create_project', { name: '测试项目', description: 'P1 终验用' });
  pid = created.data.id;
  console.log(`创建成功: ${pid}`);
}

// ---- 2. 记录需求文档 ----
console.log('\n═══ Step 2: add_document ═══');
const added = await callTool('add_document', {
  project_id: pid,
  title: '需求文档',
  content: docContentV1,
  change_note: '初始需求：手机号登录',
});
if (added.isError) throw new Error(added.data);
console.log(`文档创建成功: ${added.data.document_id}（v${added.data.version_no}，${added.data.chunk_count} 个分块）`);
const docId = added.data.document_id;

// ---- 3. 搜索验证码相关内容 ----
console.log('\n═══ Step 3: search_documents「验证码」 ═══');
const search1 = await callTool('search_documents', { project_id: pid, query: '验证码' });
for (const h of search1.data.hits) {
  console.log(`- [${h.source}] ${h.document_title} > ${h.heading_path || '(无章节)'} : ${h.content.slice(0, 50)}…`);
}

// ---- 4. 需求变更：有效期 5 分钟 → 10 分钟 ----
console.log('\n═══ Step 4: update_document ═══');
const updated = await callTool('update_document', {
  document_id: docId,
  content: docContentV1.replace('验证码 5 分钟有效', '验证码 10 分钟有效'),
  change_note: '需求变更：验证码有效期由 5 分钟延长至 10 分钟',
});
console.log(`更新成功: v${updated.data.version_no}（${updated.data.chunk_count} 个分块重新索引）`);

// ---- 5. 查看历史版本 ----
console.log('\n═══ Step 5: get_document 版本回溯 ═══');
const v1 = await callTool('get_document', { document_id: docId, version: 1 });
const v2 = await callTool('get_document', { document_id: docId, version: 2 });
console.log(`v1 (change_note: ${v1.data.change_note})`);
console.log(`  内容: ${v1.data.content.replace(/\n+/g, ' ').slice(0, 60)}…`);
console.log(`v2 (change_note: ${v2.data.change_note})`);
console.log(`  内容: ${v2.data.content.replace(/\n+/g, ' ').slice(0, 60)}…`);

// ---- 自动断言 ----
console.log('\n═══ 终验断言 ═══');
const checks = [
  ['建项目成功', !!pid],
  ['加文档成功且分块', added.data.chunk_count >= 1],
  ['搜索命中「验证码」', search1.data.hits?.length >= 1],
  ['变更为 v2', updated.data.version_no === 2],
  ['v1 保留旧内容（5 分钟）', v1.data.content.includes('5 分钟')],
  ['v2 是新内容（10 分钟）', v2.data.content.includes('10 分钟')],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
console.log(`\n终验结果: ${pass}/${checks.length}`);
process.exit(pass === checks.length ? 0 : 1);
