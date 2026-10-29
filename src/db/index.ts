import Database from 'better-sqlite3';
import { join } from 'node:path';
import { DATA_DIR } from '../config/index.js';
import { MIGRATIONS } from './migrations.js';
import { ensureVecExtension } from './vector.js';

export type Db = Database.Database;

/**
 * 打开数据库并执行未应用的 migrations。
 * @param filename 数据库文件路径，传 ':memory:' 可创建内存库（集成测试用）
 */
export function openDb(filename?: string): Db {
  const db = new Database(filename ?? join(DATA_DIR, 'app.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  // 连接级统一加载 sqlite-vec：chunks_vec 存在时，任何直接访问（updateDocument
  // 向量搬运、deleteProject 清理、pendingCount 统计等）都必须有 vec0 模块，
  // 不能依赖"恰好先经过 ensureVecTable"的隐式时序。失败静默降级为纯 FTS 检索。
  try {
    ensureVecExtension(db);
  } catch { /* 扩展不可用：向量路缺席，FTS5/LIKE 路照常工作 */ }
  return db;
}

/** 应用级单例：延迟初始化，全进程共享一个连接 */
let singleton: Db | null = null;

export function getDb(): Db {
  if (!singleton) singleton = openDb();
  return singleton;
}

export function closeDb(): void {
  singleton?.close();
  singleton = null;
}

/**
 * 基于 PRAGMA user_version 的增量迁移：
 * 每个迁移在独立事务中执行（exec + 写版本号），失败整体回滚。
 */
function runMigrations(db: Db): void {
  let current = db.pragma('user_version', { simple: true }) as number;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    if (migration.version !== current + 1) {
      throw new Error(
        `migration 版本不连续：当前 user_version=${current}，` +
        `下一个应为 ${current + 1}，收到 ${migration.version}`,
      );
    }

    const apply = db.transaction(() => {
      db.exec(migration.sql);
      migration.after?.(db);
      db.pragma(`user_version = ${migration.version}`);
    });

    try {
      apply();
      current = migration.version;
    } catch (err) {
      throw new Error(
        `migration v${migration.version}(${migration.name}) 执行失败: ` +
        `${(err as Error).message}`,
      );
    }
  }
}
