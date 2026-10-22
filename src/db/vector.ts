import * as sqliteVec from 'sqlite-vec';
import type { Db } from './index.js';

/**
 * chunks_vec 向量虚拟表管理（sqlite-vec）。
 * 维度由 embedding 模型决定，切换模型（指纹变化）时必须重建：
 * DROP 后 CREATE，所有旧向量作废，全部 chunk 进入待补算状态。
 */

const loadedDbs = new WeakSet<Db>();

/** 惰性加载 sqlite-vec 扩展（幂等） */
export function ensureVecExtension(db: Db): void {
  if (loadedDbs.has(db)) return;
  sqliteVec.load(db);
  loadedDbs.add(db);
}

export function getEmbeddingMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM embedding_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setEmbeddingMeta(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO embedding_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export interface VecTableState {
  /** true = 发生过重建（指纹/维度变化），旧向量全部作废 */
  rebuilt: boolean;
}

/**
 * 确保向量表存在且与当前模型指纹/维度匹配。
 * - 无表 → 创建
 * - 指纹或维度变化 → DROP 重建（旧向量全部作废）
 */
export function ensureVecTable(db: Db, fingerprint: string, dim: number): VecTableState {
  ensureVecExtension(db);
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'",
  ).get();
  const storedFp = getEmbeddingMeta(db, 'fingerprint');
  const storedDim = getEmbeddingMeta(db, 'dim');

  const needsRebuild = !tableExists || storedFp !== fingerprint || storedDim !== String(dim);

  if (tableExists && needsRebuild) {
    db.exec('DROP TABLE chunks_vec');
  }
  if (needsRebuild) {
    db.exec(
      `CREATE VIRTUAL TABLE chunks_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding FLOAT[${dim}])`,
    );
    setEmbeddingMeta(db, 'fingerprint', fingerprint);
    setEmbeddingMeta(db, 'dim', String(dim));
  }
  return { rebuilt: !tableExists || (needsRebuild && !!tableExists) };
}

/** 当前已向量化的 chunk 数（用于状态展示与待补算统计） */
export function countVectors(db: Db): number {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'",
  ).get();
  if (!exists) return 0;
  return (db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get() as { n: number }).n;
}
