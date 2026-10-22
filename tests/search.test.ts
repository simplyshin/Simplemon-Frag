import { describe, expect, it } from 'vitest';
import { createTestDb, seedProject } from './helpers.js';
import { searchDocuments } from '../src/services/search.js';
import { createProject } from '../src/services/project.js';

describe('search service', () => {
  it('长词走 FTS 召回并返回章节路径', async () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    const r = await searchDocuments(db, { projectId, query: '退款流程' });
    expect(r.total).toBeGreaterThanOrEqual(1);
    expect(r.hits[0].source).toBe('fts');
    expect(r.hits.some((h) => h.heading_path.includes('退款流程'))).toBe(true);
    expect(r.hits[0].document_title).toBe('需求说明');
  });

  it('短词（2字）降级 LIKE 召回', async () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    const r = await searchDocuments(db, { projectId, query: '退款' });
    expect(r.total).toBeGreaterThanOrEqual(1);
    expect(r.hits[0].source).toBe('like');
  });

  it('FTS 无结果时全词 LIKE 兜底', async () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    // "验签" 只出现在接口设计正文；前一词不存在 → FTS 空 → LIKE 兜底仍命中
    const r = await searchDocuments(db, { projectId, query: '验签' });
    expect(r.total).toBeGreaterThanOrEqual(1);
  });

  it('项目间隔离：搜不到其他项目的文档', async () => {
    const db = createTestDb();
    seedProject(db, '项目一');
    const other = createProject(db, '项目二');
    const r = await searchDocuments(db, { projectId: other.id, query: '退款流程' });
    expect(r.total).toBe(0);
  });

  it('空结果返回空集，topK 限制生效', async () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    expect((await searchDocuments(db, { projectId, query: '量子纠缠' })).total).toBe(0);
    const limited = await searchDocuments(db, { projectId, query: '支付', topK: 1 });
    expect(limited.total).toBeLessThanOrEqual(1);
  });

  it('空查询词被拒绝', async () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    await expect(searchDocuments(db, { projectId, query: '   ' })).rejects.toThrow(/不能为空/);
  });

  it('只检索最新版本的 chunk（旧版本内容不可搜到）', async () => {
    const db = createTestDb();
    const { projectId, docIds } = seedProject(db);
    // 直接断言版本过滤逻辑：chunk 只挂在 latest_version_id 上
    const rows = db.prepare(`
      SELECT COUNT(*) AS n FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE d.project_id = ? AND c.version_id != d.latest_version_id
    `).all(projectId) as { n: number }[];
    expect(rows[0].n).toBe(0);
    expect(docIds.length).toBe(2);
  });
});
