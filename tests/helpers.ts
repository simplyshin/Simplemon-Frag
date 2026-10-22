import type { Db } from '../src/db/index.js';
import { openDb } from '../src/db/index.js';
import { createProject } from '../src/services/project.js';
import { addDocument } from '../src/services/document.js';

/** 每个测试用独立的内存库，互不影响 */
export function createTestDb(): Db {
  return openDb(':memory:');
}

export const SAMPLE_DOC = `# 需求说明

## 支付模块

系统需要接入微信支付与支付宝两种支付方式。

### 退款流程

用户可在订单完成后 7 天内发起退款申请，原路退回。

## 通知模块

支付成功后通过短信通知用户。
`;

/** 造一个带两篇文档的项目，返回 { projectId, docIds } */
export function seedProject(db: Db, name = '测试项目'): { projectId: string; docIds: string[] } {
  const project = createProject(db, name, '集成测试用');
  const docIds: string[] = [];
  for (const title of ['需求说明', '接口设计']) {
    const content = title === '需求说明' ? SAMPLE_DOC : `# 接口设计\n\nPOST /api/pay 创建支付单，需验签。`;
    const r = addDocument(db, { projectId: project.id, title, content, createdBy: 'test' });
    docIds.push(r.document_id);
  }
  return { projectId: project.id, docIds };
}
