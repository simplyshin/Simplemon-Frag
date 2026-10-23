import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/config 与 dist/config 距离项目根目录均为两级
export const PROJECT_ROOT = join(__dirname, '..', '..');
export const DATA_DIR = join(PROJECT_ROOT, 'data');
const CONFIG_FILE = join(DATA_DIR, 'config.json');
const ENV_FILE = join(PROJECT_ROOT, '.env');

// ---------- 类型定义 ----------

export interface LlmConfig {
  /** openai | anthropic | deepseek | zhipu */
  provider: string;
  /** 各厂商独立配置（apiKeyEnv 引用环境变量名，不在本文件存明文 key） */
  options: Record<string, Record<string, string | undefined>>;
}

export interface EmbeddingConfig {
  /** local（默认，零 key 开箱即用）| openai-compatible */
  provider: string;
  /** local 模型标识 */
  local: { model: string };
  /** openai-compatible 模式专用 */
  baseUrl: string;
  model: string;
  /** 存放 API key 的环境变量名 */
  apiKeyEnv: string;
}

export interface ChunkingConfig {
  maxTokens: number;
  overlap: number;
}

export interface ServerConfig {
  port: number;
  /** MCP/REST 端点鉴权 token；来自 env AUTH_TOKEN，优先于配置文件 */
  authToken: string;
  /**
   * stdio 模式下是否同进程内嵌启动 Web 后台（Fastify + REST + 静态托管）。
   * 默认 false 保持纯 stdio；CLI 参数 --web 优先于本配置。
   * 同进程共享 SQLite 连接，不会出现双进程 SQLITE_BUSY。
   */
  webInStdio: boolean;
  /**
   * 文档写入（REST + MCP 工具）成功后自动重建项目文档索引（去抖 5s 后台执行）。
   * 默认 true；多实例横向扩展时应关闭（设 AUTO_REBUILD_INDEX=off 或配置文件置 false），
   * 索引改由指定实例或运维脚本定期触发。手动 rebuild_index 不受影响。
   */
  autoRebuildIndex: boolean;
}

export interface AppConfig {
  llm: LlmConfig;
  embedding: EmbeddingConfig;
  chunking: ChunkingConfig;
  server: ServerConfig;
}

// ---------- 默认配置 ----------

const DEFAULT_CONFIG: AppConfig = {
  llm: {
    provider: 'zhipu',
    options: {
      openai: { apiKeyEnv: 'OPENAI_API_KEY' },
      anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
      zhipu: { apiKeyEnv: 'ZHIPU_API_KEY' },
    },
  },
  embedding: {
    provider: 'local',
    local: { model: 'bge-small-zh-v1.5' },
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'embedding-3',
    apiKeyEnv: 'ZHIPU_API_KEY',
  },
  chunking: { maxTokens: 800, overlap: 100 },
  server: { port: 3210, authToken: '', webInStdio: false, autoRebuildIndex: true },
};

// ---------- 工具函数 ----------

/** 极简 .env 加载：不覆盖已存在的环境变量（避免污染外部注入） */
function loadDotEnv(): void {
  if (!existsSync(ENV_FILE)) return;
  for (const line of readFileSync(ENV_FILE, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as T));
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(value) && isPlainObject(result[key])
      ? deepMerge(result[key], value)
      : value;
  }
  return result as T;
}

// ---------- 对外接口 ----------

let cachedConfig: AppConfig | null = null;

/**
 * 加载应用配置，优先级：环境变量 > data/config.json > 内置默认值。
 * 结果进程内缓存，重复调用无 IO。
 */
export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  loadDotEnv();

  let fileConfig: unknown = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      fileConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    } catch (err) {
      throw new Error(`配置文件解析失败: ${CONFIG_FILE} — ${(err as Error).message}`);
    }
  }

  const merged = deepMerge(DEFAULT_CONFIG, fileConfig);

  // 环境变量覆盖
  if (process.env.PORT) merged.server.port = Number(process.env.PORT);
  if (process.env.AUTH_TOKEN) merged.server.authToken = process.env.AUTH_TOKEN;
  if (process.env.AUTO_REBUILD_INDEX) {
    merged.server.autoRebuildIndex = process.env.AUTO_REBUILD_INDEX !== 'off';
  }

  if (!merged.server.authToken) {
    throw new Error('缺少鉴权 token：请在 .env 中设置 AUTH_TOKEN（参考 .env.example）');
  }

  // 确保 data 目录存在（数据库/上传文件/配置文件的宿主目录）
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  cachedConfig = merged;
  return merged;
}

/** 供需要读取 provider API key 的模块使用：按环境变量名取 key */
export function getApiKey(envVarName: string): string | undefined {
  loadDotEnv();
  return process.env[envVarName];
}

/**
 * 增量更新 data/config.json（P3 Web 设置页用）：只合并传入的 patch，
 * 写回后清空进程内缓存，下一次 loadConfig 生效。API key 仍建议放 .env，
 * config.json 只存环境变量名引用。
 */
export function saveConfig(patch: Record<string, unknown>): void {
  loadDotEnv();
  let fileConfig: Record<string, unknown> = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      fileConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
      fileConfig = {}; // 既有文件损坏时以 patch 为准重建，避免设置页被卡死
    }
  }
  const merged = deepMerge(fileConfig, patch);
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n');
  cachedConfig = null;
}
