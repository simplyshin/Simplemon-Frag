import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { generateDocument, type GenerateType } from '../../services/generation.js';
import { listLinks, linkDocuments, relatedHint } from '../../services/links.js';
import { resolveDocument, resolveProject } from '../../services/resolve.js';
import { embedAfterWrite } from '../../services/embedding.js';
import { addDocument } from '../../services/document.js';
import { fail, handle, ok } from './shared.js';

/** P4 Tools：文档生成（generate_document）与关联查询（list_related_documents） */
export function registerGenerationTools(mcp: McpServer): void {
  mcp.registerTool('generate_document', {
    title: '生成聚合文档',
    description:
      '从项目文档库聚合生成最新版功能文档（functional）/ 使用说明（usage）/ 需求文档（requirements）。'
      + '未传 doc_ids 时聚合项目内全部文档（上限 20 篇）；include_changelog=true 时文末附文档级变更记录表。'
      + '生成结果作为 generated 文档入库（同名追加版本），可被 search_documents 检索、在 Web 后台查看。'
      + '未配置 LLM key 时降级为机械聚合（原文结构化拼接），快照与变更记录不受影响。',
    inputSchema: {
      project_id: z.string().min(1).describe('项目 id 或项目名称（名称支持模糊）'),
      type: z.enum(['functional', 'usage', 'requirements', 'communication_summary'])
        .describe('生成类型（communication_summary=客户沟通纪要）'),
      doc_ids: z.array(z.string()).optional().describe('来源文档 id 列表，可选；不传则聚合项目内全部文档'),
      title: z.string().optional().describe('生成文档标题，默认「项目名 — 类型」'),
      include_changelog: z.boolean().optional().describe('文末附变更记录章节，默认 false'),
      instruction: z.string().optional().describe('额外生成要求（面向 LLM），可选'),
    },
  }, async ({ project_id, type, doc_ids, title, include_changelog, instruction }) =>
    handle(async () => {
      const db = getDb();
      const project = resolveProject(db, project_id);
      // doc_ids 每个元素支持 id 或模糊标题（在目标项目内解析）
      const resolvedDocIds = doc_ids?.map((ref) => resolveDocument(db, { documentId: ref, projectId: project.id }).id);
      const r = await generateDocument(db, {
        projectId: project.id,
        type: type as GenerateType,
        docIds: resolvedDocIds,
        title,
        includeChangelog: include_changelog,
        instruction,
      });
      // 生成文档本身也要向量化，才能被语义检索命中（失败不阻塞返回）
      const embedding = await embedAfterWrite(getDb(), r.document_id);
      return ok({ ...r, embedding });
    }));

  mcp.registerTool('list_related_documents', {
    title: '查询关联文档',
    description:
      '查询某文档的自动关联文档（向量语义相似度建立，双向）。'
      + '用于需求变更前检查影响面：改这篇文档时，哪些文档可能需要同步更新。'
      + 'document_id 传文档 id 或标题（标题支持模糊，可配合 project_id 消歧）。',
    inputSchema: {
      document_id: z.string().min(1).describe('文档 id 或标题（标题支持模糊）'),
      project_id: z.string().optional().describe('项目 id 或名称（可选，标题重名时消歧）'),
    },
  }, async ({ document_id, project_id }) => handle(async () => {
    const doc = resolveDocument(getDb(), { documentId: document_id, projectId: project_id });
    const links = listLinks(getDb(), doc.id);
    if (!links.length) {
      return ok({ document_id: doc.id, document_title: doc.title, related: [], note: '暂无自动关联文档（关联在文档向量化后自动建立）' });
    }
    return ok({
      document_id: doc.id,
      document_title: doc.title,
      related: links,
      note: `共 ${links.length} 篇关联文档；修改本文档时建议检查它们是否需要同步更新`,
    });
  }));
}

/** P5 Tool：沟通记录归档（一段文字 + 渠道元数据，复用分块/向量化/关联全管线） */
export function registerCommunicationTools(mcp: McpServer): void {
  mcp.registerTool('add_communication', {
    title: '归档沟通记录',
    description:
      '把一段客户/团队沟通记录归档进项目（聊天粘贴、邮件要点、会议纪要、OCR 提取的文字均可）。'
      + '记录会像普通文档一样被分块、向量化、自动关联需求文档，之后 search_documents 可检索到原文，'
      + 'generate_document(type=communication_summary) 可生成沟通纪要——需求变更时有据可查。'
      + '建议尽量提供 channel/parties/occurred_at 三要素。',
    inputSchema: {
      project_id: z.string().min(1).describe('项目 id 或项目名称（名称支持模糊）'),
      content: z.string().min(1).describe('沟通记录原文（一段话或对话记录）'),
      channel: z.string().optional().describe('沟通渠道：email / wechat / phone / meeting / ocr 等，默认 unknown'),
      parties: z.array(z.string()).optional().describe('参与方，如 ["客户张三", "我方项目经理"]'),
      occurred_at: z.string().optional().describe('沟通发生时间（ISO 8601 或可读格式），默认归档时刻'),
      title: z.string().optional().describe('记录标题，默认「沟通记录 <时间> <渠道>」'),
      related_document_ids: z.array(z.string()).optional()
        .describe('手动关联的需求/设计文档（id 或标题，标题支持模糊），可选；语义相关文档已自动关联'),
    },
  }, async ({ project_id, content, channel, parties, occurred_at, title, related_document_ids }) =>
    handle(async () => {
      const db = getDb();
      const project = resolveProject(db, project_id);
      const occurred = occurred_at?.trim() || new Date().toISOString();
      const docTitle = title?.trim()
        || `沟通记录 ${occurred.slice(0, 16).replace('T', ' ')} ${channel ?? ''}`.trim();
      const metadata: Record<string, unknown> = {
        channel: channel ?? 'unknown',
        parties: parties ?? [],
        occurred_at: occurred,
      };
      const r = addDocument(db, {
        projectId: project.id,
        title: docTitle,
        content,
        changeNote: `沟通记录归档（${metadata.channel}）`,
        sourceType: 'communication',
        createdBy: 'mcp',
        metadata,
      });
      const embedding = await embedAfterWrite(db, r.document_id);
      // 手动补链（依据链）；自动关联已在 embedAfterWrite 内建立。related 支持模糊标题
      const linked: string[] = [];
      for (const ref of related_document_ids ?? []) {
        try {
          const target = resolveDocument(db, { documentId: ref, projectId: project.id });
          linkDocuments(db, project.id, r.document_id, target.id, '沟通记录归档时手动关联');
          linked.push(target.title);
        } catch { /* 单个关联失败不阻塞归档 */ }
      }
      const related = relatedHint(db, r.document_id);
      return ok({ ...r, title: docTitle, metadata, linked_documents: linked, embedding, related });
    }));
}
