# frag-mcp — 项目文档管理 MCP 服务

一个自托管的**项目文档管理 + RAG 语义检索** MCP 服务。让 AI 客户端（Trae、Codex、Claude 等）直接管理你的项目文档：增删改查、版本追溯、语义检索、自动关联、生成聚合文档、归档客户沟通记录；同时提供 Web 后台供人工管理。数据全部存在本机 SQLite，不外泄。

## 一、它能干什么

| 能力 | 说明 | 对应 Tools |
|---|---|---|
| **文档管理** | 建项目、加文档（文本/本地 md·txt·docx·pdf）、改文档自动追加版本（历史可回溯）、软删除 | `create_project` `list_projects` `add_document` `update_document` `get_document` `list_documents` `delete_document` |
| **语义检索** | 混合检索：FTS5 关键词 + 向量语义 + LIKE 兜底 → RRF 融合排序，返回片段带章节路径与来源标签；向量路故障自动降级，检索永不可用 | `search_documents` |
| **版本与溯源** | 每次修改都是新版本；可回看任意版本、对比任意两版本、段落级溯源（标注每个段落在哪个版本产生/修改） | `get_document(?version)` + REST `/trace` |
| **自动关联** | 文档间按向量质心相似度自动建关联；改一处需求时 AI 立刻收到「关联文档需同步检查」提示 | `list_related_documents` |
| **文档生成** | 从项目文档聚合生成功能文档 / 使用说明 / 需求文档，可附变更记录表；LLM 可选（无 key 时机械聚合降级） | `generate_document` |
| **沟通归档** | 客户诉求、会议纪要、OCR 文字等「一段话」归档入库，与需求文档建立依据链——需求变更时争议有据可查 | `add_communication` |
| **Web 后台** | 项目/文档管理、拖拽上传、在线编辑、版本 diff 对比、检索、Provider 设置（key 脱敏），与 MCP 同端口 | 浏览器访问 `http://localhost:3210` |

**核心价值**：文档散落、版本混乱、AI 缺乏项目上下文、需求变更口说无凭——四件事一次解决，且 AI 在对话中即可完成全部操作。

## 二、快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置鉴权 token（必须）
#    .env 中设置 AUTH_TOKEN=你的token（只填 token 本身，不要带 Bearer 前缀）
cp .env.example .env   # 然后编辑

# 3. （可选）预下载本地 embedding 模型（~100MB，一次性）
#    已配置 HF 镜像 + 断点重试；不预下载则首次向量化时自动下载
node scripts/download-model.mjs

# 4. 构建并启动
npm run build
node dist/server.js              # HTTP 模式（默认，端口 3210）
node dist/server.js --stdio      # stdio 模式（Codex 等客户端用，不启动 Web）
node dist/server.js --stdio --web  # stdio 模式 + 同进程内嵌 Web 后台（也可配置 server.webInStdio=true）

# 5. 验证
curl http://localhost:3210/health
```

Web 后台：浏览器打开 `http://localhost:3210` 即可（本机 `/api` 免 token）。

## 三、AI 客户端接入

### Trae / Claude 等支持 HTTP 的客户端

MCP 配置中添加 Streamable HTTP 端点：

```
URL:  http://localhost:3210/mcp
Header: Authorization: Bearer <你的 AUTH_TOKEN>
```

### Codex 等只支持 stdio 的客户端

```json
{
  "mcpServers": {
    "frag-mcp": {
      "command": "node",
      "args": ["D:/WorkSpace/trea/MCP/rag/dist/server.js", "--stdio", "--web"]
    }
  }
}
```

stdio 模式无需 token（本地子进程可信），与 HTTP 模式共享同一份 SQLite 数据。
加 `--web`（或在 `data/config.json` 的 server 节设 `"webInStdio": true`）后，stdio 进程内嵌启动
Web 后台（同端口 3210），浏览器可直接管理文档——与 MCP 同进程共享 SQLite 连接，
不会出现双进程并发写库问题；HTTP 日志自动走 stderr，不污染 stdout 的 MCP 协议。

## 四、13 个 MCP Tools 速查

```
项目管理      list_projects / create_project
文档管理      list_documents / add_document / get_document / update_document / delete_document / export_document
文档检索      search_documents        # 支持口语化查询，如「钱怎么退回来」
索引维护      rebuild_index           # 重建《项目文档索引》
文档生成      generate_document       # type: functional | usage | requirements | communication_summary
文档关联      list_related_documents  # 改需求前查影响面
沟通归档      add_communication       # 一段话 + channel/parties/occurred_at
```

**get_document 大文档用法**：先 `outline=true` 拿标题大纲与 total_length，再用
`offset`/`limit` 分页读正文，避免一次性返回超大内容；`export_document(document_id, file_path)`
由服务端把文档直接写成 .md 文件（缺省落 `data/exports/`），导出大文档不耗 token。
`add_document` 在项目内已存在内容完全相同的文档时返回 `duplicate_warning`（不阻断入库）；
`generate_document` 未配置 LLM key 时返回 `degraded=true` 与配置提示；
`server_info` 提供 `llm_configured` 状态。Web 后台文档详情页新增「下载 .md」按钮。

### 名称模糊匹配

