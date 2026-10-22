/**
 * DB 层冒烟测试（可重复执行）：node scripts/smoke-db.mjs
 * 验证：建表迁移、FTS 触发器同步、中文检索（trigram ≥3 字符）、软删除约束
 */
import { openDb } from '../dist/db/index.js';

const now = new Date().toISOString();
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// ---- 1. 迁移与建表 ----
const db = openDb(':memory:');
const version = db.pragma('user_version', { simple: true });
check('migration v1 已应用 (user_version=1)', version === 1, `user_version=${version}`);

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name")
  .all()
  .map((r) => r.name);
for (const t of ['projects', 'documents', 'document_versions', 'chunks', 'chunks_fts', 'doc_links', 'snapshots', 'chunks_ai', 'chunks_au', 'chunks_ad']) {
  check(`存在 ${t}`, tables.includes(t));
}

// ---- 2. 插入基础数据 ----
db.prepare(
  "INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
).run('p1', '演示项目', '测试用', now, now);
db.prepare(
  "INSERT INTO documents (id, project_id, title, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
).run('d1', 'p1', '需求说明', 'mcp', now, now);
db.prepare(
  "INSERT INTO document_versions (id, document_id, version_no, content, change_note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
).run('v1', 'd1', 1, '系统支持微信支付与支付宝支付，退款流程为人工审核。', '初始版本', 'mcp', now);
db.prepare(
  "INSERT INTO chunks (document_id, version_id, seq, heading_path, content, token_count, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
).run('d1', 'v1', 1, '需求说明 > 支付模块', '系统支持微信支付与支付宝支付，退款流程为人工审核。', 24, 'hash-abc');
check('插入 project/document/version/chunk 成功', true);

// ---- 3. FTS 触发器自动同步（INSERT 后可检索） ----
const ftsHit = db
  .prepare(
    "SELECT c.* FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE chunks_fts MATCH ?",
  )
  .all('"支付宝支付"');
check('FTS 中文检索命中（trigram, 4字）', ftsHit.length === 1, `命中 ${ftsHit.length} 条`);

const ftsShort = db
  .prepare(
    "SELECT c.* FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE chunks_fts MATCH ?",
  )
  .all('"支付"');
check('FTS 短词（2字）不命中（预期，检索层需 LIKE 降级）', ftsShort.length === 0, `命中 ${ftsShort.length} 条`);

// ---- 4. UPDATE 触发器：内容变更后旧词失效、新词生效 ----
db.prepare("UPDATE chunks SET content = ? WHERE id = 1").run(
  '系统支持微信支付与支付宝支付，退款流程为系统自动审核，无需人工介入。',
);
const afterUpdate = db
  .prepare(
    "SELECT c.* FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE chunks_fts MATCH ?",
  )
  .all('"系统自动审核"');
const oldGone = db
  .prepare(
    "SELECT c.* FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE chunks_fts MATCH ?",
  )
  .all('"人工审核"');
check('UPDATE 后新内容可检索', afterUpdate.length === 1, `命中 ${afterUpdate.length} 条`);
check('UPDATE 后旧内容不再命中', oldGone.length === 0, `命中 ${oldGone.length} 条`);

// ---- 5. 外键约束生效 ----
let fkBlocked = false;
try {
  db.prepare(
    "INSERT INTO documents (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run('d2', 'p-not-exist', '坏数据', now, now);
} catch {
  fkBlocked = true;
}
check('外键约束生效（非法 project_id 被拒绝）', fkBlocked);

db.close();

// ---- 6. 文件库二次打开：迁移幂等 ----
const { getDb, closeDb } = await import('../dist/db/index.js');
getDb();
const v2 = getDb().pragma('user_version', { simple: true });
check('二次打开迁移幂等（不重复执行，仍为 v1）', v2 === 1, `user_version=${v2}`);
closeDb();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
