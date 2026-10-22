import { describe, expect, it } from 'vitest';
import { chunkContent, estimateTokens, hashContent } from '../src/services/chunk.js';

describe('chunk service', () => {
  it('按标题层级切分并维护 heading_path', () => {
    const chunks = chunkContent(`# 总览\n\n开头介绍。\n\n## 模块A\n\nA 的说明。\n\n### 子项A1\n\nA1 细节。\n\n## 模块B\n\nB 的说明。`);
    const paths = chunks.map((c) => c.headingPath);
    expect(paths[0]).toBe('总览');
    expect(paths).toContain('总览 > 模块A');
    expect(paths).toContain('总览 > 模块A > 子项A1');
    expect(paths).toContain('总览 > 模块B');
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i + 1));
  });

  it('无标题内容归入单个空路径块', () => {
    const chunks = chunkContent('只是一段普通文字。');
    expect(chunks.length).toBe(1);
    expect(chunks[0].headingPath).toBe('');
  });

  it('超长无标题内容被二次切分', () => {
    const longText = '很长的段落。'.repeat(500); // 远超 maxTokens(800)
    const chunks = chunkContent(longText);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(800 + 50); // 允许近似误差
  });

  it('seq 连续且 hash 对相同内容稳定', () => {
    const a = chunkContent('# T\n\n正文。');
    const b = chunkContent('# T\n\n正文。');
    expect(a[0].contentHash).toBe(b[0].contentHash);
    expect(hashContent('x')).toBe(hashContent('x'));
    expect(hashContent('x')).not.toBe(hashContent('y'));
  });

  it('token 估算：中文按字、英文按 4 字符', () => {
    expect(estimateTokens('支付流程退款')).toBe(6); // 6 个 CJK
    expect(estimateTokens('abcdefgh')).toBe(2); // 8/4
  });
});
