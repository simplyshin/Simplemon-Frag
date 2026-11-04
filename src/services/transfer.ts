import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from '../db/index.js';
import { DATA_DIR } from '../config/index.js';
import { hashContent } from './hash.js';
import { createProject } from './project.js';
import { resolveProject } from './resolve.js';
import { sanitizeFilename } from './export.js';
import { embedPendingChunks } from './embedding.js';
import { scheduleRebuild } from './indexing.js';
import { addDocument, setDocumentType, updateDocument } from './document.js';
import { findMergeableDocument, isDocType, type DocType } from './doc-classify.js';

/**
 * 项目资料导入导出（bundle）：
 * - 导出：项目全部文档（含全部历史版本正文与元数据）打包为单个 JSON 文件
 * - 导入：按 bundle 内项目名匹配已有项目合并（不存在则新建）；同名文档
 *   （精确 + 归一化标题）合并到已有文档；版本按内容 hash 去重后依次追加，
 *   保留原 change_note / created_by / created_at
 * - 排除 source_type='index'（《项目文档索引》为派生物，导入端自动重建）
 */

export const BUNDLE_FORMAT = 'frag-mcp-project-bundle' as const;

export interface BundleVersion {
  content: string;
  change_note: string;
  created_by: string;
  created_at: string;
}

export interface BundleDocument {
  title: string;
  source_type: string;
  doc_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
  versions: BundleVersion[];
}

export interface ProjectBundle {
  format: typeof BUNDLE_FORMAT;
  version: 1;
  exported_at: string;
  project: { name: string; description: string };
  documents: BundleDocument[];
}

export interface ImportStats {
  project_id: string;
  project_name: string;
  project_created: boolean;
  documents_created: number;
  documents_merged: number;
  versions_added: number;
  versions_skipped: number;
  warnings: string[];
}

/** source_type 白名单：原样保留；白名单外（含 index/未知）归一为 'import' */
const SOURCE_TYPE_WHITELIST = new Set([
  'web', 'mcp', 'file', 'email', 'chat', 'meeting', 'generated', 'communication',
]);

