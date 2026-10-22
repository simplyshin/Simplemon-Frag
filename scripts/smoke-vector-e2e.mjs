/**
 * P2 真实模型端到端验收（可重复执行）：node scripts/smoke-vector-e2e.mjs
 *
 * 与 smoke-rag.mjs 的区别：不走 HTTP/服务，直接驱动 service 层 + 真实 fastembed
 * 本地模型（BAAI/bge-small-zh-v1.5），验证「模型推理 → 向量入库 → KNN 召回 →
 * hash 复用 → 更新后重检」的完整真实链路。vitest 用 fake embedder 验逻辑，本脚本验真模型。
 * 前提：模型已预下载到 data/models（node scripts/download-model.mjs）。
 */
import { openDb } from '../dist/db/index.js';
import { countVectors } from '../dist/db/vector.js';
import { addDocument, updateDocument, getDocument } from '../dist/services/document.js';
import { embedPendingChunks, pendingCount } from '../dist/services/embedding.js';
import { searchDocuments } from '../dist/services/search.js';
import { createProject } from '../dist/services/project.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const ms = (t0) => `${(performance.now() - t0).toFixed(0)}ms`;

const db = openDb(':memory:');

// 1. 真实模型首查（含模型加载耗时）
console.log('— 初始化真实 embedding 模型（首次调用含加载耗时）—');
let t0 = performance.now();
const project = createProject(db, 'e2e 项目', '真实模型端到端');
const DOC = `# 语义测试文档

## 支付模块

系统接入微信支付与支付宝。

### 退款流程

用户可在订单完成后 7 天内发起退款申请，客服审核通过后原路退回。

## 发票模块

支持电子发票开具与抬头管理。
`;
const add = addDocument(db, { projectId: project.id, title: '语义测试文档', content: DOC, createdBy: 'e2e' });
console.log(`  add_document: ${add.chunk_count} 块 (${ms(t0)})`);

t0 = performance.now();
const emb = await embedPendingChunks(db);
const tEmbed = performance.now() - t0;
check('真实模型向量化成功（无失败块）', emb.embedded > 0 && emb.failed === 0,
  `${emb.embedded} 块 / 耗时 ${tEmbed.toFixed(0)}ms / 向量表 ${countVectors(db)} 条`);
check('待补算清零', pendingCount(db) === 0);

// 2. 语义检索（FTS/LIKE 搜不到的口语化说法）
t0 = performance.now();
const s1 = await searchDocuments(db, { projectId: project.id, query: '钱怎么退回来' });
const tQuery = performance.now() - t0;
const hit = s1.hits[0];
check('语义查询命中（meta.vector=true）', s1.meta.vector === true && s1.total > 0, `检索 ${ms(t0).trim()}`);
check('命中来源为向量', hit?.source === 'vector', hit ? `${hit.document_title} > ${hit.heading_path} [${hit.source}] score=${hit.score}` : '');
check('语义正确（命中退款内容）', !!hit?.content.includes('退款'), hit?.content.slice(0, 40));
check('带章节路径', !!hit?.heading_path, hit?.heading_path ?? '');

// 3. 增量更新：改「发票」章节，「退款」章节逐字节不变 → hash 复用
const doc = getDocument(db, { documentId: add.document_id });
const updated = doc.content.replace('支持电子发票开具与抬头管理。', '支持电子发票开具、抬头管理与月度归档。');
t0 = performance.now();
const ur = updateDocument(db, { documentId: add.document_id, content: updated, changeNote: '发票功能扩展' });
check('未变章节向量被复用', ur.vectors_reused > 0, `reused=${ur.vectors_reused} (${ms(t0)})`);

t0 = performance.now();
const emb2 = await embedPendingChunks(db, { documentId: add.document_id });
check('只补算变化块', emb2.embedded <= 2 && emb2.failed === 0, `${emb2.embedded} 块 / ${pendingCount(db)} 待补算`);

// 4. 更新后语义检索仍正常（复用向量 + 新向量混合检索）
t0 = performance.now();
const s2 = await searchDocuments(db, { projectId: project.id, query: '发票能不能归档' });
check('更新后语义检索正常', s2.meta.vector === true && s2.hits.some((h) => h.content.includes('归档')),
  s2.hits[0] ? `${s2.hits[0].heading_path} [${s2.hits[0].source}]` : '');

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
