import { describe, expect, it } from 'vitest';
import {
  DOC_TYPES,
  inferDocType,
  isDocType,
  normalizeTitleForMatch,
} from '../src/services/doc-classify.js';

describe('inferDocType 关键词规则', () => {
  it('网络协议语境优先于合同（拦截「协议」歧义）', () => {
    expect(inferDocType('TCP/IP 协议说明')).toBe('tech');
    expect(inferDocType('HTTPS 接口协议文档')).toBe('tech');
    expect(inferDocType('系统通信协议设计')).toBe('tech');
  });

  it('裸「协议」默认合同语境', () => {
    expect(inferDocType('服务协议')).toBe('contract');
    expect(inferDocType('保密协议')).toBe('contract');
    expect(inferDocType('软件开发合同')).toBe('contract');
  });

  it('调整记录优先于需求（「需求变更记录」归调整）', () => {
    expect(inferDocType('需求变更记录')).toBe('adjustment');
    expect(inferDocType('代码调整说明')).toBe('adjustment');
    expect(inferDocType('接口修订历史')).toBe('adjustment');
  });

  it('测试类', () => {
    expect(inferDocType('登录功能测试用例')).toBe('test');
    expect(inferDocType('XX 项目测试报告')).toBe('test');
    expect(inferDocType('验收报告')).toBe('test');
  });

  it('需求类', () => {
    expect(inferDocType('支付需求说明')).toBe('requirement');
    expect(inferDocType('订单系统 PRD')).toBe('requirement');
    expect(inferDocType('用户故事清单')).toBe('requirement');
  });

  it('技术说明类（兜底）', () => {
    expect(inferDocType('接口设计')).toBe('tech');
    expect(inferDocType('系统架构方案')).toBe('tech');
    expect(inferDocType('部署手册')).toBe('tech');
  });

  it('无命中归 other', () => {
    expect(inferDocType('会议纪要杂记')).toBe('other');
    expect(inferDocType('README')).toBe('other');
  });

  it('DOC_TYPES 覆盖六类且 isDocType 校验', () => {
    expect(DOC_TYPES.map((t) => t.value)).toEqual([
      'requirement', 'contract', 'adjustment', 'tech', 'test', 'other',
    ]);
    expect(isDocType('tech')).toBe(true);
    expect(isDocType('nope')).toBe(false);
    expect(isDocType(123)).toBe(false);
  });
});

describe('normalizeTitleForMatch 标题归一化', () => {
  it('版本后缀等价组归一为同值', () => {
    const base = normalizeTitleForMatch('需求说明');
    expect(normalizeTitleForMatch('需求说明 v2')).toBe(base);
    expect(normalizeTitleForMatch('需求说明（2）')).toBe(base);
    expect(normalizeTitleForMatch('需求说明-副本')).toBe(base);
    expect(normalizeTitleForMatch('需求说明V2')).toBe(base);
    expect(normalizeTitleForMatch('需求说明 版本2')).toBe(base);
    expect(normalizeTitleForMatch('需求说明 ver1.2')).toBe(base);
    expect(normalizeTitleForMatch('需求说明 最终版')).toBe(base);
    expect(normalizeTitleForMatch('需求说明.pdf')).toBe(base);
  });

  it('空白与大小写不敏感', () => {
    expect(normalizeTitleForMatch('API 设计规范')).toBe(normalizeTitleForMatch('api设计规范'));
    expect(normalizeTitleForMatch('　全角空格标题　')).toBe(normalizeTitleForMatch('全角空格标题'));
  });

  it('剥后缀不产生空串（防死循环且保留有效标题）', () => {
    expect(normalizeTitleForMatch('v2')).toBe('v2');
    expect(normalizeTitleForMatch('（2）')).toBe('（2）');
    expect(normalizeTitleForMatch('副本')).toBe('副本');
  });

  it('不同标题不误归一', () => {
    expect(normalizeTitleForMatch('需求说明')).not.toBe(normalizeTitleForMatch('接口设计'));
  });
});
