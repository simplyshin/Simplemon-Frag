import type { Db } from '../db/index.js';

const now = (): string => new Date().toISOString();

/**
 * 文档自动关联（P4）：以「文档最新版本全部 chunk 向量的质心」代表文档语义，
 * 与同项目其他文档的质心算余弦相似度，超阈值写入 doc_links(type=auto)。
 * 需求变更联动：文档间建立了关联，update_document 返回 related 提示，
 * AI/人工改文档时会收到"检查关联文档是否需要同步"的提醒。
 */

export interface DocLink {
  source_id: string;
  target_id: string;
  type: string;
  score: number;
  reason: string;
}

/** chunks_vec 的 embedding 读出为 float32 BLOB（sqlite-vec 存储格式）或 JSON 文本，统一解析为 number[] */
function parseEmbedding(raw: unknown): number[] {
  if (typeof raw === 'string') return JSON.parse(raw) as number[];
  const buf = raw as Buffer;
  const out: number[] = new Array(Math.floor(buf.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

const normalize = (v: number[]): number[] => {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
};

const cosine = (a: number[], b: number[]): number =>
  a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

/** 向量缓存：rebuildProjectLinks 批量重建时避免反复读同一文档的向量 */
type VecCache = Map<string, number[][]>;

/** 文档最新版本全部 chunk 向量（逐条归一化）；无向量返回空数组 */
function docVectors(db: Db, documentId: string, cache?: VecCache): number[][] {
  const hit = cache?.get(documentId);
  if (hit) return hit;
  const rows = db.prepare(`
    SELECT vec.embedding AS embedding
    FROM chunks_vec vec
    JOIN chunks c ON c.id = vec.chunk_id
    JOIN documents d ON d.id = c.document_id
    WHERE c.document_id = ? AND c.version_id = d.latest_version_id AND d.deleted_at IS NULL
  `).all(documentId) as { embedding: unknown }[];
  const vecs = rows.map((r) => normalize(parseEmbedding(r.embedding)));
  if (cache) cache.set(documentId, vecs);
  return vecs;
}

/** 归一化向量组的质心 */
function centroidOf(vecs: number[][]): number[] {
  const c = new Array<number>(vecs[0].length).fill(0);
  for (const v of vecs) for (let i = 0; i < c.length; i++) c[i] += v[i];
  return normalize(c);
}

/**
 * 建立自动关联：与同项目其他文档两两比对，写 doc_links（幂等，覆盖旧 auto 关联）。
 * 评分 = 质心相似度 × 0.5 + 最大段落相似度 × 0.5：
 * 同领域项目（如全部为某设备的文档）质心普遍 0.9+ 已饱和（接近随机排名），
 * 最大段落相似度能区分「具体主题重叠」，组合后排名更符合人工判断。
 */
export function autoLinkDocument(
  db: Db,
  documentId: string,
  opts: { threshold?: number; topK?: number; cache?: VecCache } = {},
): DocLink[] {
  const threshold = opts.threshold ?? 0.5;
  const topK = opts.topK ?? 5;
  const cache = opts.cache;

  const self = db.prepare('SELECT id, project_id FROM documents WHERE id = ? AND deleted_at IS NULL')
    .get(documentId) as { id: string; project_id: string } | undefined;
  if (!self) return [];

  const selfVecs = docVectors(db, documentId, cache);
  if (!selfVecs.length) return [];
  const selfCentroid = centroidOf(selfVecs);
  // 控制最大段落比对的计算量（O(块²)）
  const selfSample = selfVecs.slice(0, 40);

  const candidates = (db.prepare(`
    SELECT id FROM documents
    WHERE project_id = ? AND id != ? AND deleted_at IS NULL
  `).all(self.project_id, documentId) as { id: string }[]);

  const scored: { id: string; score: number; cScore: number; maxChunk: number }[] = [];
  for (const c of candidates) {
    const vecs = docVectors(db, c.id, cache);
    if (!vecs.length) continue;
    const cScore = cosine(selfCentroid, centroidOf(vecs));
    let maxChunk = 0;
    for (const a of selfSample) {
      for (const b of vecs.slice(0, 40)) {
        const s = cosine(a, b);
        if (s > maxChunk) maxChunk = s;
      }
    }
    const score = cScore * 0.5 + maxChunk * 0.5;
    if (score >= threshold) scored.push({ id: c.id, score, cScore, maxChunk });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK);

  const insert = db.prepare(`
    INSERT INTO doc_links (project_id, source_id, target_id, type, score, reason, created_at)
    VALUES (?, ?, ?, 'auto', ?, ?, ?)
    ON CONFLICT(source_id, target_id, type)
    DO UPDATE SET score = excluded.score, reason = excluded.reason, created_at = excluded.created_at
  `);
  const writeAll = db.transaction(() => {
    for (const t of top) {
      insert.run(self.project_id, documentId, t.id, t.score,
        `质心 ${t.cScore.toFixed(2)} / 段落 ${t.maxChunk.toFixed(2)}`, now());
    }
  });
  writeAll();

  return top.map((t) => ({
    source_id: documentId,
    target_id: t.id,
    type: 'auto',
    score: t.score,
    reason: `质心 ${t.cScore.toFixed(2)} / 段落 ${t.maxChunk.toFixed(2)}`,
  }));
}

/**
 * 项目级重建自动关联（Web 后台拓扑页「重建关联」）：
 * 对项目内每篇有向量的文档重跑 autoLinkDocument（共享向量缓存）。
 * 背景：auto 关联历史上只在文档写入时对单篇触发，早期导入的文档从未互相比较。
 */
export function rebuildProjectLinks(
  db: Db,
  projectId: string,
  opts: { threshold?: number; topK?: number } = {},
): { rebuilt: number; links: number } {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new Error(`项目不存在: ${projectId}（可先调用 list_projects 获取）`);

  const docs = db.prepare(
    'SELECT id FROM documents WHERE project_id = ? AND deleted_at IS NULL',
  ).all(projectId) as { id: string }[];

  const cache: VecCache = new Map();
  let links = 0;
  for (const d of docs) {
    links += autoLinkDocument(db, d.id, { ...opts, cache }).length;
  }
  return { rebuilt: docs.length, links };
}

export interface RelatedDoc {
  document_id: string;
  title: string;
  score: number;
  reason: string;
}

/** 双向关联查询（含文档标题），供 MCP/REST/Web 使用 */
export function listLinks(db: Db, documentId: string): RelatedDoc[] {
  const rows = db.prepare(`
    SELECT l.source_id, l.target_id, l.score, l.reason,
           CASE WHEN l.source_id = ? THEN l.target_id ELSE l.source_id END AS other_id
    FROM doc_links l
    JOIN documents s ON s.id = l.source_id AND s.deleted_at IS NULL
    JOIN documents t ON t.id = l.target_id AND t.deleted_at IS NULL
    WHERE l.source_id = ? OR l.target_id = ?
    ORDER BY l.score DESC
  `).all(documentId, documentId, documentId) as {
    other_id: string; score: number; reason: string;
  }[];

  const titleStmt = db.prepare('SELECT title FROM documents WHERE id = ?');
  // 去重：A→B 与 B→A 可能同时存在（双方各自 autoLink 建立），同一文档只保留最高分
  const best = new Map<string, { document_id: string; title: string; score: number; reason: string }>();
  for (const r of rows) {
    const item = {
      document_id: r.other_id,
      title: (titleStmt.get(r.other_id) as { title: string } | undefined)?.title ?? '',
      score: r.score,
      reason: r.reason,
    };
    const prev = best.get(r.other_id);
    if (!prev || item.score > prev.score) best.set(r.other_id, item);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/** 手动建立关联（P5 沟通记录 ↔ 需求文档依据链）；已存在时忽略 */
export function linkDocuments(
  db: Db,
  projectId: string,
  sourceId: string,
  targetId: string,
  reason = '手动指定关联',
): { source_id: string; target_id: string; type: string } {
  const exists = db.prepare('SELECT id FROM documents WHERE id IN (?, ?) AND deleted_at IS NULL')
    .all(sourceId, targetId) as { id: string }[];
  if (exists.length < 2) throw new Error('关联失败：源或目标文档不存在/已删除');
  db.prepare(`
    INSERT INTO doc_links (project_id, source_id, target_id, type, score, reason, created_at)
    VALUES (?, ?, ?, 'manual', 1, ?, ?)
    ON CONFLICT(source_id, target_id, type) DO NOTHING
  `).run(projectId, sourceId, targetId, reason, now());
  return { source_id: sourceId, target_id: targetId, type: 'manual' };
}

// ---------- 项目关联拓扑（Web 后台可视化） ----------

export interface GraphNode {
  id: string;
  title: string;
  source_type: string;
  version_no: number;
  updated_at: string;
  /** 关联边数（含双向），用于节点大小渲染 */
  link_count: number;
}

export interface GraphEdge {
  source_id: string;
  target_id: string;
  type: string;
  score: number;
  reason: string;
}

/** 项目内全部未删除文档节点 + 关联边（双向去重：同一对文档只保留最高分一条） */
export function projectGraph(db: Db, projectId: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new Error(`项目不存在: ${projectId}（可先调用 list_projects 获取）`);

  const nodes = db.prepare(`
    SELECT d.id, d.title, d.source_type, d.updated_at,
           COALESCE(v.version_no, 1) AS version_no,
           (SELECT COUNT(*) FROM doc_links l
            WHERE (l.source_id = d.id OR l.target_id = d.id)
              AND l.source_id IN (SELECT id FROM documents WHERE deleted_at IS NULL)
              AND l.target_id IN (SELECT id FROM documents WHERE deleted_at IS NULL)) AS link_count
    FROM documents d
    LEFT JOIN document_versions v ON v.id = d.latest_version_id
    WHERE d.project_id = ? AND d.deleted_at IS NULL
    ORDER BY d.created_at
  `).all(projectId) as GraphNode[];

  // 双向去重：A→B 与 B→A 同一对文档保留分数更高的一条（auto 覆盖顺序按 score）
  const rows = db.prepare(`
    SELECT l.source_id, l.target_id, l.type, l.score, l.reason
    FROM doc_links l
    JOIN documents s ON s.id = l.source_id AND s.deleted_at IS NULL
    JOIN documents t ON t.id = l.target_id AND t.deleted_at IS NULL
    WHERE l.project_id = ?
  `).all(projectId) as GraphEdge[];

  const best = new Map<string, GraphEdge>();
  for (const e of rows) {
    const key = e.source_id < e.target_id ? `${e.source_id}|${e.target_id}` : `${e.target_id}|${e.source_id}`;
    const prev = best.get(key);
    if (!prev || e.score > prev.score) best.set(key, e);
  }
  return { nodes, edges: [...best.values()].sort((a, b) => b.score - a.score) };
}

/** 写入后的关联提示（MCP/REST 返回体附带）：提示 AI 检查关联文档是否需要同步 */
export function relatedHint(db: Db, documentId: string): { docs: RelatedDoc[]; note: string } {
  const docs = listLinks(db, documentId).slice(0, 3);
  return {
    docs,
    note: docs.length
      ? `本文档已自动关联 ${docs.map((d) => `「${d.title}」`).join('、')}；若本次变更涉及需求/行为调整，请检查关联文档是否需要同步更新。`
      : '',
  };
}
