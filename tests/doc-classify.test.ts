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
    // 通讯协议 / MODBUS / 协议解析等技术语境不再误判为合同
    expect(inferDocType('跟踪器MODBUS通讯协议')).toBe('tech');
    expect(inferDocType('设备通讯协议文档_最新版')).toBe('tech');
    expect(inferDocType('协议解析模块设计概要')).toBe('tech');
    expect(inferDocType('跟踪器通讯协议待确认问题清单')).toBe('tech');
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
    expect(inferDocType('缺陷修复-设备ID下发失败R01')).toBe('adjustment');
    expect(inferDocType('快速改进-蓝牙连接状态文字R07')).toBe('adjustment');
    expect(inferDocType('新增功能-配置预览分组与名称对齐R18')).toBe('adjustment');
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

  it('标题中段版本号 / 日期戳 / 版本修饰词剥离（真实交付标题形态）', () => {
    const base = normalizeTitleForMatch('控制箱APP需求规格说明书');
    // 截图中的 5 个变体：版本号嵌在标题中间 + 日期戳 + 修饰词
    expect(normalizeTitleForMatch('控制箱APP需求规格说明书_V3.4_详细交付版_20261103')).toBe(base);
    expect(normalizeTitleForMatch('控制箱APP需求规格说明书_V3.3_详细交付版_20261103')).toBe(base);
    expect(normalizeTitleForMatch('控制箱APP需求规格说明书_V3.1_详细交付版_20261103')).toBe(base);
    expect(normalizeTitleForMatch('控制箱APP需求规格说明书_V3.0_润色整合版_20261103')).toBe(base);
    // ArcTech 使用说明系列
    const manual = normalizeTitleForMatch('ArcTech Controller用户使用说明');
    expect(normalizeTitleForMatch('ArcTech Controller用户使用说明_V1.3.3_详细交付版_20261103')).toBe(manual);
    expect(normalizeTitleForMatch('ArcTech Controller用户使用说明_V1.2.0_润色整合版_20261103')).toBe(manual);
    // 日期戳两种形态
    expect(normalizeTitleForMatch('蓝牙控制箱APP研发需求说明书_20260825'))
      .toBe(normalizeTitleForMatch('蓝牙控制箱APP研发需求说明书'));
    expect(normalizeTitleForMatch('蓝牙APP测试验证 2026.10.27'))
      .toBe(normalizeTitleForMatch('蓝牙APP测试验证'));
    // version 全词中段
    expect(normalizeTitleForMatch('设计文档 version 2.0 最终稿')).toBe(normalizeTitleForMatch('设计文档'));
  });

  it('中段剥离不误伤：无点版本号与编号保留', () => {
    // 不带点的 V2/R17/IPv6 不剥（避免误伤非版本语境）
    expect(normalizeTitleForMatch('IPv6网络设计')).toBe(normalizeTitleForMatch('ipv6网络设计'));
    expect(normalizeTitleForMatch('界面调整R17')).toBe(normalizeTitleForMatch('界面调整r17'));
    // V2.0（带点）剥离后与其余部分组成新标题，不产生空串
    expect(normalizeTitleForMatch('V2.0（源码阅读后）')).toBe(normalizeTitleForMatch('（源码阅读后）'));
  });

  it('不同标题不误归一', () => {
    expect(normalizeTitleForMatch('需求说明')).not.toBe(normalizeTitleForMatch('接口设计'));
  });
});
