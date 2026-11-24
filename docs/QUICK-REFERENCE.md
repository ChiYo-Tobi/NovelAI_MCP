# 工具和图片速查

接入地址是 `https://api.chiyotobi.party/mcp/mcp`，传输方式为 Streamable HTTP。每次请求均不带 `Authorization` 是匿名模式；每次请求均带 `Authorization: Bearer USER_API_KEY` 是个人密钥模式。换密钥或模式后新建会话。具体参数以该会话的 `tools/list` schema 为准。

| 工具 | 匿名 | 个人 | 输入 / 返回 |
|---|:---:|:---:|---|
| `get_nai_prompt` | ✓ | ✓ | 无参数 `{}`，返回完整提示词模板；首次生图或重绘前先调用 |
| `generate_image` | ✓ | ✓ | 传 `base_prompt` 文生图，`model` 默认 V5 Full；`n_samples` 固定为 1 |
| `img2img` | — | ✓ | 用 `source_image`、`base_prompt` 重绘；`strength` 调整改动幅度 |
| `inpaint_image` | — | ✓ | 源图、提示词加 `mask_image` 或 `mask_regions`；不要传 Vibe 参考 |
| `augment_image` | — | ✓ | `source_image` 加 `req_type`，如线稿、着色或去背景 |
| `upscale_image` | — | ✓ | 放大源图；默认先将过大输入等比缩到 1,048,576 像素以内 |
| `encode_vibe` | — | ✓ | 为 V4.5 编码风格参考，返回可在相同模型中复用的 `vibe_id`；它不是图片 ID |
| `suggest_tags` | — | ✓ | 根据 `prompt` 片段建议标签；支持 `en`、`jp` |
| `get_subscription` | — | ✓ | 查询上游 `/v1/usage`，返回当前个人密钥的余额/用量中文摘要及完整原始 JSON。计费单位和扣费规则以上游为准 |

## 第一次调用

1. 调用 `get_nai_prompt`，参数 `{}`。模板是随服务交付的完整 [`prompts/novelAI_prompt.md`](../prompts/novelAI_prompt.md)，不是另一个服务或网页。
2. 按模板组织 `base_prompt`。下面仅演示 `generate_image` 的参数形状，两种模式都可用：

   ```json
   {
     "base_prompt": "coastal lighthouse, ocean, dawn, watercolor",
     "model": "nai-diffusion-5-full",
     "width": 1024,
     "height": 1024,
     "steps": 23,
     "n_samples": 1
   }
   ```

3. 将返回的原图和标注的下载链接展示给用户。需要长期保存时下载原图；默认 300 秒后链接和 ID 不再可读。若原图已返回但保存短链失败，不要自动重试生成，以免重复扣费。

## 模型和免费额度

- V5：`nai-diffusion-5-full`（无参考时默认）、`nai-diffusion-5-curated`。V5 支持透明背景，不支持 Vibe 或精确参考。
- V4.5：`nai-diffusion-4-5-full`、`nai-diffusion-4-5-curated`。付费请求可选择精确参考或 Vibe 参考，不能混用。使用参考时建议显式指定模型。
- 匿名仅限纯文生图。一张图的宽、高均须是 64 的正整数倍，总像素不超过 1,048,576，步数不超过 28。不要传参考字段，空数组也不行。
- 所有匿名用户共用过去 5 小时的两池：V4.5 合计 400 张、V5 合计 100 张。并发调用先预占，失败回滚；数据卷保留时重启不重置。达到限额请等最早一笔移出窗口或切换个人密钥，不要不断重试。

## 图片输入和下载

付费工具的 `source_image` 等图像参数接受有效期内的 **43 位 `image_id`**、本站原始短链、公网 HTTPS 图片直链、Base64 或 `data:image/...;base64,...`。不能传服务器文件路径、`file:` URL 或私网下载地址。用图像 ID 做下一步处理不必把大图上传第二次。

公网图片路径为 `/mcp/novelai-images/{image_id}.{ext}`（`ext` 为 `png`、`webp` 或 `jpg`，应使用回执里的实际扩展名）。归档到期后，知道 ID 或还有链接都不能重新读取；保留命名卷不会延长 TTL。服务端的额度和 Vibe 缓存与这些短期图片分卷保存。

[五种客户端的完整配置](../README.md) · [运行、反代与回滚](QUICKSTART-HTTP.md)
