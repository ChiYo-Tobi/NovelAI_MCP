# Qiandai API · NovelAI MCP

[English](README.en.md) | [运维手册](docs/QUICKSTART-HTTP.md) | [使用速查](docs/QUICK-REFERENCE.md)

在支持 **Streamable HTTP** 的 MCP 客户端中添加 **`https://api.chiyotobi.party/mcp/mcp`**。第一个 `/mcp` 是反向代理前缀，第二个 `/mcp` 是协议端点。只使用托管服务的用户无需安装 Node.js 或 Docker。

## 选择匿名体验或个人密钥

| | 匿名（不发送 Authorization） | 个人密钥（付费） |
|---|---|---|
| 可见且可调用的工具 | 仅 2 个：`get_nai_prompt`、`generate_image` | 全部 9 个：免费两项 + `img2img`、`inpaint_image`、`augment_image`、`upscale_image`、`encode_vibe`、`suggest_tags`、`get_subscription` |
| 用量归属 | 使用服务端默认凭据；所有匿名用户共用免费池 | 向上游使用自己的 `USER_API_KEY`；不占用免费池 |
| 生图限制 | 每次 1 张；宽、高均为 64 的倍数，宽 × 高 ≤ 1,048,576，步数 ≤ 28；不允许任何参考图、精确参考或 Vibe 参考 | 工具、参考和模型组合须符合相应输入约束；计费以上游为准 |

免费额度按**过去 5 小时的滑动窗口**计算：V4.5 Full 与 Curated **合计 400 张**，V5 Full 与 Curated **合计 100 张**。不是每个用户或每个模型各有一份。并发请求在出图前先持久化预占，生成失败回滚该次预占；保留数据卷重启不会重置额度。传入无效个人密钥不会自动降级为免费调用。

支持以下四个模型。**V5 Full** 是无参考生图的默认模型；付费使用精确或 Vibe 参考时请选择相应的 V4.5 模型。两种模式下文生图都只生成一张，`n_samples` 固定为 1。

| 系列 | Full | Curated |
|---|---|---|
| V5 | `nai-diffusion-5-full`（默认） | `nai-diffusion-5-curated` |
| V4.5 | `nai-diffusion-4-5-full` | `nai-diffusion-4-5-curated` |

**首次出图或重绘前先取模板。** 在客户端要求助手用 `{}` 调用 `get_nai_prompt`，读取服务随附的完整 [`prompts/novelAI_prompt.md`](prompts/novelAI_prompt.md)，再据此组织提示词。例如：「先取模板，用默认模型画一张 1024 × 1024 的海边灯塔，不使用参考图。」

回执包含**原图、43 位 `image_id` 和默认 5 分钟（300 秒）有效的图片短链**。客户端不显示内嵌图片时，及时打开链接另存原图；支持图像输入的付费工具可在有效期内使用 ID。不要公开 ID 或短链，也不要把它们当作永久图库。`get_subscription` 以个人密钥查询上游 `/v1/usage`，返回余额/用量中文摘要及**完整原始 JSON**；数字的单位、扣费规则和最终金额均以上游为准。

## 客户端配置

以下是付费配置。`USER_API_KEY` 仅为占位符，请在自己的客户端替换；每次 MCP 请求（包括重连）都由客户端发送 `Authorization: Bearer …`。**匿名用户删除整个 `headers` 字段或下述 CLI 的鉴权参数**，不要发送空的 Bearer 头。不要把密钥放入 URL、仓库、截图或共享的配置文件。

### Cursor

在 MCP 配置中合并下列条目，或参考 [example-config.json](example-config.json)：

```json
{
  "mcpServers": {
    "qiandai-api-mcp": {
      "url": "https://api.chiyotobi.party/mcp/mcp",
      "headers": { "Authorization": "Bearer USER_API_KEY" }
    }
  }
}
```

### Cherry Studio

```json
{
  "mcpServers": {
    "qiandai-api-mcp": {
      "name": "qiandai-api-mcp",
      "type": "streamableHttp",
      "baseUrl": "https://api.chiyotobi.party/mcp/mcp",
      "headers": { "Authorization": "Bearer USER_API_KEY" },
      "timeout": 600
    }
  }
}
```

### AstrBot

在「添加服务器」中粘贴这一个对象，不需要 `mcpServers` 外层：

```json
{
  "transport": "streamable_http",
  "url": "https://api.chiyotobi.party/mcp/mcp",
  "headers": { "Authorization": "Bearer USER_API_KEY" },
  "timeout": 30,
  "sse_read_timeout": 300
}
```

