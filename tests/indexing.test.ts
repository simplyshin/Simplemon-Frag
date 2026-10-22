import { describe, expect, it } from 'vitest';
import { createTestDb, seedProject } from './helpers.js';
import { rebuildIndex } from '../src/services/indexing.js';
import { getDocument, listDocuments, updateDocument } from '../src/services/document.js';

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

  it('重复重建追加版本且 action=updated', () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    const v1 = rebuildIndex(db, projectId);
    const v2 = rebuildIndex(db, projectId);
    expect(v1.action).toBe('created');
    expect(v2.action).toBe('updated');
    expect(v2.version_no).toBe(v1.version_no + 1);
    expect(v2.document_id).toBe(v1.document_id);
  });

  it('文档更新后重建，索引反映新内容', () => {
    const db = createTestDb();
    const { projectId, docIds } = seedProject(db);
    updateDocument(db, { documentId: docIds[0], content: '# 需求说明\n\n更新后的正文。', changeNote: '改' });
    rebuildIndex(db, projectId);
    const idx = getDocument(db, { projectId, title: '《项目文档索引》' });
    expect(idx.content).toContain('更新后的正文');
    const docs = listDocuments(db, projectId);
    const reqDoc = docs.find((d) => d.title === '需求说明');
    expect(reqDoc?.version_no).toBe(2);
  });

  it('不存在的项目报错', () => {
    const db = createTestDb();
    expect(() => rebuildIndex(db, 'nope')).toThrow(/项目不存在/);
  });
});
