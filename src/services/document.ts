import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Db } from '../db/index.js';
import { chunkContent } from './chunk.js';
import { hashContent } from './hash.js';

const now = (): string => new Date().toISOString();

// pdfjs-dist（pdf-parse 依赖）在 Node 环境缺少浏览器全局对象（DOMMatrix/Path2D/ImageData），
// 解析含图形操作的 PDF 时会抛 "DOMMatrix is not defined"。纯文本提取只需空实现占位，
// 必须在首次动态 import('pdf-parse') 之前挂到 globalThis。
const pdfGlobals: Record<string, unknown> = {
  DOMMatrix: class DOMMatrix {},
  Path2D: class Path2D {},
  ImageData: class ImageData {},
};
for (const [name, impl] of Object.entries(pdfGlobals)) {
  if (typeof (globalThis as Record<string, unknown>)[name] === 'undefined') {
    (globalThis as Record<string, unknown>)[name] = impl;
  }
}

/**
 * 读取本地文档文件为纯文本（P2 解析增强）：
 * .docx → mammoth 提取正文；.pdf → pdf-parse 提取文本；其余按 utf-8 文本。
 */
export async function readDocumentFile(filePath: string): Promise<string> {
  const ext = filePath.toLowerCase().split('.').pop();
  if (ext === 'docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }
  if (ext === 'pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ url: filePath });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy().catch(() => { /* 忽略释放失败 */ });
    }
  }
  return readFileSync(filePath, 'utf-8');
}

/**
 * 解析上传文件的内存 buffer（P3 Web 后台 multipart 上传用）：
 * 按 .docx / .pdf / 纯文本 分流，与 readDocumentFile 同等解析能力。
 */
export async function parseDocumentBuffer(filename: string, buffer: Buffer): Promise<string> {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (ext === 'pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy().catch(() => { /* 忽略释放失败 */ });
    }
  }
  return buffer.toString('utf-8');
}

export interface DocumentSummary {
  id: string;
  project_id: string;
  title: string;
  source_type: string;
  version_no: number;
  updated_at: string;
}

export interface DocumentFull extends DocumentSummary {
  content: string;
  change_note: string;
  heading_paths: string[];
  /** 沟通元数据等扩展信息（P5），documents.metadata 的 JSON 解析结果 */
  metadata: Record<string, unknown>;
}

/** 大纲条目：由 chunks.heading_path（"A > B > C"）拆解 */
export interface OutlineItem {
  /** 层级，从 1 开始 */
  level: number;
  /** 当前层级标题 */
  title: string;
  /** 完整标题路径（原文 heading_path） */
  path: string;
}

/** outline 模式返回：只给标题树与总长度，不返回正文（大文档省 token） */
export interface DocumentOutline {
  id: string;
  project_id: string;
  title: string;
  source_type: string;
  version_no: number;
  updated_at: string;
  outline: OutlineItem[];
  total_length: number;
  content_omitted: true;
}

/** offset/limit 分页模式返回：content 为切片，附分页元信息 */
export interface DocumentPaged extends DocumentFull {
  total_length: number;
  offset: number;
  limit: number | null;
  truncated: boolean;
}

interface DocumentRow {
  id: string;
  project_id: string;
  title: string;
  source_type: string;
  latest_version_id: string | null;
  deleted_at: string | null;
  updated_at: string;
}

/** 写入 chunks（调用方需处于事务中），FTS 由触发器自动同步；返回内容草稿与生成的行 id */
function insertChunks(
  db: Db,
  documentId: string,
  versionId: string,
  content: string,
): { drafts: ReturnType<typeof chunkContent>; ids: number[] } {
  const drafts = chunkContent(content);
  const ids: number[] = [];
  const stmt = db.prepare(
    'INSERT INTO chunks (document_id, version_id, seq, heading_path, content, token_count, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const d of drafts) {
    const info = stmt.run(documentId, versionId, d.seq, d.headingPath, d.content, d.tokenCount, d.contentHash);
    ids.push(Number(info.lastInsertRowid));
  }
  return { drafts, ids };
}

