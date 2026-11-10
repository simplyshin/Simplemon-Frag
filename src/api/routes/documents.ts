import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import {
  createCategory,
  deleteCategory,
  isKnownDocType,
  listCategories,
  updateCategory,
  type DocCategory,
} from '../../services/categories.js';
import {
  addDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  listVersions,
  parseDocumentBuffer,
  setDocumentType,
  traceVersions,
  updateDocument,
} from '../../services/document.js';
import { listLinks, projectGraph, rebuildProjectLinks } from '../../services/links.js';
import { embedAfterWrite } from '../../services/embedding.js';
import { scheduleRebuild } from '../../services/indexing.js';

/** REST：文档 CRUD + multipart 上传 + 版本历史 + 分类管理（P3 Web 后台） */

/** 分类管理（内置可改名/改色，自定义可增删；删除自定义分类时其下文档回落「其他」） */
export function registerCategoryRoutes(app: FastifyInstance): void {
  app.get('/api/doc-categories', async () => {
    // 附带各分类的未删除文档数（跨项目全局计数），供分类管理页展示与删除提示
    const db = getDb();
    const items = listCategories(db) as (DocCategory & { doc_count: number })[];
    const rows = db.prepare(
      'SELECT doc_type, COUNT(*) AS n FROM documents WHERE deleted_at IS NULL GROUP BY doc_type',
    ).all() as { doc_type: string; n: number }[];
    const counts = Object.fromEntries(rows.map((r) => [r.doc_type, r.n]));
    return { items: items.map((c) => ({ ...c, doc_count: counts[c.id] ?? 0 })) };
  });

  app.post('/api/doc-categories', async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown; color?: unknown; sort?: unknown };
    try {
      return createCategory(getDb(), body);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.patch('/api/doc-categories/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { name?: unknown; color?: unknown; sort?: unknown };
    try {
      return updateCategory(getDb(), id, body);
    } catch (err) {
      return reply.code(err instanceof Error && err.message.includes('不存在') ? 404 : 400).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/doc-categories/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return deleteCategory(getDb(), id);
    } catch (err) {
      return reply.code(err instanceof Error && err.message.includes('不存在') ? 404 : 400).send({ error: (err as Error).message });
    }
  });
}

