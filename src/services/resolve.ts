import type { Db } from '../db/index.js';
import type { Project } from './project.js';

/**
 * 名称模糊解析（P5 后补强）：AI 对话中传来的项目/文档名称往往与库中字符串
 * 不完全一致（少空格、少字、下划线/横线差异、大小写不同）。
 * 解析策略（从精确到模糊）：
 *   1. UUID / 精确 id 命中 → 直接使用
 *   2. 归一化（小写 + 去空格/下划线/横线/点）后相等
 *   3. 归一化后双向包含（contains）
 * 唯一命中 → 返回；多候选 → 报错并列出候选（AI 会追问或补全）；零命中 → 报错并列出全部可选。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[\s_\-—–·.]/g, '');
}

/** 候选呈现：把匹配到多个/零个的情况格式化为 AI 可读的错误信息（项目用 name，文档用 title） */
function ambiguityError(
  kind: string,
  input: string,
  candidates: { id: string; name?: string; title?: string }[],
): Error {
  const list = candidates.map((c) => `「${c.name ?? c.title ?? c.id}」(${c.id.slice(0, 8)})`).join('、');
  if (candidates.length > 1) {
    return new Error(`${kind}「${input}」匹配到 ${candidates.length} 个候选：${list}。请使用完整名称或 id 重试。`);
  }
  return new Error(`未找到${kind}「${input}」。可选${kind}：${list}（也可先调用 list_projects 查看）`);
}

export interface ResolvedProject {
  id: string;
  name: string;
}

/**
 * 解析项目：入参为 id 或名称（模糊）。
 * @throws 命中多个/零个时抛出带候选列表的错误
 */
export function resolveProject(db: Db, ref: string): ResolvedProject {
  const input = ref.trim();
  if (!input) throw new Error('项目不能为空');

  // 1. 精确 id
  const byId = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(input) as
    | ResolvedProject | undefined;
  if (byId) return byId;

  const all = db.prepare('SELECT id, name FROM projects').all() as ResolvedProject[];

  // 2. 名称精确（含大小写）
  const exact = all.filter((p) => p.name === input);
  if (exact.length === 1) return exact[0];

  // 3. 归一化相等
  const norm = normalizeName(input);
  const normEq = all.filter((p) => normalizeName(p.name) === norm);
  if (normEq.length === 1) return normEq[0];
  if (normEq.length > 1) throw ambiguityError('项目', input, normEq);

  // 4. 双向包含
  const contains = all.filter((p) => {
    const pn = normalizeName(p.name);
    return pn.includes(norm) || norm.includes(pn);
  });
  if (contains.length === 1) return contains[0];
  throw ambiguityError('项目', input, contains.length ? contains : all);
}

interface DocRefRow {
  id: string;
  title: string;
  project_id: string;
  project_name: string;
}

/**
 * 解析文档：入参为 id 或标题（模糊）。提供 projectId/refProject 时在项目内匹配，
 * 否则全库匹配。title 也传时按双条件联合过滤。
 * @throws 命中多个/零个时抛出带候选列表的错误
 */
export function resolveDocument(
  db: Db,
  ref: { documentId?: string; projectId?: string; title?: string; projectName?: string },
): DocRefRow {
  const inputId = ref.documentId?.trim();
  const inputTitle = ref.title?.trim();
  if (!inputId && !inputTitle) {
    throw new Error('请提供 document_id（id 或标题）');
  }

  // 项目范围：先解析项目（本身支持模糊）
  let projectWhere = '';
  const projectArgs: string[] = [];
  if (ref.projectId || ref.projectName) {
    const p = resolveProject(db, ref.projectId ?? ref.projectName!);
    projectWhere = 'AND d.project_id = ?';
    projectArgs.push(p.id);
  }

  // 1. 精确 id（UUID 才尝试，避免标题撞 UUID 查询）
  if (inputId && UUID_RE.test(inputId)) {
    const row = db.prepare(`
      SELECT d.id, d.title, d.project_id, p.name AS project_name
      FROM documents d JOIN projects p ON p.id = d.project_id
      WHERE d.id = ? AND d.deleted_at IS NULL ${projectWhere}
    `).get(inputId, ...projectArgs) as DocRefRow | undefined;
    if (row) return row;
  }

  // 2. 标题精确 → 3. 归一化 → 4. 双向包含（输入是 id 参数位还是 title 参数位都接受标题）
  const titleInputs = [inputTitle, inputId && !UUID_RE.test(inputId) ? inputId : ''].filter(Boolean) as string[];
  const base = db.prepare(`
    SELECT d.id, d.title, d.project_id, p.name AS project_name
    FROM documents d JOIN projects p ON p.id = d.project_id
    WHERE d.deleted_at IS NULL ${projectWhere}
  `).all(...projectArgs) as DocRefRow[];

  for (const input of titleInputs) {
    const exact = base.filter((d) => d.title === input);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw ambiguityError('文档', input, exact);

    const n = normalizeName(input);
    const normEq = base.filter((d) => normalizeName(d.title) === n);
    if (normEq.length === 1) return normEq[0];
    if (normEq.length > 1) throw ambiguityError('文档', input, normEq);

    const contains = base.filter((d) => {
      const dn = normalizeName(d.title);
      return dn.includes(n) || n.includes(dn);
    });
    if (contains.length === 1) return contains[0];
    if (contains.length > 1) throw ambiguityError('文档', input, contains);
  }
  throw ambiguityError('文档', inputTitle || inputId!, base.slice(0, 8));
}