export function addDocument(
  db: Db,
  input: {
    projectId: string;
    title: string;
    content?: string;
    filePath?: string;
    changeNote?: string;
    sourceType?: string;
    createdBy?: string;
    /** 沟通元数据等扩展信息（P5），JSON 序列化存 documents.metadata */
    metadata?: Record<string, unknown>;
  },
): { document_id: string; version_no: number; chunk_count: number; duplicates: { id: string; title: string }[] } {
  const content = input.filePath ? readFileSync(input.filePath, 'utf-8') : input.content;
  if (!content?.trim()) throw new Error('content 与 file_path 至少提供一个且不能为空');

  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId);
  if (!project) throw new Error(`项目不存在: ${input.projectId}（可先调用 list_projects 获取）`);

  // 重复导入检测（不阻断）：与项目内未删除文档的最新版本内容做全文档哈希比对
  const contentHash = hashContent(content);
  const duplicates = db.prepare(`
    SELECT id, title FROM documents
    WHERE project_id = ? AND content_hash = ? AND deleted_at IS NULL
    ORDER BY created_at
  `).all(input.projectId, contentHash) as { id: string; title: string }[];

  const docId = randomUUID();
  const versionId = randomUUID();
  const ts = now();

  const result = db.transaction(() => {
    db.prepare(
      'INSERT INTO documents (id, project_id, title, source_type, metadata, content_hash, latest_version_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
    ).run(
      docId,
      input.projectId,
      input.title.trim(),
      input.sourceType ?? 'mcp',
      input.metadata ? JSON.stringify(input.metadata) : '{}',
      contentHash,
      ts,
      ts,
    );
    db.prepare(
      'INSERT INTO document_versions (id, document_id, version_no, content, change_note, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)',
    ).run(versionId, docId, content, input.changeNote ?? '初始版本', input.createdBy ?? 'mcp', ts);
    const { ids } = insertChunks(db, docId, versionId, content);
    db.prepare('UPDATE documents SET latest_version_id = ? WHERE id = ?').run(versionId, docId);
    return ids.length;
  })();

  return { document_id: docId, version_no: 1, chunk_count: result, duplicates };
}

