import { createHash } from 'node:crypto';

/** 文档内容 SHA-256（重复导入检测：全文档级哈希，与 chunks 的分段哈希无关） */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}
