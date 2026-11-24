import { readFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { Ajv } from 'ajv';
import type { FreeQuota } from './free-quota.js';
import { archivePublicUrl, DEFAULT_IMAGE_TTL_MS, saveArchivedImage } from './image-archive.js';
import type { ArchiveMetadataInput } from './image-archive.js';
import {
  ensurePngBuffer, extractPngTextMetadata, fitImageToMaxPixels, generateMaskFromRegions, getImageDimensions,
  prepareImg2ImgImage, prepareInpaintMask, preparePreciseReferenceImage, resolveImageInput,
} from './image-input.js';
import { alignDimension, ENCODE_VIBE_MODELS, MAX_SEED, MAX_VIBE_REFERENCES, resolveGenerationModel, validateGenerationFeatures } from './model-registry.js';
import { DEFAULT_UPSCALE_MODEL, type NovelAIClient } from './novelai-client.js';
import {
  AUGMENT_REQ_TYPES, DEFAULT_MODEL, EMOTION_MOODS, IMAGE_FORMATS, IMAGE_MODELS, NOISE_SCHEDULES,
  PRECISE_REFERENCE_TYPES, QUALITY_PRESETS, SAMPLERS, UC_PRESET_NAMES,
} from './types.js';
import type {
  Action, AugmentReqType, CharacterReferenceInput, EmotionMood, ImageGenerationParams, MaskRegion,
  Model, SuggestTagsParams, UnpackedImage, VibeReferenceInput,
} from './types.js';
import { VibeCache, vibeCacheKey } from './vibe-cache.js';

export const SERVER_NAME = 'novelai-mcp-server';
export const SERVER_VERSION = '2.0.0';

const FREE_ONLY = '当前为免费体验模式，仅支持文生图（generate_image）与提示词模板（get_nai_prompt）。请在请求头配置 Authorization: Bearer <您的API_KEY> 解锁全部功能。';
const PROMPT_HINT = '首次调用 generate_image、img2img 或 inpaint_image 前，请先调用 get_nai_prompt 读取完整的 NovelAI 提示词模板。';
const PROMPT_FILE = new URL('../prompts/novelAI_prompt.md', import.meta.url);
const IMAGE_INPUT = '接受归档 ID、本站图片链接、公网 HTTPS 图片链接、图像 Base64 或图像数据 URI。';
const IMAGE_RECEIPT = '向用户展示回执中每张图片的下载链接。';
const DEFAULT_NEGATIVE_PROMPT = 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry';
const DEFAULT_WIDTH = 832;
const DEFAULT_HEIGHT = 1216;
const MAX_DIMENSION = 49152;
const MAX_GENERATION_PIXELS = 3145728;
const ONE_MEGAPIXEL = 1048576;
const MAX_FREE_STEPS = 28;
const MAX_REFERENCE_BYTES = 40 * 1024 * 1024;
const DEFAULT_REFERENCE_MODEL: Model = 'nai-diffusion-4-5-full';

const bounded = (type: 'number' | 'integer', description: string, minimum: number, maximum: number) => (
  { type, description, minimum, maximum }
);
const choice = (description: string, values: readonly string[]) => ({ type: 'string', description, enum: [...values] });
const flag = (description: string) => ({ type: 'boolean', description });
const text = (description: string) => ({ type: 'string', description });
const nonempty = (description: string) => ({ ...text(description), minLength: 1 });
const unit = (description: string) => bounded('number', description, 0, 1);
const dimension = (description: string) => bounded('integer', description, 1, MAX_DIMENSION);
type Properties = NonNullable<Tool['inputSchema']['properties']>;
const object = (properties: Properties, required: string[] = []) => (
  { type: 'object' as const, properties, required, additionalProperties: false }
);

const modelField = { ...choice(`出图模型。省略时默认 ${DEFAULT_MODEL}（V5 Full）。`, IMAGE_MODELS), default: DEFAULT_MODEL };
const generationFields = {
  base_prompt: nonempty('全局场景与风格提示词。'),
  base_negative_prompt: text('全局负面提示词。省略或传空字符串时使用默认负面提示词。'),
  characters: {
    type: 'array', description: '独立角色提示词。V4.5 最多 6 个，V5 最多 32 个。', maxItems: 32,
    items: object({
      prompt: nonempty('该角色的提示词。'), negative_prompt: text('该角色的负面提示词。'),
      center_x: unit('归一化水平坐标，默认 0.5。'), center_y: unit('归一化垂直坐标，默认 0.5。'),
    }, ['prompt']),
  },
  model: modelField,
  steps: bounded('integer', '采样步数，省略时采用模型默认值。', 1, 50),
  seed: bounded('integer', '随机种子，省略或传非正数时随机生成。', Number.MIN_SAFE_INTEGER, MAX_SEED),
  n_samples: { type: 'integer', const: 1, default: 1, description: '每次固定生成 1 张图片。' },
  scale: bounded('number', '提示词引导强度。', 0, 10),
  cfg_rescale: unit('引导强度重缩放。'),
  sampler: choice('采样器。局部重绘会自动改用兼容的采样器。', SAMPLERS),
  noise_schedule: choice('噪声日程；native 会转换为 karras。', NOISE_SCHEDULES),
  variety_plus: flag('启用 V4.5 的 Variety+。'),
  skip_cfg_above_sigma: { type: 'number', minimum: 0, description: '手动设置 V4.5 跳过引导的噪声阈值。' },
  use_coords: flag('采用角色坐标。省略时，有独立角色则自动启用。'),
  quality_preset: choice('质量预设，none 关闭。', QUALITY_PRESETS),
  uc_preset: choice('负面提示词预设。', UC_PRESET_NAMES),
  transparent_background: flag('生成透明背景，仅 V5 系列支持。'),
  image_format: choice('出图格式，默认 PNG。', IMAGE_FORMATS),
  uncond_scale: bounded('number', '负面提示词强度。', 0, 1.5),
  legacy_uc: flag('使用旧版负面提示词处理。'),
};
const preciseField = {
  type: 'array', description: '精确参考，与风格参考互斥。使用时必须显式选择 V4.5 模型。',
  items: object({
    image: nonempty(IMAGE_INPUT), type: choice('参考类型。', PRECISE_REFERENCE_TYPES),
    strength: unit('参考影响强度，默认 1。'), fidelity: unit('参考保真度，默认 1。'),
  }, ['image', 'type']),
};
const vibeFields = {
  vibe_references: {
    type: 'array', maxItems: MAX_VIBE_REFERENCES,
    description: 'V4.5 风格参考；请显式选择与编码匹配的 V4.5 模型。局部重绘不支持。',
    items: object({
      image: nonempty(`源参考图。${IMAGE_INPUT}每项在 image、vibe_id、encoded_vibe 中选一项。`),
      vibe_id: nonempty('同一模型此前返回的 vibe_id。'), encoded_vibe: nonempty('同一模型的风格编码（纯 Base64）。'),
      strength: unit('参考影响强度，默认 0.6。'), information_extracted: unit('原图信息提取比例，默认 1。'),
    }),
  },
  normalize_vibe_strength: flag('自动归一化风格参考强度，默认开启。'),
};
const sourceFields = {
  ...generationFields, character_references: preciseField,
  source_image: nonempty(IMAGE_INPUT),
  width: dimension('输出宽度（像素），对齐到 64 的倍数，省略时按原图。'),
  height: dimension('输出高度（像素），对齐到 64 的倍数，省略时按原图。'),
  noise: unit('添加的噪声，默认 0。'),
};

function tool(name: string, description: string, properties: Properties, required: string[] = [], readOnly = false, openWorld = true): Tool {
  return {
    name, description, inputSchema: object(properties, required),
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: openWorld },
  };
}