export function updateDocument(
  db: Db,
  input: { documentId: string; content: string; changeNote?: string; createdBy?: string },
): { document_id: string; version_no: number; chunk_count: number; vectors_reused: number } {
  if (!input.content?.trim()) throw new Error('content 不能为空');

  const doc = db.prepare(
    'SELECT id, latest_version_id FROM documents WHERE id = ? AND deleted_at IS NULL',
  ).get(input.documentId) as { id: string; latest_version_id: string } | undefined;
  if (!doc) throw new Error(`文档不存在或已删除: ${input.documentId}`);

  const maxNo = db.prepare(
    'SELECT MAX(version_no) AS no FROM document_versions WHERE document_id = ?',
  ).get(input.documentId) as { no: number };
  const versionNo = (maxNo.no ?? 0) + 1;
  const versionId = randomUUID();
  const ts = now();
  let reuseCount = 0;

  const chunkCount = db.transaction(() => {
    db.prepare(
      'INSERT INTO document_versions (id, document_id, version_no, content, change_note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(versionId, doc.id, versionNo, input.content, input.changeNote ?? '', input.createdBy ?? 'mcp', ts);

    // 增量向量化（P2 核心约定）：先搬运可复用向量（content_hash 相同 → 内容相同 → 向量有效），
    // 再清理本文档的全部旧向量行，避免 rowid 复用导致新内容命中旧向量
    const vecTableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'",
    ).get();
    const reuseMap = new Map<string, unknown>();
    if (vecTableExists) {
      const oldVectors = db.prepare(
        'SELECT c.content_hash AS hash, vec.embedding AS embedding FROM chunks c JOIN chunks_vec vec ON vec.chunk_id = c.id WHERE c.document_id = ?',
      ).all(doc.id) as { hash: string; embedding: unknown }[];
      for (const r of oldVectors) reuseMap.set(r.hash, r.embedding);
      db.prepare('DELETE FROM chunks_vec WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(doc.id);
    }

    // 旧版本 chunks 保留（chunks 挂 version_id，段落级溯源需要历史版本的
    // content_hash/heading_path）；检索层 JOIN latest_version_id 已确保
    // 只有最新版本的 chunk 参与 FTS/向量召回，保留不产生数据泄漏。
    // 仅清理旧版本向量行（向量只为最新版本保留，复用逻辑见上）。
    const { drafts, ids } = insertChunks(db, doc.id, versionId, input.content);

    let reused = 0;
    if (vecTableExists && reuseMap.size) {
      // 同 embedding.ts：PK 列必须 INTEGER 绑定（BigInt）
      const insertVec = db.prepare('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)');
      for (let i = 0; i < drafts.length; i++) {
        const vec = reuseMap.get(drafts[i].contentHash);
        if (vec !== undefined) {
          insertVec.run(BigInt(ids[i]), vec);
          reused++;
        }
      }
    }
    reuseCount = reused;

    db.prepare('UPDATE documents SET latest_version_id = ?, updated_at = ?, content_hash = ? WHERE id = ?')
      .run(versionId, ts, hashContent(input.content), doc.id);
    return drafts.length;
  })();

  return { document_id: doc.id, version_no: versionNo, chunk_count: chunkCount, vectors_reused: reuseCount };
}

function resolveDocument(
  db: Db,
  ref: { documentId?: string; projectId?: string; title?: string },
): DocumentRow {
  let row: DocumentRow | undefined;
  if (ref.documentId) {
    row = db.prepare(
      'SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL',
    ).get(ref.documentId) as DocumentRow | undefined;
  } else if (ref.projectId && ref.title) {
    row = db.prepare(
      'SELECT * FROM documents WHERE project_id = ? AND title = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1',
    ).get(ref.projectId, ref.title) as DocumentRow | undefined;
  }
  if (!row) {
    throw new Error('文档不存在或已删除：请提供 document_id，或 project_id + title（可先 list_documents / list_projects 查询）');
  }
  return row;
}

export function getDocument(
  db: Db,
  ref: {
    documentId?: string;
    projectId?: string;
    title?: string;
    version?: number;
    /** 只返回标题大纲（基于 chunks.heading_path），不返回正文 */
    outline?: boolean;
    /** 正文分页：起始字符偏移（默认 0） */
    offset?: number;
    /** 正文分页：本次返回的字符数上限（不传返回全部） */
    limit?: number;
  },
): DocumentFull | DocumentOutline | DocumentPaged {
  const doc = resolveDocument(db, ref);

  const version = ref.version
    ? db.prepare(
        'SELECT id, version_no, content, change_note FROM document_versions WHERE document_id = ? AND version_no = ?',
      ).get(doc.id, ref.version) as { id: string; version_no: number; content: string; change_note: string } | undefined
    : db.prepare(
        'SELECT id, version_no, content, change_note FROM document_versions WHERE id = ?',
      ).get(doc.latest_version_id) as { id: string; version_no: number; content: string; change_note: string } | undefined;

  if (!version) {
    throw new Error(`版本不存在: v${ref.version}（文档「${doc.title}」）`);
  }

  const headingPaths = (db.prepare(
    "SELECT DISTINCT heading_path FROM chunks WHERE version_id = ? AND heading_path != '' ORDER BY seq",
  ).all(version.id) as { heading_path: string }[]).map((r) => r.heading_path);

  const summary = {
    id: doc.id,
    project_id: doc.project_id,
    title: doc.title,
    source_type: doc.source_type,
    version_no: version.version_no,
    updated_at: doc.updated_at,
  };

  // 大纲模式：只返回标题树，正文以 total_length 告知（配合 offset/limit 按需读取）
  if (ref.outline) {
    const outline: OutlineItem[] = [];
    const seen = new Set<string>();
    for (const path of headingPaths) {
      if (seen.has(path)) continue;
      seen.add(path);
      const parts = path.split(' > ').filter(Boolean);
      outline.push({ level: parts.length, title: parts[parts.length - 1] ?? path, path });
    }
    return { ...summary, outline, total_length: version.content.length, content_omitted: true };
  }

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse((doc as { metadata?: string }).metadata ?? '{}') as Record<string, unknown>;
  } catch { metadata = {}; }

  const base: DocumentFull = {
    ...summary,
    content: version.content,
    change_note: version.change_note,
    heading_paths: headingPaths,
    metadata,
  };

  // 分页模式：按字符切片（不传 offset/limit 时行为与旧版完全一致）
  if (ref.offset !== undefined || ref.limit !== undefined) {
    const offset = Math.max(0, ref.offset ?? 0);
    const limit = ref.limit !== undefined ? Math.max(0, ref.limit) : null;
    const content = limit === null
      ? base.content.slice(offset)
      : base.content.slice(offset, offset + limit);
    return {
      ...base,
      content,
      total_length: base.content.length,
      offset,
      limit,
      truncated: offset + content.length < base.content.length,
    };
  }

  return base;
}

