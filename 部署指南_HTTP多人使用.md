# doc-mcp 部署指南 — HTTP 集中部署（多人共享）

本文说明如何把 doc-mcp 以 **HTTP 方式集中部署在一台服务器**上，让团队多人通过各自的 AI 客户端（Trae / Claude / Cursor 等）远程接入同一个知识库，而不是每人本地跑一份 stdio 进程。

## 一、两种接入方式对比

| | stdio 模式（本地） | HTTP 模式（集中部署） |
|---|---|---|
| 部署位置 | 每人自己的电脑各跑一份 | 一台服务器跑一份，所有人连它 |
| 数据 | 各自独立、互不相通 | **共享同一份 SQLite 知识库** |
| 适用场景 | 个人单机使用 | 团队协作、文档统一管理 |
| 鉴权 | 无需 token（本地可信） | 所有 `/mcp`、远程 `/api` 请求需 Bearer token |

> HTTP 是本服务的**默认模式**：直接 `node dist/server.js` 即以 Streamable HTTP 启动，监听 `0.0.0.0`，无需任何代码改动。

```
                     ┌──────────────────────────────┐
 Trae (同事A) ──HTTP──▶│  doc-mcp 服务（服务器/主机）    │
 Claude (同事B) ─HTTP─▶│  :3210                       │
 Cursor (同事C) ─HTTP─▶│  ├─ /mcp   (MCP 协议端点)      │
                     │  ├─ /api   (REST, Web后台用)   │
 浏览器 (管理员) ──────▶│  └─ /      (Web 后台静态页)    │
                     │  data/doc.db  ← 唯一数据源     │
                     └──────────────────────────────┘
```

## 二、服务器部署步骤

前置要求：服务器安装 **Node.js ≥ 20**。

```bash
# 1. 获取代码并安装依赖
cd /path/to/rag
npm install

# 2. 生成一个强随机 token（发给所有使用者的就是这个）
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env：
#   AUTH_TOKEN=<上面生成的随机串>     ← 必填，团队共用
#   PORT=3210                       ← 可改

# 4. 构建（含 Web 后台前端）
npm run build
cd web && npm install && npm run build && cd ..

# 5. （可选）预下载本地 embedding 模型 ~100MB
#    不预下载则首次向量化时自动下载（服务器需能访问 HuggingFace 镜像）
node scripts/download-model.mjs

# 6. 启动（HTTP 模式即默认模式）
node dist/server.js

# 7. 验证
curl http://localhost:3210/health
# 期望返回 {"status":"ok","service":"doc-mcp-server","version":"0.1.0"}
```

### 进程守护（长期运行必须）

服务进程不能挂在终端会话上，选一种：

**Linux — systemd 示例**（`/etc/systemd/system/doc-mcp.service`）：

```ini
[Unit]
Description=doc-mcp server
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/rag
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now doc-mcp
sudo systemctl status doc-mcp      # 查看状态
journalctl -u doc-mcp -f           # 查看日志
```

**Windows — NSSM 示例**：

```powershell
nssm install doc-mcp "C:\Program Files\nodejs\node.exe" "D:\path\to\rag\dist\server.js"
nssm set doc-mcp AppDirectory D:\path\to\rag
nssm start doc-mcp
```

## 三、开放网络访问

### 局域网使用（推荐）

在服务器防火墙放行 3210 端口：

```powershell
# Windows 防火墙
netsh advfirewall firewall add rule name="doc-mcp" dir=in action=allow protocol=TCP localport=3210
```

```bash
# Linux (firewalld)
sudo firewall-cmd --permanent --add-port=3210/tcp && sudo firewall-cmd --reload
# Linux (ufw)
sudo ufw allow 3210/tcp
```

同事用 `http://<服务器局域网IP>:3210/mcp` 接入即可，数据不出内网。

### 公网 / 跨网段使用（建议加反向代理 + HTTPS）

裸暴露 3210 到公网不推荐，建议前面加一层 nginx 做 HTTPS 与头部注入：

```nginx
server {
    listen 443 ssl;
    server_name docmcp.example.com;
    # ssl_certificate     /etc/nginx/certs/fullchain.pem;
    # ssl_certificate_key /etc/nginx/certs/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3210;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        # 超时调大，避免 MCP 长耗时工具调用（如文档生成）被掐断
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # 可选：给浏览器访问 Web 后台自动注入鉴权头（见第五节）
    # location /api/ {
    #     proxy_pass http://127.0.0.1:3210;
    #     proxy_set_header Authorization "Bearer <你的AUTH_TOKEN>";
    # }
}
```

## 四、客户端接入（发给每位使用者的说明）

每人只需要两样东西：**服务地址** 和 **token**。

### Trae / Claude 等支持 Streamable HTTP 的客户端

