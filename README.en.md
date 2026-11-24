# Qiandai API · NovelAI MCP

[简体中文](README.md) | [Operations guide (中文)](docs/QUICKSTART-HTTP.md) | [Tool reference (中文)](docs/QUICK-REFERENCE.md)

Add **`https://api.chiyotobi.party/mcp/mcp`** to a **Streamable HTTP** MCP client. The first `/mcp` is the reverse proxy prefix; the second is the protocol endpoint. You do not need Node.js or Docker to use the hosted service.

## Choose an access mode

| | Anonymous (omit Authorization) | Personal API key (paid) |
|---|---|---|
| Tools listed and callable | Only 2: `get_nai_prompt` and `generate_image` | All 9: the free pair plus `img2img`, `inpaint_image`, `augment_image`, `upscale_image`, `encode_vibe`, `suggest_tags` and `get_subscription` |
| Usage charged to | A server-side default credential; all anonymous users share the free pools | Your `USER_API_KEY` at the upstream service, not the free pools |
| Generation limits | One image; width and height must each be multiples of 64, width × height ≤ 1,048,576, steps ≤ 28. No image, precise or Vibe references | Tool and model input constraints still apply; the upstream service determines charges |

The **rolling five-hour window** counts V4.5 Full and Curated **together, up to 400 images**, and V5 Full and Curated **together, up to 100 images**. These are not separate allowances per user or model. A free request reserves a slot on disk before generation; a failed generation rolls back its reservation. Restarting with the same data volume does not reset usage. An invalid personal key does not fall back to the server's credential.

There are four models. **V5 Full** is the default for generation without references. For a paid request using precise or Vibe references, select the corresponding V4.5 model. Text-to-image generation returns one image in both modes (`n_samples` is fixed at 1).

| Family | Full | Curated |
|---|---|---|
| V5 | `nai-diffusion-5-full` (default) | `nai-diffusion-5-curated` |
| V4.5 | `nai-diffusion-4-5-full` | `nai-diffusion-4-5-curated` |

**Get the template before the first generation or edit.** Ask your assistant to call `get_nai_prompt` with `{}`, read the complete bundled [`prompts/novelAI_prompt.md`](prompts/novelAI_prompt.md), then compose the prompt. For example: “Get the template first, then draw a coastal lighthouse at 1024 × 1024 using the default model and no references.”

Image results include **the original image, a 43-character `image_id`, and a short link valid for five minutes (300 seconds) by default**. If the client does not render the image, open the link and save the original before expiry. Paid tools that take images can use the ID while the image is available. Do not treat IDs or short links as a permanent gallery or share them publicly. `get_subscription` queries upstream `/v1/usage` with your key and returns a Chinese balance/usage summary alongside the **complete original JSON**. The upstream service defines units, pricing and final charges.

## Client configuration

The examples below use a personal key. Replace `USER_API_KEY` only in your own client; it sends `Authorization: Bearer …` with each MCP request, including reconnects. **For anonymous access omit the entire `headers` field or the CLI authentication flag.** Do not send an empty Bearer header or put keys in URLs, shared configs, screenshots or source control.

### Cursor

Merge the entry into your MCP configuration; see also [example-config.json](example-config.json).

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

Paste this single object into **Add Server**, without a `mcpServers` wrapper:

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

Anonymous (omit `--header`):

```sh
claude mcp add --transport http qiandai-api-mcp https://api.chiyotobi.party/mcp/mcp
```

### Codex

Set the key in the **environment that runs Codex**. Use the command for your shell; keep actual secrets out of shared shell histories.

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

Anonymous access requires neither the environment variable nor `--bearer-token-env-var`:

```sh
codex mcp add qiandai-api-mcp --url https://api.chiyotobi.party/mcp/mcp
```

Reconnect and refresh the tool list after switching modes. Expect 2 tools without credentials and 9 with a personal key.

## Self-hosting

Use the supplied [Compose file](docker-compose.yml) and [Dockerfile](Dockerfile). The multi-stage Node 24 Debian image includes the platform-specific `sharp` dependencies and the full prompt template. The service runs as the non-root `node` user.

1. Copy [.env.example](.env.example) to an untracked, service-specific `.env`. Set `DEFAULT_NOVELAI_API_KEY` there and set `MCP_DOCKER_NETWORK` to the name of the **existing private network** containing the upstream. Never give the default server key to a client.
2. Check that `qiandaiapi-app` resolves on that network. Run `docker compose config --quiet`, then `docker compose up -d --build --wait novelai-mcp`. Compose runs a single instance with `restart: unless-stopped`.
3. From the host, run `curl -fsS http://127.0.0.1:13000/health` for process health. The container listens on `0.0.0.0:3000`; use `novelai-mcp:3000` from a proxy on its private network, or `127.0.0.1:${MCP_HOST_PORT:-13000}` from a host proxy. Do not publish the container port publicly.

| Compose setting | Default / purpose |
|---|---|
| `UPSTREAM_BASE_URL` | `http://qiandaiapi-app:8080` on the existing private network |
| `MCP_ALLOWED_ORIGINS` | `*`; may be restricted to a comma-separated list of origins. CORS is not authentication |
| `MCP_IMAGE_PUBLIC_BASE_URL` | `https://api.chiyotobi.party/mcp`, including the proxy prefix but not the protocol endpoint |
| `MCP_IMAGE_TTL_SECONDS` | `300`, the short link lifetime in seconds |
| `PORT` / `MCP_HOST_PORT` | Fixed `3000` in the container / loopback `13000` on the host by default |
| `MCP_DATA_DIR` | Volume `novelai-mcp-data` → `/var/lib/novelai-mcp/data`, for quota and the Vibe cache |
| `MCP_IMAGE_ARCHIVE_DIR` | Separate volume `novelai-mcp-images` → `/var/lib/novelai-mcp/images`, for temporary images |

The [Caddy route](deploy/caddy-route.caddy) strips the outer `/mcp` **once**: public `/mcp/health` maps to `/health`, and `/mcp/mcp` maps to `/mcp`. Preserve authorization and MCP session headers and disable buffering. A containerized proxy on the same network needs no host port mapping. Before an upgrade, retain the working image tag, drain requests, and back up both volumes and the proxy configuration. Replace the single instance; never let the old and new process write to the same volumes at once. To roll back, keep traffic drained, select the previous image/config and compatible volumes, then check health and the anonymous tool list before reopening traffic. See the [runbook](docs/QUICKSTART-HTTP.md) for the proxy configuration and rollback commands.

For local development, use Node.js 24 and run `npm ci`, `npm run build`, then `npm test` in the project root. To try the service, use a dedicated `.env` pointing at a reachable test upstream and set `MCP_BIND_HOST=127.0.0.1`. Run `npm run start:http`; the local MCP endpoint is `http://127.0.0.1:3000/mcp`.

[Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
