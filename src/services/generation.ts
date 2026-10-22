import type { Db } from '../db/index.js';
import { addDocument, updateDocument } from './document.js';
import { getLlm } from '../llm/registry.js';

const now = (): string => new Date().toISOString();

/**
 * generate_document（P4 核心）：从项目文档库聚合生成最新版
 * 功能文档 / 使用说明 / 需求文档，可附「变更记录」章节。
 *
 * 约定（方案 §文档生成与变更记录机制）：
 * - 范围：传入 doc_ids，未传则取项目内全部未删除文档（上限 20 篇）
 * - 生成结果写入 documents（source_type='generated'）：同名文档追加版本而非新建，
 *   天然获得版本机制 / 分块 / FTS / 向量检索 / Web 后台可见
 * - 同时写 snapshots 表留档（source_doc_ids 记录数据来源）
 * - LLM 未配置 key 时降级为「机械聚合」（结构化拼接原文段落），
 *   不阻塞快照与变更记录——这两项不需要 LLM
 * - 使用节奏：按需触发，不随每次文档变更自动重生成
 */

export type GenerateType = 'functional' | 'usage' | 'requirements' | 'communication_summary';

const TYPE_LABELS: Record<GenerateType, string> = {
  functional: '功能文档',
  usage: '使用说明',
  requirements: '需求文档',
  communication_summary: '沟通纪要',
};

const TYPE_PROMPTS: Record<GenerateType, string> = {
  functional:
    '生成一份「功能文档」，面向产品与研发，结构要求：1) 系统概述 2) 功能清单总表（模块/功能点/规则简述）'
    + ' 3) 按模块展开的功能行为说明。只描述资料中存在的功能，不要编造。',
  usage:
    '生成一份「使用说明」，面向最终用户，结构要求：1) 功能简介 2) 分场景操作步骤（步骤编号清晰）'
    + ' 3) 常见问题 FAQ。语言通俗，只写资料中提到的操作，不要编造入口或按钮。',
  requirements:
    '生成一份「需求文档」，面向需求管理，结构要求：1) 需求背景与目标 2) 功能需求列表（FR-编号、描述、优先级）'
    + ' 3) 非功能需求 4) 验收标准。规则与数值必须与资料一致，不要编造。',
  communication_summary:
    '生成一份「客户沟通纪要」，面向项目管理与争议追溯，结构要求：1) 沟通概况（时间范围、参与方、渠道）'
    + ' 2) 按时间线排列的沟通要点（每条标注日期/渠道/参与方与核心内容）'
    + ' 3) 需求变更与承诺事项清单（原文依据）。只汇总资料中的沟通内容，不要编造。',
};

const MAX_DOC_CHARS = 8000;  // 单篇文档喂给 LLM 的字符上限
const MAX_TOTAL_CHARS = 60_000;

export interface GenerateResult {
  document_id: string;
  title: string;
  version_no: number;
  chunk_count: number;
  vectors_reused: number;
  snapshot_id: number;
  generated_by: 'llm' | 'aggregate';
  /** true = 未配置 LLM key（或调用失败），已降级机械聚合 */
  degraded: boolean;
  /** 降级说明（degraded=true 时存在），提示配置 LLM 后可重新生成 */
  degraded_note?: string;
  source_doc_ids: string[];
}

