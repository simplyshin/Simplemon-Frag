import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { embedAfterWrite } from '../../services/embedding.js';
import { relatedHint } from '../../services/links.js';
import { resolveDocument, resolveProject } from '../../services/resolve.js';
import {
  addDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  readDocumentFile,
  updateDocument,
} from '../../services/document.js';
import { exportDocument } from '../../services/export.js';
import { scheduleRebuild } from '../../services/indexing.js';
import { fail, handle, ok } from './shared.js';

/**
 * Tools 3-7：文档 CRUD（每次更新追加版本并重新分块，FTS 自动同步）。
 * project_id / document_id 参数均同时接受 id 或名称（名称模糊匹配：
 * 忽略空格/下划线/横线/大小写，多候选时返回候选列表）。
 */
export function registerDocumentTools(mcp: McpServer): void {
  mcp.registerTool('list_documents', {
    title: '列出项目文档',
    description: '列出指定项目下的全部文档（不含已删除），返回文档 id、标题、当前版本号。',
    inputSchema: {
      project_id: z.string().min(1).describe('项目 id 或项目名称（名称支持模糊，忽略空格/下划线/大小写）'),
    },
  }, async ({ project_id }) => handle(() => {
    const p = resolveProject(getDb(), project_id);
    return ok(listDocuments(getDb(), p.id));
  }));

  mcp.registerTool('add_document', {
    title: '添加文档',
    description:
      '向项目添加一篇文档（v1 版本）。content 直接给文本，或给 file_path 读取本地文件。' +
      '服务端会自动按标题分块并建立全文索引。成功返回 document_id 与分块数量。',
    inputSchema: {
      project_id: z.string().min(1).describe('目标项目 id 或名称（支持模糊）'),
      title: z.string().min(1).describe('文档标题，如「需求说明」'),
      content: z.string().optional().describe('文档正文（markdown），与 file_path 二选一'),
      file_path: z.string().optional().describe('本地文件绝对路径，支持 md/txt/docx/pdf'),
      change_note: z.string().optional().describe('变更说明，可选，默认「初始版本」'),
    },
  }, async (args) => {
    try {
      const project = resolveProject(getDb(), args.project_id);
      // file_path 支持 md/txt（utf-8）、docx、pdf（P2 解析增强）
      const content = args.file_path ? await readDocumentFile(args.file_path) : args.content;
      const r = addDocument(getDb(), {
        projectId: project.id,
        title: args.title,
        content,
        changeNote: args.change_note,
      });
      const embedding = await embedAfterWrite(getDb(), r.document_id);
      // P4 需求变更联动：返回自动关联文档，提醒 AI 检查是否需要同步更新
      const related = relatedHint(getDb(), r.document_id);
      // 重复导入检测（不阻断）：内容完全相同时提醒调用方，由 AI 决定是否保留
      const duplicate_warning = r.duplicates.length
        ? `项目内已存在内容完全相同的文档（已照常入库，可考虑删除其一）：`
          + r.duplicates.map((d) => `「${d.title}」(${d.id})`).join('、')
        : undefined;
      // 自动索引重建：不依赖 AI 主动调用 rebuild_index（实践验证不可靠）
      scheduleRebuild(getDb(), project.id);
      return ok({ ...r, project: project.name, embedding, related, duplicate_warning });
    } catch (err) {
      return fail(err);
    }
  });

  mcp.registerTool('get_document', {
    title: '读取文档',
    description:
      '读取文档内容。document_id 传文档 id 或标题（标题支持模糊，可配合 project_id 缩小范围）；' +
      '不传 version 返回最新版本，传 version 可回看历史版本。' +
      '大文档建议先传 outline=true 看标题大纲，再用 offset/limit 按需分页读取正文，避免一次性返回超大内容。',
    inputSchema: {
      document_id: z.string().optional().describe('文档 id 或标题（标题支持模糊）'),
      project_id: z.string().optional().describe('项目 id 或名称（可选，用于缩小标题匹配范围）'),
      title: z.string().optional().describe('文档标题（与 document_id 二选一，支持模糊）'),
      version: z.number().int().positive().optional().describe('历史版本号，可选'),
      outline: z.boolean().optional()
        .describe('为 true 时只返回标题大纲（不返回正文），并给出 total_length 供分页参考'),
      offset: z.number().int().min(0).optional()
        .describe('正文分页起始字符偏移（默认 0），与 limit 配合使用'),
      limit: z.number().int().min(0).optional()
        .describe('本次返回的正文最大字符数（不传返回全部）'),
    },
  }, async (args) => handle(() => {
    const doc = resolveDocument(getDb(), {
      documentId: args.document_id,
      projectId: args.project_id,
      title: args.title,
    });
    return ok(getDocument(getDb(), {
      documentId: doc.id,
      version: args.version,
      outline: args.outline,
      offset: args.offset,
      limit: args.limit,
    }));
  }));

  mcp.registerTool('export_document', {
    title: '导出文档到本地文件',
    description:
      '将文档（默认最新版本，可指定历史版本）的 markdown 内容由服务端直接写入本地文件，' +
      '返回文件路径与大小。适合导出大文档供用户直接打开，避免客户端读全文转写浪费 token。',
    inputSchema: {
      document_id: z.string().min(1).describe('文档 id 或标题（标题支持模糊）'),
      project_id: z.string().optional().describe('项目 id 或名称（可选，标题重名时用于消歧）'),
      version: z.number().int().positive().optional().describe('历史版本号，可选，默认最新版本'),
      file_path: z.string().optional()
        .describe('导出目标本地文件绝对路径（如 D:\\docs\\协议.md）；缺省写入服务端 data/exports/<标题>.md'),
    },
  }, async (args) => {
    try {
      const doc = resolveDocument(getDb(), {
        documentId: args.document_id,
        projectId: args.project_id,
      });
      return ok(exportDocument(getDb(), {
        documentId: doc.id,
        version: args.version,
        filePath: args.file_path,
      }));
    } catch (err) {
      return fail(err);
    }
  });

  mcp.registerTool('update_document', {
    title: '更新文档',
    description:
      '更新文档内容：追加一个新版本（历史版本保留可回溯），并自动重新分块、刷新全文索引。' +
      '这是需求变更时修改文档的核心工具。document_id 传文档 id 或标题（标题支持模糊，可配合 project_id 缩小范围）。',
    inputSchema: {
      document_id: z.string().min(1).describe('文档 id 或标题（标题支持模糊）'),
      project_id: z.string().optional().describe('项目 id 或名称（可选，标题重名时用于消歧）'),
      content: z.string().min(1).describe('新的完整正文（markdown）'),
      change_note: z.string().optional().describe('本次变更说明，如「新增退款流程章节」'),
    },
  }, async (args) => {
    try {
      const doc = resolveDocument(getDb(), {
        documentId: args.document_id,
        projectId: args.project_id,
      });
      const r = updateDocument(getDb(), {
        documentId: doc.id,
        content: args.content,
        changeNote: args.change_note,
      });
      const embedding = await embedAfterWrite(getDb(), r.document_id);
      // P4 需求变更联动：返回自动关联文档，提醒 AI 检查是否需要同步更新
      const related = relatedHint(getDb(), r.document_id);
      scheduleRebuild(getDb(), doc.project_id);
      return ok({ ...r, document_title: doc.title, embedding, related });
    } catch (err) {
      return fail(err);
    }
  });

  mcp.registerTool('delete_document', {
    title: '删除文档',
    description: '软删除文档（版本历史保留），删除后不再出现在文档列表与检索结果中。document_id 传文档 id 或标题（支持模糊）。',
    inputSchema: {
      document_id: z.string().min(1).describe('文档 id 或标题（标题支持模糊，可配合 project_id 消歧）'),
      project_id: z.string().optional().describe('项目 id 或名称（可选，标题重名时用于消歧）'),
    },
  }, async ({ document_id, project_id }) => handle(() => {
    const doc = resolveDocument(getDb(), { documentId: document_id, projectId: project_id });
    scheduleRebuild(getDb(), doc.project_id); // 软删除后重建，索引中该节自动消失
    return ok({ ...deleteDocument(getDb(), doc.id), document_title: doc.title });
  }));
}
