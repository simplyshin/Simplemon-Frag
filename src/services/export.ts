import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from '../config/index.js';
import { getDocument } from './document.js';
import type { Db } from '../db/index.js';

/**
 * 文档导出（服务端直写本地文件）：
 * 大文档不必经 AI 客户端 get_document 全量读入再转写，
 * 由服务端直接落盘，客户端只拿到文件路径。
 */

export interface ExportResult {
  document_id: string;
  title: string;
  version_no: number;
  file_path: string;
  size_bytes: number;
  char_count: number;
}

/** Windows/macOS/Linux 通用非法文件名字符 → 下划线 */
function sanitizeFilename(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|\r\n\t]+/g, '_').trim();
  return safe || 'document';
}

export function exportDocument(
  db: Db,
  input: {
    documentId: string;
    version?: number;
    /** 导出目标本地绝对路径（文件）；缺省落 data/exports/<安全标题>.md */
    filePath?: string;
  },
): ExportResult {
  const doc = getDocument(db, {
    documentId: input.documentId,
    version: input.version,
  });
  if (!('content' in doc)) {
    // 理论不可达（本服务不启用 outline 模式），防御性兜底
    throw new Error('导出失败：文档内容为空');
  }
  const content = doc.content;

  const target = input.filePath?.trim() || join(DATA_DIR, 'exports', `${sanitizeFilename(doc.title)}.md`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf-8');

  return {
    document_id: doc.id,
    title: doc.title,
    version_no: doc.version_no,
    file_path: target,
    size_bytes: statSync(target).size,
    char_count: content.length,
  };
}