所有工具的 `project_id` / `document_id` 参数**既接受 id 也接受名称**，名称支持模糊匹配：
忽略大小写、空格、下划线、横线（如传「控制箱APP」可命中「控制箱 APP」），还能容忍
双向包含（传「需求说明」可命中「蓝牙控制箱APP研发需求说明书_20260825」这类长标题）。
唯一命中直接返回；匹配到多个候选时返回候选列表（含 id 前缀），AI 会自动追问消歧。

### 典型对话示例

> **你**：把这份需求加进去，然后搜下退款相关的内容
> → AI 调 `add_document` + `search_documents`

> **你**：客户刚在微信说导出上限要从 1 万行改到 5 万行，记一下
> → AI 调 `add_communication`（channel=wechat，自动关联需求文档）

> **你**：按这个变更更新需求文档，注意看有没有关联文档要同步
> → AI 调 `update_document`（返回体自动带 related 提示）→ 检查关联文档 → 必要时一并更新

> **你**：给我生成一份最新的需求文档，附上变更记录
> → AI 调 `generate_document(type=requirements, include_changelog=true)`

> **你**：客户现在说当初不是这么约定的，帮我查证据
> → AI 调 `search_documents` 检索沟通记录原文与时间戳 → 争议有据可查

## 五、Web 后台功能

访问 `http://localhost:3210`：

- **项目管理**：新建/删除项目（级联删除文档与向量）
- **文档管理**：列表、上传（md/txt/docx/pdf，入库即向量化）、软删除
- **文档详情**：查看/在线编辑、版本时间线、任意两版行级 diff
- **文档检索**：语义+关键词混合检索，结果带来源标签（语义/关键词）与章节路径
- **Provider 设置**：切换 LLM / Embedding Provider（key 脱敏展示，key 本体在 `.env` 管理；embedding 模型切换自动重建向量表）

## 六、配置

优先级：环境变量 > `data/config.json` > 内置默认值。

| 配置项 | 位置 | 说明 |
|---|---|---|
| `AUTH_TOKEN` | `.env`（必须） | MCP/REST 鉴权 token；本机 Web 后台与 `/api` 免 token |
| `PORT` | `.env` | 服务端口，默认 3210 |
| LLM Provider | Web 设置页 / `data/config.json` | openai / anthropic / deepseek / zhipu 预置；key 放 `.env` 对应变量名；**不配置也能用**（生成降级为机械聚合） |
| Embedding | Web 设置页 / `data/config.json` | 默认 `local`（bge-small-zh-v1.5，512 维，零 key）；可切 `openai-compatible`；切换模型自动重建向量表 |
| 分块 | `data/config.json` | maxTokens=800 / overlap=100 |

## 七、测试与验收脚本

```bash
npm test                       # vitest 45 用例（service 级集成测试）
node scripts/smoke-rag.mjs     # P2 语义检索验收（4/4）
node scripts/smoke-rest.mjs    # P3 REST API 冒烟（11/11）
node scripts/smoke-web.mjs     # P3 Web↔AI 双向验收（7/7）
node scripts/smoke-p4.mjs      # P4 关联/生成/溯源验收（12/12，含性能数据）
node scripts/smoke-p5.mjs      # P5 沟通归档追溯验收（10/10）
node scripts/smoke-vector-e2e.mjs  # 真实 embedding 模型端到端（9/9）
node scripts/final-acceptance.mjs  # P1 全链路终验（6/6）
node scripts/seed-mock.mjs     # 灌入演示项目（需求说明/接口设计/FAQ）
```

## 八、实测性能（local 模型，CPU 推理）

| 操作 | 耗时 |
|---|---|
| 单篇文档入库（含向量化 + 自动关联） | ~28ms |
| 语义检索全链路 | ~20ms |
| 更新文档（hash 复用，仅补算变更块） | ~28ms |
| 生成聚合文档（机械聚合 + 向量化） | ~174ms（LLM 模式另加数秒推理，按需触发） |
| 段落级版本溯源 | ~1ms |
| 250 篇 / 750 块规模检索 | ~1ms |

增量向量化：更新文档只对 content_hash 变化的块重新推理，未变章节向量搬运复用（零成本）。

## 九、目录与数据

```
rag/
├─ src/               # 后端（Fastify + better-sqlite3 + MCP SDK + sqlite-vec + fastembed）
│  ├─ mcp/tools/      # 12 个 MCP tools
│  ├─ api/routes/     # REST API（Web 后台用，与 MCP 共用 services 层）
│  ├─ services/       # 业务逻辑（文档/检索/向量化/关联/生成）
│  └─ llm/            # LLM / Embedding Provider 抽象（local 默认 + openai-compatible）
├─ web/               # Vue 3 + Vite + Element Plus 后台（npm run build 后由服务托管）
├─ data/              # 运行时数据（doc.db、models/、config.json）——勿提交 git
├─ scripts/           # 冒烟/验收/演示数据脚本
└─ tests/             # vitest 集成测试（内存库）
```

- 版本机制：`document_versions` 追加版本不覆盖；chunks 挂 version_id，历史版本分块保留供溯源
- 检索降级：embedding 任何故障时向量路静默缺席，FTS/LIKE 照常工作，后台每 5 分钟自动补算
- 沟通记录：`source_type='communication'` + `metadata`（channel/parties/occurred_at），与普通文档同管线

---
*设计文档见 [方案设计.md](./方案设计.md)（完整方案、路线图与各阶段验收记录）。*
