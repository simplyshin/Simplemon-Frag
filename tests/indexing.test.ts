import { describe, expect, it, vi } from 'vitest';
import { createTestDb, seedProject } from './helpers.js';
import {
  flushPendingRebuilds,
  isIndexPossiblyStale,
  rebuildIndex,
  scheduleRebuild,
} from '../src/services/indexing.js';
import {
  addDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  listVersions,
  updateDocument,
} from '../src/services/document.js';

describe('indexing service', () => {
  it('首次生成 created，内容含全部文档摘要', () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    const r = rebuildIndex(db, projectId);
    expect(r.action).toBe('created');
    expect(r.doc_count).toBe(2);

    const idx = getDocument(db, { projectId, title: '《项目文档索引》' });
    expect(idx.source_type).toBe('index');
    expect(idx.content).toContain('摘要：');
    expect(idx.content).toContain('需求说明');
    expect(idx.content).toContain('接口设计');
    // 不把自己编进索引
    expect(idx.content).not.toContain('《项目文档索引》');
  });

  it('版本节流：内容无变化时 skipped 且不追加版本', () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    const v1 = rebuildIndex(db, projectId);
    expect(v1.action).toBe('created');

    const v2 = rebuildIndex(db, projectId);
    expect(v2.action).toBe('skipped');
    expect(v2.version_no).toBe(0);
    expect(v2.document_id).toBe(v1.document_id);
    // 版本数仍为 1（确定性：无时间戳入正文 → 内容 hash 不变）
    expect(listVersions(db, v1.document_id).length).toBe(1);
  });

  it('确定性：同文档集合两次生成的内容逐字节相同', () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    rebuildIndex(db, projectId);
    const before = getDocument(db, { projectId, title: '《项目文档索引》' }).content;
    rebuildIndex(db, projectId);
    const after = getDocument(db, { projectId, title: '《项目文档索引》' }).content;
    expect(after).toBe(before);
  });

  it('文档更新后重建，索引反映新内容且 action=updated', () => {
    const db = createTestDb();
    const { projectId, docIds } = seedProject(db);
    rebuildIndex(db, projectId);
    updateDocument(db, { documentId: docIds[0], content: '# 需求说明\n\n更新后的正文。', changeNote: '改' });
    const r = rebuildIndex(db, projectId);
    expect(r.action).toBe('updated');
    const idx = getDocument(db, { projectId, title: '《项目文档索引》' });
    expect(idx.content).toContain('更新后的正文');
    const docs = listDocuments(db, projectId);
    const reqDoc = docs.find((d) => d.title === '需求说明');
    expect(reqDoc?.version_no).toBe(2);
  });

  it('重建时间记入 change_note 而非正文', () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    rebuildIndex(db, projectId);
    const idx = getDocument(db, { projectId, title: '《项目文档索引》' });
    expect(idx.change_note).toContain('篇文档');
    expect(idx.content).not.toMatch(/生成于|自动生成/);
  });

  it('重建后写入指纹 metadata，删除/新增/损坏均被预检感知', () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    expect(isIndexPossiblyStale(db, projectId)).toBe(true); // 无索引文档

    rebuildIndex(db, projectId);
    expect(isIndexPossiblyStale(db, projectId)).toBe(false);

    // 新增文档：doc_count 变化
    const added = addDocument(db, { projectId, title: '新增文档', content: '# 新增\n\n正文。' });
    expect(isIndexPossiblyStale(db, projectId)).toBe(true);
    rebuildIndex(db, projectId);
    expect(isIndexPossiblyStale(db, projectId)).toBe(false);

    // 软删除：updated_at 不变，由 doc_count 感知
    deleteDocument(db, added.document_id);
    expect(isIndexPossiblyStale(db, projectId)).toBe(true);
    rebuildIndex(db, projectId);
    expect(isIndexPossiblyStale(db, projectId)).toBe(false);

    // metadata 损坏：保守视为滞后
    db.prepare("UPDATE documents SET metadata = '{oops' WHERE project_id = ? AND title = '《项目文档索引》'")
      .run(projectId);
    expect(isIndexPossiblyStale(db, projectId)).toBe(true);
  });

  it('去抖合并：静默期内多次触发只重建一次', async () => {
    vi.useFakeTimers();
    try {
      const db = createTestDb();
      const { projectId } = seedProject(db);
      scheduleRebuild(db, projectId);
      scheduleRebuild(db, projectId);
      scheduleRebuild(db, projectId);
      await vi.advanceTimersByTimeAsync(5_000);

      const idx = getDocument(db, { projectId, title: '《项目文档索引》' });
      expect(idx.source_type).toBe('index');
      expect(listVersions(db, idx.id).length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushPendingRebuilds 同步补齐未触发的重建', () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    scheduleRebuild(db, projectId); // 未到去抖期
    flushPendingRebuilds(db);
    const idx = getDocument(db, { projectId, title: '《项目文档索引》' });
    expect(idx.source_type).toBe('index');
    // flush 后无遗留：再次 flush 不产生新版本
    flushPendingRebuilds(db);
    expect(listVersions(db, idx.id).length).toBe(1);
  });

  it('不存在的项目报错', () => {
    const db = createTestDb();
    expect(() => rebuildIndex(db, 'nope')).toThrow(/项目不存在/);
  });
});
