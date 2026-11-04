import { describe, expect, it } from 'vitest';
import { createTestDb, seedProject, SAMPLE_DOC } from './helpers.js';
import { createProject } from '../src/services/project.js';
import { addDocument, getDocument, listDocuments, listVersions } from '../src/services/document.js';
import {
  BUNDLE_FORMAT,
  exportProjectBundle,
  importProjectBundle,
} from '../src/services/transfer.js';

const iso = (s: string): string => new Date(s).toISOString();

/** 造一个带多版本文档的项目 */
function seedRichProject(db: ReturnType<typeof createTestDb>, name: string) {
  const project = createProject(db, name, '导出导入测试');
  const r1 = addDocument(db, {
    projectId: project.id, title: '需求说明', content: SAMPLE_DOC, createdBy: 'test',
  });
  const r2 = addDocument(db, {
    projectId: project.id, title: '服务协议', content: '# 服务协议\n\n甲方乙方条款。', createdBy: 'test',
  });
  // 「需求说明」同名入库自动合并，追加两个版本
  addDocument(db, {
    projectId: project.id, title: '需求说明', content: '# 需求说明\n\nv2 正文。', createdBy: 'test',
  });
  addDocument(db, {
    projectId: project.id, title: '需求说明', content: '# 需求说明\n\nv3 正文。', createdBy: 'test',
  });
  // 自动索引文档（导出应排除）
  addDocument(db, {
    projectId: project.id, title: '《项目文档索引》', content: '# 索引', sourceType: 'index', createdBy: 'system',
  });
  return { project, docIds: [r1.document_id, r2.document_id] };
}

describe('exportProjectBundle', () => {
  it('导出结构完整：format/project/documents/versions，按 created_at 升序', () => {
    const db = createTestDb();
    const { project } = seedRichProject(db, '导出项目');
    const bundle = exportProjectBundle(db, project.id);
    expect(bundle.format).toBe(BUNDLE_FORMAT);
    expect(bundle.version).toBe(1);
    expect(bundle.exported_at).toBeTruthy();
    expect(bundle.project.name).toBe('导出项目');
    expect(bundle.project.description).toBe('导出导入测试');
    // 排除《项目文档索引》
    expect(bundle.documents.map((d) => d.title).sort()).toEqual(['服务协议', '需求说明']);
    const req = bundle.documents.find((d) => d.title === '需求说明')!;
    expect(req.doc_type).toBe('requirement');
    expect(req.versions).toHaveLength(3);
    // 版本升序：v1 内容为初始版本
    expect(req.versions[0].content).toBe(SAMPLE_DOC);
    expect(req.versions[1].content).toContain('v2 正文');
    expect(req.versions[2].content).toContain('v3 正文');
    expect(req.versions.every((v) => v.created_at && typeof v.created_by === 'string')).toBe(true);
  });

  it('docIds 过滤：只导出指定文档，无效 id 忽略', () => {
    const db = createTestDb();
    const { project, docIds } = seedRichProject(db, '过滤项目');
    const bundle = exportProjectBundle(db, project.id, [docIds[1], 'nope']);
    expect(bundle.documents.map((d) => d.title)).toEqual(['服务协议']);
  });

  it('项目不存在抛错', () => {
    const db = createTestDb();
    expect(() => exportProjectBundle(db, 'nope')).toThrow(/项目不存在/);
  });
});

