import { setEmbedderForTests, type Embedder } from '../src/llm/embedding/index.js';

// 测试环境初始化：services 内部会调用 loadConfig()（要求 AUTH_TOKEN 存在）
process.env.AUTH_TOKEN ??= 'test-token';
process.env.PORT ??= '3999';

// 默认注入"总是抛错"的 embedder：强制走降级路径，
// 保证不触发真实 fastembed 模型下载；向量管线用例自行注入确定性假实现
const failingEmbedder: Embedder = {
  fingerprint: 'test:failing',
  dim: 4,
  embedPassages: async () => { throw new Error('test: embedding unavailable'); },
  embedQuery: async () => { throw new Error('test: embedding unavailable'); },
};
setEmbedderForTests(failingEmbedder);
