# 运行手册：单实例 Streamable HTTP

仅连接托管服务请看 [README 中的客户端配置](../README.md)。本页供运行服务和反向代理的人使用。

## 1. 复用已有私有网络

在项目根目录准备 Docker Engine 和 Compose v2。上游应用应当已经在一个用户定义的私有网络中，且 `qiandaiapi-app` 是该网络上可解析的名称或别名。可通过仅显示网络名的命令核对（容器名按实际替换）：

```sh
docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' qiandaiapi-app
```

把 `.env.example` 复制为本服务专用的 `.env`（POSIX：`cp .env.example .env`；PowerShell：`Copy-Item .env.example .env`），**仅首次配置时复制**。在受信任的编辑器里填值，不要把真实凭据写进命令行。限制 `.env` 的读取权限（POSIX 用 `chmod 600 .env`；Windows 用文件 ACL）。不要在该文件放其他服务的凭据，Compose 的 `env_file` 会将它注入此容器。

| 配置名 | Compose 值或设置方法 |
|---|---|
| `MCP_DOCKER_NETWORK` | 必填：上述已有网络的**精确名称**。Compose 引用 external network，不会新建或接管它 |
| `DEFAULT_NOVELAI_API_KEY` | 必填：服务端用于匿名体验的默认密钥，仅在部署机 `.env` 注入。个人客户端发送自己的 `USER_API_KEY` |
| `UPSTREAM_BASE_URL` | `http://qiandaiapi-app:8080`，是私网服务基址，不是公网 MCP 地址 |
| `MCP_BIND_HOST` / `PORT` | 容器固定为 `0.0.0.0` / `3000`，这样同网反代和容器内健康检查都能访问 |
| `MCP_HOST_PORT` | 默认 `13000`；只发布 `127.0.0.1:${MCP_HOST_PORT:-13000}:3000`。反代也在同一私网时可移除整个 `ports` 段 |
| `MCP_IMAGE_PUBLIC_BASE_URL` | `https://api.chiyotobi.party/mcp`，用客户端可达的 HTTPS 基址，保留外层路径前缀，不含查询、凭据或第二个 `/mcp` |
| `MCP_IMAGE_TTL_SECONDS` | `300`；过期的图和 ID 不再提供，不能靠重启或备份延长下载链接 |
| `MCP_ALLOWED_ORIGINS` | `*`；如需限制，可换成逗号分隔的完整源（例如 `https://api.chiyotobi.party`，不带路径）。这只是 Origin 策略，不是鉴权 |
| `MCP_DATA_DIR` | `/var/lib/novelai-mcp/data`，命名卷 `novelai-mcp-data` 保存免费额度及 Vibe 缓存 |
| `MCP_IMAGE_ARCHIVE_DIR` | `/var/lib/novelai-mcp/images`，命名卷 `novelai-mcp-images` 保存限时原图及元数据 |
| `MCP_IMAGE_TAG` | 本地构建标签，默认 `local`；生产为每个版本设一个唯一标签，保留上一个健康版本，不覆盖它 |

只需把本服务接入该网络，不要停掉或重建上游、反代或外部网络。两个挂载点必须彼此独立、不能互相包含；不要挂在 `/` 或项目根上，也不要把他人数据放入图片清理目录。**一个账本只允许一个服务进程写入**，不使用扩容、集群或多 worker。

## 2. 构建与内部验收

```sh
docker compose config --quiet
docker compose build novelai-mcp
docker compose up -d --no-build --wait novelai-mcp
docker compose ps novelai-mcp
curl -fsS http://127.0.0.1:13000/health
```

最后一条对应默认宿主端口，正常返回 `{"status":"ok"}`；健康检查只确认 HTTP 进程，不发送上游生成请求。不要将不带 `--quiet` 的 `docker compose config` 或完整 `docker inspect` 发给他人，其中可能含环境密钥。

