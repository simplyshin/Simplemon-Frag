/**
 * P5 验收（可重复执行）：node scripts/smoke-p5.mjs
 * 方案验收标准（修正后）：归档一段客户变更诉求 → 检索命中原文与时间 →
 * 生成沟通纪要可追溯（需求变更可追溯到原始沟通记录）。
 * 全链路走 MCP 端点（模拟 AI 客户端）。
 */
const BASE = 'http://localhost:3210';
const TOKEN = 'dev-token-123575885';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const rest = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const mcp = async (name, args) => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await res.json();
  if (j.result?.isError) throw new Error(j.result.content[0].text);
  return JSON.parse(j.result.content[0].text);
};

// 0. 清理历史验收数据
for (const p of (await rest('GET', '/api/projects')).data.filter((p) => p.name.startsWith('P5验收-'))) {
  await rest('DELETE', `/api/projects/${p.id}`);
}

// 1. 建项目 + 需求文档
const proj = (await rest('POST', '/api/projects', { name: `P5验收-${Date.now()}`, description: 'P5 端到端' })).data;
const reqDoc = await mcp('add_document', {
  project_id: proj.id, title: '需求说明',
  content: '# 需求说明\n\n## 报表模块\n\n报表支持导出 Excel 与 PDF 两种格式，导出上限 1 万行。',
});
check('需求文档入库', !!reqDoc.document_id);

// 2. 归档一段客户沟通记录（微信里提的变更诉求，含时间/参与方，手动关联需求文档）
const OCCURRED = '2026-10-18 14:30';
const comm = await mcp('add_communication', {
  project_id: proj.id,
  content: '客户张三在微信提出：报表导出行数上限 1 万行不够用，希望提升到 5 万行，月底上线前必须完成。我方答应评估后本周回复。',
  channel: 'wechat',
  parties: ['客户张三', '我方项目经理'],
  occurred_at: OCCURRED,
  related_document_ids: [reqDoc.document_id],
});
check('add_communication 归档成功（communication 类型 + metadata）',
  !!comm.document_id && comm.metadata?.channel === 'wechat'
  && comm.metadata?.occurred_at === OCCURRED
  && comm.metadata?.parties?.includes('客户张三'),
  comm.metadata ? `channel=${comm.metadata.channel}` : '');
check('手动关联需求文档（manual 依据链）', comm.linked_documents?.includes(reqDoc.document_id),
  (comm.linked_documents ?? []).join(','));

// 3. 需求文档侧能查到沟通记录（双向关联）
const rel = await mcp('list_related_documents', { document_id: reqDoc.document_id });
check('需求文档侧可查到沟通记录（依据链）',
  rel.related.some((d) => d.document_id === comm.document_id),
  rel.related.map((d) => d.title).join(','));

// 4. 语义检索命中原文与时间
await new Promise((r) => setTimeout(r, 500));
const hit = await mcp('search_documents', { project_id: proj.id, query: '报表导出行数上限要改多少' });
check('检索命中沟通记录原文（含诉求与时间）',
  hit.total >= 1 && hit.hits.some((h) => h.document_id === comm.document_id
    && h.content.includes('5 万行')),
  `${hit.total} 条 [${hit.hits[0]?.source}]`);
const commDoc = await mcp('get_document', { document_id: comm.document_id });
check('get_document 返回沟通元数据（可追溯时间/渠道/参与方）',
  commDoc.metadata?.channel === 'wechat' && commDoc.metadata?.occurred_at === OCCURRED);

// 5. 生成沟通纪要（时间线）
const summary = await mcp('generate_document', {
  project_id: proj.id, type: 'communication_summary', include_changelog: true,
});
check('generate_document(communication_summary) 成功',
  !!summary.document_id && summary.generated_by, `by=${summary.generated_by}`);
const sumDoc = await mcp('get_document', { document_id: summary.document_id });
check('沟通纪要含时间线条目（可追溯到 2026-10-18 微信沟通）',
  sumDoc.content.includes('沟通时间线') && sumDoc.content.includes('2026-10-18')
  && sumDoc.content.includes('微信') && sumDoc.content.includes('客户张三'),
  '');

// 6. 需求变更追溯闭环：AI 检索 + 依据链 + 纪要三样齐备
check('追溯闭环三要素齐备（原文/依据链/纪要）',
  hit.hits.some((h) => h.document_id === comm.document_id)
  && rel.related.some((d) => d.document_id === comm.document_id)
  && sumDoc.content.includes('5 万行'));

// 清理
for (const p of (await rest('GET', '/api/projects')).data.filter((p) => p.name.startsWith('P5验收-'))) {
  await rest('DELETE', `/api/projects/${p.id}`);
}
check('验收数据已清理', !(await rest('GET', '/api/projects')).data.some((p) => p.name.startsWith('P5验收')));

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