const generateDescription = `按提示词生成图片，默认使用 V5 Full。${PROMPT_HINT}${IMAGE_RECEIPT}`;
const promptTool = tool('get_nai_prompt', PROMPT_HINT, {}, [], true, false);
const paidTools = [
  tool('generate_image', generateDescription, {
    ...generationFields, character_references: preciseField, ...vibeFields,
    width: { ...dimension('输出宽度（像素），对齐到 64 的倍数。'), default: DEFAULT_WIDTH },
    height: { ...dimension('输出高度（像素），对齐到 64 的倍数。'), default: DEFAULT_HEIGHT },
  }, ['base_prompt']),
  tool('img2img', `用提示词重绘源图，strength 越大改动越多。${PROMPT_HINT}${IMAGE_RECEIPT}`, {
    ...sourceFields, ...vibeFields, strength: unit('去噪强度，默认 0.7。'),
    color_correct: flag('校正颜色以贴近原图，默认开启。'),
    extra_noise_seed: bounded('integer', '额外噪声种子，默认沿用出图种子。', 1, MAX_SEED),
  }, ['base_prompt', 'source_image']),
  tool('inpaint_image', `重绘源图指定区域。提供 mask_image 或 mask_regions；不接受 vibe_references。${PROMPT_HINT}${IMAGE_RECEIPT}`, {
    ...sourceFields,
    mask_image: nonempty(`黑色保留，白色重绘。与 mask_regions 同时提供时优先使用此遮罩。${IMAGE_INPUT}`),
    mask_regions: {
      type: 'array', minItems: 1, maxItems: 64, description: '最多 64 个矩形或椭圆，以画面左上角为原点。',
      items: object({
        shape: choice('区域形状，默认矩形。', ['rect', 'ellipse']), x: unit('左侧相对位置。'), y: unit('上侧相对位置。'),
        width: { ...unit('相对宽度。'), exclusiveMinimum: 0 }, height: { ...unit('相对高度。'), exclusiveMinimum: 0 },
      }, ['x', 'y', 'width', 'height']),
    },
    inpaint_strength: unit('遮罩内重绘强度，默认 1。'), add_original_image: flag('用原图合成遮罩外区域，默认开启。'),
  }, ['base_prompt', 'source_image']),
  tool('augment_image', `对源图抽线稿、转素描、着色、清理画面、改变表情、移除背景或调整像素。${IMAGE_RECEIPT}`, {
    source_image: nonempty(IMAGE_INPUT), req_type: choice('图像处理方式。', AUGMENT_REQ_TYPES),
    emotion: choice('表情名称，req_type 为 emotion 时必须提供。', EMOTION_MOODS),
    prompt: text('补充提示词。'), defry: bounded('integer', '着色降噪或表情减弱程度，只用于 colorize 和 emotion。', 0, 5),
    width: dimension('处理宽度，默认沿用源图。'), height: dimension('处理高度，默认沿用源图。'),
  }, ['source_image', 'req_type']),
  tool('upscale_image', `4 倍超分辨率放大图片。默认先将超过 1,048,576 像素的输入等比缩小。${IMAGE_RECEIPT}`, {
    source_image: nonempty(IMAGE_INPUT), model: { ...nonempty('放大使用的上游模型标识。'), default: DEFAULT_UPSCALE_MODEL },
    declared_blur_sigma: { type: 'number', minimum: 0, description: '显式声明的源图模糊程度。' },
    auto_fit_1mp: { ...flag('自动等比缩小过大的输入图。'), default: true },
  }, ['source_image']),
  tool('encode_vibe', '为 V4.5 编码风格参考，同一模型的后续生图或图生图可用 vibe_id 复用。', {
    source_image: nonempty(IMAGE_INPUT), model: { ...choice('编码模型，默认 V4.5 Full。', ENCODE_VIBE_MODELS), default: DEFAULT_REFERENCE_MODEL },
    information_extracted: { ...unit('信息提取比例。'), default: 1 }, mask_image: nonempty(`可选参考遮罩。${IMAGE_INPUT}`),
    crop_to_mask: flag('编码时裁剪到遮罩区域，启用时必须提供 mask_image。'),
    include_raw_base64: { ...flag('同时返回原始 Base64 编码。'), default: false },
  }, ['source_image']),
  tool('suggest_tags', '按提示词片段查询 NovelAI 标签建议，返回标签 JSON。', {
    prompt: nonempty('需要补全的提示词片段。'), model: modelField,
    lang: { ...choice('标签语言。', ['en', 'jp']), default: 'en' }, limit: { ...bounded('integer', '最多返回的标签数。', 1, 100), default: 20 },
  }, ['prompt'], true),
  tool('get_subscription', '查询当前 API Key 在中转站的账户余额与用量信息（调用 /v1/usage），返回中文摘要与完整的上游 JSON。', {}, [], true),
  promptTool,
];
export const TOOL_COUNT = paidTools.length;