/** 文档级变更记录（方案 §变更记录机制 起步粒度）：从 document_versions 汇总 */
export function buildChangelog(db: Db, docIds: string[], limit = 50): string {
  if (!docIds.length) return '';
  const placeholders = docIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT d.title, v.version_no, v.change_note, v.created_by, v.created_at
    FROM document_versions v
    JOIN documents d ON d.id = v.document_id
    WHERE v.document_id IN (${placeholders}) AND v.change_note != ''
    ORDER BY v.created_at DESC
    LIMIT ?
  `).all(...docIds, limit) as {
    title: string; version_no: number; change_note: string; created_by: string; created_at: string;
  }[];
  if (!rows.length) return '';

  const lines = [
    '## 变更记录',
    '',
    '| 日期 | 文档 | 版本 | 变更说明 | 操作方 |',
    '|---|---|---|---|---|',
    ...rows.map((r) =>
      `| ${r.created_at.slice(0, 10)} | ${r.title} | v${r.version_no} | ${r.change_note.replace(/\|/g, '\\|')} | ${r.created_by} |`),
  ];
  return lines.join('\n');
}

/** 无 LLM 时的机械聚合：结构化拼接各文档章节（沟通纪要按时间线排列） */
function aggregateContent(
  db: Db,
  type: GenerateType,
  docs: { title: string; content: string; occurredAt?: string; channel?: string; parties?: string }[],
): string {
  const note = [
    '> 未配置 LLM key，本文档由服务端直接聚合项目文档原文生成；',
    '> 配置 LLM Provider 后可重新生成以获得改写润色版本。',
  ];
  if (type === 'communication_summary') {
    const sorted = [...docs].sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? ''));
    return [
      `# ${TYPE_LABELS[type]}（机械聚合）`, '',
      ...note, '',
      '## 沟通时间线', '',
      ...sorted.flatMap((d) => {
        const head = [d.occurredAt, d.channel, d.parties].filter(Boolean).join(' · ') || d.title;
        return [`### ${head}`, '', d.content.trim(), ''];
      }),
    ].join('\n');
  }
  const header = [
    `# ${TYPE_LABELS[type]}（机械聚合）`, '',
    ...note, '',
  ].join('\n');
  const body = docs
    .map((d) => `## ${d.title}\n\n${d.content.replace(/^# .*\n/, '').trim()}`)
    .join('\n\n');
  return `${header}${body}`;
}

/** 有 LLM 时：模板 prompt 聚合改写 */
async function llmGenerate(
  db: Db,
  type: GenerateType,
  docs: { title: string; content: string; occurredAt?: string; channel?: string; parties?: string }[],
  instruction?: string,
): Promise<string | null> {
  const llm = getLlm();
  if (!llm) return null;

  let corpus = '';
  for (const d of docs) {
    const meta = [d.occurredAt, d.channel, d.parties].filter(Boolean).join(' · ');
    const piece = `=== 文档：${d.title}${meta ? `（${meta}）` : ''} ===\n${d.content.slice(0, MAX_DOC_CHARS)}`;
    if (corpus.length + piece.length > MAX_TOTAL_CHARS) break;
    corpus += (corpus ? '\n\n' : '') + piece;
  }
  const messages = [
    {
      role: 'system' as const,
      content: '你是资深文档工程师。只根据用户提供的项目资料聚合改写目标文档，'
        + '不得编造资料中不存在的功能、数值或规则。输出 Markdown 正文，不要额外解释。',
    },
    {
      role: 'user' as const,
      content: `${TYPE_PROMPTS[type]}\n${instruction ? `额外要求：${instruction}\n` : ''}\n项目资料如下：\n\n${corpus}`,
    },
  ];
  try {
    return await llm.chat(messages, { maxTokens: 4096, temperature: 0.3 });
  } catch (err) {
    console.error(`[generate] LLM 生成失败，降级机械聚合: ${(err as Error).message}`);
    return null;
  }
}

