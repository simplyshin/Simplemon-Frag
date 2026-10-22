import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, seedProject, SAMPLE_DOC } from './helpers.js';
import { setEmbedderForTests, type Embedder } from '../src/llm/embedding/index.js';
import { embedPendingChunks } from '../src/services/embedding.js';
import { addDocument, getDocument, traceVersions, updateDocument } from '../src/services/document.js';
import { autoLinkDocument, listLinks, relatedHint } from '../src/services/links.js';
import { buildChangelog, generateDocument } from '../src/services/generation.js';
import { createProject } from '../src/services/project.js';
import { searchDocuments } from '../src/services/search.js';

// 与 vector.test.ts 相同的确定性假 embedder
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

describe('doc auto-links（P4 需求变更联动）', () => {
  afterAll(() => setEmbedderForTests(null));

  it('向量化后自动建立关联（内容重叠多的文档相似度高），双向可查', async () => {
    const db = createTestDb();
    setEmbedderForTests(createFakeEmbedder());
    seedProject(db); // 需求说明（支付/退款）+ 接口设计（支付）
    await embedPendingChunks(db);

    const docs = db.prepare('SELECT id FROM documents ORDER BY created_at').all() as { id: string }[];
    const links = autoLinkDocument(db, docs[0].id);
    expect(links.length).toBeGreaterThanOrEqual(1);

    const both = listLinks(db, docs[0].id);
    expect(both.some((l) => l.title && l.score > 0)).toBe(true);
    // 双向：从对方视角也能查到
    const other = docs.find((d) => d.id !== docs[0].id)!;
    expect(listLinks(db, other.id).some((l) => l.document_id === docs[0].id)).toBe(true);
  });

  it('relatedHint：有关联时返回同步更新提示文案', async () => {
    const db = createTestDb();
    setEmbedderForTests(createFakeEmbedder());
    seedProject(db);
    await embedPendingChunks(db);
    const docs = db.prepare('SELECT id FROM documents ORDER BY created_at').all() as { id: string }[];
    autoLinkDocument(db, docs[0].id);

    const hint = relatedHint(db, docs[0].id);
    expect(hint.docs.length).toBeGreaterThanOrEqual(1);
    expect(hint.note).toContain('同步更新');
  });
});

describe('generate_document（P4）', () => {
  afterAll(() => setEmbedderForTests(null));

  it('无 LLM key 时降级机械聚合 + 变更记录 + snapshots 留档 + 生成文档可检索', async () => {
    const db = createTestDb();
    setEmbedderForTests(createFakeEmbedder());
    const { projectId, docIds } = seedProject(db);

    // 制造变更历史（含 change_note），供变更记录章节
    const doc = getDocument(db, { documentId: docIds[0] });
    updateDocument(db, {
      documentId: docIds[0],
      content: doc.content.replace('原路退回', '原路退回，7 天到账'),
      changeNote: '退款补充到账时效',
      createdBy: 'test',
    });
    await embedPendingChunks(db);

    const r = await generateDocument(db, {
      projectId,
      type: 'requirements',
      includeChangelog: true,
    });
    expect(r.generated_by).toBe('aggregate'); // 测试环境无 key
    expect(r.version_no).toBe(1);
    expect(r.snapshot_id).toBeGreaterThan(0);
    expect(r.source_doc_ids).toContain(docIds[0]);

    // 生成文档入库且带变更记录章节
    const gen = getDocument(db, { documentId: r.document_id });
    expect(gen.source_type).toBe('generated');
    expect(gen.content).toContain('## 变更记录');
    expect(gen.content).toContain('退款补充到账时效');

    // snapshots 留档
    const snap = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(r.snapshot_id) as
      { type: string; source_doc_ids: string };
    expect(snap.type).toBe('requirements');
    expect(JSON.parse(snap.source_doc_ids)).toContain(docIds[0]);

    // 生成文档分块入库 → 可被 FTS 检索
    await embedPendingChunks(db);
    const s2 = await searchDocuments(db, { projectId, query: '原路退回，7 天到账' });
    expect(s2.total).toBeGreaterThanOrEqual(1);
  });

  it('重复生成同名文档 → 追加版本而非新建（每次生成都是新版本）', async () => {
    const db = createTestDb();
    setEmbedderForTests(createFakeEmbedder());
    const { projectId } = seedProject(db);
    await embedPendingChunks(db);

    const r1 = await generateDocument(db, { projectId, type: 'functional' });
    const r2 = await generateDocument(db, { projectId, type: 'functional' });
    expect(r1.document_id).toBe(r2.document_id);
    expect(r2.version_no).toBe(2);

    const snaps = db.prepare('SELECT version_no FROM snapshots WHERE project_id = ? AND type = ? ORDER BY version_no')
      .all(projectId, 'functional') as { version_no: number }[];
    expect(snaps.map((s) => s.version_no)).toEqual([1, 2]);
  });

  it('doc_ids 越权校验：不属于项目的文档被拒绝', async () => {
    const db = createTestDb();
    setEmbedderForTests(createFakeEmbedder());
    const p1 = createProject(db, '项目一');
    const p2 = createProject(db, '项目二');
    const other = addDocument(db, { projectId: p2.id, title: '别家文档', content: '# 别家\n\n内容' });
    await expect(generateDocument(db, {
      projectId: p1.id, type: 'usage', docIds: [other.document_id],
    })).rejects.toThrow('不属于该项目');
  });
});

describe('buildChangelog / traceVersions（P4 段落级溯源）', () => {
  it('changelog 汇总版本时间线（markdown 表格）', () => {
    const db = createTestDb();
    const { docIds } = seedProject(db);
    updateDocument(db, { documentId: docIds[0], content: SAMPLE_DOC + '\n追加内容', changeNote: '追加章节' });
    const md = buildChangelog(db, docIds);
    expect(md).toContain('## 变更记录');
    expect(md).toContain('追加章节');
    expect(md).toContain('v2');
  });

  it('traceVersions：unchanged/changed/added 标注与来源版本', () => {
    const db = createTestDb();
    const { docIds } = seedProject(db);
    // v2：改一处 + 加一节
    updateDocument(db, {
      documentId: docIds[0],
      content: SAMPLE_DOC.replace('原路退回', '原路退回（7 天到账）') + '\n## 计费模块\n\n按月订阅。',
      changeNote: '改退款 + 新增计费',
    });

    const t = traceVersions(db, docIds[0], 1, 2);
    expect(t.from_version).toBe(1);
    expect(t.to_version).toBe(2);
    const changed = t.blocks.filter((b) => b.status === 'changed');
    const added = t.blocks.filter((b) => b.status === 'added');
    const unchanged = t.blocks.filter((b) => b.status === 'unchanged');
    expect(changed.some((b) => b.content.includes('原路退回（7 天到账）'))).toBe(true);
    expect(added.some((b) => b.heading_path.includes('计费模块'))).toBe(true);
    expect(unchanged.length).toBeGreaterThan(0);
    expect(t.summary.unchanged + t.summary.changed + t.summary.added).toBe(t.blocks.length);
  });
});
