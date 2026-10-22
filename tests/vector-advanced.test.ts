import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, seedProject } from './helpers.js';
import { setEmbedderForTests, type Embedder } from '../src/llm/embedding/index.js';
import { embedPendingChunks, pendingCount } from '../src/services/embedding.js';
import { addDocument, deleteDocument, updateDocument, getDocument } from '../src/services/document.js';
import { searchDocuments } from '../src/services/search.js';

/**
 * P2 深度测试：RRF 融合正确性、规模性能、版本/删除过滤、topK 边界。
 * 基础管线（补算/复用/降级/指纹重建）见 vector.test.ts。
 */

// 与 vector.test.ts 相同的确定性假 embedder（字符频率 → 8 维归一化向量）
function createFakeEmbedder(fingerprint = 'test:fake'): Embedder {
  const embed = (text: string): number[] => {
    const v = new Array(8).fill(0);
    for (const ch of text) v[ch.charCodeAt(0) % 8] += 1;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  };
  return {
    fingerprint,
    dim: 8,
    embedPassages: async (texts: string[]) => texts.map(embed),
    embedQuery: async (text: string) => embed(text),
  };
}

describe('vector pipeline — advanced', () => {
  afterAll(() => {
    setEmbedderForTests(null);
  });

  it('RRF 融合：FTS+向量双路命中的 chunk 排名高于仅单路命中', async () => {
    const db = createTestDb();
    setEmbedderForTests(createFakeEmbedder());
    const { projectId } = seedProject(db);
    await embedPendingChunks(db);

    // 「退款流程」既是 chunk 内的连续子串（FTS trigram 可命中），
    // 又会被 queryEmbed 向量化（向量路命中）→ 双路 RRF 叠加
    const result = await searchDocuments(db, { projectId, query: '退款流程' });
    expect(result.meta.vector).toBe(true);
    expect(result.hits.length).toBeGreaterThanOrEqual(2);

    const top = result.hits[0];
    expect(top.content).toContain('退款流程');
    expect(top.source).toBe('vector'); // 双路命中 source 取 vector
    // 单路最高分 = 1/(60+1+1) ≈ 0.0161；双路叠加必然更高
    expect(top.score).toBeGreaterThan(0.032);
    if (result.hits.length > 1) {
      expect(top.score).toBeGreaterThan(result.hits[1].score);
    }
  });

  it('版本过滤：update_document 后检索只命中最新版本的 chunk', async () => {
    const db = createTestDb();
    setEmbedderForTests(createFakeEmbedder());
    const { projectId, docIds } = seedProject(db);
    await embedPendingChunks(db);

    const doc = getDocument(db, { documentId: docIds[0] });
    const updated = doc.content.replace('支付成功后通过短信通知用户。', '支付成功后改为站内信通知用户。');
    updateDocument(db, { documentId: docIds[0], content: updated, changeNote: '通知渠道替换' });
    await embedPendingChunks(db);

    // 搜索旧版本独有词「短信」：应只命中最新版本（v2）的 chunk，不能泄漏 v1 内容
    const result = await searchDocuments(db, { projectId, query: '短信' });
    for (const hit of result.hits) {
      if (hit.document_id === docIds[0]) {
        expect(hit.version_no).toBe(2);
      }
    }
    // 且新内容「站内信」可被搜到
    const r2 = await searchDocuments(db, { projectId, query: '站内信' });
    expect(r2.hits.some((h) => h.document_id === docIds[0] && h.content.includes('站内信'))).toBe(true);
  });

  it('软删除过滤：delete_document 后其向量不再参与检索', async () => {
    const db = createTestDb();
    setEmbedderForTests(createFakeEmbedder());
    const { projectId, docIds } = seedProject(db);
    await embedPendingChunks(db);

    // 「接口设计」含「验签」独有词；删除后不应再被搜到
    deleteDocument(db, docIds[1]);
    const result = await searchDocuments(db, { projectId, query: '验签' });
    expect(result.hits.every((h) => h.document_id !== docIds[1])).toBe(true);
    expect(result.hits.some((h) => h.document_id === docIds[1])).toBe(false);
  });

  it('规模性能：500+ chunk 向量化与 KNN 查询在阈值内完成', async () => {
    const db = createTestDb();
    setEmbedderForTests(createFakeEmbedder());
    const project = await import('../src/services/project.js').then((m) => m.createProject(db, '规模测试', 'perf'));

    // 250 篇 × 2 chunk = 500 chunk，每块带唯一词保证可区分
    const docs: string[] = [];
    for (let i = 0; i < 250; i++) {
      docs.push(`# 规模文档${i}\n\n## 阿尔法章节\n\n这是第${i}篇文档的阿尔法内容，唯一词 alpha${i}。\n\n## 贝塔章节\n\n这是第${i}篇文档的贝塔内容，唯一词 beta${i}。`);
    }
    const t0 = performance.now();
    for (let i = 0; i < docs.length; i++) {
      addDocument(db, { projectId: project.id, title: `规模文档${i}`, content: docs[i], createdBy: 'perf' });
    }
    const tAdd = performance.now();

    const r = await embedPendingChunks(db, { limit: 1_000_000 });
    const tEmbed = performance.now();
    expect(r.embedded).toBeGreaterThanOrEqual(500); // 每篇至少 2 块（实际 3 块：h1 后空段 + 两个 h2）
    expect(r.failed).toBe(0);
    expect(pendingCount(db)).toBe(0);

    // KNN + FTS + RRF 全链路查询延迟
    const t1 = performance.now();
    const result = await searchDocuments(db, { projectId: project.id, query: '阿尔法内容' });
    const tQuery = performance.now();

    expect(result.total).toBeGreaterThan(0);
    expect(result.meta.vector).toBe(true);
    console.log(`[perf] 250 篇入库 ${(tAdd - t0).toFixed(0)}ms | 500 块向量化 ${(tEmbed - tAdd).toFixed(0)}ms | 检索 ${(tQuery - t1).toFixed(0)}ms`);
    expect(tQuery - t1).toBeLessThan(500); // 内存库 + 8 维向量，宽阈值防 CI 抖动
  });

  it('topK 边界：topK=50 时向量 KNN（limit 30）不阻断融合', async () => {
    const db = createTestDb();
    setEmbedderForTests(createFakeEmbedder());
    const { projectId } = seedProject(db);
    await embedPendingChunks(db);

    const result = await searchDocuments(db, { projectId, query: '支付', topK: 50 });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.hits.length).toBeLessThanOrEqual(50);
  });
});
