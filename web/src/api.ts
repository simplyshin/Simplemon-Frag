/** REST API 封装：本机同源免鉴权（/api 对 localhost 放行），错误统一抛 Error(error) */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(path, {
    method,
    headers: body === undefined || isForm ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应保留 null */ }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error ?? `请求失败（HTTP ${res.status}）`;
    throw new Error(msg);
  }
  return data as T;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentSummary {
  id: string;
  project_id: string;
  title: string;
  source_type: string;
  version_no: number;
  updated_at: string;
}

export interface DocumentFull {
  id: string;
  project_id: string;
  title: string;
  source_type: string;
  version_no: number;
  updated_at: string;
  content: string;
  change_note: string;
  heading_paths: string[];
}

export interface VersionSummary {
  version_no: number;
  change_note: string;
  created_by: string;
  created_at: string;
}

export interface SearchHit {
  document_id: string;
  document_title: string;
  version_no: number;
  seq: number;
  heading_path: string;
  content: string;
  score: number;
  source: 'fts' | 'vector' | 'like';
}

export interface SearchResult {
  query: string;
  total: number;
  hits: SearchHit[];
  meta: { vector: boolean };
}

export interface Settings {
  llm: {
    provider: string;
    providers: Record<string, { baseUrl: string; model: string; apiKeyEnv: string; hasKey: boolean; keyHint: string }>;
  };
  embedding: {
    provider: string;
    local: { model: string };
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    hasKey: boolean;
    keyHint: string;
  };
  chunking: { maxTokens: number; overlap: number };
}
