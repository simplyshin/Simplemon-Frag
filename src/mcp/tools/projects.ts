import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { createProject, listProjects } from '../../services/project.js';
import { handle, ok } from './shared.js';

/** Tools 1-2：项目管理 */
export function registerProjectTools(mcp: McpServer): void {
  mcp.registerTool('list_projects', {
    title: '列出项目',
    description: '列出 MCP 服务中的全部项目，返回项目 id、名称、描述与更新时间。',
    inputSchema: {},
  }, async () => handle(() => ok(listProjects(getDb()))));

  mcp.registerTool('create_project', {
    title: '创建项目',
    description: '创建一个新项目（项目名不可重复）。返回新项目的 id，后续添加文档需要它。',
    inputSchema: {
      name: z.string().min(1).describe('项目名称，如「支付网关重构」'),
      description: z.string().optional().describe('项目简介，可选'),
    },
  }, async ({ name, description }) => handle(() => ok(createProject(getDb(), name, description))));
}
