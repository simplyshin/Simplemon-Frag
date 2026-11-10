import type { FastifyInstance } from 'fastify';
import { registerProjectRoutes } from './projects.js';
import { registerCategoryRoutes, registerDocumentRoutes } from './documents.js';
import { registerSearchRoutes } from './search.js';
import { registerSettingsRoutes } from './settings.js';
import { registerTransferRoutes } from './transfer.js';

/** REST API 总注册（P3 Web 后台，与 MCP 同端口共用 services 层） */
export function registerApiRoutes(app: FastifyInstance): void {
  registerProjectRoutes(app);
  registerCategoryRoutes(app);
  registerDocumentRoutes(app);
  registerSearchRoutes(app);
  registerSettingsRoutes(app);
  registerTransferRoutes(app);
}
