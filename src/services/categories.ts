import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';

/**
 * 可管理文档分类：doc_categories 表。
 * - 内置分类（built_in=1）id 固定为 v4 枚举 slug（requirement 等），documents.doc_type 存分类 id
 * - 自定义分类 id 用 UUID，name 仅作显示；改名不影响文档引用
 * - 删除自定义分类时，其下未删除文档自动回落到内置分类 other
 */

export interface DocCategory {
  id: string;
  name: string;
  color: string;
  sort: number;
  built_in: number;
  created_at: string;
}

/** 允许的标签色（与 el-tag type 对应） */
export const CATEGORY_COLORS = ['primary', 'success', 'info', 'warning', 'danger'] as const;

const COLOR_SET = new Set<string>(CATEGORY_COLORS);

export function listCategories(db: Db): DocCategory[] {
  return db.prepare(
    'SELECT id, name, color, sort, built_in, created_at FROM doc_categories ORDER BY sort, created_at',
  ).all() as DocCategory[];
}

/** 校验是否为已知分类 id（内置 + 自定义），用于 doc_type 入参校验 */
export function isKnownDocType(db: Db, v: unknown): v is string {
  if (typeof v !== 'string' || !v.trim()) return false;
  return db.prepare('SELECT id FROM doc_categories WHERE id = ?').get(v) !== undefined;
}

function normalizeColor(v: unknown): string {
  const s = String(v ?? 'info').trim();
  return COLOR_SET.has(s) ? s : 'info';
}

function cleanName(raw: unknown): string {
  const name = String(raw ?? '').trim();
  if (!name) throw new Error('分类名称不能为空');
  if (name.length > 30) throw new Error('分类名称过长（最多 30 字）');
  return name;
}

export function createCategory(
  db: Db,
  input: { name?: unknown; color?: unknown; sort?: unknown },
): DocCategory {
  const name = cleanName(input.name);
  if (db.prepare('SELECT id FROM doc_categories WHERE name = ?').get(name)) {
    throw new Error(`分类已存在: ${name}`);
  }
  const color = normalizeColor(input.color);
  const sort = Number.isFinite(Number(input.sort)) && input.sort !== undefined ? Number(input.sort) : 100;
  const id = randomUUID();
  db.prepare(
    'INSERT INTO doc_categories (id, name, color, sort, built_in, created_at) VALUES (?, ?, ?, ?, 0, ?)',
  ).run(id, name, color, sort, new Date().toISOString());
  return db.prepare('SELECT * FROM doc_categories WHERE id = ?').get(id) as DocCategory;
}

export function updateCategory(
  db: Db,
  id: string,
  patch: { name?: unknown; color?: unknown; sort?: unknown },
): DocCategory {
  const cat = db.prepare('SELECT * FROM doc_categories WHERE id = ?').get(id) as DocCategory | undefined;
  if (!cat) throw new Error(`分类不存在: ${id}`);
  const name = patch.name !== undefined ? cleanName(patch.name) : cat.name;
  if (name !== cat.name) {
    const dup = db.prepare('SELECT id FROM doc_categories WHERE name = ? AND id != ?').get(name, id);
    if (dup) throw new Error(`分类已存在: ${name}`);
  }
  const color = patch.color !== undefined ? normalizeColor(patch.color) : cat.color;
  const sortRaw = patch.sort;
  const sort = sortRaw !== undefined && Number.isFinite(Number(sortRaw)) ? Number(sortRaw) : cat.sort;
  db.prepare('UPDATE doc_categories SET name = ?, color = ?, sort = ? WHERE id = ?').run(name, color, sort, id);
  return db.prepare('SELECT * FROM doc_categories WHERE id = ?').get(id) as DocCategory;
}

export function deleteCategory(db: Db, id: string): { deleted: boolean; moved_documents: number } {
  const cat = db.prepare('SELECT * FROM doc_categories WHERE id = ?').get(id) as DocCategory | undefined;
  if (!cat) throw new Error(`分类不存在: ${id}`);
  if (cat.built_in) throw new Error(`内置分类「${cat.name}」不可删除（可改名/改色）`);
  // 分类下未删除文档回落到内置 other（other 必为内置，恒存在）
  const moved = db.prepare(
    "UPDATE documents SET doc_type = 'other' WHERE doc_type = ? AND deleted_at IS NULL",
  ).run(id).changes;
  db.prepare('DELETE FROM doc_categories WHERE id = ?').run(id);
  return { deleted: true, moved_documents: moved };
}
