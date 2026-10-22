# doc-mcp 改进计划：stdio 内嵌 Web 后台 + 文档导出下载 + 体验优化

## Context（背景）

用户当前以 stdio 模式将 doc-mcp 接入 Trae 使用，暴露出以下问题：

1. **stdio 模式下 Web 后台完全不可用**：`src/server.ts` L20-25 中 stdio 分支只创建 MCP 连接，不启动任何 HTTP 服务，用户无法通过浏览器管理文档/项目/设置。且此前 HTTP + stdio 双进程并存曾引发 SQLITE_BUSY，因此不能简单建议"另开一个 HTTP 进程"。
2. **大文档无导出/下载途径**：读取大文档（如刚生成的 66KB 协议文档）只能由 AI 客户端 `get_document` 全量读入再转写，浪费大量 token 与时间；Web 后台也没有下载按钮。
3. **本次使用中暴露的体验问题**：同名同内容文档被重复导入无提示（发现两篇完全相同的「跟踪器MODBUS通讯协议」）；大文档只能一次性全量返回；LLM key 未配置时 `generate_document` 静默降级为机械聚合，用户易误认为智能生成。
- 机械聚合时是否可以自动让客户端知道并提示用户？然后由客户端大模型生成文档？

用户已确认方案方向：
- stdio 模式 Web 后台：**配置开关开启**（默认关闭，`data/config.json` 的 `server.webInStdio=true` 或 `--web` 参数）
- 导出能力：**MCP export_document 工具 + Web 后台下载按钮**
- 顺带做：**重复导入检测、get_document 分页/大纲读取、生成降级提示**

核心设计原则：stdio 内嵌 Web 时与 MCP **同进程**共享同一 SQLite 连接（better-sqlite3 单例），从根本上避免双进程 SQLITE_BUSY。

## 实现步骤

### 1. 重构 server.ts，抽出可复用 HTTP 启动逻辑
- 新建 `src/http/app.ts`：将 `src/server.ts` L29-88 的 Fastify 构建（multipart、鉴权钩子、/health、`registerMcpRoutes`、`registerApiRoutes`、web/dist 静态托管 + SPA fallback）与 `start()` 迁出为 `createHttpApp(config)` / `startHttpApp(config)`；HTTP 分支与 stdio 分支共用。
- stdio 分支（L20-25）改造：先 `loadConfig()`；connect 后若 `process.argv.includes('--web') || config.server.webInStdio` 则调用 `startHttpApp`（不重复调用 `startPendingRetryLoop`，或与 HTTP 模式合并为同一启动函数内部逻辑）。
- **日志必须走 stderr**：stdio 模式下 Fastify logger 传 `{ level: 'info', stream: process.stderr }`（HTTP 模式保持现状），stdout 专用于 MCP 协议。

### 2. 配置项
- `src/config/index.ts`：`ServerConfig`（L38-42）加 `webInStdio: boolean`；`DEFAULT_CONFIG`（L71）置 `false`；`data/config.json` 的 server 节可覆盖；`--web` CLI 参数优先级最高。

### 3. SQLite 迁移 v3：content_hash
- `src/db/migrations.ts` 新增 MIGRATION_V3：`ALTER TABLE documents ADD COLUMN content_hash TEXT` + 部分索引 `(project_id, content_hash) WHERE deleted_at IS NULL AND content_hash IS NOT NULL`。
- v3 回调中用 Node `crypto.createHash('sha256')` 遍历存量文档（JOIN 最新版本）回填哈希；同事务执行。
- `src/services/document.ts`：`addDocument`（L128 INSERT）、`updateDocument`（L207 UPDATE）写入哈希，抽 `hashContent()` 辅助函数。

### 4. 重复导入检测
- `addDocument` 入库前按 `project_id + content_hash`（未删除）查询；命中则在返回体加 `duplicates: {id, title}[]`，**不阻断入库**。
- `src/mcp/tools/documents.ts` `add_document` 返回体附加 `duplicate_warning` 文案；REST 上传路由（`src/api/routes/documents.ts`）透传。

### 5. MCP 工具 export_document
- 新建 `src/services/export.ts`：`exportDocument(db, {documentId, version?, filePath?})`，复用 `getDocument`；标题 sanitize（`replace(/[\\/:*?"<>|\r\n]/g, '_')`）；`filePath` 缺省落 `data/exports/<安全标题>.md`（mkdir recursive）；返回 `{file_path, size_bytes, char_count, version_no}`。
- 注册于 `src/mcp/tools/documents.ts`，schema：`document_id`(必填)、`project_id?`（缩小标题匹配）、`version?`、`file_path?`（"导出目标本地绝对路径"，与 add_document 的 file_path 参数模式对齐）。

