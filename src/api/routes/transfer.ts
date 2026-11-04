import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { exportProjectBundle, importProjectBundle, postImportIndex } from '../../services/transfer.js';
import { sanitizeFilename } from '../../services/export.js';

/** REST：项目资料导入导出（bundle JSON，导出整项目或指定文档，导入自动合并） */
export function registerTransferRoutes(app: FastifyInstance): void {
  // 导出项目 bundle：?doc_ids=id1,id2 可选指定文档，缺省导出全部（排除自动索引文档）
  app.get('/api/projects/:id/export', async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { doc_ids?: string };
    const docIds = q.doc_ids
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const bundle = exportProjectBundle(getDb(), id, docIds);
      const project = getDb().prepare('SELECT name FROM projects WHERE id = ?').get(id) as { name: string } | undefined;
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const safeName = sanitizeFilename(`${project?.name ?? 'project'}-export-${date}`);
      reply.type('application/json; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.json`);
      return JSON.stringify(bundle);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  // 导入项目 bundle（multipart：file + 可选 target_project_id）
  // 目标解析：target_project_id 优先 → 按 bundle 内项目名精确匹配（存在即合并）→ 新建
  app.post('/api/projects/import', async (request, reply) => {
    try {
      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ error: '缺少上传文件（multipart 字段名 file，内容为项目导出的 JSON bundle）' });
      }
      const buffer = await file.toBuffer();
      let bundle: unknown;
      try {
        bundle = JSON.parse(buffer.toString('utf-8'));
      } catch {
        return reply.code(400).send({ error: '上传文件不是合法的 JSON' });
      }
      const targetProjectId = (file.fields.target_project_id as { value?: string } | undefined)?.value?.trim() || undefined;
      const stats = importProjectBundle(getDb(), bundle, { targetProjectId });
      const embedding = await postImportIndex(getDb(), stats.project_id);
      return { ...stats, embedding };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