describe('importProjectBundle', () => {
  it('导入到新项目：全量重建（含版本级/文档级时间、doc_type、metadata）', () => {
    const db = createTestDb();
    const { project } = seedRichProject(db, '源项目');
    const bundle = exportProjectBundle(db, project.id);
    const req = bundle.documents.find((d) => d.title === '需求说明')!;
    req.versions[0].created_at = iso('2026-01-01T08:00:00Z');
    req.versions[1].created_at = iso('2026-01-02T08:00:00Z');
    req.versions[2].created_at = iso('2026-01-03T08:00:00Z');

    const db2 = createTestDb();
    const stats = importProjectBundle(db2, bundle);
    expect(stats.project_created).toBe(true);
    expect(stats.project_name).toBe('源项目');
    expect(stats.documents_created).toBe(2);
    expect(stats.documents_merged).toBe(0);
    expect(stats.versions_added).toBe(4);
    expect(stats.versions_skipped).toBe(0);

    const docs = listDocuments(db2, stats.project_id);
    expect(docs.total).toBe(2);
    const reqDoc = docs.items.find((d) => d.title === '需求说明')!;
    expect(reqDoc.doc_type).toBe('requirement');
    expect(listVersions(db2, reqDoc.id)).toHaveLength(3);
    // 版本级时间保留
    const versions = (db2.prepare(
      'SELECT created_at FROM document_versions WHERE document_id = ? ORDER BY version_no',
    ).all(reqDoc.id) as { created_at: string }[]).map((r) => r.created_at);
    expect(versions).toEqual([
      iso('2026-01-01T08:00:00Z'), iso('2026-01-02T08:00:00Z'), iso('2026-01-03T08:00:00Z'),
    ]);
    // 文档级时间收敛到末版本
    const docRow = db2.prepare('SELECT created_at, updated_at FROM documents WHERE id = ?').get(reqDoc.id) as { created_at: string; updated_at: string };
    expect(docRow.created_at).toBe(iso('2026-01-01T08:00:00Z'));
    expect(docRow.updated_at).toBe(iso('2026-01-03T08:00:00Z'));
  });

  it('导入同名项目：同名文档合并、不同版本追加', () => {
    const db = createTestDb();
    const { projectId } = seedProject(db); // 已有「需求说明」「接口设计」
    const bundle = exportProjectBundle(db, projectId);
    const req = bundle.documents.find((d) => d.title === '需求说明')!;
    req.versions.push({ content: '# 需求说明\n\n导入的新版本。', change_note: '导入追加', created_by: 'import', created_at: iso('2026-02-01T00:00:00Z') });

    const stats = importProjectBundle(db, bundle);
    expect(stats.project_created).toBe(false);
    expect(stats.documents_merged).toBe(2); // 需求说明 + 接口设计
    expect(stats.versions_added).toBe(1); // 仅追加新版本，已有版本全部去重跳过
    expect(stats.versions_skipped).toBe(2);
    const docs = listDocuments(db, projectId);
    expect(docs.items.find((d) => d.title === '需求说明')!.version_no).toBe(2);
  });

  it('归一化标题命中：「需求说明 v2」合并到已有「需求说明」', () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    const stats = importProjectBundle(db, {
      format: BUNDLE_FORMAT, version: 1, exported_at: iso('2026-02-01T00:00:00Z'),
      project: { name: '任意名字', description: '' },
      documents: [{
        title: '需求说明 v2', source_type: 'mcp', doc_type: 'requirement', metadata: {},
        created_at: iso('2026-02-01T00:00:00Z'),
        versions: [{ content: '# 需求说明\n\n变体标题版本。', change_note: '变体', created_by: 'import', created_at: iso('2026-02-01T00:00:00Z') }],
      }],
    }, { targetProjectId: projectId });
    expect(stats.project_created).toBe(false);
    expect(stats.documents_merged).toBe(1);
    expect(stats.documents_created).toBe(0);
    expect(listDocuments(db, projectId).items.find((d) => d.title === '需求说明')!.version_no).toBe(2);
  });

  it('相同内容版本跳过（bundle 内重复版本同样去重）', () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    const dup = '# 需求说明\n\n与 v1 逐字相同。';
    const stats = importProjectBundle(db, {
      format: BUNDLE_FORMAT, version: 1, exported_at: iso('2026-02-01T00:00:00Z'),
      project: { name: '测试项目', description: '' },
      documents: [{
        title: '需求说明', source_type: 'mcp', doc_type: 'requirement', metadata: {},
        created_at: iso('2026-02-01T00:00:00Z'),
        versions: [
          { content: dup, change_note: 'a', created_by: 'import', created_at: iso('2026-02-01T00:00:00Z') },
          { content: dup, change_note: 'b', created_by: 'import', created_at: iso('2026-02-02T00:00:00Z') },
        ],
      }],
    });
    expect(stats.versions_added).toBe(1);
    expect(stats.versions_skipped).toBe(1);
    const reqId = listDocuments(db, projectId).items.find((d) => d.title === '需求说明')!.id;
    expect(listVersions(db, reqId)).toHaveLength(2);
  });

  it('source_type 白名单：已知值保留，index/未知归一为 import', () => {
    const db = createTestDb();
    importProjectBundle(db, {
      format: BUNDLE_FORMAT, version: 1, exported_at: iso('2026-02-01T00:00:00Z'),
      project: { name: '来源项目', description: '' },
      documents: [
        { title: '邮件一', source_type: 'email', doc_type: 'other', metadata: {}, created_at: iso('2026-02-01T00:00:00Z'), versions: [{ content: '正文', change_note: '', created_by: 'import', created_at: iso('2026-02-01T00:00:00Z') }] },
        { title: '索引一', source_type: 'index', doc_type: 'other', metadata: {}, created_at: iso('2026-02-01T00:00:00Z'), versions: [{ content: '正文', change_note: '', created_by: 'import', created_at: iso('2026-02-01T00:00:00Z') }] },
        { title: '怪值一', source_type: 'weird', doc_type: 'other', metadata: {}, created_at: iso('2026-02-01T00:00:00Z'), versions: [{ content: '正文', change_note: '', created_by: 'import', created_at: iso('2026-02-01T00:00:00Z') }] },
      ],
    });
    const types = (db.prepare('SELECT title, source_type FROM documents').all() as { title: string; source_type: string }[]);
    expect(types.find((t) => t.title === '邮件一')?.source_type).toBe('email');
    expect(types.find((t) => t.title === '索引一')?.source_type).toBe('import');
    expect(types.find((t) => t.title === '怪值一')?.source_type).toBe('import');
  });

  it('坏数据容错：非对象/缺 name 抛错，缺 versions 跳过并记录 warnings', () => {
    const db = createTestDb();
    expect(() => importProjectBundle(db, 'not-an-object')).toThrow(/顶层必须是 JSON 对象/);
    expect(() => importProjectBundle(db, { format: BUNDLE_FORMAT, version: 1, project: {} })).toThrow(/project\.name/);
    const stats = importProjectBundle(db, {
      format: BUNDLE_FORMAT, version: 1, exported_at: iso('2026-02-01T00:00:00Z'),
      project: { name: '容错项目', description: '' },
      documents: [
        { title: '', source_type: 'mcp', doc_type: 'other', metadata: {}, created_at: '', versions: [] },
        { title: '无版本文档', source_type: 'mcp', doc_type: 'other', metadata: {}, created_at: '', versions: [] },
        'not-an-object' as never,
      ],
    });
    expect(stats.documents_created).toBe(0);
    expect(stats.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('metadata 形状非法置空对象', () => {
    const db = createTestDb();
    const stats = importProjectBundle(db, {
      format: BUNDLE_FORMAT, version: 1, exported_at: iso('2026-02-01T00:00:00Z'),
      project: { name: '元数据项目', description: '' },
      documents: [{
        title: '文档一', source_type: 'mcp', doc_type: 'other', metadata: 'not-an-object' as never,
        created_at: iso('2026-02-01T00:00:00Z'),
        versions: [{ content: '正文', change_note: '', created_by: 'import', created_at: iso('2026-02-01T00:00:00Z') }],
      }],
    });
    expect(stats.documents_created).toBe(1);
    const row = db.prepare('SELECT metadata FROM documents WHERE title = ?').get('文档一') as { metadata: string };
    expect(JSON.parse(row.metadata)).toEqual({});
  });

  it('targetProjectId 优先（id 与名称均可），不存在报错', () => {
    const db = createTestDb();
    const p1 = createProject(db, '目标项目');
    const bundle = {
      format: BUNDLE_FORMAT, version: 1, exported_at: iso('2026-02-01T00:00:00Z'),
      project: { name: '别的名字', description: '' },
      documents: [{
        title: '文档一', source_type: 'mcp', doc_type: 'other', metadata: {},
        created_at: iso('2026-02-01T00:00:00Z'),
        versions: [{ content: '正文', change_note: '', created_by: 'import', created_at: iso('2026-02-01T00:00:00Z') }],
      }],
    } as const;
    const byId = importProjectBundle(db, { ...bundle }, { targetProjectId: p1.id });
    expect(byId.project_id).toBe(p1.id);
    expect(byId.project_created).toBe(false);
    const byName = importProjectBundle(db, { ...bundle, documents: [{ ...bundle.documents[0], title: '文档二' }] }, { targetProjectId: '目标项目' });
    expect(byName.project_id).toBe(p1.id);
    expect(() => importProjectBundle(db, { ...bundle, documents: [{ ...bundle.documents[0], title: '文档三' }] }, { targetProjectId: '不存在的项目xyz' }))
      .toThrow(/不存在/);
  });

  it('往返一致性：导出 → 新库导入 → 内容与版本与源库一致', () => {
    const db = createTestDb();
    const { project } = seedRichProject(db, '往返项目');
    const bundle = exportProjectBundle(db, project.id);

    const db2 = createTestDb();
    importProjectBundle(db2, bundle);

    // bundle 排除《项目文档索引》，源侧同步排除后对比
    const srcDocs = listDocuments(db, project.id).items
      .filter((d) => d.source_type !== 'index')
      .sort((a, b) => a.title.localeCompare(b.title));
    const dstDocs = listDocuments(db2, (db2.prepare('SELECT id FROM projects WHERE name = ?').get('往返项目') as { id: string }).id)
      .items.sort((a, b) => a.title.localeCompare(b.title));
    expect(dstDocs.map((d) => d.title)).toEqual(srcDocs.map((d) => d.title));
    for (let i = 0; i < srcDocs.length; i++) {
      expect(dstDocs[i].doc_type).toBe(srcDocs[i].doc_type);
      expect(dstDocs[i].version_no).toBe(srcDocs[i].version_no);
      const a = getDocument(db, { documentId: srcDocs[i].id });
      const b = getDocument(db2, { documentId: dstDocs[i].id });
      expect(b.content).toBe(a.content);
      expect(b.metadata).toEqual(a.metadata);
    }
  });
});