const freeSize = (label: string, value: number) => ({
  ...bounded('integer', `${label}（像素）：须为 64 的倍数，宽 × 高不超过 1,048,576。`, 64, MAX_DIMENSION),
  multipleOf: 64, default: value,
});
const freeTools = [
  tool('generate_image', `${generateDescription}免费体验仅限纯文生图，宽高须为 64 的倍数，总像素不超过 1,048,576，至多 28 步。`, {
    ...generationFields, width: freeSize('宽度', DEFAULT_WIDTH), height: freeSize('高度', DEFAULT_HEIGHT),
    steps: bounded('integer', '采样步数，免费体验最多 28 步。', 1, MAX_FREE_STEPS),
  }, ['base_prompt']),
  promptTool,
];
const ajv = new Ajv({ ownProperties: true });
function compileTools(tools: Tool[]) {
  return { tools, validators: new Map(tools.map(({ name, inputSchema }) => [name, ajv.compile(inputSchema)])) };
}
const catalogs = { paid: compileTools(paidTools), free: compileTools(freeTools) };

export interface NovelAIMcpServerOptions {
  mode: 'free' | 'paid';
  client: Pick<NovelAIClient, 'generateImage' | 'augmentImage' | 'upscaleImage' | 'encodeVibe' | 'suggestTags' | 'getSubscription'>;
  archiveDir?: string;
  imageOrigin?: URL;
  vibeCache?: VibeCache;
  quota?: Pick<FreeQuota, 'run'>;
  imageTtlMs?: number;
  transportLabel?: string;
}