export function registerDocumentRoutes(app: FastifyInstance): void {
  // 支持分类过滤 / 标题搜索 / 时间筛选 / 分页：?doc_type=&keyword=&updated_from=&updated_to=&page=&page_size=
  app.get('/api/projects/:id/documents', async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as {
      doc_type?: string; keyword?: string; updated_from?: string; updated_to?: string; page?: string; page_size?: string;
    };
    if (q.doc_type !== undefined && !isKnownDocType(getDb(), q.doc_type)) {
      return reply.code(400).send({ error: `未知分类: ${q.doc_type}（GET /api/doc-categories 获取有效分类列表）` });
    }
    const timeOpts: { updatedFrom?: string; updatedTo?: string } = {};
    for (const [key, raw] of [['updatedFrom', q.updated_from], ['updatedTo', q.updated_to]] as const) {
      if (raw === undefined || raw === '') continue;
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) {
        return reply.code(400).send({ error: `${key} 不是合法时间: ${raw}` });
      }
      timeOpts[key] = new Date(ms).toISOString();
    }
    if (timeOpts.updatedFrom && timeOpts.updatedTo && timeOpts.updatedFrom > timeOpts.updatedTo) {
      return reply.code(400).send({ error: 'updated_from 不能晚于 updated_to' });
    }
    const page = q.page !== undefined ? Number(q.page) : undefined;
    const pageSize = q.page_size !== undefined ? Number(q.page_size) : undefined;
    if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
      return reply.code(400).send({ error: 'page 必须为正整数' });
    }
    if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 0)) {
      return reply.code(400).send({ error: 'page_size 必须为非负整数（0 = 全量）' });
    }
    try {
      const r = listDocuments(getDb(), id, {
        docType: q.doc_type,
        keyword: q.keyword,
        ...timeOpts,
        page,
        pageSize,
      });
      return { items: r.items, total: r.total, page: r.page, page_size: r.pageSize, counts: r.counts };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  // multipart 上传：file（md/txt/docx/pdf）+ 可选 title / changeNote / docType
  app.post('/api/projects/:id/documents', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ error: '缺少上传文件（multipart 字段名 file）' });
      }
      const buffer = await file.toBuffer();
      const title = (file.fields.title as { value?: string } | undefined)?.value?.trim()
        || file.filename.replace(/\.[^.]+$/, '');
      const changeNote = (file.fields.changeNote as { value?: string } | undefined)?.value
        || `Web 上传 ${file.filename}`;
      const docTypeField = (file.fields.docType as { value?: string } | undefined)?.value;
      if (docTypeField !== undefined && docTypeField !== '' && !isKnownDocType(getDb(), docTypeField)) {
        return reply.code(400).send({ error: `未知分类 docType: ${docTypeField}（GET /api/doc-categories 获取有效分类列表）` });
      }
      const content = await parseDocumentBuffer(file.filename, buffer);
      if (!content?.trim()) {
        return reply.code(400).send({ error: `无法从 ${file.filename} 提取到文本内容` });
      }
      const r = addDocument(getDb(), {
        projectId: id,
        title,
        content,
        changeNote,
        sourceType: 'web',
        createdBy: 'web',
        docType: docTypeField || undefined,
      });
      const embedding = await embedAfterWrite(getDb(), r.document_id);
      const duplicate_warning = r.duplicates.length
        ? `项目内已存在内容完全相同的文档（已照常入库，可考虑删除其一）：`
          + r.duplicates.map((d) => `「${d.title}」(${d.id})`).join('、')
        : undefined;
      // 自动索引重建：去抖 5s 后台执行，不阻塞本次响应
      scheduleRebuild(getDb(), id);
      return { ...r, embedding, duplicate_warning, index_rebuild: 'scheduled' };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // 文档关联拓扑（Web 后台可视化）：节点 = 文档，边 = doc_links（双向去重）
  app.get('/api/projects/:id/graph', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return projectGraph(getDb(), id);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  // 项目级重建自动关联（拓扑页「重建关联」按钮）：全部文档两两重算 doc_links(auto)
  app.post('/api/projects/:id/links/rebuild', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return rebuildProjectLinks(getDb(), id);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.get('/api/documents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { version } = request.query as { version?: string };
    try {
      return getDocument(getDb(), {
        documentId: id,
        version: version ? Number(version) : undefined,
      });
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  // 文档导出下载（markdown 附件；查看历史版本时 ?version=N）
  app.get('/api/documents/:id/export', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { version } = request.query as { version?: string };
    try {
      const doc = getDocument(getDb(), {
        documentId: id,
        version: version ? Number(version) : undefined,
      });
      if (!('content' in doc)) {
        return reply.code(400).send({ error: '导出失败：文档内容为空' });
      }
      const safeName = doc.title.replace(/[\\/:*?"<>|\r\n\t]+/g, '_').trim() || 'document';
      reply.type('text/markdown; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.md`);
      return doc.content;
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  // 手动修改文档分类（不追加版本、不参与索引；分类 id 需存在于 doc_categories）
  app.patch('/api/documents/:id/doc-type', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { doc_type?: string };
    if (!isKnownDocType(getDb(), body.doc_type)) {
      return reply.code(400).send({ error: `未知分类: ${body.doc_type}（GET /api/doc-categories 获取有效分类列表）` });
    }
    try {
      return setDocumentType(getDb(), id, body.doc_type);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.put('/api/documents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { content?: string; changeNote?: string };
    if (!body.content?.trim()) {
      return reply.code(400).send({ error: 'content 不能为空' });
    }
    try {
      const r = updateDocument(getDb(), {
        documentId: id,
        content: body.content,
        changeNote: body.changeNote || 'Web 更新',
        createdBy: 'web',
      });
      const embedding = await embedAfterWrite(getDb(), id);
      scheduleRebuild(getDb(), id);
      return { ...r, embedding, index_rebuild: 'scheduled' };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/documents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const r = deleteDocument(getDb(), id);
      scheduleRebuild(getDb(), id); // 软删除后重建，索引中该节自动消失
      return { ...r, index_rebuild: 'scheduled' };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.get('/api/documents/:id/versions', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return listVersions(getDb(), id);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  // P4：自动关联文档（双向）
  app.get('/api/documents/:id/links', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return { document_id: id, related: listLinks(getDb(), id) };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  // P4：段落级溯源（块级 hash 对比，标注段落来源版本）
  app.get('/api/documents/:id/trace', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { from, to } = request.query as { from?: string; to?: string };
    const fromV = Number(from);
    const toV = Number(to);
    if (!fromV || !toV) {
      return reply.code(400).send({ error: 'from 与 to 均为必填的版本号，如 ?from=1&to=2' });
    }
    try {
      return traceVersions(getDb(), id, fromV, toV);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });
}