两个构建阶段使用 Node 24 Debian。锁文件中的 `sharp` 为 `0.35.5`，其引擎声明 `>=20.9.0`；镜像安装锁定的本平台可选二进制，构建时验证可以加载 `sharp`。运行阶段不带编译器，以 `node` 用户启动。Docker 会从镜像中 `node` 所有的两个目录初始化**新空命名卷**，默认无需 root 初始化容器。已有卷不会因重建镜像自动变更权限。

可用只读检查确认身份、模板和实际写权限（不会创建文件或打印密钥）：

```sh
docker compose exec -T novelai-mcp node -e "const fs=require('node:fs'); if(process.getuid()===0) process.exit(1); for(const p of [process.env.MCP_DATA_DIR,process.env.MCP_IMAGE_ARCHIVE_DIR]) fs.accessSync(p,fs.constants.W_OK); fs.accessSync('/app/prompts/novelAI_prompt.md',fs.constants.R_OK)"
```

如果旧卷报权限错误，先停写并备份，再由管理员仅修正对应卷内的所有者/权限，不要改用 root 运行服务或放宽为全员可写。没有宿主端口时可在容器内检查 `http://127.0.0.1:3000/health`，或从同网反代检查 `http://novelai-mcp:3000/health`。

## 3. HTTPS 反代：只去掉一层前缀

| 客户端请求 | 反代给 `novelai-mcp:3000` 的路径 |
|---|---|
| `https://api.chiyotobi.party/mcp/mcp` | `/mcp`；POST 收发 MCP 消息，支持浏览器 OPTIONS 预检。GET、DELETE 返回 405 |
| `https://api.chiyotobi.party/mcp/novelai-images/{id}.{ext}` | `/novelai-images/{id}.{ext}`；GET/HEAD，不缓存。图片下载不依赖客户端的个人 API Key |
| `https://api.chiyotobi.party/mcp/health` | `/health`；正常时返回 HTTP 200。容器自己的探针仍直接访问 `/health` |

**Caddy（上线配置）**：使用仓库的 [deploy/caddy-route.caddy](../deploy/caddy-route.caddy)。将片段放在已有 API 站点的 HTTPS 配置块内、兜底 `handle` 前；`handle_path /mcp/*` 已剥掉外层前缀，不要再 rewrite 一次。Caddy 与服务应在同一私网，反代目标是 `novelai-mcp:3000`。先备份原配置、校验完整配置，再平滑 reload；不要替换其他站点或证书配置。

**Nginx 等价示例**：将以下单个 `location` 放入现有的 TLS `server`。`proxy_pass` **末尾的 `/` 不能省**，它将 `/mcp/` 替换成 `/`，转发上表三条路径。如果 Nginx 运行在宿主机，则用 `http://127.0.0.1:13000/`（或相应回环端口）。

```nginx
location ^~ /mcp/ {
    proxy_pass http://novelai-mcp:3000/;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Mcp-Session-Id $http_mcp_session_id;
    proxy_set_header MCP-Protocol-Version $http_mcp_protocol_version;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_cache off;
    proxy_next_upstream off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    client_max_body_size 50m;
    access_log off; # the image path itself grants temporary access
}
```

代理必须保留每次请求的 `Authorization`（包括缺省）、`MCP-Protocol-Version`、`Accept`、`Content-Type` 和响应的 `Cache-Control`，不要注入默认密钥。旧客户端的 `Mcp-Session-Id` 可以透传；服务端忽略它，不下发新 ID，也不按 ID 路由。不要记录鉴权头、请求体、旧 ID 或有效图片链接。Nginx 用 `nginx -t` 校验，通过后 reload；若它只在启动时解析容器 DNS 名，容器重建后还需 reload 以解析新的 IP。可用 `curl -fsS https://api.chiyotobi.party/mcp/health` 检查完整前缀转发，预期 HTTP 200、`{"status":"ok"}`。

通过代理 POST `initialize` 协商版本，再以该 `MCP-Protocol-Version` POST `notifications/initialized`（空响应，202）。后续请求都在各自的 POST 上返回结果，不建立独立 GET 流，不发保活。用 `tools/list` 验证不带鉴权列出 2 个工具、带个人密钥列出 9 个；权限只取决于本次请求，而非上一次握手。

