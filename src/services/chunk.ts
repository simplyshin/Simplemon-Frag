import { createHash } from 'node:crypto';
import { loadConfig } from '../config/index.js';

/**
 * P1 最小分块（依赖注记 1）：按 markdown 标题层级切分，
 * 超长章节按空行段落二次聚合。P2 将增强：token 上限精调、
 * overlap、docx/pdf 解析。chunk 哈希用于增量向量化复用。
 */

export interface ChunkDraft {
  seq: number;
  headingPath: string;
  content: string;
  tokenCount: number;
  contentHash: string;
}

/** 粗略 token 估算：CJK 字符约 1 token/字，其余约 4 字符/token */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk++;
  }
  return cjk + Math.ceil((text.length - cjk) / 4);
}

export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

interface Section {
  headingPath: string;
  lines: string[];
}

/** 按标题层级切出 sections；无标题内容归入一个空路径 section */
function splitByHeadings(content: string): Section[] {
  const sections: Section[] = [];
  const stack: string[] = []; // stack[level-1] = 标题文本
  let current: Section = { headingPath: '', lines: [] };

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(HEADING_RE);
    if (match) {
      if (current.lines.some((l) => l.trim())) sections.push(current);
      const level = match[1].length;
      stack.length = level - 1;
      stack[level - 1] = match[2].trim();
      current = { headingPath: stack.filter(Boolean).join(' > '), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.some((l) => l.trim())) sections.push(current);
  return sections;
}

/** 超长 section 按空行段落聚合；单个超大段落硬切 */
function splitOversized(text: string, maxTokens: number): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const out: string[] = [];
  let buf = '';

  const flush = () => {
    if (buf.trim()) out.push(buf.trimEnd());
    buf = '';
  };

  for (const p of paragraphs) {
    if (estimateTokens(p) > maxTokens) {
      flush();
      // 硬切：按 maxTokens 字符切（最坏情况纯 CJK ≈ 1 token/字，保证不超限）
      for (let i = 0; i < p.length; i += maxTokens) {
        out.push(p.slice(i, i + maxTokens));
      }
      continue;
    }
    if (estimateTokens(buf + '\n\n' + p) > maxTokens) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  return out.length ? out : [text];
}

export function chunkContent(content: string): ChunkDraft[] {
  const { maxTokens } = loadConfig().chunking;
  const drafts: ChunkDraft[] = [];

  for (const section of splitByHeadings(content)) {
    const text = section.lines.join('\n').trim();
    const pieces = estimateTokens(text) > maxTokens
      ? splitOversized(text, maxTokens)
      : [text];

    for (const piece of pieces) {
      if (!piece.trim()) continue;
      drafts.push({
        seq: drafts.length + 1,
        headingPath: section.headingPath,
        content: piece,
        tokenCount: estimateTokens(piece),
        contentHash: hashContent(piece),
      });
    }
  }
  return drafts;
}