### 6. REST 导出端点 + 前端下载按钮
- `src/api/routes/documents.ts` 加 `GET /api/documents/:id/export?version=`：`Content-Disposition: attachment; filename*=UTF-8''<encodeURIComponent(title)>.md`，正文为 markdown 内容。
- `web/src/views/DocumentDetailView.vue`（L109 编辑按钮旁）加"下载"按钮：`window.open('/api/documents/<id>/export' + (查看历史版本时 '?version=N'))`。

### 7. get_document 分页/大纲
- schema 加可选 `outline: boolean`、`offset: int≥0`、`limit: int≥0`。
- `src/services/document.ts` `getDocument`（L235-274）加可选参数：`outline` 时基于已有 heading_path 查询（L253-255）构建标题树；分页用 `content.slice(offset, offset+limit)`，返回体加 `total_length / offset / limit / truncated`。全部向后兼容。

### 8. 生成降级提示
- `src/services/generation.ts`：`GenerateResult` 加 `degraded: boolean` 与 `degraded_note?`；`generatedBy === 'aggregate'`（L208 附近）时置位，note 文案说明"未配置 LLM key，已降级机械聚合，可在 Web 设置页配置后重新生成"。
- `src/mcp/tools/index.ts` `server_info`（L19）返回加 `llm_configured: !!getLlm()`（import 自 src/llm/registry.ts）。

## 关键文件
- [src/server.ts](file:///d:/WorkSpace/trea/MCP/rag/src/server.ts)（重构拆分）
- [src/config/index.ts](file:///d:/WorkSpace/trea/MCP/rag/src/config/index.ts)（webInStdio 配置）
- [src/db/migrations.ts](file:///d:/WorkSpace/trea/MCP/rag/src/db/migrations.ts)（迁移 v3）
- [src/services/document.ts](file:///d:/WorkSpace/trea/MCP/rag/src/services/document.ts)（哈希、分页、大纲）
- [src/services/export.ts](file:///d:/WorkSpace/trea/MCP/rag/src/services/export.ts)（新建）
- [src/mcp/tools/documents.ts](file:///d:/WorkSpace/trea/MCP/rag/src/mcp/tools/documents.ts)（export_document、duplicate_warning）
- [src/api/routes/documents.ts](file:///d:/WorkSpace/trea/MCP/rag/src/api/routes/documents.ts)（导出端点）
- [web/src/views/DocumentDetailView.vue](file:///d:/WorkSpace/trea/MCP/rag/web/src/views/DocumentDetailView.vue)（下载按钮）
- [src/services/generation.ts](file:///d:/WorkSpace/trea/MCP/rag/src/services/generation.ts)、[src/mcp/tools/index.ts](file:///d:/WorkSpace/trea/MCP/rag/src/mcp/tools/index.ts)（降级提示）

## 验证方式

1. `npm run build` 后 `node dist/server.js --stdio --web`：stderr 出现 HTTP 监听日志、stdout 无协议污染；`curl http://localhost:3210/health` 与 `/api/projects` 正常；Trae stdio 对话同时可用（同进程无 SQLITE_BUSY）。
2. 仅 `--stdio`（不加 `--web`、配置默认 false）时 Web 不启动，行为与现状一致。
3. MCP Inspector 或 Trae 内调用 `export_document{document_id, file_path}`：目标路径生成 md 文件，内容与 `get_document` 一致；不传 file_path 时落 `data/exports/`。
4. 同内容 `add_document` 两次：第二次返回 `duplicate_warning`；重启后查询 `SELECT content_hash FROM documents` 确认存量已回填。
5. `get_document{outline:true}` 返回标题树；`{offset:0, limit:200}` 返回截断片段且带 `total_length/truncated`。
6. `curl -OJ http://localhost:3210/api/documents/:id/export` 核对下载文件名与内容；Web 详情页点下载按钮可用。
7. 未配置 LLM key 时 `generate_document` 返回 `degraded:true` 及提示；`server_info` 返回 `llm_configured:false`。
8. 回归：跑既有测试（npm test）确认无破坏。
