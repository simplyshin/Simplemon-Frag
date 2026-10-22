import { describe, expect, it } from 'vitest';
import { createTestDb, seedProject, SAMPLE_DOC } from './helpers.js';
import {
  addDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from '../src/services/document.js';
import { createProject } from '../src/services/project.js';
import { searchDocuments } from '../src/services/search.js';

describe('document service', () => {
  it('add_document 创建 v1 并按标题分块', () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    const doc = getDocument(db, { projectId, title: '需求说明' });
    expect(doc.version_no).toBe(1);
    // 3 个二级/三级章节 + 文档头，至少 3 块
    expect(doc.heading_paths.length).toBeGreaterThanOrEqual(3);
    expect(doc.heading_paths).toContain('需求说明 > 支付模块 > 退款流程');
  });

  it('get_document 支持 id 定位与 project+title 定位', () => {
    const db = createTestDb();
    const { projectId, docIds } = seedProject(db);
    const byTitle = getDocument(db, { projectId, title: '需求说明' });
    const byId = getDocument(db, { documentId: docIds[0] });
    expect(byId.content).toBe(byTitle.content);
  });

  it('update_document 追加版本并重新分块，v1 可回溯', () => {
    const db = createTestDb();
    const { docIds } = seedProject(db);
    const r = updateDocument(db, {
      documentId: docIds[0],
      content: SAMPLE_DOC.replace('7 天内', '15 天内'),
      changeNote: '退款期限延长',
    });
    expect(r.version_no).toBe(2);

    const v1 = getDocument(db, { documentId: docIds[0], version: 1 });
    const latest = getDocument(db, { documentId: docIds[0] });
    expect(v1.content).toContain('7 天内');
    expect(latest.version_no).toBe(2);
    expect(latest.content).toContain('15 天内');
    expect(latest.change_note).toBe('退款期限延长');
  });

  it('update_document 后检索只命中最新版本内容（旧版本 chunk 保留仅供溯源）', async () => {
    const db = createTestDb();
    const { projectId, docIds } = seedProject(db);
    updateDocument(db, {
      documentId: docIds[0],
      content: '# 需求说明\n\n新的内容，包含聚合支付字样。',
      changeNote: '重写',
    });
    // 旧版本独有词「退款流程」不再从该文档召回（检索层 JOIN latest_version_id 过滤）
    const oldHits = await searchDocuments(db, { projectId, query: '退款流程' });
    expect(oldHits.hits.every((h) => h.document_id !== docIds[0])).toBe(true);
    // 新版本独有词可召回
    const newHits = await searchDocuments(db, { projectId, query: '聚合支付' });
    expect(newHits.hits.some((h) => h.document_id === docIds[0])).toBe(true);
  });

  it('delete_document 软删除后不再出现在列表，重复删除报错', () => {
    const db = createTestDb();
    const { projectId, docIds } = seedProject(db);
    deleteDocument(db, docIds[0]);
    const docs = listDocuments(db, projectId);
    expect(docs.map((d) => d.title)).toEqual(['接口设计']);
    expect(() => deleteDocument(db, docIds[0])).toThrow(/已删除/);
  });

  it('不存在的项目/文档给出明确错误', () => {
    const db = createTestDb();
    expect(() => addDocument(db, { projectId: 'nope', title: 'x', content: 'y' })).toThrow(/项目不存在/);
    expect(() => getDocument(db, { documentId: 'nope' })).toThrow(/不存在/);
  });

  it('content 与 file_path 均缺失时被拒绝', () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    expect(() => addDocument(db, { projectId, title: 'x' })).toThrow(/至少提供一个/);
  });

  it('创建项目 + 文档的完整闭环（列数一致性）', () => {
    const db = createTestDb();
    const project = createProject(db, '闭环项目');
    addDocument(db, { projectId: project.id, title: 'A', content: '# A\n\n内容一。' });
    addDocument(db, { projectId: project.id, title: 'B', content: '# B\n\n内容二。' });
    const docs = listDocuments(db, project.id);
    expect(docs.length).toBe(2);
    expect(docs.every((d) => d.version_no === 1)).toBe(true);
  });
});
