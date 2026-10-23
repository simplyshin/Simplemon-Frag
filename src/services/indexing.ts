import type { Db } from '../db/index.js';
import { addDocument, updateDocument } from './document.js';
import { embedAfterWrite } from './embedding.js';
import { hashContent } from './hash.js';
import { loadConfig } from '../config/index.js';

/**
 * 项目文档索引生成（P1 朴素版，依赖注记 2：不依赖 LLM）。
 * 摘要 = 每篇文档正文首段截断；P2 接入 LLM 后升级为语义摘要。
 * 索引文档本身是一篇特殊文档（source_type=index），重建 = 追加新版本，
 * 复用既有的版本/分块/索引机制。
 *
 * 自动重建（写路径触发）：REST 路由与 MCP 写工具成功写入后调用 scheduleRebuild
 * 打脏标记，去抖合并后后台重建。三项关键性质：
 * - 确定性：索引内容是文档集合的纯函数（无时间戳，时间记入 change_note），
 *   这是版本节流与向量按 hash 复用的前提——内容必变则二者永不生效
 * - 版本节流：新内容与索引文档现有 content_hash 相同时 skipped，零写入零嵌入
 * - 免锁：rebuildIndex/addDocument/updateDocument 全同步，事件循环保证互不交叠；
 *   唯一异步空窗（await embedAfterWrite）期间的新写入由 while 循环消化
 */

const INDEX_TITLE = '《项目文档索引》';
const DEBOUNCE_MS = 5_000;

function summarize(content: string, maxChars = 150): string {
  const body = content
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#')) // 去掉标题行，取正文
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
}

export interface RebuildResult {
  document_id: string;
  version_no: number;
  doc_count: number;
  action: 'created' | 'updated' | 'skipped';
}

/** 索引新鲜度指纹：随每次重建写入索引文档 metadata，供启动自愈预检（见 isIndexPossiblyStale） */
function buildFingerprint(docs: { updated_at: string }[]): { doc_count: number; max_updated_at: string } {
  return {
    doc_count: docs.length,
    max_updated_at: docs.reduce((m, d) => (d.updated_at > m ? d.updated_at : m), ''),
  };
}

export function rebuildIndex(
  db: Db,
  projectId: string,
): RebuildResult {
  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as
    | { id: string; name: string }
    | undefined;
  if (!project) throw new Error(`项目不存在: ${projectId}（可先调用 list_projects 获取）`);

  const docs = db.prepare(`
    SELECT d.id, d.title, d.source_type, v.version_no, v.content, d.updated_at
    FROM documents d
    JOIN document_versions v ON v.id = d.latest_version_id
    WHERE d.project_id = ? AND d.deleted_at IS NULL AND d.title != ?
    ORDER BY d.created_at
  `).all(projectId, INDEX_TITLE) as {
    id: string; title: string; source_type: string; version_no: number; content: string; updated_at: string;
  }[];

  const fingerprint = buildFingerprint(docs);
  const generatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const sections = docs.map((d) =>
    `## ${d.title}（v${d.version_no}，更新于 ${d.updated_at.slice(0, 19).replace('T', ' ')}）\n\n摘要：${summarize(d.content)}`,
  );
  // 确定性内容：任何易变信息（生成时间）都不得进入正文，否则 hash 节流失效
  const content = [
    `# 项目文档索引 — ${project.name}`,
    '',
    `> 共 ${docs.length} 篇文档，随文档变更自动更新，也可通过 rebuild_index 手动重建。`,
    '',
    ...sections,
  ].join('\n');

  const existing = db.prepare(
    'SELECT id FROM documents WHERE project_id = ? AND title = ? AND deleted_at IS NULL',
  ).get(projectId, INDEX_TITLE) as { id: string } | undefined;

  if (existing) {
    // 版本节流：documents.content_hash 由 addDocument/updateDocument 在事务内维护，
    // 恒等于最新版本内容的真实哈希，比对结果即"写入是否为无操作"的权威判定
    const row = db.prepare('SELECT content_hash FROM documents WHERE id = ?')
      .get(existing.id) as { content_hash: string };
    if (row.content_hash === hashContent(content)) {
      return { document_id: existing.id, version_no: 0, doc_count: docs.length, action: 'skipped' };
    }
    const r = updateDocument(db, {
      documentId: existing.id,
      content,
      changeNote: `重建索引（${docs.length} 篇文档，${generatedAt}）`,
      createdBy: 'system',
      metadata: fingerprint,
    });
    return { document_id: r.document_id, version_no: r.version_no, doc_count: docs.length, action: 'updated' };
  }

  const r = addDocument(db, {
    projectId,
    title: INDEX_TITLE,
    content,
    changeNote: `首次生成索引（${docs.length} 篇文档，${generatedAt}）`,
    sourceType: 'index',
    createdBy: 'system',
    metadata: fingerprint,
  });
  return { document_id: r.document_id, version_no: r.version_no, doc_count: docs.length, action: 'created' };
}