MCP 配置中添加（以 Trae 为例）：

```json
{
  "mcpServers": {
    "doc-mcp": {
      "url": "http://192.168.1.100:3210/mcp",
      "headers": {
        "Authorization": "Bearer <你的AUTH_TOKEN>"
      }
    }
  }
}
```

> URL 换成实际服务器地址；若走 nginx + HTTPS，则用 `https://docmcp.example.com/mcp`。
> 保存后重启/刷新 MCP 连接，能列出 12 个工具即接入成功。

### 快速自检

```bash
# 1. 服务是否可达（免鉴权）
curl http://192.168.1.100:3210/health

# 2. token 是否正确（应返回 JSON-RPC 响应而不是 401）
curl -X POST http://192.168.1.100:3210/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

## 五、Web 后台的远程访问说明

Web 后台（`http://服务器IP:3210`）的**静态页面所有人可打开**，但页面调用的 `/api` 接口**远程访问需要 Bearer token**（本机 127.0.0.1 免 token）。浏览器页面目前不会自动携带 token，因此远程打开后台会遇到 401。三种解决办法：

1. **反向代理注入头（推荐）**：按第三节 nginx 配置中注释掉的 `/api/` 段，让 nginx 统一补 `Authorization` 头，远程浏览器直接可用；
2. **SSH 隧道**：管理机执行 `ssh -L 3210:127.0.0.1:3210 user@服务器`，然后浏览器访问 `http://localhost:3210`（本机 IP 免 token）；
3. **仅限服务器本机管理**：后台操作（上传、编辑、设置）集中在服务器本机或跳板机上做，其他人只通过 AI 客户端 + MCP 使用。

## 六、多人使用注意事项

- **单一 token、共享知识库**：当前版本所有用户共用同一个 `AUTH_TOKEN`，读写同一个知识库，**没有按人隔离的权限**。token 泄露等于开放全部文档，请通过内部渠道分发，必要时定期轮换（改 `.env` 后重启服务，同步更新各客户端）。
- **并发安全**：所有请求由同一个服务进程处理，SQLite 已启用 WAL 模式，多人同时检索/入库/生成没有问题。
- **不要再起第二个进程指向同一 data 目录**：如果有人在自己电脑上又跑了一份 stdio 模式并共享同一份 `data/`（如挂载同一目录），可能出现 `SQLITE_BUSY`。数据只保留服务器一份，本地不要直连服务器的数据目录。
- **Embedding 模型只在服务端跑一次**：local 模型（bge-small-zh-v1.5）在服务器上加载，客户端零依赖、零下载，这正是 HTTP 部署的优势。
- **大文件上传限制**：Web 后台上传单文件上限 50MB（Fastify multipart 限制）。

## 七、安全建议

1. `AUTH_TOKEN` 必须是强随机串（≥24 字节），不要用示例中的 `change-me`；
2. 不要将 3210 端口直接暴露公网，走 nginx + HTTPS；没有条件时至少限制防火墙来源 IP；
3. token 与 API key 只放服务器 `.env`，该文件已在 gitignore 中，切勿提交仓库或发到群里；
4. 定期备份 `data/doc.db`（WAL 模式下连同 `doc.db-wal`、`doc.db-shm` 一起拷贝，或停服后拷贝）；
5. 如需按人追责/隔离，需在应用层扩展多用户鉴权（当前版本未内置）。

## 八、常见问题

| 现象 | 原因与处理 |
|---|---|
| 客户端报 401 Unauthorized | token 不对或没带 `Bearer ` 前缀；核对 `.env` 的 `AUTH_TOKEN` 与客户端 headers 是否一致 |
| 客户端连接超时 / 拒绝 | 服务未启动或防火墙未放行；先 `curl /health` 排查网络，再查 `systemctl status doc-mcp` |
| 启动报「缺少鉴权 token」 | `.env` 未配置 `AUTH_TOKEN`，或文件不在项目根目录 |
| 端口被占用 | 换端口：`.env` 改 `PORT`，或杀掉占用进程后重启 |
| `SQLITE_BUSY` | 有第二个进程在写同一 `data/doc.db`（常见于 stdio 调试进程未关）；确保只有服务器一个进程使用该数据目录 |
| 远程浏览器打开后台白屏 / 接口 401 | 正常现象，见第五节三种解决方案 |
| 检索结果变少、无语义结果 | 服务器首次启动在下载 embedding 模型，或模型下载失败走了降级（仅关键词检索）；查看服务日志，必要时手动 `node scripts/download-model.mjs` |
| 更换了 token 后大家都 401 | 改 `.env` 后需重启服务进程，并把新 token 同步到所有客户端配置 |

---
*MCP 工具清单与使用示例见 [README.md](./README.md)；完整方案设计见 [方案设计.md](./方案设计.md)。*
