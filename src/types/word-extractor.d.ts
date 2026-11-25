declare module 'word-extractor' {
  interface WordDocument {
    /** 正文文本 */
    getBody(): string;
    /** 头部文本（页眉等） */
    getHeaders(): string;
    /** 尾部文本（页脚等） */
    getFooters(): string;
    /** 批注 */
    getEndnotes(): string;
    /** 脚注 */
    getFootnotes(): string;
  }
  export default class WordExtractor {
    /** 从文件路径或 Buffer 提取 .doc 内容 */
    extract(input: string | Buffer): Promise<WordDocument>;
  }
}