// ---------- 自动重建调度（去抖 + 单飞，纯内存状态，无 DB 迁移） ----------

interface ScheduleState {
  /** 去抖定时器（unref，不阻止进程退出） */
  timer: NodeJS.Timeout | null;
  /** 待重建标记：running 期间的新写入只置位，由执行循环消化 */
  dirty: boolean;
  /** 单飞标记：同一项目同时至多一个重建任务 */
  running: boolean;
}

const schedulers = new Map<string, ScheduleState>();

/** 配置开关（4.4）：缺失/异常时保持默认开启；多实例部署可 AUTO_REBUILD_INDEX=off 关闭 */
function autoRebuildEnabled(): boolean {
  try {
    return loadConfig().server.autoRebuildIndex !== false;
  } catch {
    return true;
  }
}

/** 写路径触发：仅打标记，O(1)，不触碰 DB、永不抛错、永不阻塞请求 */
export function scheduleRebuild(db: Db, projectId: string): void {
  if (!autoRebuildEnabled()) return;
  let s = schedulers.get(projectId);
  if (!s) {
    s = { timer: null, dirty: false, running: false };
    schedulers.set(projectId, s);
  }
  s.dirty = true;
  if (s.running) return; // 执行中：跑完后复查 dirty 再排一轮
  if (s.timer) clearTimeout(s.timer); // 去抖：静默期内再写 → 重置计时
  s.timer = setTimeout(() => {
    s.timer = null;
    void runRebuild(db, projectId);
  }, DEBOUNCE_MS);
  s.timer.unref();
}

async function runRebuild(db: Db, projectId: string): Promise<void> {
  const s = schedulers.get(projectId);
  if (!s) return;
  s.running = true;
  try {
    while (s.dirty) {
      s.dirty = false;
      try {
        const r = rebuildIndex(db, projectId);
        // skipped 已是最新，无需向量化；否则索引文档新增块内联补算 + 自动关联
        if (r.action !== 'skipped') await embedAfterWrite(db, r.document_id);
      } catch (err) {
        console.error(`[indexing] 项目 ${projectId} 自动重建失败（等下次写操作重试）:`, (err as Error).message);
        break; // 失败不无限重试，dirty 已清空，等下次写操作重新触发
      }
    }
  } finally {
    s.running = false;
    if (s.dirty && !s.timer) {
      // 兜底：执行期间又收到新标记
      s.timer = setTimeout(() => {
        s.timer = null;
        void runRebuild(db, projectId);
      }, DEBOUNCE_MS);
      s.timer.unref();
    }
  }
}

/** 进程退出前调用：同步清空未触发的重建（只做 rebuildIndex，不做 embed，向量由 retry loop 兜底） */
export function flushPendingRebuilds(db: Db): void {
  for (const [projectId, s] of schedulers) {
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    if (s.dirty && !s.running) {
      s.dirty = false;
      try {
        rebuildIndex(db, projectId);
      } catch { /* 退出流程中静默 */ }
    }
  }
}

/**
 * 启动自愈预检：指纹比对（O(元数据)，不读正文）。
 * 保守判断——失配只代表"可能过期"，误判由版本节流兜底 skipped；
 * 指纹缺失/损坏视为滞后。COUNT 覆盖了 deleteDocument 不更新 updated_at 的删除盲区。
 */
export function isIndexPossiblyStale(db: Db, projectId: string): boolean {
  const indexDoc = db.prepare(
    'SELECT metadata FROM documents WHERE project_id = ? AND title = ? AND deleted_at IS NULL',
  ).get(projectId, INDEX_TITLE) as { metadata: string } | undefined;
  if (!indexDoc) return true; // 无索引文档 → 必然重建
  let saved: { doc_count?: unknown; max_updated_at?: unknown };
  try {
    saved = JSON.parse(indexDoc.metadata);
  } catch {
    return true;
  }
  if (typeof saved.doc_count !== 'number' || typeof saved.max_updated_at !== 'string') return true;
  const cur = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS m
    FROM documents WHERE project_id = ? AND deleted_at IS NULL AND title != ?
  `).get(projectId, INDEX_TITLE) as { n: number; m: string };
  return cur.n !== saved.doc_count || cur.m !== saved.max_updated_at;
}

/** 启动自愈：逐项目指纹预检，仅对疑似滞后的项目错峰排重建（避免项目多时的同步重建潮） */
export function scheduleStartupRebuilds(db: Db): void {
  const projects = db.prepare('SELECT id FROM projects').all() as { id: string }[];
  let stale = 0;
  for (const p of projects) {
    if (!isIndexPossiblyStale(db, p.id)) continue;
    const delay = stale++ * 500;
    setTimeout(() => scheduleRebuild(db, p.id), delay).unref();
  }
}
