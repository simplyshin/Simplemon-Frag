import { describe, expect, it } from 'vitest';
import { createTestDb, seedProject, SAMPLE_DOC } from './helpers.js';
import {
  addDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  setDocumentType,
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
    expect(docs.items.map((d) => d.title)).toEqual(['接口设计']);
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
    expect(docs.items.length).toBe(2);
    expect(docs.items.every((d) => d.version_no === 1)).toBe(true);
  });
});

describe('document 同名合并与分类', () => {
  it('同名 addDocument 自动合并为新版本而非新建', () => {
    const db = createTestDb();
    const { projectId, docIds } = seedProject(db);
    const r = addDocument(db, { projectId, title: '需求说明', content: '# 需求说明\n\n更新后的正文。' });
    expect(r.merged).toBe(true);
    expect(r.document_id).toBe(docIds[0]);
    expect(r.version_no).toBe(2);
    const docs = listDocuments(db, projectId);
    expect(docs.total).toBe(2); // 未新增文档
  });

  it('归一化标题匹配：需求说明 v2 合并到已有「需求说明」', () => {
    const db = createTestDb();
    const { projectId, docIds } = seedProject(db);
    const r = addDocument(db, { projectId, title: '需求说明 v2', content: '# 需求说明\n\nv2 正文。' });
    expect(r.merged).toBe(true);
    expect(r.document_id).toBe(docIds[0]);
  });

  it('mergeSameTitle: false 时同名也新建文档', () => {
    const db = createTestDb();
    const { projectId, docIds } = seedProject(db);
    const r = addDocument(db, { projectId, title: '需求说明', content: '# 需求说明\n\n另一份。', mergeSameTitle: false });
    expect(r.merged).toBeUndefined();
    expect(r.document_id).not.toBe(docIds[0]);
    expect(listDocuments(db, projectId).total).toBe(3);
  });

  it('防误合并：index/generated 来源文档不作为合并目标', () => {
    const db = createTestDb();
    const project = createProject(db, '内部文档项目');
    addDocument(db, {
      projectId: project.id, title: '《项目文档索引》', content: '# 索引\n\n内容。',
      sourceType: 'index', mergeSameTitle: false,
    });
    const r = addDocument(db, { projectId: project.id, title: '《项目文档索引》', content: '# 索引\n\n新内容。' });
    expect(r.merged).toBeUndefined();
  });

  it('入库自动分类：显式 docType 优先，否则按标题推断', () => {
    const db = createTestDb();
    const project = createProject(db, '分类项目');
    const r1 = addDocument(db, { projectId: project.id, title: '采购合同', content: '合同正文' });
    expect(r1.doc_type).toBe('contract');
    const r2 = addDocument(db, { projectId: project.id, title: '随便的标题', content: '内容', docType: 'test' });
    expect(r2.doc_type).toBe('test');
    const r3 = addDocument(db, { projectId: project.id, title: '随便的标题 v2', content: '新内容' });
    expect(r3.doc_type).toBe('other'); // 合并路径自动推断不覆盖人工设置
  });

  it('listDocuments 分类过滤 / keyword 转义 / 分页 / counts', () => {
    const db = createTestDb();
    const project = createProject(db, '列表项目');
    addDocument(db, { projectId: project.id, title: '支付需求说明', content: 'a' });
    addDocument(db, { projectId: project.id, title: '服务协议', content: 'b' });
    addDocument(db, { projectId: project.id, title: '登录功能测试用例', content: 'c' });
    addDocument(db, { projectId: project.id, title: '杂项笔记', content: 'd' });

    // 分类过滤
    const req = listDocuments(db, project.id, { docType: 'requirement' });
    expect(req.items.map((d) => d.title)).toEqual(['支付需求说明']);
    // keyword 命中
    const kw = listDocuments(db, project.id, { keyword: '测试' });
    expect(kw.items.map((d) => d.title)).toEqual(['登录功能测试用例']);
    // LIKE 通配符转义：'%' 不应通配
    const like = listDocuments(db, project.id, { keyword: '%' });
    expect(like.items.length).toBe(0);
    // 分页切片与 total
    const p1 = listDocuments(db, project.id, { page: 1, pageSize: 2 });
    const p2 = listDocuments(db, project.id, { page: 2, pageSize: 2 });
    expect(p1.total).toBe(4);
    expect(p1.items.length).toBe(2);
    expect(p2.items.length).toBe(2);
    expect(new Set([...p1.items, ...p2.items].map((d) => d.id)).size).toBe(4);
    // counts 项目级常显，不受 docType/keyword 过滤影响
    expect(req.counts.requirement).toBe(1);
    expect(req.counts.contract).toBe(1);
    expect(req.counts.test).toBe(1);
    expect(req.counts.other).toBe(1);
    // 分类字段出现在 items
    expect(req.items[0].doc_type).toBe('requirement');
  });

  it('setDocumentType 手动修改分类，非法文档报错', () => {
    const db = createTestDb();
    const { projectId, docIds } = seedProject(db);
    const r = setDocumentType(db, docIds[0], 'contract');
    expect(r.doc_type).toBe('contract');
    expect(listDocuments(db, projectId, { docType: 'contract' }).total).toBe(1);
    expect(() => setDocumentType(db, 'nope', 'tech')).toThrow(/不存在或已删除/);
  });
});