/** generate_document 主流程 */
export async function generateDocument(
  db: Db,
  input: {
    projectId: string;
    type: GenerateType;
    docIds?: string[];
    title?: string;
    includeChangelog?: boolean;
    instruction?: string;
  },
): Promise<GenerateResult> {
  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(input.projectId) as
    | { id: string; name: string }
    | undefined;
  if (!project) throw new Error(`项目不存在: ${input.projectId}`);

  // 1. 圈定范围
  let docIds = input.docIds?.length ? input.docIds : [];
  if (docIds.length) {
    const placeholders = docIds.map(() => '?').join(',');
    const valid = db.prepare(
      `SELECT id FROM documents WHERE id IN (${placeholders}) AND project_id = ? AND deleted_at IS NULL`,
    ).all(...docIds, input.projectId) as { id: string }[];
    if (valid.length !== docIds.length) throw new Error('部分 doc_ids 不属于该项目或已删除');
  } else {
    docIds = (db.prepare(
      'SELECT id FROM documents WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 20',
    ).all(input.projectId) as { id: string }[]).map((r) => r.id);
  }
  if (!docIds.length) throw new Error('项目内没有可用文档，无法生成');

  // 2. 收集最新版内容（含沟通元数据，供沟通纪要时间线与 LLM 上下文标注）
  const docs = docIds.map((id) => {
    const row = db.prepare(`
      SELECT d.id, d.title, d.metadata, v.content
      FROM documents d JOIN document_versions v ON v.id = d.latest_version_id
      WHERE d.id = ?
    `).get(id) as { id: string; title: string; metadata: string; content: string };
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>; } catch { /* 空即可 */ }
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      occurredAt: typeof meta.occurred_at === 'string' ? meta.occurred_at : '',
      channel: typeof meta.channel === 'string' ? meta.channel : '',
      parties: Array.isArray(meta.parties) ? meta.parties.join('、') : '',
    };
  });

  // 3. LLM 聚合改写（无 key / 失败 → 机械聚合）
  let generated = await llmGenerate(db, input.type, docs, input.instruction);
  const generatedBy: 'llm' | 'aggregate' = generated ? 'llm' : 'aggregate';
  const degraded = generatedBy === 'aggregate';
  generated ||= aggregateContent(db, input.type, docs);

  // 4. 变更记录章节（文档级）
  if (input.includeChangelog) {
    const changelog = buildChangelog(db, docIds);
    if (changelog) generated = `${generated.trimEnd()}\n\n---\n\n${changelog}\n`;
  }

  // 5. 写入文档库：同名 generated 文档追加版本，否则新建
  const title = input.title?.trim() || `${project.name} — ${TYPE_LABELS[input.type]}`;
  const existing = db.prepare(`
    SELECT id FROM documents
    WHERE project_id = ? AND title = ? AND source_type = 'generated' AND deleted_at IS NULL
    ORDER BY created_at LIMIT 1
  `).get(input.projectId, title) as { id: string } | undefined;

  let r: { document_id: string; version_no: number; chunk_count: number; vectors_reused: number };
  if (existing) {
    r = updateDocument(db, {
      documentId: existing.id,
      content: generated,
      changeNote: `重新生成（${generatedBy}，来源 ${docs.length} 篇文档）`,
      createdBy: 'system',
    });
  } else {
    const added = addDocument(db, {
      projectId: input.projectId,
      title,
      content: generated,
      changeNote: `首次生成（${generatedBy}，来源 ${docs.length} 篇文档）`,
      sourceType: 'generated',
      createdBy: 'system',
    });
    r = { ...added, vectors_reused: 0 };
  }

  // 6. snapshots 留档
  const maxNo = db.prepare(
    'SELECT MAX(version_no) AS no FROM snapshots WHERE project_id = ? AND type = ?',
  ).get(input.projectId, input.type) as { no: number | null };
  const snapshot = db.prepare(`
    INSERT INTO snapshots (project_id, version_no, title, type, content, source_doc_ids, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.projectId,
    (maxNo.no ?? 0) + 1,
    title,
    input.type,
    generated,
    JSON.stringify(docIds),
    now(),
  );

  return {
    document_id: r.document_id,
    title,
    version_no: r.version_no,
    chunk_count: r.chunk_count,
    vectors_reused: r.vectors_reused,
    snapshot_id: Number(snapshot.lastInsertRowid),
    generated_by: generatedBy,
    degraded,
    degraded_note: degraded
      ? '未配置 LLM key（或调用失败），本次为机械聚合（原文结构化拼接）。'
        + '可在 Web 后台设置页配置 LLM Provider 后重新生成，获得 AI 改写润色版本。'
      : undefined,
    source_doc_ids: docIds,
  };
}