interface GenerationArguments {
  base_prompt: string; base_negative_prompt?: string;
  characters?: { prompt: string; negative_prompt?: string; center_x?: number; center_y?: number }[];
  model?: Model; width?: number; height?: number; steps?: number; seed?: number; n_samples?: number;
  scale?: number; cfg_rescale?: number; sampler?: ImageGenerationParams['sampler']; noise_schedule?: ImageGenerationParams['noise_schedule'];
  variety_plus?: boolean; skip_cfg_above_sigma?: number; use_coords?: boolean;
  quality_preset?: ImageGenerationParams['qualityPresetId']; uc_preset?: ImageGenerationParams['ucPresetId'];
  transparent_background?: boolean; image_format?: ImageGenerationParams['image_format']; uncond_scale?: number; legacy_uc?: boolean;
  character_references?: CharacterReferenceInput[]; vibe_references?: VibeReferenceInput[]; normalize_vibe_strength?: boolean;
  source_image?: string; strength?: number; noise?: number; color_correct?: boolean; extra_noise_seed?: number;
  mask_image?: string; mask_regions?: MaskRegion[]; inpaint_strength?: number; add_original_image?: boolean;
}

const asText = (value: string) => ({ type: 'text' as const, text: value });
const asJson = (value: object): CallToolResult => ({ content: [asText(JSON.stringify(value))] });
const failure = (message: string): CallToolResult => ({ isError: true, content: [asText(message)] });

function checkVibeReference(ref: VibeReferenceInput): void {
  if ([ref.image, ref.encoded_vibe, ref.vibe_id].filter(value => value !== undefined).length !== 1) {
    throw new Error('每个风格参考必须提供 image、vibe_id 或 encoded_vibe 中的一项');
  }
  if (ref.encoded_vibe && (ref.encoded_vibe.length > MAX_REFERENCE_BYTES || ref.encoded_vibe.length % 4 === 1 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(ref.encoded_vibe))) {
    throw new Error('encoded_vibe 必须是有效的纯 Base64 编码');
  }
}

function ttlNotice(ms: number): string {
  const duration = ms % 60000 === 0 ? `${ms / 60000} 分钟` : ms % 1000 === 0 ? `${ms / 1000} 秒` : `${ms} 毫秒`;
  return `图片下载链接 ${duration}内有效，过期将自动清理。`;
}