export function listDocuments(db: Db, projectId: string): DocumentSummary[] {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new Error(`项目不存在: ${projectId}（可先调用 list_projects 获取）`);

  return db.prepare(`
    SELECT d.id, d.project_id, d.title, d.source_type,
           v.version_no AS version_no, d.updated_at
    FROM documents d
    LEFT JOIN document_versions v ON v.id = d.latest_version_id
    WHERE d.project_id = ? AND d.deleted_at IS NULL
    ORDER BY d.created_at
  `).all(projectId) as DocumentSummary[];
}

export function deleteDocument(db: Db, documentId: string): { document_id: string; deleted: boolean } {
  const result = db.prepare(
    'UPDATE documents SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
  ).run(now(), documentId);
  if (result.changes === 0) {
    throw new Error(`文档不存在或已删除: ${documentId}`);
  }
  return { document_id: documentId, deleted: true };
}

export interface VersionSummary {
  version_no: number;
  change_note: string;
  created_by: string;
  created_at: string;
}

/** 版本历史列表（P3 Web 后台版本对比页用），新版本在前 */
export function listVersions(db: Db, documentId: string): VersionSummary[] {
  const doc = resolveDocument(db, { documentId });
  return db.prepare(`
    SELECT version_no, change_note, created_by, created_at
    FROM document_versions WHERE document_id = ?
    ORDER BY version_no DESC
  `).all(doc.id) as VersionSummary[];
}

// ---------- 段落级溯源（P4 增强） ----------

export interface TraceBlock {
  seq: number;
  heading_path: string;
  content: string;
  /** unchanged: 两版内容一致；changed: 同章节但内容变了；added: 新版新增段落 */
  status: 'unchanged' | 'changed' | 'added';
  /** changed/added 时，段落首次出现的版本号 */
  since_version: number;
}

export interface TraceResult {
  document_id: string;
  from_version: number;
  to_version: number;
  summary: { unchanged: number; changed: number; added: number };
  blocks: TraceBlock[];
}

/**
 * 相邻/任意两版本的块级溯源：以 content_hash 判定段落沿用，
 * 以 heading_path 判定「改写」还是「新增」，标注每个段落首次出现的版本。
 */
export function traceVersions(
  db: Db,
  documentId: string,
  fromVersion: number,
  toVersion: number,
): TraceResult {
  const doc = resolveDocument(db, { documentId });
  const load = (version: number) => {
    const v = db.prepare(
      'SELECT id, version_no FROM document_versions WHERE document_id = ? AND version_no = ?',
    ).get(doc.id, version) as { id: string; version_no: number } | undefined;
    if (!v) throw new Error(`版本不存在: v${version}（文档「${doc.title}」）`);
    return db.prepare(
      'SELECT seq, heading_path, content, content_hash FROM chunks WHERE version_id = ? ORDER BY seq',
    ).all(v.id) as { seq: number; heading_path: string; content: string; content_hash: string }[];
  };

  const fromBlocks = load(fromVersion);
  const toBlocks = load(toVersion);
  const fromHashes = new Set(fromBlocks.map((b) => b.content_hash));
  const fromHeadings = new Set(fromBlocks.map((b) => b.heading_path).filter(Boolean));

  const blocks: TraceBlock[] = toBlocks.map((b, idx) => {
    if (fromHashes.has(b.content_hash)) {
      return { seq: b.seq, heading_path: b.heading_path, content: b.content, status: 'unchanged', since_version: fromVersion };
    }
    // 改写判定：同章节（heading 相同）或同位置（heading 为空的顶层段，seq 未越界）
    const sameHeading = !!b.heading_path && fromHeadings.has(b.heading_path);
    const samePosition = !b.heading_path && idx < fromBlocks.length;
    return {
      seq: b.seq,
      heading_path: b.heading_path,
      content: b.content,
      status: sameHeading || samePosition ? 'changed' : 'added',
      since_version: toVersion,
    };
  });

  return {
    document_id: doc.id,
    from_version: fromVersion,
    to_version: toVersion,
    summary: {
      unchanged: blocks.filter((b) => b.status === 'unchanged').length,
      changed: blocks.filter((b) => b.status === 'changed').length,
      added: blocks.filter((b) => b.status === 'added').length,
    },
    blocks,
  };
}