### Claude Code

```sh
claude mcp add --transport http qiandai-api-mcp https://api.chiyotobi.party/mcp/mcp --header "Authorization: Bearer USER_API_KEY"
```

匿名配置（不添加 `--header`）：

```sh
claude mcp add --transport http qiandai-api-mcp https://api.chiyotobi.party/mcp/mcp
```

### Codex

在**运行 Codex 的同一环境**提供个人密钥，选择一种方式，不要把真实值留在共享终端历史中：

```sh
# Linux / macOS / POSIX shell
export QIANDAI_MCP_API_KEY='USER_API_KEY'
```

```powershell
# Windows PowerShell
$env:QIANDAI_MCP_API_KEY = 'USER_API_KEY'
```

```cmd
:: Windows cmd.exe
set "QIANDAI_MCP_API_KEY=USER_API_KEY"
```

```sh
codex mcp add qiandai-api-mcp --url https://api.chiyotobi.party/mcp/mcp --bearer-token-env-var QIANDAI_MCP_API_KEY
```

匿名时无需设置环境变量，也不传 `--bearer-token-env-var`：

```sh
codex mcp add qiandai-api-mcp --url https://api.chiyotobi.party/mcp/mcp
```

切换接入方式后重新连接并刷新工具列表，匿名应看到 2 个工具，使用个人密钥应看到 9 个。

## 自行运行

推荐用仓库的 [Compose 配置](docker-compose.yml) 和 [Dockerfile](Dockerfile)。镜像用 Node 24 Debian 分阶段编译、保留 `sharp` 所需的平台依赖及完整提示词模板，以非 root 的 `node` 用户运行。

1. 将 [.env.example](.env.example) 复制为项目专用、不入库的 `.env`，填入服务端 `DEFAULT_NOVELAI_API_KEY` 和**已经存在**的上游私有网络名 `MCP_DOCKER_NETWORK`。不要把服务端默认密钥配给客户端。
2. 确认该网络内可解析 `qiandaiapi-app`，再执行 `docker compose config --quiet`、`docker compose up -d --build --wait novelai-mcp`。Compose 默认为单实例，重启策略 `unless-stopped`。
3. 宿主机用 `curl -fsS http://127.0.0.1:13000/health` 检查进程。容器监听 `0.0.0.0:3000`，同网反代访问 `novelai-mcp:3000`；宿主反代使用 `127.0.0.1:${MCP_HOST_PORT:-13000}`。不要把容器端口发布到公网。

| Compose 运行参数 | 默认值 / 用途 |
|---|---|
| `UPSTREAM_BASE_URL` | `http://qiandaiapi-app:8080`，现有私网内的上游 |
| `MCP_ALLOWED_ORIGINS` | `*`；可限制为逗号分隔的 Origin。跨域策略不代替鉴权 |
| `MCP_IMAGE_PUBLIC_BASE_URL` | `https://api.chiyotobi.party/mcp`，含外层前缀，不含协议端点 |
| `MCP_IMAGE_TTL_SECONDS` | `300`，图片链接有效秒数 |
| `PORT` / `MCP_HOST_PORT` | 容器固定 `3000` / 宿主回环默认 `13000` |
| `MCP_DATA_DIR` | 卷 `novelai-mcp-data` → `/var/lib/novelai-mcp/data`，保存额度和 Vibe 缓存 |
| `MCP_IMAGE_ARCHIVE_DIR` | 独立卷 `novelai-mcp-images` → `/var/lib/novelai-mcp/images`，保存限时图片 |

[现成的 Caddy 片段](deploy/caddy-route.caddy) 只剥掉一次外层 `/mcp`：公网 `/mcp/health` 对应内部 `/health`，`/mcp/mcp` 对应 `/mcp`。保留鉴权头、会话头和流式响应；同网容器反代无需发布宿主端口。升级前先保留旧镜像标签，排空请求后备份两个卷及代理配置，再替换单实例；不要同时用新旧进程写同一个卷。详见[网络、反代和回滚操作](docs/QUICKSTART-HTTP.md)。

本地开发使用 Node.js 24：在项目根依次执行 `npm ci`、`npm run build`、`npm test`。本机试运行用专用 `.env` 指向可达的测试上游，并设置 `MCP_BIND_HOST=127.0.0.1`；启动命令为 `npm run start:http`。本机协议地址是 `http://127.0.0.1:3000/mcp`。

[贡献指南](CONTRIBUTING.md) · [MIT 许可证](LICENSE)
