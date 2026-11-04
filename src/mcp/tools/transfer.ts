import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { resolveProject } from '../../services/resolve.js';
import {
  exportProjectBundle,
  importProjectBundleFromFile,
  postImportIndex,
  saveProjectBundle,
} from '../../services/transfer.js';
import { fail, handle, ok } from './shared.js';

/**
 * 项目资料导入导出（bundle JSON）：
 * - 导出：项目全部文档（含全部历史版本）打包为单个 JSON 文件，排除自动索引文档
 * - 导入：按 bundle 项目名匹配已有项目合并（不存在则新建）；同名文档自动合并，
 *   版本按内容去重后追加并保留原时间戳
 */
export function registerTransferTools(mcp: McpServer): void {
  mcp.registerTool('export_project', {
    title: '导出项目资料',
    description:
      '将指定项目的全部资料（文档清单、每篇文档的全部历史版本正文与元数据）导出为单个 JSON bundle 文件。' +
      '排除自动生成的《项目文档索引》。缺省写入服务端 data/exports/<项目名>-bundle.json。',
    inputSchema: {
      project_id: z.string().min(1).describe('项目 id 或名称（名称支持模糊）'),
      file_path: z.string().optional()
        .describe('导出目标本地文件绝对路径（如 D:\\backup\\项目-bundle.json）；缺省写入服务端 data/exports/<项目名>-bundle.json'),
    },
  }, async (args) => {
    try {
      const p = resolveProject(getDb(), args.project_id);
      const bundle = exportProjectBundle(getDb(), p.id);
      return ok({ project: p.name, ...saveProjectBundle(bundle, args.file_path) });
    } catch (err) {
      return fail(err);
    }
  });

  mcp.registerTool('import_project', {
    title: '导入项目资料',
    description:
      '从项目导出的 JSON bundle 文件导入资料并自动合并：目标项目按 bundle 内项目名匹配（已存在则合并、不存在则新建，' +
      '可用 target_project_id 指定）；同名文档（含「xx v2」等版本变体标题）合并到已有文档；' +
      '文档内不同版本按内容去重后依次追加，保留原变更说明与时间戳。返回导入统计。',
    inputSchema: {
      file_path: z.string().min(1).describe('bundle JSON 文件的本地绝对路径'),
      target_project_id: z.string().optional()
        .describe('导入目标项目 id 或名称（可选，支持模糊；缺省按 bundle 内项目名匹配）'),
    },
  }, async (args) => {
    try {
      const target = args.target_project_id
        ? resolveProject(getDb(), args.target_project_id).id
        : undefined;
      const stats = importProjectBundleFromFile(getDb(), args.file_path, { targetProjectId: target });
      const embedding = await postImportIndex(getDb(), stats.project_id);
      return ok({ ...stats, embedding });
    } catch (err) {
      return fail(err);
    }
  });
}
