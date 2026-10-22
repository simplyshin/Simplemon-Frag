/**
 * 本地 embedding 模型预下载（一次性）：node scripts/download-model.mjs
 * 需要网络；国内网络建议设置 HF_ENDPOINT=https://hf-mirror.com（429 限流时自动退避重试）
 */
const ENDPOINT = process.env.HF_ENDPOINT ?? 'https://hf-mirror.com';
process.env.HF_ENDPOINT = ENDPOINT;

const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
const { join, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(ROOT, 'data', 'models');

const maxRetries = 5;
for (let attempt = 1; attempt <= maxRetries; attempt++) {
  try {
    console.log(`[${attempt}/${maxRetries}] 下载模型（${ENDPOINT}）...`);
    const started = Date.now();
    const emb = await FlagEmbedding.init({
      model: EmbeddingModel.BGESmallZH,
      cacheDir,
      showDownloadProgress: true,
    });
    const vec = await emb.queryEmbed('验证下载可用');
    console.log(`模型就绪，维度 ${vec.length}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`缓存目录: ${cacheDir}`);
    process.exit(0);
  } catch (err) {
    console.error(`下载失败: ${err.message}`);
    if (attempt < maxRetries) {
      const wait = attempt * 15_000;
      console.log(`${wait / 1000}s 后重试...`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
console.error('多次重试仍失败：请检查网络/代理，或手动设置 HF_ENDPOINT 后重跑本脚本');
process.exit(1);
