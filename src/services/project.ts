import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';

const now = (): string => new Date().toISOString();

export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export function listProjects(db: Db): Project[] {
  return db
    .prepare('SELECT id, name, description, created_at, updated_at FROM projects ORDER BY created_at')
    .all() as Project[];
}

export function createProject(db: Db, name: string, description = ''): Project {
  if (!name.trim()) throw new Error('项目名称不能为空');
  const duplicated = db
    .prepare('SELECT id FROM projects WHERE name = ?')
    .get(name.trim()) as { id: string } | undefined;
  if (duplicated) throw new Error(`项目「${name}」已存在 (id=${duplicated.id})`);

  const id = randomUUID();
  const ts = now();
  db.prepare(
    'INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, name.trim(), description.trim(), ts, ts);
  return { id, name: name.trim(), description: description.trim(), created_at: ts, updated_at: ts };
}

/**
 * 删除项目及其全部文档（含版本与向量，物理删除；chunks_fts 由触发器同步）。
 * 与文档级软删除不同：删除项目是明确的管理动作，不做半软半硬的中间态。
 */
export function deleteProject(db: Db, projectId: string): { project_id: string; deleted_documents: number } {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new Error(`项目不存在: ${projectId}`);

  const run = db.transaction(() => {
    const docIds = (db.prepare('SELECT id FROM documents WHERE project_id = ?')
      .all(projectId) as { id: string }[]).map((r) => r.id);
    for (const docId of docIds) {
      db.prepare('DELETE FROM chunks_vec WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(docId);
      db.prepare('DELETE FROM chunks WHERE document_id = ?').run(docId); // FTS 触发器同步
      db.prepare('DELETE FROM document_versions WHERE document_id = ?').run(docId);
    }
    // doc_links 引用 documents，必须先于 documents 删除
    db.prepare('DELETE FROM doc_links WHERE project_id = ?').run(projectId);
    const deleted = db.prepare('DELETE FROM documents WHERE project_id = ?').run(projectId).changes;
    db.prepare('DELETE FROM snapshots WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    return deleted;
  });
  return { project_id: projectId, deleted_documents: run() };
}
