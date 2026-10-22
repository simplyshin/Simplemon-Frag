/**
 * 数据库 migrations —— 按 PRAGMA user_version 增量执行。
 *
 * 约定：
 * - 每个迁移必须是幂等安全的整体（在事务中执行，失败即回滚）
 * - 已发布的迁移 SQL 不可修改，只能追加新版本
 * - P2 将追加 v2：chunks_vec 向量虚拟表（依赖 sqlite-vec 扩展加载）
 */

import type { Db } from './index.js';
import { hashContent } from '../services/hash.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * SQL 之后的补充逻辑（同事务执行，失败整体回滚）：
   * 用于 SQL 无法表达的回填（如需要 TS 计算哈希）。
   */
  after?: (db: Db) => void;
}

/** v1 —— P1 骨架：全部业务表 + FTS5 全文索引 + 同步触发器 */
export const MIGRATION_V1: Migration = {
  version: 1,
  name: 'init-p1-schema',
  sql: `
-- ============ 项目 ============
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,              -- UUID
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,                 -- ISO 8601
  updated_at  TEXT NOT NULL
);

-- ============ 文档（软删除：deleted_at 非空即已删除） ============
CREATE TABLE documents (
  id                TEXT PRIMARY KEY,        -- UUID
  project_id        TEXT NOT NULL REFERENCES projects(id),
  title             TEXT NOT NULL,
  -- web|mcp|file|email|chat|meeting（P5 扩展后三类）
  source_type       TEXT NOT NULL DEFAULT 'web',
  -- 沟通元数据等扩展字段，JSON 字符串（发件人/日期/thread_id...）
  metadata          TEXT NOT NULL DEFAULT '{}',
  latest_version_id TEXT,
  deleted_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_documents_project
  ON documents(project_id) WHERE deleted_at IS NULL;

-- ============ 文档版本（每次更新追加新版本，不覆盖） ============
CREATE TABLE document_versions (
  id          TEXT PRIMARY KEY,              -- UUID
  document_id TEXT NOT NULL REFERENCES documents(id),
  version_no  INTEGER NOT NULL,
  content     TEXT NOT NULL,
  change_note TEXT NOT NULL DEFAULT '',
  -- mcp|web|system
  created_by  TEXT NOT NULL DEFAULT 'mcp',
  created_at  TEXT NOT NULL,
  UNIQUE(document_id, version_no)
);
CREATE INDEX idx_versions_doc
  ON document_versions(document_id, version_no);

-- ============ 分块（id 用 INTEGER rowid，供 FTS5 external content 直接引用） ============
CREATE TABLE chunks (
  id           INTEGER PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id),
  version_id   TEXT NOT NULL REFERENCES document_versions(id),
  seq          INTEGER NOT NULL,             -- 块序号，从 1 开始
  heading_path TEXT NOT NULL DEFAULT '',     -- 如：需求说明 > 支付模块 > 退款流程
  content      TEXT NOT NULL,
  token_count  INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,                -- 增量向量化：hash 相同复用旧向量
  UNIQUE(version_id, seq)
);
CREATE INDEX idx_chunks_doc ON chunks(document_id);
CREATE INDEX idx_chunks_version ON chunks(version_id);

-- ============ FTS5 全文索引（trigram 分词支持中文子串检索） ============
-- 注意：trigram 最少匹配 3 个字符，2 字以内的短查询由检索层降级 LIKE 处理
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  content='chunks',
  content_rowid='id',
  tokenize='trigram'
);

-- external content 模式需要触发器保持 FTS 与 chunks 同步
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER chunks_au AFTER UPDATE OF content ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;

-- ============ 文档关联（P4 自动关联 / P5 沟通↔需求依据链） ============
CREATE TABLE doc_links (
  id         INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  source_id  TEXT NOT NULL REFERENCES documents(id),
  target_id  TEXT NOT NULL REFERENCES documents(id),
  -- auto|manual|llm
  type       TEXT NOT NULL DEFAULT 'auto',
  score      REAL NOT NULL DEFAULT 0,
  reason     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(source_id, target_id, type)
);
CREATE INDEX idx_links_project ON doc_links(project_id);

-- ============ 生成类文档/归档（P4 generate_document 输出） ============
CREATE TABLE snapshots (
  id             INTEGER PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  version_no     INTEGER NOT NULL,
  title          TEXT NOT NULL,
  -- functional|usage|requirements|snapshot|communication_summary(P5)
  type           TEXT NOT NULL DEFAULT 'snapshot',
  content        TEXT NOT NULL,
  source_doc_ids TEXT NOT NULL DEFAULT '[]',  -- JSON 数组
  created_at     TEXT NOT NULL,
  UNIQUE(project_id, type, version_no)
);
`,
};

/** v2 —— P2 RAG：embedding 元数据表（chunks_vec 向量表因维度可变，由运行时动态创建） */
export const MIGRATION_V2: Migration = {
  version: 2,
  name: 'p2-embedding-meta',
  sql: `
CREATE TABLE IF NOT EXISTS embedding_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
};

/** v3 —— 重复导入检测：documents 记录最新版本内容的全文档 SHA-256 */
export const MIGRATION_V3: Migration = {
  version: 3,
  name: 'content-hash-duplicate-detect',
  sql: `
ALTER TABLE documents ADD COLUMN content_hash TEXT;
CREATE INDEX idx_documents_content_hash
  ON documents(project_id, content_hash)
  WHERE deleted_at IS NULL AND content_hash IS NOT NULL;
`,
  after: (db) => {
    // 回填存量文档（SQL 无法计算 SHA-256，用 TS 遍历；同事务内，失败即回滚）
    const rows = db.prepare(`
      SELECT d.id AS id, v.content AS content
      FROM documents d JOIN document_versions v ON v.id = d.latest_version_id
      WHERE d.content_hash IS NULL
    `).all() as { id: string; content: string }[];
    const update = db.prepare('UPDATE documents SET content_hash = ? WHERE id = ?');
    for (const row of rows) update.run(hashContent(row.content), row.id);
  },
};

/** 全部按版本号升序排列，新增迁移追加到数组末尾 */
export const MIGRATIONS: readonly Migration[] = [MIGRATION_V1, MIGRATION_V2, MIGRATION_V3];
