import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import {
  addDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  listVersions,
  parseDocumentBuffer,
  traceVersions,
  updateDocument,
} from '../../services/document.js';
import { listLinks, projectGraph, rebuildProjectLinks } from '../../services/links.js';
import { embedAfterWrite } from '../../services/embedding.js';

/** REST：文档 CRUD + multipart 上传 + 版本历史（P3 Web 后台） */
export function registerDocumentRoutes(app: FastifyInstance): void {
  app.get('/api/projects/:id/documents', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return listDocuments(getDb(), id);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  // multipart 上传：file（md/txt/docx/pdf）+ 可选 title / changeNote
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
      });
      const embedding = await embedAfterWrite(getDb(), r.document_id);
      const duplicate_warning = r.duplicates.length
        ? `项目内已存在内容完全相同的文档（已照常入库，可考虑删除其一）：`
          + r.duplicates.map((d) => `「${d.title}」(${d.id})`).join('、')
        : undefined;
      return { ...r, embedding, duplicate_warning };
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
      return { ...r, embedding };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/documents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return deleteDocument(getDb(), id);
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
