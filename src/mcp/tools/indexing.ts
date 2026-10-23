import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { rebuildIndex } from '../../services/indexing.js';
import { resolveProject } from '../../services/resolve.js';
import { handle, ok } from './shared.js';

/** Tool 9：重建项目文档索引（P1 朴素版：目录+首段截断摘要，无 LLM） */
export function registerIndexTools(mcp: McpServer): void {
  mcp.registerTool('rebuild_index', {
    title: '重建项目文档索引',
    description:
      '为项目生成/更新《项目文档索引》文档：包含全部文档目录与内容摘要。' +
      '批量更新文档后调用可刷新索引（写操作后通常已自动重建，本工具用于手动强制刷新）。' +
      '每次重建都追加新版本，内容无变化时跳过建版（action=skipped），历史索引可回溯。',
    inputSchema: {
      project_id: z.string().min(1).describe('项目 id 或项目名称（名称支持模糊）'),
    },
  }, async ({ project_id }) => handle(() => ok(rebuildIndex(getDb(), resolveProject(getDb(), project_id).id))));
}
