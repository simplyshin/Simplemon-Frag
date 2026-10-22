import type { Db } from '../db/index.js';
import { ensureVecTable } from '../db/vector.js';
import { getEmbedder } from '../llm/embedding/index.js';

/**
 * 向量化管线（P2 核心约定）：
 * - 增量：只有 chunks_vec 中没有记录的 chunk 才调 embedding（content_hash 复用在
 *   update_document 内部通过向量搬运实现，见 reuseVectorsByHash）
 * - 降级：embedding 失败不影响文档入库，失败 chunk 保持"待补算"状态
 *   （检索时向量路自动缺席，FTS5/LIKE 路照常工作）
 */

export interface EmbedResult {
  embedded: number;
  failed: number;
}

/** 待补算 chunk（仅最新版本的 chunk 参与检索，旧版本不补算）；向量表尚不存在时全部视为待补算 */
export function pendingChunks(
  db: Db,
  opts: { documentId?: string; limit?: number } = {},
): { id: number; content: string }[] {
  const vecTableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'",
  ).get();
  const notExistsClause = vecTableExists
    ? 'AND NOT EXISTS (SELECT 1 FROM chunks_vec vec WHERE vec.chunk_id = c.id)'
    : '';
  return db.prepare(`
    SELECT c.id, c.content
    FROM chunks c
    JOIN documents d ON d.id = c.document_id AND d.deleted_at IS NULL
    JOIN document_versions v ON v.id = c.version_id AND v.id = d.latest_version_id
    WHERE c.version_id = v.id
      ${notExistsClause}
      ${opts.documentId ? 'AND c.document_id = ?' : ''}
    LIMIT ?
  `).all(...(opts.documentId ? [opts.documentId] : []), opts.limit ?? 64) as { id: number; content: string }[];
}

export function pendingCount(db: Db): number {
  return pendingChunks(db, { limit: 1_000_000 }).length;
}

/**
 * 为待补算 chunk 生成向量。异常向上抛出（调用方决定降级策略）。
 * 首次调用会初始化 embedder（local 模型此时才下载/加载），
 * 并在指纹/维度变化时重建向量表。
 */
export async function embedPendingChunks(
  db: Db,
  opts: { documentId?: string; limit?: number } = {},
): Promise<EmbedResult> {
  const embedder = getEmbedder();
  // 指纹/维度检查必须先于待补算查询：模型切换后需先重建向量表，
  // 否则全部 chunk 带着旧模型向量"看起来已补算"，重建永远不会触发
  if (embedder.dim > 0) ensureVecTable(db, embedder.fingerprint, embedder.dim);

  const rows = pendingChunks(db, { documentId: opts.documentId, limit: opts.limit ?? 64 });
  if (!rows.length) return { embedded: 0, failed: 0 };

  // dim === -1（API 模型维度未知）时用首个 chunk 试算确定维度再建表
  if (embedder.dim === -1) {
    const probe = await embedder.embedPassages([rows[0].content]);
    embedder.dim = probe[0].length;
    ensureVecTable(db, embedder.fingerprint, embedder.dim);
  }

  const remaining = [...rows];
  let embedded = 0;
  let failed = 0;

  while (remaining.length) {
    const batch = remaining.splice(0, 32);
    try {
      const vectors = await embedder.embedPassages(batch.map((r) => r.content));
      // vec0 的 PK 列要求 INTEGER：better-sqlite3 默认把 JS number 绑成 REAL，必须用 BigInt
      const insert = db.prepare('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)');
      const insertAll = db.transaction(() => {
        for (let i = 0; i < batch.length; i++) {
          insert.run(BigInt(batch[i].id), JSON.stringify(vectors[i]));
        }
      });
      insertAll();
      embedded += batch.length;
    } catch (err) {
      failed += batch.length;
      console.error(`[embedding] 批量向量化失败（${batch.length} 块保持待补算）: ${(err as Error).message}`);
      break; // 连续失败大概率是 provider 层问题，留待下次重试
    }
  }
  return { embedded, failed };
}

/** 后台定期补算（服务启动时注册），静默容错 */
export function startPendingRetryLoop(db: Db, intervalMs = 5 * 60_000): void {
  const run = () => {
    embedPendingChunks(db, { limit: 256 }).catch(() => { /* 静默，下轮重试 */ });
  };
  setTimeout(run, 10_000); // 启动 10s 后先补一轮
  setInterval(run, intervalMs);
}

/**
 * 写入后内联补算（MCP tools 与 REST 路由共用）：成功返回提示文本，
 * 失败返回降级提示——不阻塞文档入库，剩余块由 retry loop 兜底。
 * 向量化成功后顺带重建文档自动关联（doc_links，P4 需求变更联动的数据基础）。
 */
export async function embedAfterWrite(db: Db, documentId: string): Promise<string> {
  try {
    const r = await embedPendingChunks(db, { documentId, limit: 64 });
    if (r.embedded > 0) {
      // 关联建立在向量之上；失败静默（不阻塞入库，下次写入会重建）
      try {
        const { autoLinkDocument } = await import('./links.js');
        autoLinkDocument(db, documentId);
      } catch { /* 关联失败不影响主流程 */ }
      return `已向量化 ${r.embedded} 块`;
    }
    return '内容未变化，向量已复用';
  } catch (err) {
    return `向量索引暂不可用（已降级为全文检索，稍后自动补算）: ${(err as Error).message}`;
  }
}
