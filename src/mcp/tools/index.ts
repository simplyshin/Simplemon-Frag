import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getLlm } from '../../llm/registry.js';
import { registerDocumentTools } from './documents.js';
import { registerGenerationTools, registerCommunicationTools } from './generation.js';
import { registerIndexTools } from './indexing.js';
import { registerProjectTools } from './projects.js';
import { registerSearchTools } from './search.js';

/**
 * 注册全部 MCP tools。
 * - server_info：连通性验证占位工具（保留，供客户端与冒烟脚本使用）
 * - Tools 1-2：projects.ts（项目管理）
 * - Tools 3-7：documents.ts（文档 CRUD，含版本机制与最小分块）
 * - Tool 8：search.ts（文档检索）
 * - Tool 9：indexing.ts（重建项目文档索引）
 * - Tools 10-11：generation.ts（P4：generate_document / list_related_documents）
 * - Tool 12：generation.ts（P5：add_communication 沟通记录归档）
 */
export function registerAllTools(mcp: McpServer): void {
  mcp.registerTool('server_info', {
    title: '服务信息',
    description: '返回文档管理 MCP 服务的基本信息。可用于验证服务连通性。',
    inputSchema: {},
  }, async () => ({
    content: [{
      type: 'text',
      text: JSON.stringify({
        service: 'frag-mcp-server',
        version: '0.1.0',
        llm_configured: !!getLlm(),
        capabilities: [
          '项目管理: list_projects / create_project',
          '文档管理: list_documents / add_document / get_document / update_document / delete_document / export_document',
          '文档检索: search_documents',
          '索引维护: rebuild_index',
          '文档生成: generate_document（功能文档/使用说明/需求文档/沟通纪要，附变更记录）',
          '文档关联: list_related_documents（自动关联 + 需求变更联动提示）',
          '沟通归档: add_communication（一段文字 + 渠道/参与方/时间，变更可追溯）',
        ],
      }, null, 2),
    }],
  }));

  registerProjectTools(mcp);
  registerDocumentTools(mcp);
  registerSearchTools(mcp);
  registerIndexTools(mcp);
  registerGenerationTools(mcp);
  registerCommunicationTools(mcp);
}
