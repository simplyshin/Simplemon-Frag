import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { searchDocuments } from '../../services/search.js';
import { resolveProject } from '../../services/resolve.js';
import { handle, ok } from './shared.js';

/** Tool 8：文档检索（混合召回的 MCP 入口，P1 为 FTS5+LIKE，P2 加向量路） */
export function registerSearchTools(mcp: McpServer): void {
  mcp.registerTool('search_documents', {
    title: '检索文档',
    description:
      '在指定项目内全文检索文档内容，返回相关片段及来源（文档、版本、章节路径、相关度）。' +
      '需要查找"某功能在哪些文档里怎么写的"时使用此工具。',
    inputSchema: {
      project_id: z.string().min(1).describe('项目 id 或项目名称（名称支持模糊，忽略空格/下划线/大小写）'),
      query: z.string().min(1).describe('查询词，如「退款流程」；支持口语化描述，多个词用空格分隔'),
      top_k: z.number().int().positive().max(50).optional().describe('返回条数上限，默认 8'),
    },
  // 注意：searchDocuments 是 async，必须 await 后再 ok()，否则 JSON.stringify(Promise) === "{}"
  }, async ({ project_id, query, top_k }) => handle(async () => ok(await searchDocuments(getDb(), {
    projectId: resolveProject(getDb(), project_id).id,
    query,
    topK: top_k,
  }))));
}
