/** 一次性清理：删除全部「冒烟项目-*」临时项目及其文档/版本/分块 */
import { getDb, closeDb } from '../dist/db/index.js';

const db = getDb();
const targets = db.prepare("SELECT id, name FROM projects WHERE name LIKE '冒烟项目-%'").all();
console.log(`待清理临时项目: ${targets.length} 个`);

const wipe = db.transaction(() => {
  for (const p of targets) {
    db.prepare('DELETE FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE project_id = ?)').run(p.id);
    db.prepare('DELETE FROM document_versions WHERE document_id IN (SELECT id FROM documents WHERE project_id = ?)').run(p.id);
    db.prepare('DELETE FROM doc_links WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM snapshots WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM documents WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
  }
});
wipe();

for (const p of targets) console.log(`  已删除: ${p.name} (${p.id})`);

const remaining = db.prepare('SELECT name FROM projects').all().map((r) => r.name);
const ftsCount = db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get().n;
console.log(`\n剩余项目: ${remaining.join(', ')}`);
console.log(`FTS 剩余索引条目: ${ftsCount}（应仅剩演示项目数据）`);
closeDb();
