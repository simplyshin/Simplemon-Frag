import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, seedProject } from './helpers.js';
import { countVectors } from '../src/db/vector.js';
import { setEmbedderForTests, type Embedder } from '../src/llm/embedding/index.js';
import { embedPendingChunks, pendingCount } from '../src/services/embedding.js';
import { addDocument, updateDocument } from '../src/services/document.js';
import { searchDocuments } from '../src/services/search.js';

/**
 * 确定性假 embedder：字符频率 → 8 维向量（归一化）。
 * 内容重叠越多余弦越近，足以验证向量召回与增量复用逻辑。
 */
function createFakeEmbedder(fingerprint = 'test:fake'): Embedder & { calls: number } {
  const state = { calls: 0 };
  const embed = (text: string): number[] => {
    const v = new Array(8).fill(0);
    for (const ch of text) v[ch.charCodeAt(0) % 8] += 1;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  };
  return {
    fingerprint,
    dim: 8,
    get calls() { return state.calls; },
    async embedPassages(texts: string[]) {
      state.calls += texts.length;
      return texts.map(embed);
    },
    async embedQuery(text: string) {
      state.calls += 1;
      return embed(text);
    },
  } as Embedder & { calls: number };
}

describe('vector pipeline', () => {
  afterAll(() => {
    // 恢复 setup.ts 的默认降级注入，避免影响其他测试文件
    setEmbedderForTests(null);
  });

  it('入库后待补算 → 向量化完成 → 向量召回命中', async () => {
    const db = createTestDb();
    const fake = createFakeEmbedder();
    setEmbedderForTests(fake);
    const { projectId, docIds } = seedProject(db);

    // 库入成功但尚未向量化
    expect(pendingCount(db)).toBeGreaterThan(0);
    expect(countVectors(db)).toBe(0);

    const r = await embedPendingChunks(db);
    expect(r.embedded).toBeGreaterThan(0);
    expect(pendingCount(db)).toBe(0);
    expect(countVectors(db)).toBe(r.embedded);

    // 搜索：向量路参与 RRF，命中来源含 vector
    const result = await searchDocuments(db, { projectId, query: '退款流程' });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.meta.vector).toBe(true);
    expect(result.hits.some((h) => h.source === 'vector')).toBe(true);
    expect(docIds.length).toBe(2);
  });

  it('增量向量化：更新文档时未变化章节的向量被复用，只补算变化块', async () => {
    const db = createTestDb();
    const fake = createFakeEmbedder();
    setEmbedderForTests(fake);
    const { projectId, docIds } = seedProject(db);
    await embedPendingChunks(db);
    const callsAfterSeed = fake.calls;

    // 仅修改通知模块章节，其余章节内容保持逐字节一致
    const doc = await import('../src/services/document.js').then((m) =>
      m.getDocument(db, { documentId: docIds[0] }),
    );
    const updated = doc.content.replace('支付成功后通过短信通知用户。', '支付成功后通过邮件与短信双通道通知用户。');
    expect(updated).not.toBe(doc.content);

    const ur = updateDocument(db, { documentId: docIds[0], content: updated, changeNote: '通知渠道扩展' });
    expect(ur.vectors_reused).toBeGreaterThan(0); // 未变章节向量被搬运

    const before = fake.calls;
    await embedPendingChunks(db, { documentId: docIds[0] });
    expect(fake.calls).toBeLessThan(before - callsAfterSeed + 10); // 只补算了少量变化块
    expect(pendingCount(db)).toBe(0);

    // 项目内检索仍正常（RRF 融合复用与新算的向量）
    const result = await searchDocuments(db, { projectId, query: '双通道通知' });
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it('embedding 失败降级：入库不受阻，FTS 检索照常', async () => {
    const db = createTestDb();
    setEmbedderForTests({
      fingerprint: 'test:broken',
      dim: 4,
      embedPassages: async () => { throw new Error('broken'); },
      embedQuery: async () => { throw new Error('broken'); },
    });
    const { projectId } = seedProject(db);
    const result = await searchDocuments(db, { projectId, query: '退款流程' });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.meta.vector).toBe(false); // 向量路缺席
    expect(result.hits.every((h) => h.source !== 'vector')).toBe(true);
  });

  it('模型指纹变化触发向量表重建，全部 chunk 重新待补算', async () => {
    const db = createTestDb();
    const fakeA = createFakeEmbedder('test:model-a');
    setEmbedderForTests(fakeA);
    const { projectId } = seedProject(db);
    await embedPendingChunks(db);
    expect(countVectors(db)).toBeGreaterThan(0);

    setEmbedderForTests(createFakeEmbedder('test:model-b'));
    const r = await embedPendingChunks(db);
    expect(r.embedded).toBeGreaterThan(0); // 指纹变化 → 重建后全部重算
    expect(countVectors(db)).toBe(r.embedded);
    expect(pendingCount(db)).toBe(0);
  });

  it('add_document 直接入库不阻塞（无向量时靠 FTS 检索）', async () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    const r = addDocument(db, { projectId, title: '纯文本', content: '# 纯文本\n\n没有向量也能被关键词搜到。' });
    expect(r.chunk_count).toBeGreaterThan(0);
    const result = await searchDocuments(db, { projectId, query: '没有向量' });
    expect(result.total).toBeGreaterThanOrEqual(1);
  });
});
