/**
 * P3 验收（可重复执行）：node scripts/smoke-web.mjs
 * 方案验收标准：后台上传的文档 AI 能搜到，AI 改的文档后台能看到。
 * 通过 REST API 模拟后台行为，通过 MCP 端点模拟 AI 客户端行为。
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
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};
const mcp = async (name, args) => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await res.json();
  return JSON.parse(j.result.content[0].text);
};

// 1. Web 静态页可访问（免鉴权）
const page = await fetch(BASE + '/');
const html = await page.text();
check('Web 后台页面可访问（/ 返回 HTML）', page.status === 200 && html.includes('<div id="app">'), `${page.status}`);
const spa = await fetch(BASE + '/doc/some-id'); // SPA fallback
check('SPA 路由 fallback 生效', spa.status === 200 && (await spa.text()).includes('<div id="app">'));

// 2. 后台上传 → AI 搜到
const proj = (await rest('POST', '/api/projects', { name: `P3验收-${Date.now()}`, description: 'P3 端到端' })).data;
const form = new FormData();
form.append('file', new Blob(['# 会员权益说明\n\n## 积分规则\n\n每消费 1 元累计 1 积分，积分可兑换优惠券，1000 积分起兑。'], { type: 'text/markdown' }), 'member-benefits.md');
const up = await fetch(`${BASE}/api/projects/${proj.id}/documents`, { method: 'POST', body: form });
const upData = await up.json();
check('后台上传成功', up.status === 200 && upData.chunk_count > 0, `${upData.chunk_count} 块; ${upData.embedding}`);
await new Promise((r) => setTimeout(r, 800));

const aiSearch = await mcp('search_documents', { project_id: proj.id, query: '消费积分怎么兑换' });
check('后台上传的文档 AI 语义能搜到', aiSearch.total > 0 && aiSearch.hits[0].source === 'vector'
  && aiSearch.hits[0].content.includes('积分'),
  `${aiSearch.total} 条 [${aiSearch.hits[0]?.source}]`);

// 3. AI 改文档 → 后台能看到
const aiDocs = await mcp('list_documents', { project_id: proj.id });
const docId = aiDocs[0].id;
await mcp('update_document', {
  document_id: docId,
  content: '# 会员权益说明\n\n## 积分规则\n\n每消费 1 元累计 2 积分（2026-11 起生效），积分可兑换优惠券，1000 积分起兑。',
  change_note: 'AI 更新：积分倍率调整',
});
const webDoc = (await rest('GET', `/api/documents/${docId}`)).data;
check('AI 改的文档后台能看到（版本+内容）', webDoc.version_no === 2 && webDoc.content.includes('2 积分'),
  `v${webDoc.version_no}`);
const webVers = (await rest('GET', `/api/documents/${docId}/versions`)).data;
check('版本历史完整（后台可对比）', webVers.length === 2 && webVers[0].change_note.includes('AI 更新'),
  webVers.map((v) => `v${v.version_no}`).join(','));

// 清理本次及历史失败的验收数据
const left0 = (await rest('GET', '/api/projects')).data;
for (const p of left0.filter((p) => p.name.startsWith('P3验收-'))) {
  await rest('DELETE', `/api/projects/${p.id}`);
}
const left = (await rest('GET', '/api/projects')).data;
check('验收数据已清理', !left.some((p) => p.name.startsWith('P3验收')), '');

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