**公网只读验收**：在运行脚本的环境中设置个人 `QIANDAI_MCP_API_KEY`（不是服务端默认密钥），从仓库根目录选择以下一条命令。两者都验证工具列表、完整模板及个人 `get_subscription`，不发起任何图片操作。

```sh
node scripts/acceptance.mjs --stateless-smoke
# 也可真实静置 31 分钟，让原客户端不保活、不重新握手，再做只读调用：
node scripts/acceptance.mjs --stateless-smoke --idle-minutes 31
```

**收费验收**另用 `node scripts/acceptance.mjs --live`，仅在明确获准消耗额度时运行。它会执行 1 次免费生成和 4 次个人密钥图片操作，校验原图、ID、短链和默认 300 秒 TTL 到期后的 404。不要把它用作探活，也不要自动重试计费请求。

## 4. 平滑切换与回滚

**MCP 传输无状态，运维仍限单实例**：免费额度账本、Vibe 缓存和限时图片都在卷中。切换版本前要排空正在处理的 POST，不能让两个版本同时读写同一账本。

1. **变更前**：记录当前镜像 ID、唯一镜像标签、端口、卷名、网络名及反代配置，安全保存专用 `.env`。在候选版本的独立网络、卷、端口和模拟上游中先验收；不要把第二个别名 `novelai-mcp` 加进生产网。保留足够磁盘空间和已验证的旧镜像。
2. **切换时**：先在反代暂停接收新调用，等在途生成和预占/回滚结束，勿自动重放请求。用 `docker compose stop novelai-mcp` 正常停止，再对**同一时间点的两个卷**做受限备份/快照（保留文件属主、权限及时间），记录与镜像的对应关系。不要删除卷或重置额度。
3. **发布**：将 `MCP_IMAGE_TAG` 切至已验证的唯一标签，对应镜像已在本机时执行 `docker compose up -d --no-build --wait novelai-mcp`；必要时更新反代并验证配置。先查内部 `/health`、卷写权限、模板和两种工具清单，再放行流量。无状态版本没有待恢复的 MCP 会话；仍支持原协商版本时，客户端可直接发送下一个 POST。
4. **回滚**：暂停新流量并排空、停止候选容器，将 `MCP_IMAGE_TAG` 与 Compose、反代配置恢复到已知健康版本，保留原有网络和卷。若数据格式向后兼容，优先复用现有卷以保留最新用量；若不兼容，先保全当前卷，确认变更后的业务记录如何对账，再离线恢复匹配的两个备份。**不能通过回滚旧账本丢弃已经成功的生成记录**。再次执行 `docker compose up -d --no-build --wait novelai-mcp`，按回滚目标版本验收工具调用后再放量；若回到旧的有会话版本，客户端按该版本的握手流程接入。

切勿用 `docker compose down -v`、卷清理或跳过鉴权来排错。图像备份本身仍是敏感数据，应限制访问并按保留策略销毁；5 分钟的在线访问期限不是备份的保留授权。

## 常见故障

- **网络不存在 / 上游不通**：核对 external network 名是否完全匹配、上游的网络别名和内部端口是否正确。容器内的 `localhost` 不是宿主或上游。
- **公网 404 但 `/health` 正常**：先区分 MCP 入口与图片短链；核对路径是否只去掉一层 `/mcp`，图片是否过期、扩展名是否与回执一致。不要把 `MCP_IMAGE_PUBLIC_BASE_URL` 写成 `…/mcp/mcp`。
- **个人客户端只看到 2 个工具**：检查 `tools/list` 这次请求是否带了 `Authorization: Bearer USER_API_KEY`，代理是否原样转发；更换凭据后刷新工具列表，不用换 ID。缺省头走匿名，格式不正确返回 401；把服务端保留密钥当作个人密钥发送返回 403。Origin 拒绝也可能返回 403。上游拒绝个人密钥不会回退到免费额度。
- **图片请求超时**：检查代理缓冲、请求体大小、读取超时及客户端超时。先核对上游是否已成功，避免自动重试产生第二次费用。
