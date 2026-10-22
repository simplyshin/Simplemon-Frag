/**
 * Tools 1-7 端到端验证（可重复执行）：node scripts/smoke-tools.mjs
 * 前提：服务已启动，AUTH_TOKEN 环境变量与服务一致。
 * 通过 MCP 协议走完整 HTTP 链路验证 CRUD + 版本机制 + 分块索引。
 */
const BASE = process.env.MCP_URL ?? 'http://localhost:3210/mcp';
const TOKEN = process.env.AUTH_TOKEN ?? 'dev-token-123575885';

const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  Authorization: `Bearer ${TOKEN}`,
};

let idCounter = 0;
async function callTool(name, args = {}) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++idCounter, method: 'tools/call', params: { name, arguments: args } }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`tools/call ${name} 协议错误: ${json.error.message}`);
  const raw = json.result.content[0].text;
  const isError = !!json.result.isError;
  // 业务错误返回纯文本；成功返回 JSON
  let data = raw;
  if (!isError) {
    try { data = JSON.parse(raw); } catch { /* 保留原文 */ }
  }
  return { isError, data };
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// 1. list_projects
const projects = await callTool('list_projects');
check('Tool1 list_projects 可用', !projects.isError && Array.isArray(projects.data),
  `共 ${projects.data?.length ?? '?'} 个项目`);

// 2. create_project（重名应报错）
const created = await callTool('create_project', { name: `冒烟项目-${Date.now()}`, description: 'smoke-tools 临时项目' });
const projectId = created.data.id;
check('Tool2 create_project 成功', !created.isError && !!projectId, projectId);
const dup = await callTool('create_project', { name: created.data.name });
check('Tool2 重名项目被拒绝', dup.isError, dup.data);

// 3. add_document（含标题层级，验证分块）
const md = `# 需求说明\n\n## 支付模块\n\n接入微信支付与支付宝。\n\n## 退款模块\n\n7 天内可申请退款，人工审核。\n\n## 通知模块\n\n支付成功短信通知。`;
const added = await callTool('add_document', { project_id: projectId, title: '需求说明', content: md });
check('Tool4 add_document 成功且按标题分块', !added.isError && added.data.chunk_count >= 3,
  `chunks=${added.data.chunk_count}`);
const docId = added.data.document_id;

// 4. list_documents
const docs = await callTool('list_documents', { project_id: projectId });
check('Tool3 list_documents 返回 1 篇文档 v1', !docs.isError && docs.data.length === 1 && docs.data[0].version_no === 1);

// 5. get_document（project_id + title 定位）
const got = await callTool('get_document', { project_id: projectId, title: '需求说明' });
check('Tool5 get_document 按 title 定位成功', !got.isError && got.data.content.includes('退款模块'),
  `v${got.data.version_no}, 章节路径: ${got.data.heading_paths.length}`);

// 6. update_document → v2，并验证 FTS 同步（内容被替换）
const mdV2 = `# 需求说明\n\n## 支付模块\n\n接入微信支付与支付宝，支持聚合扫码。\n\n## 发票模块\n\n支持开具电子发票，3 个工作日内送达。`;
const updated = await callTool('update_document', { document_id: docId, content: mdV2, change_note: '移除退款模块，新增发票模块' });
check('Tool6 update_document 追加版本 v2', !updated.isError && updated.data.version_no === 2,
  `chunks=${updated.data.chunk_count}`);

// 7. 版本回溯：v1 仍可读
const v1 = await callTool('get_document', { document_id: docId, version: 1 });
check('Tool5 版本回溯 v1 内容保留', !v1.isError && v1.data.content.includes('退款模块'));

// 8. 最新版本是新内容
const latest = await callTool('get_document', { document_id: docId });
check('Tool5 默认返回最新 v2', !latest.isError && latest.data.version_no === 2 && latest.data.content.includes('发票模块'));

// 9. FTS 直接验证索引同步（新词可检索、旧词消失）——限定本文档范围
const { getDb } = await import('../dist/db/index.js');
const db = getDb();
const ftsCount = (query) => db.prepare(
  "SELECT COUNT(*) AS n FROM chunks_fts f JOIN chunks c ON c.id=f.rowid WHERE c.document_id = ? AND chunks_fts MATCH ?",
).get(docId, query).n;
check('FTS 索引同步：v2 新词可检索', ftsCount('"电子发票"') >= 1);
check('FTS 索引同步：v1 旧词已清理', ftsCount('"人工审核"') === 0);

// 10. delete_document 软删除
const del = await callTool('delete_document', { document_id: docId });
const afterDel = await callTool('list_documents', { project_id: projectId });
check('Tool7 delete_document 软删除生效', !del.isError && afterDel.data.length === 0);

// 11. 参数校验：不存在的文档
const missing = await callTool('get_document', { document_id: 'not-exist' });
check('get_document 不存在文档返回 isError', missing.isError);

console.log(`\n${results.filter(Boolean).length}/${results.length} 通过`);
process.exit(results.every(Boolean) ? 0 : 1);
