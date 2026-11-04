import type { Db } from '../db/index.js';

/** 文档业务分类（与来源 source_type 无关） */
export type DocType = 'requirement' | 'contract' | 'adjustment' | 'tech' | 'test' | 'other';

export const DOC_TYPES: readonly { value: DocType; label: string }[] = [
  { value: 'requirement', label: '需求' },
  { value: 'contract', label: '合同' },
  { value: 'adjustment', label: '调整记录' },
  { value: 'tech', label: '技术说明' },
  { value: 'test', label: '测试' },
  { value: 'other', label: '其他' },
] as const;

const DOC_TYPE_SET = new Set<string>(DOC_TYPES.map((t) => t.value));

export function isDocType(v: unknown): v is DocType {
  return typeof v === 'string' && DOC_TYPE_SET.has(v);
}

export function docTypeLabel(v: string): string {
  return DOC_TYPES.find((t) => t.value === v)?.label ?? v;
}

/**
 * 有序规则表：先命中先得，未命中 other。
 * 优先级设计要点：
 * - 网络协议语境（TCP/HTTP/通信协议…）放在 contract 之前，拦截「协议」歧义
 * - adjustment 高于 requirement：「需求变更记录」应归调整记录
 * - 裸「协议」默认合同语境（服务协议/保密协议）
 */
const DOC_TYPE_RULES: readonly { type: DocType; pattern: RegExp }[] = [
  { type: 'tech', pattern: /tcp|udp|https?(?![a-z])|网络协议|通信协议|传输协议|接口协议|协议栈/i },
  { type: 'test', pattern: /测试|用例|验收|压测|\bqa\b|\btest/i },
  { type: 'adjustment', pattern: /变更|调整|修订|洽商|增补/ },
  { type: 'contract', pattern: /合同|协议|报价|标书|投标|商务|签约|条款|甲方|乙方/ },
  { type: 'requirement', pattern: /需求|\bprd\b|规格|用户故事|功能文档|功能说明/i },
  { type: 'tech', pattern: /技术|架构|设计|开发|接口|\bapi\b|\bsdk\b|部署|运维|数据库|方案|白皮书|手册|指南|使用说明/i },
] as const;

/** 按标题关键词推断文档类型（入库自动分类用） */
export function inferDocType(title: string): DocType {
  for (const rule of DOC_TYPE_RULES) {
    if (rule.pattern.test(title)) return rule.type;
  }
  return 'other';
}

/**
 * 标题归一化（同名版本合并匹配用）：
 * 剥扩展名 → 循环剥版本后缀（(2)/v2/版本2/X版/副本/final…）→ 去空白 + 小写。
 * 剥离正则均要求非空匹配，防止死循环。
 */
export function normalizeTitleForMatch(title: string): string {
  let s = title.trim().replace(/\u3000/g, ' ').replace(/\.(md|txt|docx|pdf)$/i, '');
  const stripPatterns: RegExp[] = [
    /[（(]\d+[）)]$/,
    /[-–—_·\s]*(?:v|ver|version|版本)\s*\d+(?:\.\d+)*$/i,
    /\d+(?:\.\d+)*版$/,
    /[-–—_·\s]*(?:副本|拷贝|copy|final|最终版|最新版|定稿|初稿|终稿)$/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of stripPatterns) {
      const next = s.replace(p, '');
      // 仅在确实剥掉了非空后缀时继续（防死循环）
      if (next !== s && next.trim().length > 0) {
        s = next.trim();
        changed = true;
      }
    }
  }
  return s.replace(/\s+/g, '').toLowerCase();
}

/**
 * 同名合并目标查找：先按原始标题精确匹配，
 * 未命中再取项目内标题做归一化比对（如「需求说明 v2」匹配「需求说明」）。
 * 排除 source_type='index'（《项目文档索引》有自己的 existing/update 生命周期）。
 */
export function findMergeableDocument(
  db: Db,
  projectId: string,
  title: string,
): { id: string; title: string } | undefined {
  const exact = db.prepare(`
    SELECT id, title FROM documents
    WHERE project_id = ? AND title = ? AND deleted_at IS NULL AND source_type != 'index'
    ORDER BY created_at LIMIT 1
  `).get(projectId, title) as { id: string; title: string } | undefined;
  if (exact) return exact;

  const rows = db.prepare(`
    SELECT id, title FROM documents
    WHERE project_id = ? AND deleted_at IS NULL AND source_type != 'index'
    ORDER BY created_at
  `).all(projectId) as { id: string; title: string }[];
  const target = normalizeTitleForMatch(title);
  if (!target) return undefined;
  return rows.find((r) => normalizeTitleForMatch(r.title) === target);
}
