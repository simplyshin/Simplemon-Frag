import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { createProject, deleteProject, listProjects } from '../../services/project.js';

/** REST：项目管理（P3 Web 后台） */
export function registerProjectRoutes(app: FastifyInstance): void {
  app.get('/api/projects', async () => listProjects(getDb()));

  app.post('/api/projects', async (request, reply) => {
    const body = (request.body ?? {}) as { name?: string; description?: string };
    if (!body.name?.trim()) {
      return reply.code(400).send({ error: 'name 不能为空' });
    }
    try {
      return createProject(getDb(), body.name.trim(), body.description);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // 物理级联删除项目及其全部文档（含版本与向量）
  app.delete('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return deleteProject(getDb(), id);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });
}
