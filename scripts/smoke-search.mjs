/**
 * Tool 8/9 端到端验证（可重复执行）：node scripts/smoke-search.mjs
 * 前提：服务已启动且已运行 seed-mock.mjs；AUTH_TOKEN 环境变量与服务一致。
 * 验证：FTS 长词召回、短词 LIKE 降级、多词 AND、空结果、索引生成与版本递增。
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
  if (json.error) throw new Error(`tools/call ${name} 协议错误: ${json.error.message}`);
  const raw = json.result.content[0].text;
  const isError = !!json.result.isError;
  let data = raw;
  if (!isError) { try { data = JSON.parse(raw); } catch { /* 保留原文 */ } }
  return { isError, data };
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const projects = await callTool('list_projects');
const demo = projects.data.find((p) => p.name === '演示项目');
if (!demo) { console.log('FAIL  演示项目不存在，请先运行 seed-mock.mjs'); process.exit(1); }
const pid = demo.id;

// ---- Tool 8: search_documents ----

// 1. 长词 FTS 召回（4 字，trigram）
const s1 = await callTool('search_documents', { project_id: pid, query: '退款流程' });
check('search 长词「退款流程」命中', !s1.isError && s1.data.total >= 1,
  s1.data.hits?.map((h) => `${h.document_title}>${h.heading_path || '(无章节)'} [${h.source}]`).join(' ; '));
check('search 返回章节路径', s1.data.hits?.some((h) => h.heading_path.includes('退款流程')));

// 2. 短词 LIKE 降级（2 字）
const s2 = await callTool('search_documents', { project_id: pid, query: '退款' });
check('search 短词「退款」LIKE 降级命中', !s2.isError && s2.data.total >= 1,
  `source=${s2.data.hits?.[0]?.source}`);

// 3. 多词 AND（需求说明同时含微信支付+通知，索引文档摘要也可能命中）
const s3 = await callTool('search_documents', { project_id: pid, query: '微信支付 通知' });
check('search 多词命中包含需求说明', !s3.isError && s3.data.hits?.some((h) => h.document_title === '需求说明'),
  s3.data.hits?.map((h) => `${h.document_title}[${h.source}]`).join(','));

// 4. 空结果不报错
const s4 = await callTool('search_documents', { project_id: pid, query: '量子纠缠' });
check('search 无结果返回空集不报错', !s4.isError && s4.data.total === 0);

// 5. top_k 生效
const s5 = await callTool('search_documents', { project_id: pid, query: '支付', top_k: 2 });
check('search top_k 限制生效', !s5.isError && s5.data.total <= 2, `total=${s5.data.total}`);

// ---- Tool 9: rebuild_index ----

// 6. 生成/重建（幂等断言：首次 created，重跑 updated）
const i1 = await callTool('rebuild_index', { project_id: pid });
check('rebuild_index 生成成功', !i1.isError && ['created', 'updated'].includes(i1.data.action) && i1.data.doc_count === 3,
  `action=${i1.data.action}, docs=${i1.data.doc_count}, v${i1.data.version_no}`);

// 7. 索引文档存在且内容含摘要
const idx = await callTool('get_document', { project_id: pid, title: '《项目文档索引》' });
check('索引文档包含各文档摘要', !idx.isError && idx.data.content.includes('摘要：') && idx.data.content.includes('退款'),
  `v${idx.data.version_no}`);
check('索引文档不出现在自己的索引里', !idx.data.content.includes('《项目文档索引》'));

// 8. 再次重建 → 版本递增
const i2 = await callTool('rebuild_index', { project_id: pid });
check('rebuild_index 二次重建版本递增', !i2.isError && i2.data.action === 'updated' && i2.data.version_no === i1.data.version_no + 1,
  `v${i1.data.version_no} → v${i2.data.version_no}`);

// 9. 索引可被检索到（自动分块进了 FTS）
const s6 = await callTool('search_documents', { project_id: pid, query: '项目文档索引' });
check('search 可命中索引文档', !s6.isError && s6.data.hits?.some((h) => h.document_title === '《项目文档索引》'));

console.log(`\n${results.filter(Boolean).length}/${results.length} 通过`);
process.exit(results.every(Boolean) ? 0 : 1);
