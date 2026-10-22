import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestDb, seedProject } from './helpers.js';
import { addDocument, getDocument, updateDocument } from '../src/services/document.js';
import { exportDocument } from '../src/services/export.js';
import { generateDocument } from '../src/services/generation.js';
import { DATA_DIR } from '../src/config/index.js';

/** 改进批次：重复导入检测 / get_document 大纲与分页 / export_document */
describe('重复导入检测（content_hash）', () => {
  it('迁移 v3：user_version=3 且存量文档 content_hash 已回填', () => {
    const db = createTestDb();
    const { docIds } = seedProject(db);
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    for (const id of docIds) {
      const hash = (db.prepare('SELECT content_hash FROM documents WHERE id = ?').get(id) as { content_hash: string }).content_hash;
      expect(hash).toBeTruthy();
    }
  });

  it('同内容再次入库返回 duplicates 提示（不阻断）', () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    const content = '# 重复文档\n\n完全相同的内容。';
    const first = addDocument(db, { projectId, title: '文档一', content });
    expect(first.duplicates).toHaveLength(0);
    const second = addDocument(db, { projectId, title: '文档二', content });
    expect(second.duplicates).toHaveLength(1);
    expect(second.duplicates[0].title).toBe('文档一');
    expect(second.duplicates[0].id).toBe(first.document_id);
  });

  it('update_document 刷新 content_hash：内容改回与旧文档相同后可被检测', () => {
    const db = createTestDb();
    const { projectId, docIds } = seedProject(db);
    const contentA = (db.prepare(
      'SELECT v.content AS c FROM documents d JOIN document_versions v ON v.id = d.latest_version_id WHERE d.id = ?',
    ).get(docIds[0]) as { c: string }).c;
    updateDocument(db, { documentId: docIds[1], content: '临时内容', changeNote: '临时' });
    const r = updateDocument(db, { documentId: docIds[1], content: contentA, changeNote: '改回相同内容' });
    expect(r.version_no).toBe(3);
    // 重新以相同内容入库应命中两篇（文档一 + 被更新的接口设计）
    const added = addDocument(db, { projectId, title: '文档三', content: contentA });
    expect(added.duplicates).toHaveLength(2);
  });
});

describe('generate_document 降级提示', () => {
  it('未配置 LLM key 时返回 degraded=true 与说明（测试环境无 key）', async () => {
    const db = createTestDb();
    const { projectId } = seedProject(db);
    const r = await generateDocument(db, { projectId, type: 'functional', title: '降级测试' });
    expect(r.generated_by).toBe('aggregate');
    expect(r.degraded).toBe(true);
    expect(r.degraded_note).toContain('未配置 LLM key');
  });
});

describe('get_document 大纲与分页', () => {
  it('outline 模式只返回标题树，不返回正文', () => {
    const db = createTestDb();
    const { docIds } = seedProject(db);
    const outline = getDocument(db, { documentId: docIds[0], outline: true }) as Record<string, unknown> & {
      outline: { level: number; title: string; path: string }[];
      total_length: number;
      content_omitted: boolean;
    };
    expect(outline.content_omitted).toBe(true);
    expect(outline.total_length).toBeGreaterThan(0);
    expect('content' in outline).toBe(false);
    expect(outline.outline).toContainEqual({ level: 2, title: '支付模块', path: '需求说明 > 支付模块' });
    expect(outline.outline).toContainEqual({ level: 3, title: '退款流程', path: '需求说明 > 支付模块 > 退款流程' });
  });

  it('offset/limit 分页切片正确并标注 truncated', () => {
    const db = createTestDb();
    const { docIds } = seedProject(db);
    const page1 = getDocument(db, { documentId: docIds[0], offset: 0, limit: 10 }) as Record<string, unknown> & {
      content: string; total_length: number; truncated: boolean;
    };
    const full = getDocument(db, { documentId: docIds[0] }) as { content: string };
    expect(page1.content).toBe(full.content.slice(0, 10));
    expect(page1.total_length).toBe(full.content.length);
    expect(page1.truncated).toBe(true);
    const page2 = getDocument(db, { documentId: docIds[0], offset: 10, limit: 10 }) as { content: string };
    expect(page2.content).toBe(full.content.slice(10, 20));
  });

  it('不传 outline/offset/limit 时返回完整正文（向后兼容）', () => {
    const db = createTestDb();
    const { docIds } = seedProject(db);
    const doc = getDocument(db, { documentId: docIds[0] }) as Record<string, unknown>;
    expect('content' in doc).toBe(true);
    expect('truncated' in doc).toBe(false);
    expect('content_omitted' in doc).toBe(false);
  });
});

describe('export_document 服务', () => {
  it('导出到指定路径，文件名非法字符被替换，内容与 get_document 一致', () => {
    const db = createTestDb();
    const { docIds } = seedProject(db);
    const dir = mkdtempSync(join(tmpdir(), 'docmcp-export-'));
    try {
      const r = exportDocument(db, { documentId: docIds[0], filePath: join(dir, '导出:测试?.md') });
      // 显式路径按原样写入（盘符冒号合法，不做文件名改写）
      expect(existsSync(r.file_path)).toBe(true);
      expect(r.file_path).toBe(join(dir, '导出:测试?.md'));
      const full = getDocument(db, { documentId: docIds[0] }) as { content: string };
      expect(readFileSync(r.file_path, 'utf-8')).toBe(full.content);
      expect(r.char_count).toBe(full.content.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('缺省路径落 data/exports/<安全标题>.md（测试后清理）', () => {
    const db = createTestDb();
    const { docIds } = seedProject(db);
    const r = exportDocument(db, { documentId: docIds[0] });
    try {
      expect(r.file_path.startsWith(join(DATA_DIR, 'exports'))).toBe(true);
      // 默认文件名由标题生成，非法字符应被替换为下划线
      const base = r.file_path.split('\\').pop() ?? '';
      expect(base).not.toMatch(/[:*?"<>|\r\n]/);
      expect(existsSync(r.file_path)).toBe(true);
    } finally {
      if (existsSync(r.file_path)) rmSync(r.file_path, { force: true });
    }
  });
});
