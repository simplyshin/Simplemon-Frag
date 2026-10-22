import type { Db } from '../db/index.js';
import { ensureVecTable } from '../db/vector.js';
import { getEmbedder } from '../llm/embedding/index.js';

/**
 * 混合检索服务（P2）：多路召回 → RRF 融合排序。
 *
 * 路径（依赖注记 3 的分层落地）：
 * - FTS5 trigram：长词（≥3 字符）关键词召回
 * - 向量：查询向量化后 KNN 召回（语义，容忍换说法）
 * - LIKE：短词（<3 字符）子串降级 / 全路无结果时的兜底
 *
 * 降级策略：embedding 任何环节失败（模型未就绪、API 报错、维度未知），
 * 向量路静默缺席，FTS/LIKE 照常返回——文档检索永不因向量化故障而不可用。
 */

export type HitSource = 'fts' | 'vector' | 'like';

export interface SearchHit {
  document_id: string;
  document_title: string;
  version_no: number;
  seq: number;
  heading_path: string;
  content: string;
  score: number;
  source: HitSource;
}

export interface SearchResult {
  query: string;
  total: number;
  hits: SearchHit[];
  meta: { vector: boolean };
}

interface RecallRow {
  id: number;
  document_id: string;
  document_title: string;
  version_no: number;
  seq: number;
  heading_path: string;
  content: string;
  score: number;
}

const BASE_JOIN = `
  FROM chunks c
  JOIN documents d ON d.id = c.document_id AND d.deleted_at IS NULL AND d.project_id = ?
  JOIN document_versions v ON v.id = c.version_id AND v.id = d.latest_version_id
`;

/** FTS5 召回：≥3 字符的词走 trigram 短语匹配，按 bm25 相关度排序 */
function recallFts(db: Db, projectId: string, phrases: string[], limit: number): RecallRow[] {
  const match = phrases.join(' '); // 空格分隔 = AND 语义
  try {
    return db.prepare(`
      SELECT c.id, c.document_id, d.title AS document_title, v.version_no,
             c.seq, c.heading_path, c.content,
             -bm25(chunks_fts) AS score
      ${BASE_JOIN}
      JOIN chunks_fts f ON f.rowid = c.id
      WHERE chunks_fts MATCH ?
      ORDER BY score DESC
      LIMIT ?
    `).all(projectId, match, limit) as RecallRow[];
  } catch {
    return []; // MATCH 语法异常时静默降级到 LIKE
  }
}

/** 向量 KNN 召回（sqlite-vec），仅最新版本的 chunk */
function recallVector(db: Db, projectId: string, queryVec: number[], limit: number): RecallRow[] {
  return db.prepare(`
    SELECT c.id, c.document_id, d.title AS document_title, v.version_no,
           c.seq, c.heading_path, c.content,
           vec.distance AS score
    FROM chunks_vec vec
    JOIN chunks c ON c.id = vec.chunk_id
    JOIN documents d ON d.id = c.document_id AND d.deleted_at IS NULL AND d.project_id = ?
    JOIN document_versions v ON v.id = c.version_id AND v.id = d.latest_version_id
    WHERE vec.embedding MATCH ? AND vec.k = ?
    ORDER BY vec.distance
  `).all(projectId, JSON.stringify(queryVec), limit) as RecallRow[];
}

/** LIKE 召回：短语/单字等 FTS 覆盖不了的短词，按出现次数计分 */
function recallLike(db: Db, projectId: string, terms: string[], limit: number): RecallRow[] {
  const rows: RecallRow[] = [];
  const seen = new Set<number>();
  for (const term of terms) {
    const escaped = term.replace(/[\\%_]/g, (m) => `\\${m}`);
    const hits = db.prepare(`
      SELECT c.id, c.document_id, d.title AS document_title, v.version_no,
             c.seq, c.heading_path, c.content,
             (length(c.content) - length(replace(c.content, ?, ''))) / length(?) AS score
      ${BASE_JOIN}
      WHERE c.content LIKE '%' || ? || '%' ESCAPE '\\'
      LIMIT ?
    `).all(term, term, projectId, escaped, limit) as RecallRow[];
    for (const hit of hits) {
      if (!seen.has(hit.id)) {
        seen.add(hit.id);
        rows.push(hit);
      }
    }
  }
  return rows;
}

/** RRF（Reciprocal Rank Fusion）：多路召回按排名融合，无需调权重 */
function rrfFuse(
  lists: { source: HitSource; rows: RecallRow[] }[],
  topK: number,
): SearchHit[] {
  const K = 60;
  const entries = new Map<number, { row: RecallRow; score: number; sources: Set<HitSource> }>();
  for (const list of lists) {
    list.rows.forEach((row, i) => {
      const entry = entries.get(row.id) ?? { row, score: 0, sources: new Set<HitSource>() };
      entry.score += 1 / (K + i + 1);
      entry.sources.add(list.source);
      entries.set(row.id, entry);
    });
  }
  return [...entries.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ row, score, sources }) => ({
      document_id: row.document_id,
      document_title: row.document_title,
      version_no: row.version_no,
      seq: row.seq,
      heading_path: row.heading_path,
      content: row.content,
      score: Math.round(score * 10_000) / 10_000,
      source: sources.has('vector') ? 'vector' : sources.has('fts') ? 'fts' : 'like',
    }));
}

/** 检索入口：多路召回 → RRF 融合 */
export async function searchDocuments(
  db: Db,
  input: { projectId: string; query: string; topK?: number },
): Promise<SearchResult> {
  const topK = Math.min(input.topK ?? 8, 50);
  const terms = input.query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) throw new Error('查询词不能为空');

  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId);
  if (!project) throw new Error(`项目不存在: ${input.projectId}（可先调用 list_projects 获取）`);

  const lists: { source: HitSource; rows: RecallRow[] }[] = [];
  let vectorAvailable = false;

  // 路 1：长词（≥3 字符）FTS5 trigram
  const longTerms = terms.filter((t) => t.length >= 3);
  if (longTerms.length) {
    const rows = recallFts(db, input.projectId, longTerms.map((t) => `"${t.replace(/"/g, '""')}"`), topK);
    if (rows.length) lists.push({ source: 'fts', rows });
  }

  // 路 2：向量语义召回。任何失败静默降级（失败原因打日志便于排查）
  try {
    const embedder = getEmbedder();
    const queryVec = await embedder.embedQuery(input.query);
    ensureVecTable(db, embedder.fingerprint, queryVec.length);
    const rows = recallVector(db, input.projectId, queryVec, 30);
    if (rows.length) lists.push({ source: 'vector', rows });
    vectorAvailable = true;
  } catch (err) {
    console.error(`[search] 向量召回不可用，已降级: ${(err as Error).message}`);
  }

  // 路 3：LIKE —— 短词降级；或全路无结果时全词兜底
  const shortTerms = terms.filter((t) => t.length < 3);
  const likeTerms = lists.length ? shortTerms : terms;
  if (likeTerms.length) {
    const rows = recallLike(db, input.projectId, likeTerms, topK);
    if (rows.length) lists.push({ source: 'like', rows });
  }

  if (!lists.length) {
    return { query: input.query, total: 0, hits: [], meta: { vector: vectorAvailable } };
  }
  const hits = rrfFuse(lists, topK);
  return { query: input.query, total: hits.length, hits, meta: { vector: vectorAvailable } };
}