export function createNovelAIMcpServer(options: NovelAIMcpServerOptions): Server {
  const { mode, client, archiveDir, imageOrigin, quota, imageTtlMs = DEFAULT_IMAGE_TTL_MS, transportLabel = 'MCP' } = options;
  if (mode !== 'free' && mode !== 'paid') throw new Error('必须指定免费或付费服务模式');
  if (!Number.isSafeInteger(imageTtlMs) || imageTtlMs <= 0) throw new Error('imageTtlMs 必须为正整数毫秒');
  const { tools, validators } = catalogs[mode];
  const vibeCache = options.vibeCache ?? new VibeCache();
  const readImage = (input: string) => resolveImageInput(input, { archiveDir, imageOrigin, imageTtlMs });

  async function receipt(images: UnpackedImage[], meta: ArchiveMetadataInput, vibeIds: string[] = []): Promise<CallToolResult> {
    const lines = [`NovelAI 已返回 ${images.length} 张图片。`];
    let hasDownload = false;
    for (const [index, image] of images.entries()) {
      const size = await getImageDimensions(image.buffer).catch(() => undefined);
      const comment = image.ext === 'png' ? extractPngTextMetadata(image.buffer).Comment : undefined;
      const embeddedSeed = comment && typeof comment === 'object' && 'seed' in comment && typeof comment.seed === 'number' ? comment.seed : undefined;
      const outputSeed = image.seed ?? embeddedSeed;
      const metadata = { ...meta, width: size?.width ?? meta.width, height: size?.height ?? meta.height, seed: outputSeed ?? meta.seed };
      const parts = [`图 ${index + 1}`];
      if (metadata.model) parts.push(`模型 ${metadata.model}`);
      if (metadata.width !== undefined && metadata.height !== undefined) parts.push(`${metadata.width}×${metadata.height}`);
      if (metadata.seed !== undefined) parts.push(`${outputSeed === undefined ? '请求 ' : ''}seed ${metadata.seed}`);
      if (archiveDir) {
        try {
          const { id, ext } = await saveArchivedImage(archiveDir, image.buffer, metadata);
          parts.push(`image_id ${id}`);
          if (imageOrigin) {
            parts.push(`[查看或下载图片](${archivePublicUrl(imageOrigin, id, ext)})`);
            hasDownload = true;
          }
        } catch {
          console.error(`[${transportLabel}] 写入图片归档失败`);
          parts.push('服务器保存失败，本张没有下载链接。请勿为同一结果自动重新出图。');
        }
      }
      lines.push(parts.join(' · '));
    }
    if (meta.note) lines.push(meta.note);
    if (vibeIds.length) lines.push(`可复用的 vibe_id：${[...new Set(vibeIds)].join('、')}。`);
    if (hasDownload) lines.push(ttlNotice(imageTtlMs));
    return { content: [asText(lines.join('\n')), ...images.map(({ mimeType, buffer }) => ({
      type: 'image' as const, mimeType, data: buffer.toString('base64'),
    }))] };
  }

  async function encodeReference(image: Buffer, model: Model, informationExtracted: number, mask?: Buffer, cropToMask?: boolean) {
    const normalized = await ensurePngBuffer(image);
    const normalizedMask = mask ? await ensurePngBuffer(mask) : undefined;
    const info = Number(informationExtracted.toFixed(4));
    const key = vibeCacheKey(normalized, model, info, normalizedMask, cropToMask);
    return vibeCache.getOrEncode(key, model, info, () => client.encodeVibe({
      image: normalized.toString('base64'), model, information_extracted: info,
      mask: normalizedMask?.toString('base64'), crop_to_mask: cropToMask,
    }));
  }

  async function generate(name: string, args: GenerationArguments, action: Action): Promise<CallToolResult> {
    if (!args.base_prompt.trim()) throw new Error('base_prompt 不能为空');
    const hasPrecise = Boolean(args.character_references?.length);
    const hasVibes = Boolean(args.vibe_references?.length);
    if (hasPrecise && hasVibes) throw new Error('精确参考与风格参考不能同时使用');
    const model = args.model ?? DEFAULT_MODEL;
    if (args.model === undefined && (hasPrecise || hasVibes)) {
      throw new Error(`默认模型 ${DEFAULT_MODEL} 不支持参考图；请显式选择 V4.5 模型（${ENCODE_VIBE_MODELS.join('、')}）。`);
    }
    const params: ImageGenerationParams = {
      action, model, prompt: args.base_prompt, negative_prompt: args.base_negative_prompt || DEFAULT_NEGATIVE_PROMPT,
      steps: args.steps, seed: args.seed, n_samples: 1, scale: args.scale, cfg_rescale: args.cfg_rescale,
      sampler: args.sampler, noise_schedule: args.noise_schedule, variety_plus: args.variety_plus,
      skip_cfg_above_sigma: args.skip_cfg_above_sigma, use_coords: args.use_coords,
      qualityPresetId: args.quality_preset, ucPresetId: args.uc_preset, transparent_background: args.transparent_background,
      image_format: args.image_format, uncond_scale: args.uncond_scale, legacy_uc: args.legacy_uc,
      characterPrompts: args.characters?.map(c => ({
        prompt: c.prompt, uc: c.negative_prompt ?? '', center: { x: c.center_x ?? 0.5, y: c.center_y ?? 0.5 }, enabled: true,
      })),
      ...(args.character_references !== undefined && { characterReferences: args.character_references }),
      ...(args.vibe_references !== undefined && { vibeReferences: args.vibe_references }),
      ...(args.normalize_vibe_strength !== undefined && { normalize_reference_strength_multiple: args.normalize_vibe_strength }),
    };
    const { capability } = resolveGenerationModel(model, action);
    validateGenerationFeatures(params, capability);
    for (const ref of args.vibe_references ?? []) checkVibeReference(ref);
    if (action === 'infill' && !args.mask_image && !args.mask_regions?.length) throw new Error('请提供 mask_image 或至少一个 mask_regions');

    const source = args.source_image !== undefined ? await readImage(args.source_image) : undefined;
    const sourceSize = source ? await getImageDimensions(source) : undefined;
    const rawWidth = args.width ?? sourceSize?.width ?? DEFAULT_WIDTH;
    const rawHeight = args.height ?? sourceSize?.height ?? DEFAULT_HEIGHT;
    if (mode === 'free') {
      if (rawWidth % 64 || rawHeight % 64) throw new Error('免费体验的 width 和 height 必须为 64 的倍数');
      if (rawWidth * rawHeight > ONE_MEGAPIXEL) throw new Error('免费体验的 width × height 不能超过 1,048,576 像素');
      if ((args.steps ?? capability.defaultSteps) > MAX_FREE_STEPS) throw new Error('免费体验的 steps 不能超过 28');
    }
    const width = alignDimension(rawWidth), height = alignDimension(rawHeight);
    if (width * height > MAX_GENERATION_PIXELS) throw new Error('图片最多支持 3,145,728 像素，请缩小宽度或高度');
    params.width = width;
    params.height = height;
    if (source) params.image = (await prepareImg2ImgImage(source, width, height)).toString('base64');
    if (action === 'img2img') {
      params.strength = args.strength;
      params.noise = args.noise;
      params.color_correct = args.color_correct;
      params.extra_noise_seed = args.extra_noise_seed;
    } else if (action === 'infill') {
      const mask = args.mask_image ? await prepareInpaintMask(await readImage(args.mask_image), width, height)
        : await generateMaskFromRegions(width, height, args.mask_regions!);
      params.mask = mask.toString('base64');
      params.add_original_image = args.add_original_image;
      params.inpaintImg2ImgStrength = args.inpaint_strength;
      params.noise = args.noise;
    }

    let referenceBytes = 0;
    const reserve = (bytes: number) => {
      referenceBytes += bytes;
      if (referenceBytes > MAX_REFERENCE_BYTES) throw new Error('参考图合计大于 40 MiB，请缩小图片或用 vibe_id 复用编码');
    };
    if (args.character_references) {
      params.characterReferences = [];
      for (const ref of args.character_references) {
        const image = await preparePreciseReferenceImage(await readImage(ref.image));
        reserve(image.length);
        params.characterReferences.push({ ...ref, image: image.toString('base64') });
      }
    }
    const vibeIds: string[] = [];
    if (args.vibe_references) {
      const prepared: VibeReferenceInput[] = [];
      const pending: { index: number; image: Buffer; info: number }[] = [];
      for (const ref of args.vibe_references) {
        if (ref.vibe_id) {
          const cached = await vibeCache.getById(ref.vibe_id);
          if (!cached) throw new Error('找不到该 vibe_id，请重新提供源参考图或通过 encode_vibe 编码');
          if (cached.model !== model) throw new Error('vibe_id 的编码模型与本次模型不同，请用同一模型重新编码');
          if (ref.information_extracted !== undefined && Number(ref.information_extracted.toFixed(4)) !== cached.information_extracted) {
            throw new Error('vibe_id 已固定信息提取比例，请调整比例后重新编码源图');
          }
          reserve(cached.encoded_vibe.length);
          vibeIds.push(cached.id);
          prepared.push({ strength: ref.strength, encoded_vibe: cached.encoded_vibe });
        } else if (ref.encoded_vibe) {
          reserve(ref.encoded_vibe.length);
          prepared.push({ strength: ref.strength, encoded_vibe: ref.encoded_vibe });
        } else {
          const image = await readImage(ref.image!);
          reserve(image.length);
          pending.push({ index: prepared.length, image, info: ref.information_extracted ?? 1 });
          prepared.push({ strength: ref.strength });
        }
      }
      // 读完并验证所有参考输入后才允许调用上游编码。
      for (const { index, image, info } of pending) {
        const cached = await encodeReference(image, model, info);
        prepared[index].encoded_vibe = cached.encoded_vibe;
        vibeIds.push(cached.id);
      }
      params.vibeReferences = prepared;
    }

    if (mode === 'free' && !quota) throw new Error('免费体验配额未配置，未发起出图请求');
    // 只保护这一次上游调用。结果处理或本地保存失败不能撤销已经成功的生成。
    const generated = mode === 'free' ? await quota!.run(model, () => client.generateImage(params)) : await client.generateImage(params);
    return receipt(generated.images, {
      tool: name, action, model: generated.model, width, height, seed: generated.seed,
      prompt_preview: params.prompt.slice(0, 240), note: generated.fallbackNotice,
    }, vibeIds);
  }

  async function augment(args: { source_image: string; req_type: AugmentReqType; emotion?: EmotionMood; prompt?: string; defry?: number; width?: number; height?: number }) {
    if (args.req_type === 'emotion' && !args.emotion) throw new Error('req_type 为 emotion 时必须提供 emotion');
    if (args.emotion !== undefined && args.req_type !== 'emotion') throw new Error('emotion 只用于 emotion 处理');
    if (args.defry !== undefined && args.req_type !== 'emotion' && args.req_type !== 'colorize') throw new Error('defry 只用于 colorize 或 emotion 处理');
    const source = await readImage(args.source_image);
    const size = await getImageDimensions(source);
    const width = args.width ?? size.width, height = args.height ?? size.height;
    const image = width !== size.width || height !== size.height ? await prepareImg2ImgImage(source, width, height) : await ensurePngBuffer(source);
    const images = await client.augmentImage({
      image: image.toString('base64'), req_type: args.req_type, emotion: args.emotion, prompt: args.prompt, defry: args.defry, width, height,
    });
    return receipt(images, { tool: 'augment_image', action: args.req_type, width, height, prompt_preview: args.prompt?.slice(0, 240) });
  }

  async function upscale(args: { source_image: string; model?: string; declared_blur_sigma?: number; auto_fit_1mp?: boolean }) {
    const source = await readImage(args.source_image);
    const model = args.model ?? DEFAULT_UPSCALE_MODEL;
    let image: Buffer;
    if (args.auto_fit_1mp !== false) {
      ({ buffer: image } = await fitImageToMaxPixels(source, ONE_MEGAPIXEL));
    } else {
      const size = await getImageDimensions(source);
      if (size.width * size.height > ONE_MEGAPIXEL) throw new Error('源图超过 1,048,576 像素，请启用 auto_fit_1mp 或缩小图片');
      image = await ensurePngBuffer(source);
    }
    const images = await client.upscaleImage({ image: image.toString('base64'), model, declared_blur_sigma: args.declared_blur_sigma });
    return receipt(images, { tool: 'upscale_image', action: 'upscale', model });
  }

  async function encode(args: { source_image: string; model?: Model; information_extracted?: number; mask_image?: string; crop_to_mask?: boolean; include_raw_base64?: boolean }) {
    if (args.crop_to_mask && !args.mask_image) throw new Error('crop_to_mask 需要提供 mask_image');
    const image = await readImage(args.source_image);
    const mask = args.mask_image ? await readImage(args.mask_image) : undefined;
    const cached = await encodeReference(image, args.model ?? DEFAULT_REFERENCE_MODEL, args.information_extracted ?? 1, mask, args.crop_to_mask);
    return asJson({
      vibe_id: cached.id, model: cached.model, information_extracted: cached.information_extracted,
      ...(args.include_raw_base64 && { encoded_vibe: cached.encoded_vibe }),
    });
  }

  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, {
    capabilities: { tools: {} },
    instructions: `默认出图模型为 ${DEFAULT_MODEL}（V5 Full）。${PROMPT_HINT}${IMAGE_RECEIPT}${mode === 'free' ? FREE_ONLY : ''}`,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }): Promise<CallToolResult> => {
    // 列表和执行共用同一个白名单，未授权的请求不能进入参数处理或触发任何上游调用。
    const validate = validators.get(name);
    if (!validate) return failure(mode === 'free' ? FREE_ONLY : '未知工具');
    if (name === 'inpaint_image' && Object.hasOwn(args, 'vibe_references')) {
      return failure('局部重绘不支持 vibe_references，即使是空数组也请省略此字段。');
    }
    if (mode === 'free' && name === 'generate_image' && (Object.hasOwn(args, 'character_references') || Object.hasOwn(args, 'vibe_references'))) {
      return failure('免费体验仅支持纯文生图，请勿传入 character_references 或 vibe_references（包括空数组）。如需使用参考图，请配置个人 API Key。');
    }
    if ((name === 'generate_image' || name === 'img2img' || name === 'inpaint_image') && Object.hasOwn(args, 'n_samples') && args.n_samples !== 1) {
      return failure('n_samples 固定为 1，每次只能生成 1 张图片。');
    }
    if (!validate(args)) {
      const e = validate.errors?.[0];
      const field = [e?.instancePath.slice(1), e?.params.additionalProperty ?? e?.params.missingProperty].filter(Boolean).join('.') || '输入';
      if (e?.keyword === 'enum' && e.instancePath === '/model') {
        return failure(`不支持该模型。可选模型：${e.params.allowedValues.join('、')}`);
      }
      if (e?.keyword === 'additionalProperties') return failure(`不支持的工具参数：${field}`);
      if (e?.keyword === 'multipleOf') return failure(`${field} 必须为 ${e.params.multipleOf} 的倍数`);
      if (e?.keyword === 'maximum') return failure(`${field} 不能超过 ${e.params.limit}`);
      return failure(`请检查工具参数 ${field} 的类型、范围或必填项`);
    }
    try {
      switch (name) {
        case 'generate_image': return await generate(name, args as unknown as GenerationArguments, 'generate');
        case 'img2img': return await generate(name, args as unknown as GenerationArguments, 'img2img');
        case 'inpaint_image': return await generate(name, args as unknown as GenerationArguments, 'infill');
        case 'augment_image': return await augment(args as Parameters<typeof augment>[0]);
        case 'upscale_image': return await upscale(args as Parameters<typeof upscale>[0]);
        case 'encode_vibe': return await encode(args as Parameters<typeof encode>[0]);
        case 'suggest_tags': {
          const { prompt, model = DEFAULT_MODEL, lang = 'en', limit = 20 } = args as unknown as SuggestTagsParams & { limit?: number };
          const { tags } = await client.suggestTags({ prompt, model, lang });
          return asJson({ tags: tags.slice(0, limit) });
        }
        case 'get_subscription': {
          const { raw, summary } = await client.getSubscription();
          return { content: [asText(summary), asText(JSON.stringify(raw))] };
        }
        case 'get_nai_prompt': return { content: [asText(await readFile(PROMPT_FILE, 'utf8'))] };
        default: return failure('未知工具');
      }
    } catch (error) {
      console.error(`[${transportLabel}] 工具执行失败`, name);
      const code = (error as NodeJS.ErrnoException)?.code;
      const message = code && name === 'get_nai_prompt' ? '无法读取提示词模板文件'
        : code === 'ENOENT' ? '找不到指定的图片或归档记录' : code ? '执行工具时遇到系统错误'
          : error instanceof Error ? error.message : '工具执行失败';
      return failure(`错误：${message}`);
    }
  });
  return server;
}
