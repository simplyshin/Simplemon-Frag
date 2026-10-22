// P3 REST API 冒烟（可重复执行）：node scripts/smoke-rest.mjs
const BASE = 'http://localhost:3210';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const api = async (method, path, body, headers = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? { ...headers } : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = await res.text();
  try { data = JSON.parse(data); } catch { /* 保留原文 */ }
  return { status: res.status, data };
};

// 1. 本机 /api 免 Bearer
const r0 = await api('GET', '/api/projects');
check('本机 /api 免 Bearer 可访问', r0.status === 200 && Array.isArray(r0.data), `${r0.status}，${r0.data.length} 个项目`);

// 2. /mcp 无 token 仍 401
const r1 = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
check('/mcp 无 Bearer 仍被拒绝', r1.status === 401, String(r1.status));

// 3. 建项目 → multipart 上传 → 检索 → 版本
const proj = (await api('POST', '/api/projects', { name: `REST冒烟-${Date.now()}`, description: 'P3 验收' })).data;
check('创建项目', !!proj?.id, proj?.id);

const form = new FormData();
form.append('file', new Blob([`# 上传测试文档\n\n## 退款政策\n\n商品签收后 15 天内可无理由退货退款。`], { type: 'text/markdown' }), 'upload-test.md');
form.append('title', '上传测试文档');
const up = await fetch(`${BASE}/api/projects/${proj.id}/documents`, { method: 'POST', body: form });
const upData = await up.json().catch(() => null);
check('multipart 上传入库', up.status === 200 && !!upData?.document_id, JSON.stringify(upData)?.slice(0, 120));

const docs = (await api('GET', `/api/projects/${proj.id}/documents`)).data;
check('文档列表可见（source=web）', docs?.length === 1 && docs[0].source_type === 'web', docs?.[0]?.source_type);

await new Promise((r) => setTimeout(r, 1000)); // 等内联向量化
const sr = (await api('POST', '/api/search', { projectId: proj.id, query: '钱怎么退回来' })).data;
check('REST 检索命中（向量路）', sr?.meta?.vector === true && sr?.total > 0 && sr.hits[0].source === 'vector',
  `${sr?.total} 条 [${sr?.hits?.[0]?.source}]`);

const docId = upData.document_id;
const put = (await api('PUT', `/api/documents/${docId}`, { content: '# 上传测试文档\n\n## 退款政策\n\n商品签收后 30 天内可无理由退货退款。', changeNote: '延长退货期' })).data;
check('PUT 更新追加版本 + 向量复用', put?.version_no === 2 && put?.vectors_reused > 0, `v${put?.version_no}, reused=${put?.vectors_reused}`);

const vers = (await api('GET', `/api/documents/${docId}/versions`)).data;
check('版本历史列表', Array.isArray(vers) && vers.length === 2 && vers[0].version_no === 2, `${vers?.length} 个版本`);

const v1 = (await api('GET', `/api/documents/${docId}?version=1`)).data;
check('回看 v1 内容', v1?.content?.includes('15 天'), '');

const st = (await api('GET', '/api/settings')).data;
check('settings 脱敏返回（有 hasKey/keyHint 无明文）',
  !!st?.embedding?.hasKey !== undefined && st.embedding.apiKeyEnv && !JSON.stringify(st).includes('dev-token'),
  `embedding.apiKeyEnv=${st?.embedding?.apiKeyEnv}`);

// 清理冒烟数据
await api('DELETE', `/api/documents/${docId}`);
const delProj = await api('DELETE', `/api/projects/${proj.id}`);
check('DELETE 项目级联清理', delProj.status === 200 && delProj.data.deleted_documents >= 1, JSON.stringify(delProj.data));

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
