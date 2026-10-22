import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { searchDocuments } from '../../services/search.js';

/** REST：语义+关键词混合检索（P3 Web 后台检索页） */
export function registerSearchRoutes(app: FastifyInstance): void {
  app.post('/api/search', async (request, reply) => {
    const body = (request.body ?? {}) as { projectId?: string; query?: string; topK?: number };
    if (!body.projectId || !body.query?.trim()) {
      return reply.code(400).send({ error: 'projectId 与 query 不能为空' });
    }
    try {
      return await searchDocuments(getDb(), {
        projectId: body.projectId,
        query: body.query,
        topK: body.topK,
      });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
