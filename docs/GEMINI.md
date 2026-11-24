# 在其他 Streamable HTTP 客户端接入

如果你的 Gemini 或其他客户端支持自定义远程 MCP 服务，先确认它支持 **Streamable HTTP** 以及你要用的鉴权方式。以下只涉及协议配置，不假定某个版本或账号一定有该入口。

| 客户端能力 | 如何配置 |
|---|---|
| 可以填写服务 URL | 填 `https://api.chiyotobi.party/mcp/mcp`，不是图片基址或健康检查地址 |
| 只能填写 URL，不能附带自定义请求头 | 使用匿名体验。不要把密钥附在域名、路径或查询参数里 |
| 可以为每次请求添加 HTTP header | 个人密钥模式填写 `Authorization: Bearer USER_API_KEY`；匿名模式完全不发送该头 |

初始化后刷新工具列表。匿名只应出现 `get_nai_prompt` 和 `generate_image`；个人密钥模式有 9 个工具。切换密钥或模式时重新初始化会话。先让助手用 `{}` 调用 `get_nai_prompt` 读取完整模板，再提出绘图要求。

生成结果包含原图；客户端没有显示内嵌图片时，请从回执打开下载链接并在默认的 5 分钟内保存。链接和 43 位 `image_id` 都不是永久存储，谁持有未过期的图片链接就可能读取图片。不要把真实链接、密钥或回执贴到公开日志。

Cursor、Cherry Studio、AstrBot、Claude Code 与 Codex 的完整示例见[中文 README](../README.md) 或 [English README](../README.en.md)。
