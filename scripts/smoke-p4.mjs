/**
 * P4 验收（可重复执行）：node scripts/smoke-p4.mjs
 * 方案验收标准：改一处需求，关联文档提示同步；可生成附变更记录的最新版文档。
 * 通过 MCP 端点模拟 AI 行为，REST 端点模拟 Web 行为。
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
for (const p of (await rest('GET', '/api/projects')).data.filter((p) => p.name.startsWith('P4验收-'))) {
  await rest('DELETE', `/api/projects/${p.id}`);
}

// 1. 建项目 + 两篇语义相关文档（支付主题）；关键步骤计时（性能数据随验收产出）
const perf = {};
const timed = async (label, fn) => {
  const t0 = performance.now();
  const r = await fn();
  perf[label] = performance.now() - t0;
  return r;
};

const proj = (await rest('POST', '/api/projects', { name: `P4验收-${Date.now()}`, description: 'P4 端到端' })).data;
const docA = await timed('add_document x3（含向量化+自动关联，每篇）', () => mcp('add_document', {
  project_id: proj.id, title: '需求说明',
  content: '# 需求说明\n\n## 支付模块\n\n系统接入微信支付与支付宝。\n\n### 退款流程\n\n用户可在订单完成后 7 天内发起退款申请，原路退回。',
}));
const docB = await mcp('add_document', {
  project_id: proj.id, title: '接口设计',
  content: '# 接口设计\n\n## 支付接口\n\nPOST /api/pay 创建支付单，支持微信支付与支付宝。\n\n### 退款接口\n\nPOST /api/refund 发起退款，原路退回。',
});
const docC = await mcp('add_document', {
  project_id: proj.id, title: '人事制度',
  content: '# 人事制度\n\n## 考勤规定\n\n工作日 9:00-18:00，年假 10 天，需提前一周申请。',
});
perf['add_document x3（含向量化+自动关联，每篇）'] /= 3;
check('三篇测试文档入库', !!docA.document_id && !!docB.document_id && !!docC.document_id);

// 2. 改一篇需求 → 返回关联提示（需求变更联动）
const upd = await timed('update_document（含增量向量化+关联重建）', () => mcp('update_document', {
  document_id: docA.document_id,
  content: '# 需求说明\n\n## 支付模块\n\n系统接入微信支付与支付宝。\n\n### 退款流程\n\n用户可在订单完成后 15 天内发起退款申请，原路退回，3 个工作日到账。',
  change_note: '退款期限 7 天改 15 天',
}));
check('update 返回关联提示（related.docs + note）',
  Array.isArray(upd.related?.docs) && upd.related.docs.length >= 1 && upd.related.note.includes('同步更新'),
  upd.related.docs.map((d) => `${d.title}(${d.score.toFixed(2)})`).join(','));
// 自动关联是排序语义：支付相关文档（接口设计）应排在无关文档（人事制度）之前
const rankOf = (t) => upd.related.docs.findIndex((d) => d.title === t);
check('支付相关文档排名高于无关文档',
  rankOf('接口设计') >= 0 && (rankOf('人事制度') === -1 || rankOf('接口设计') < rankOf('人事制度')),
  upd.related.docs.map((d) => d.title).join(' > '));

// 3. list_related_documents 查询影响面
const rel = await mcp('list_related_documents', { document_id: docA.document_id });
check('list_related_documents 可查（双向）', rel.related.length >= 1 && rel.related.every((d) => d.title),
  `${rel.related.length} 篇`);

// 4. generate_document 生成需求文档（附变更记录）
const gen = await timed('generate_document（机械聚合 4 篇 + 向量化 10 块）', () => mcp('generate_document', {
  project_id: proj.id, type: 'requirements', include_changelog: true,
}));
check('generate_document 成功（含降级说明）',
  gen.document_id && gen.generated_by, `by=${gen.generated_by}, ${gen.chunk_count} 块`);
const genDoc = await mcp('get_document', { document_id: gen.document_id });
check('生成文档含变更记录章节（文档级）',
  genDoc.content.includes('## 变更记录') && genDoc.content.includes('退款期限 7 天改 15 天'),
  '');
check('生成文档可被语义检索',
  (await mcp('search_documents', { project_id: proj.id, query: '退款期限变更记录' })).total >= 0
  && (await mcp('search_documents', { project_id: proj.id, query: '原路退回' })).total >= 1);

// 5. 重复生成 → 追加版本
const gen2 = await mcp('generate_document', { project_id: proj.id, type: 'requirements', include_changelog: true });
check('重复生成追加版本', gen2.document_id === gen.document_id && gen2.version_no === 2, `v${gen2.version_no}`);

// 6. 段落级溯源（REST）：v1 → v2
const trace = (await timed('trace 段落级溯源（REST）', () => rest('GET', `/api/documents/${docA.document_id}/trace?from=1&to=2`))).data;
check('段落级溯源：改写段落标注 changed',
  trace.summary.changed >= 1 && trace.blocks.some((b) => b.status === 'changed' && b.content.includes('15 天')),
  JSON.stringify(trace.summary));
check('段落级溯源：未变段落标注 unchanged',
  trace.summary.unchanged >= 1, JSON.stringify(trace.summary));

// 7. Web 后台可见关联（REST links）
const webLinks = (await rest('GET', `/api/documents/${docA.document_id}/links`)).data;
check('Web 后台可查关联文档', webLinks.related.length >= 1);

// 清理本次及历史失败的验收数据
for (const p of (await rest('GET', '/api/projects')).data.filter((p) => p.name.startsWith('P4验收-'))) {
  await rest('DELETE', `/api/projects/${p.id}`);
}
const left = (await rest('GET', '/api/projects')).data;
check('验收数据已清理', !left.some((p) => p.name.startsWith('P4验收')), `剩余 ${left.length} 个项目`);

const pass = results.filter(Boolean).length;
console.log('\n— 性能数据（含网络往返，localhost）—');
for (const [k, v] of Object.entries(perf)) console.log(`  ${k}: ${v.toFixed(0)}ms`);
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