function normalizeSourceType(st: unknown): string {
  return typeof st === 'string' && SOURCE_TYPE_WHITELIST.has(st) ? st : 'import';
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

/** 版本排序：created_at 升序，非法时间排最后（稳定排序保持原相对顺序） */
function sortByCreatedAt(versions: BundleVersion[]): BundleVersion[] {
  const time = (v: BundleVersion): number => {
    const t = Date.parse(v.created_at);
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  return [...versions].sort((a, b) => time(a) - time(b));
}

// ---------- 导出 ----------

export function exportProjectBundle(db: Db, projectId: string, docIds?: string[]): ProjectBundle {
  const project = db.prepare(
    'SELECT id, name, description FROM projects WHERE id = ?',
  ).get(projectId) as { id: string; name: string; description: string } | undefined;
  if (!project) throw new Error(`项目不存在: ${projectId}`);

  // docIds 过滤：无效 id 直接忽略（不抛错）
  let ids: string[] | undefined;
  if (docIds && docIds.length) {
    const wanted = new Set(docIds.map((s) => s.trim()).filter(Boolean));
    const existing = (db.prepare(
      'SELECT id FROM documents WHERE project_id = ? AND deleted_at IS NULL AND source_type != \'index\'',
    ).all(projectId) as { id: string }[]).map((r) => r.id);
    ids = existing.filter((id) => wanted.has(id));
  }

  const where = ids !== undefined
    ? `project_id = ? AND deleted_at IS NULL AND source_type != 'index' AND id IN (${ids.map(() => '?').join(',') || 'NULL'})`
    : `project_id = ? AND deleted_at IS NULL AND source_type != 'index'`;
  const params = ids !== undefined ? [projectId, ...ids] : [projectId];

  const docRows = db.prepare(
    `SELECT id, title, source_type, doc_type, metadata, created_at FROM documents WHERE ${where} ORDER BY created_at`,
  ).all(...params) as { id: string; title: string; source_type: string; doc_type: string; metadata: string; created_at: string }[];

  const loadVersions = db.prepare(
    'SELECT content, change_note, created_by, created_at FROM document_versions WHERE document_id = ? ORDER BY version_no',
  );

  const documents: BundleDocument[] = docRows.map((d) => {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(d.metadata ?? '{}') as Record<string, unknown>;
    } catch { metadata = {}; }
    return {
      title: d.title,
      source_type: d.source_type,
      doc_type: d.doc_type,
      metadata,
      created_at: d.created_at,
      versions: (loadVersions.all(d.id) as { content: string; change_note: string; created_by: string; created_at: string }[])
        .map((v) => ({ content: v.content, change_note: v.change_note, created_by: v.created_by, created_at: v.created_at })),
    };
  });

  return {
    format: BUNDLE_FORMAT,
    version: 1,
    exported_at: new Date().toISOString(),
    project: { name: project.name, description: project.description },
    documents,
  };
}

/** bundle 落盘（服务端直写，同 exportDocument 方式）；缺省 data/exports/<项目名>-bundle.json */
export function saveProjectBundle(
  bundle: ProjectBundle,
  filePath?: string,
): { file_path: string; size_bytes: number; document_count: number; version_count: number } {
  const target = filePath?.trim() || join(DATA_DIR, 'exports', `${sanitizeFilename(bundle.project.name)}-bundle.json`);
  mkdirSync(dirname(target), { recursive: true });
  const json = JSON.stringify(bundle, null, 2);
  writeFileSync(target, json, 'utf-8');
  return {
    file_path: target,
    size_bytes: statSync(target).size,
    document_count: bundle.documents.length,
    version_count: bundle.documents.reduce((n, d) => n + d.versions.length, 0),
  };
}

// ---------- 导入 ----------

function resolveTargetProject(
  db: Db,
  bundle: ProjectBundle,
  targetProjectId?: string,
): { id: string; name: string; created: boolean } {
  if (targetProjectId) {
    const p = resolveProject(db, targetProjectId);
    return { id: p.id, name: p.name, created: false };
  }
  const existing = db.prepare('SELECT id, name FROM projects WHERE name = ?')
    .get(bundle.project.name) as { id: string; name: string } | undefined;
  if (existing) return { id: existing.id, name: existing.name, created: false };
  const p = createProject(db, bundle.project.name, bundle.project.description ?? '');
  return { id: p.id, name: p.name, created: true };
}

export function importProjectBundle(
  db: Db,
  raw: unknown,
  opts: { targetProjectId?: string } = {},
): ImportStats {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('bundle 格式非法：顶层必须是 JSON 对象');
  }
  const bundle = raw as Partial<ProjectBundle>;
  const projectName = typeof bundle.project?.name === 'string' ? bundle.project.name.trim() : '';
  if (!projectName) throw new Error('bundle 格式非法：缺少 project.name');

  const rawDocs = Array.isArray(bundle.documents) ? bundle.documents : [];

  // 预校验与归一化（事务外完成，事务内只做写入）
  const docs: { title: string; sourceType: string; docType?: DocType; metadata: Record<string, unknown>; createdAt?: string; versions: BundleVersion[] }[] = [];
  const preWarnings: string[] = [];
  rawDocs.forEach((d, idx) => {
    const label = `documents[${idx}]`;
    if (d === null || typeof d !== 'object') {
      preWarnings.push(`${label} 不是对象，已跳过`);
      return;
    }
    const doc = d as Partial<BundleDocument>;
    const title = typeof doc.title === 'string' ? doc.title.trim() : '';
    const versions = Array.isArray(doc.versions)
      ? (doc.versions as Partial<BundleVersion>[]).filter((v) => v !== null && typeof v === 'object')
      : [];
    if (!title) {
      preWarnings.push(`${label} 缺少有效 title，已跳过`);
      return;
    }
    if (!versions.length) {
      preWarnings.push(`文档「${title}」没有可用版本，已跳过`);
      return;
    }
    const valid: BundleVersion[] = [];
    versions.forEach((v, vi) => {
      const content = typeof v.content === 'string' ? v.content : '';
      if (!content.trim()) {
        preWarnings.push(`文档「${title}」第 ${vi + 1} 个版本内容为空，已跳过`);
        return;
      }
      valid.push({
        content,
        change_note: typeof v.change_note === 'string' ? v.change_note : '',
        created_by: typeof v.created_by === 'string' && v.created_by.trim() ? v.created_by : 'import',
        created_at: typeof v.created_at === 'string' && !Number.isNaN(Date.parse(v.created_at))
          ? new Date(v.created_at).toISOString()
          : '',
      });
    });
    if (!valid.length) {
      preWarnings.push(`文档「${title}」没有有效版本内容，已跳过`);
      return;
    }
    docs.push({
      title,
      sourceType: normalizeSourceType(doc.source_type),
      docType: isDocType(doc.doc_type) ? doc.doc_type : undefined,
      metadata: parseMetadata(doc.metadata),
      createdAt: typeof doc.created_at === 'string' && !Number.isNaN(Date.parse(doc.created_at))
        ? new Date(doc.created_at).toISOString()
        : undefined,
      versions: sortByCreatedAt(valid),
    });
  });

  const warnings = [...preWarnings];

  // 整个导入包在单个事务内（better-sqlite3 嵌套事务自动降级为 savepoint），
  // 任一硬错误整体回滚，warnings 中记录的软跳过不影响原子性
  const run = db.transaction((): ImportStats => {
    const target = resolveTargetProject(
      db,
      { format: BUNDLE_FORMAT, version: 1, exported_at: '', project: { name: projectName, description: bundle.project?.description ?? '' }, documents: [] },
      opts.targetProjectId,
    );
    const stats: ImportStats = {
      project_id: target.id,
      project_name: target.name,
      project_created: target.created,
      documents_created: 0,
      documents_merged: 0,
      versions_added: 0,
      versions_skipped: 0,
      warnings,
    };

    // 目标文档已有版本内容 hash 惰性缓存（追加后同步维护）
    const hashCache = new Map<string, Set<string>>();
    const loadHashes = (documentId: string): Set<string> => {
      let s = hashCache.get(documentId);
      if (!s) {
        s = new Set(
          (db.prepare('SELECT content FROM document_versions WHERE document_id = ?').all(documentId) as { content: string }[])
            .map((r) => hashContent(r.content)),
        );
        hashCache.set(documentId, s);
      }
      return s;
    };

    for (const doc of docs) {
      const existing = findMergeableDocument(db, target.id, doc.title);
      if (existing) {
        stats.documents_merged++;
        const hashes = loadHashes(existing.id);
        for (const v of doc.versions) {
          const h = hashContent(v.content);
          if (hashes.has(h)) {
            stats.versions_skipped++;
            continue;
          }
          updateDocument(db, {
            documentId: existing.id,
            content: v.content,
            changeNote: v.change_note,
            createdBy: v.created_by,
            createdAt: v.created_at || undefined,
          });
          hashes.add(h);
          stats.versions_added++;
        }
        // bundle 携带有效分类时覆盖（导入语义：以 bundle 元数据为准）
        if (doc.docType) setDocumentType(db, existing.id, doc.docType);
      } else {
        stats.documents_created++;
        const first = doc.versions[0];
        const r = addDocument(db, {
          projectId: target.id,
          title: doc.title,
          content: first.content,
          changeNote: first.change_note || '导入初始版本',
          sourceType: doc.sourceType,
          createdBy: first.created_by,
          metadata: doc.metadata,
          docType: doc.docType,
          mergeSameTitle: false, // 合并目标已判定过，关闭二次同名合并
        });
        const hashes = new Set<string>([hashContent(first.content)]);
        hashCache.set(r.document_id, hashes);
        stats.versions_added++;
        // addDocument 不支持 createdAt：回填 v1 的原始版本时间
        if (first.created_at) {
          db.prepare('UPDATE document_versions SET created_at = ? WHERE document_id = ? AND version_no = 1')
            .run(first.created_at, r.document_id);
        }
        for (const v of doc.versions.slice(1)) {
          const h = hashContent(v.content);
          if (hashes.has(h)) {
            stats.versions_skipped++;
            continue;
          }
          updateDocument(db, {
            documentId: r.document_id,
            content: v.content,
            changeNote: v.change_note,
            createdBy: v.created_by,
            createdAt: v.created_at || undefined,
          });
          hashes.add(h);
          stats.versions_added++;
        }
        // 恢复原始文档级时间：created_at=首版本时间，updated_at 收敛到末版本时间
        const firstTs = doc.versions[0].created_at;
        const lastTs = doc.versions[doc.versions.length - 1].created_at;
        if (firstTs) {
          db.prepare('UPDATE documents SET created_at = ?, updated_at = ? WHERE id = ?')
            .run(firstTs, lastTs || firstTs, r.document_id);
        }
      }
    }
    return stats;
  });

  return run();
}

/** 从本地文件读取并导入 bundle（MCP 工具用） */
export function importProjectBundleFromFile(
  db: Db,
  filePath: string,
  opts: { targetProjectId?: string } = {},
): ImportStats {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    throw new Error(`文件不是合法的 JSON: ${filePath}`);
  }
  return importProjectBundle(db, raw, opts);
}

/**
 * 导入后索引收尾（REST/MCP 共用）：一次全局补算导入文档的最新版 chunk 向量
 * （只覆盖最新版，检索层 JOIN latest_version_id），随后调度项目索引重建。
 * 失败降级为提示文本，不抛错（后台 retry loop 与 rebuild 兜底）。
 */
export async function postImportIndex(db: Db, projectId: string): Promise<string> {
  let embedding = '向量补算失败，剩余块将由后台定期补算';
  try {
    const r = await embedPendingChunks(db, { limit: 1_000_000 });
    embedding = `已向量化 ${r.embedded} 块` + (r.failed ? `（${r.failed} 块待后台重试）` : '');
  } catch (err) {
    embedding = `向量补算失败（${(err as Error).message}），剩余块将由后台定期补算`;
  }
  scheduleRebuild(db, projectId);
  return embedding;
}
