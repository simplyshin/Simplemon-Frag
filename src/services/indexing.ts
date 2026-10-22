import type { Db } from '../db/index.js';
import { addDocument, updateDocument } from './document.js';

/**
 * 项目文档索引生成（P1 朴素版，依赖注记 2：不依赖 LLM）。
 * 摘要 = 每篇文档正文首段截断；P2 接入 LLM 后升级为语义摘要。
 * 索引文档本身是一篇特殊文档（source_type=index），重建 = 追加新版本，
 * 复用既有的版本/分块/索引机制。
 */

const INDEX_TITLE = '《项目文档索引》';

function summarize(content: string, maxChars = 150): string {
  const body = content
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#')) // 去掉标题行，取正文
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
}

export function rebuildIndex(
  db: Db,
  projectId: string,
): { document_id: string; version_no: number; doc_count: number; action: 'created' | 'updated' } {
  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as
    | { id: string; name: string }
    | undefined;
  if (!project) throw new Error(`项目不存在: ${projectId}（可先调用 list_projects 获取）`);

  const docs = db.prepare(`
    SELECT d.id, d.title, d.source_type, v.version_no, v.content, d.updated_at
    FROM documents d
    JOIN document_versions v ON v.id = d.latest_version_id
    WHERE d.project_id = ? AND d.deleted_at IS NULL AND d.title != ?
    ORDER BY d.created_at
  `).all(projectId, INDEX_TITLE) as {
    id: string; title: string; source_type: string; version_no: number; content: string; updated_at: string;
  }[];

  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const sections = docs.map((d) =>
    `## ${d.title}（v${d.version_no}，更新于 ${d.updated_at.slice(0, 19).replace('T', ' ')}）\n\n摘要：${summarize(d.content)}`,
  );
  const content = [
    `# 项目文档索引 — ${project.name}`,
    '',
    `> 自动生成于 ${ts}，共 ${docs.length} 篇文档。变更后可通过 rebuild_index 重新生成。`,
    '',
    ...sections,
  ].join('\n');

  const existing = db.prepare(
    'SELECT id FROM documents WHERE project_id = ? AND title = ? AND deleted_at IS NULL',
  ).get(projectId, INDEX_TITLE) as { id: string } | undefined;

  if (existing) {
    const r = updateDocument(db, {
      documentId: existing.id,
      content,
      changeNote: `重建索引（${docs.length} 篇文档）`,
      createdBy: 'system',
    });
    return { document_id: r.document_id, version_no: r.version_no, doc_count: docs.length, action: 'updated' };
  }

  const r = addDocument(db, {
    projectId,
    title: INDEX_TITLE,
    content,
    changeNote: '首次生成索引',
    sourceType: 'index',
    createdBy: 'system',
  });
  return { document_id: r.document_id, version_no: r.version_no, doc_count: docs.length, action: 'created' };
}
