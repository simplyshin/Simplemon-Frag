/**
 * Mock 数据种子脚本（可重复执行）：node scripts/seed-mock.mjs
 * 创建「演示项目」及 3 篇文档（含标题层级，用于后续检索验证）。
 * 幂等：项目已存在则跳过。
 */
import { getDb, closeDb } from '../dist/db/index.js';
import { createProject, listProjects } from '../dist/services/project.js';
import { addDocument } from '../dist/services/document.js';

const db = getDb();

const MOCK_DOCS = [
  {
    title: '需求说明',
    content: `# 需求说明

## 支付模块

系统需要接入微信支付与支付宝两种支付方式，下单后 30 分钟未支付自动关闭订单。

### 退款流程

用户可在订单完成后 7 天内发起退款申请，客服审核通过后原路退回，退款到账时间为 1-3 个工作日。

## 通知模块

支付成功后通过短信与站内信双通道通知用户，通知失败自动重试 3 次。
`,
  },
  {
    title: '接口设计',
    content: `# 接口设计

## 支付接口

POST /api/pay 创建支付单，请求参数包含订单号、金额、支付渠道，返回支付跳转链接。

POST /api/pay/notify 为第三方回调接口，需验签并保证幂等处理。

## 订单接口

GET /api/orders/:id 查询订单详情，包含订单状态机：待支付、已支付、已关闭、退款中、已退款。
`,
  },
  {
    title: 'FAQ',
    content: `# 常见问题

## 支付相关

Q: 重复点击支付按钮会重复扣款吗？
A: 不会，同一订单号重复创建支付单会返回同一支付链接。

Q: 退款失败怎么办？
A: 退款失败会转人工处理，客服会在 1 个工作日内联系用户。
`,
  },
];

// 幂等：演示项目已存在则跳过
const existing = listProjects(db).find((p) => p.name === '演示项目');
if (existing) {
  console.log(`演示项目已存在 (id=${existing.id})，跳过种子数据`);
} else {
  const project = createProject(db, '演示项目', '用于验证 MCP tools 的 mock 数据');
  console.log(`创建演示项目: ${project.id}`);

  for (const doc of MOCK_DOCS) {
    const r = addDocument(db, {
      projectId: project.id,
      title: doc.title,
      content: doc.content,
      changeNote: 'mock 种子数据',
      createdBy: 'system',
    });
    console.log(`  添加文档「${doc.title}」→ ${r.document_id}（${r.chunk_count} 块）`);
  }
}

closeDb();
console.log('种子数据完成');
