import { randomInt } from 'node:crypto';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch, { type Response } from 'node-fetch';
import {
  alignDimension,
  computeVarietySigma,
  ENCODE_VIBE_MODELS,
  normalizeSeed,
  resolveGenerationModel,
  validateGenerationFeatures,
} from './model-registry.js';
import { unpackImageResponse } from './response-unpack.js';
import {
  AUGMENT_REQ_TYPES,
  DEFAULT_MODEL,
  EMOTION_MOODS,
  PRECISE_REFERENCE_TYPES,
  resolveImageModel,
  UC_PRESET_NAMES,
} from './types.js';
import type {
  Action,
  AugmentImageParams,
  EncodeVibeParams,
  GenerationResult,
  ImageGenerationParams,
  NovelAIRequestPayload,
  SuggestTagsParams,
  TagSuggestion,
  UnpackedImage,
  UpscaleImageParams,
} from './types.js';

const DEFAULT_UPSTREAM_BASE_URL = 'http://qiandaiapi-app:8080';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_IMAGE_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 4096;
const MAX_ERROR_SUMMARY_CHARS = 160;
const CORRELATION_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const DEFAULT_UPSCALE_MODEL = DEFAULT_MODEL;

export interface NovelAIClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

// BlockList also matches IPv4 subnets against canonical IPv4-mapped IPv6 literals.
const localAddresses = new BlockList();
localAddresses.addSubnet('0.0.0.0', 8);
localAddresses.addSubnet('10.0.0.0', 8);
localAddresses.addSubnet('100.64.0.0', 10);
localAddresses.addSubnet('127.0.0.0', 8);
localAddresses.addSubnet('169.254.0.0', 16);
localAddresses.addSubnet('172.16.0.0', 12);
localAddresses.addSubnet('192.168.0.0', 16);
localAddresses.addAddress('::', 'ipv6');
localAddresses.addAddress('::1', 'ipv6');
localAddresses.addSubnet('fc00::', 7, 'ipv6');
localAddresses.addSubnet('fe80::', 10, 'ipv6');
const directHttp = new HttpAgent({ keepAlive: true });
const directHttps = new HttpsAgent({ keepAlive: true });

function isLocalUpstream(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const family = isIP(host);
  if (family) return localAddresses.check(host, family === 6 ? 'ipv6' : 'ipv4');
  return !host.includes('.') || host.endsWith('.localhost');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTagSuggestion(value: unknown): value is TagSuggestion {
  return isRecord(value) && typeof value.tag === 'string' &&
    (value.count === undefined || (typeof value.count === 'number' && Number.isFinite(value.count)));
}

function requireImage(value: string | undefined, field = 'image'): string {
  if (typeof value !== 'string') throw new Error(`${field} 需要 Base64 数据`);
  const base64 = value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').replace(/\s+/g, '');
  const remainder = base64.length % 4;
  if (remainder === 1 || (base64.endsWith('=') && remainder !== 0) || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error(`${field} 需要有效的 Base64 数据`);
  }
  return base64;
}

function checkRange(value: number, field: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${field} 必须在 ${min} 到 ${max} 之间`);
  return value;
}

function checkInteger(value: number, field: string, min: number, max: number): number {
  checkRange(value, field, min, max);
  if (!Number.isInteger(value)) throw new Error(`${field} 必须是整数`);
  return value;
}

function isDdim(sampler: string): boolean {
  return sampler === 'ddim' || sampler === 'ddim_v3';
}

function buildGenerationRequest(params: ImageGenerationParams): {
  payload: NovelAIRequestPayload;
  requestedModel: GenerationResult['requestedModel'];
  fallbackNotice?: string;
} {
  const action: Action = params.action ?? 'generate';
  if (action !== 'generate' && action !== 'img2img' && action !== 'infill') throw new Error('不支持该出图操作');
  if (typeof params.prompt !== 'string' || !params.prompt.trim()) throw new Error('出图提示词不能为空');
  if ('n_samples' in params && params.n_samples !== 1) throw new Error('仅支持单图请求，n_samples 必须为数字 1');
  const { model, requestedModel, capability, fallbackNotice } = resolveGenerationModel(params.model, action);
  validateGenerationFeatures(params, capability);

  const width = alignDimension(params.width ?? 832);
  const height = alignDimension(params.height ?? 1216);
  const input = params.transparent_background && !/\btransparent background\b/i.test(params.prompt)
    ? `transparent background, ${params.prompt}`
    : params.prompt;
  const negativePrompt = params.negative_prompt ?? '';
  const requestedSampler = params.sampler ?? 'k_euler_ancestral';
  const sampler = action === 'infill' && isDdim(requestedSampler) ? 'k_euler_ancestral' : requestedSampler;
  const noiseSchedule = params.noise_schedule ?? 'karras';
  const seed = normalizeSeed(params.seed);
  let varietySigma: number | null = null;
  if (capability.varietyBase !== null) {
    if (params.skip_cfg_above_sigma !== undefined) varietySigma = params.skip_cfg_above_sigma;
    else if (params.variety_plus) varietySigma = computeVarietySigma(capability.varietyBase, width, height);
  }

  const characters = (params.characterPrompts ?? []).map(character => ({ ...character, enabled: character.enabled ?? true }));
  const enabled = characters.filter(character => character.enabled);
  const useCoords = params.use_coords ?? enabled.length > 0;
  const legacyUc = params.legacy_uc ?? false;
  const parameters: NovelAIRequestPayload['parameters'] = {
    params_version: capability.paramsVersion,
    width,
    height,
    scale: params.scale ?? capability.defaultScale,
    sampler,
    steps: checkInteger(params.steps ?? capability.defaultSteps, 'steps', 1, 50),
    n_samples: 1,
    cfg_rescale: checkRange(params.cfg_rescale ?? 0, 'cfg_rescale', 0, 1),
    skip_cfg_above_sigma: varietySigma,
    seed,
    negative_prompt: negativePrompt,
    deliberate_euler_ancestral_bug: false,
    prefer_brownian: params.prefer_brownian ?? capability.preferBrownian,
    image_format: params.image_format ?? 'png',
    legacy: false,
    characterPrompts: characters,
    use_coords: useCoords,
    legacy_uc: legacyUc,
    v4_prompt: {
      caption: { base_caption: input, char_captions: enabled.map(character => ({ char_caption: character.prompt, centers: [character.center] })) },
      use_coords: useCoords,
      use_order: true,
    },
    v4_negative_prompt: {
      caption: { base_caption: negativePrompt, char_captions: enabled.map(character => ({ char_caption: character.uc, centers: [character.center] })) },
      legacy_uc: legacyUc,
    },
  };

  if (sampler !== 'ddim_v3') parameters.noise_schedule = noiseSchedule === 'native' ? 'karras' : noiseSchedule;
  if (params.uncond_scale !== undefined) parameters.uncond_scale = params.uncond_scale === 0 ? 0.00001 : params.uncond_scale;

  if (capability.paramsVersion === 4) {
    parameters.ucPresetId = params.ucPresetId ?? UC_PRESET_NAMES[params.ucPreset ?? 0] ?? 'heavy';
    parameters.qualityPresetId = params.qualityPresetId ?? (params.qualityToggle === false ? 'none' : 'standard');
  } else {
    parameters.ucPreset = params.ucPresetId === undefined ? params.ucPreset ?? 0 : UC_PRESET_NAMES.indexOf(params.ucPresetId);
    parameters.qualityToggle = params.qualityPresetId === undefined ? params.qualityToggle ?? true : params.qualityPresetId !== 'none';
  }
  if (params.transparent_background) {
    parameters.straight_alpha = true;
    parameters.tag_hint_transparent_background = true;
  }

  if (action === 'img2img') {
    parameters.image = requireImage(params.image);
    parameters.strength = checkRange(params.strength ?? 0.7, 'strength', 0, 1);
    parameters.noise = checkRange(params.noise ?? 0, 'noise', 0, 1);
    parameters.extra_noise_seed = params.extra_noise_seed === undefined ? seed : normalizeSeed(params.extra_noise_seed);
    parameters.color_correct = params.color_correct ?? true;
  }
  if (action === 'infill') {
    const strength = checkRange(params.inpaintImg2ImgStrength ?? 1, 'inpaintImg2ImgStrength', 0, 1);
    const noise = checkRange(params.noise ?? 0, 'noise', 0, 1);
    parameters.image = requireImage(params.image);
    parameters.mask = requireImage(params.mask, 'mask');
    parameters.add_original_image = params.add_original_image ?? true;
    parameters.inpaintImg2ImgStrength = strength;
    parameters.noise = noise;
    if (strength < 1) {
      parameters.img2img = { strength, color_correct: true, ...(noise > 0 ? { noise } : {}), extra_noise_seed: seed };
    }
  }

  if (params.characterReferences?.length) {
    parameters.director_reference_images = params.characterReferences.map(ref => requireImage(ref.image, 'character_references.image'));
    parameters.director_reference_descriptions = params.characterReferences.map(ref => {
      if (!PRECISE_REFERENCE_TYPES.includes(ref.type)) throw new Error('不支持该精确参考类型');
      return { caption: { base_caption: ref.type, char_captions: [] }, legacy_uc: false };
    });
    parameters.director_reference_information_extracted = params.characterReferences.map(() => 1);
    parameters.director_reference_strength_values = params.characterReferences.map(ref => checkRange(ref.strength ?? 1, '精确参考强度', 0, 1));
    parameters.director_reference_secondary_strength_values = params.characterReferences.map(ref => (
      Number((1 - checkRange(ref.fidelity ?? 1, '精确参考忠实度', 0, 1)).toFixed(4))
    ));
  }

  const vibes = [...(params.vibeReferences ?? [])];
  for (const [index, encoded_vibe] of (params.reference_image_multiple ?? []).entries()) {
    vibes.push({ encoded_vibe, strength: params.reference_strength_multiple?.[index] ?? params.reference_strength });
  }
  if (vibes.length) {
    parameters.reference_image_multiple = vibes.map(ref => requireImage(ref.encoded_vibe, 'vibe_references.encoded_vibe'));
    parameters.reference_strength_multiple = vibes.map(ref => checkRange(ref.strength ?? 0.6, 'Vibe 强度', 0, 1));
    parameters.normalize_reference_strength_multiple = params.normalize_reference_strength_multiple ?? true;
  }

  return { payload: { input, model, action, parameters }, requestedModel, fallbackNotice };
}

function usageSummary(raw: Record<string, unknown>): string {
  // Never infer balances, costs, units or a plan from other fields.
  const numeric = (value: unknown): string | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.trim())) return value.trim();
    return undefined;
  };
  const unit = typeof raw.unit === 'string' ? raw.unit.trim() : '';
  const sections: string[] = [];
  if (typeof raw.planName === 'string' && raw.planName.trim()) sections.push(`套餐：${raw.planName.trim()}`);
  if (unit) sections.push(`单位：${unit}`);
  for (const [key, label] of [['balance', '余额'], ['remaining', '剩余']] as const) {
    const amount = numeric(raw[key]);
    if (amount !== undefined) sections.push(`${label}：${amount}`);
  }
  if (isRecord(raw.usage)) {
    for (const [key, label] of [['today', '今日'], ['total', '累计']] as const) {
      const usage = raw.usage[key];
      if (!isRecord(usage)) continue;
      const metrics: string[] = [];
      for (const [field, name] of [['requests', '请求数'], ['cost', '费用'], ['actual_cost', '实际费用']] as const) {
        const amount = numeric(usage[field]);
        if (amount !== undefined) metrics.push(`${name} ${amount}`);
      }
      if (metrics.length) sections.push(`${label}：${metrics.join('，')}`);
    }
  }
  for (const [key, label] of [['daily_usage', '每日用量'], ['model_stats', '模型统计']] as const) {
    const detail = raw[key];
    if (Array.isArray(detail) || isRecord(detail)) sections.push(`${label}：${Object.keys(detail).length} 项`);
  }
  return sections.join('；') || '上游已返回用量对象，没有可摘要的字段。';
}

const OMITTED_ERROR = '上游未提供可安全展示的错误说明';

function safeErrorText(value: unknown, apiKey: string): string {
  if (typeof value !== 'string' || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|&(?:lt|gt);/i.test(value)) return OMITTED_ERROR;
  // Keep prose, not echoed requests, URLs, headers, keys, images or stack traces.
  let text = value.replaceAll(apiKey, '[已脱敏]').trim().split(/[\r\n]/, 1)[0];
  const sensitive = /\b(?:[\w-]*(?:token|password|passwd|passphrase|secret|credential|cookie|signature|api[-_]?key|private[-_]?key|authorization)[\w-]*|api\s+key|key|bearer|basic|session(?:[-_ ]?id)?)\b|(?:https?|data):|-----BEGIN |\b(?:sk|pk|pst|nai)[-_]|\b(?:prompt|image|headers?|payload|body)\s*[:=]/i;
  const index = text.search(sensitive);
  if (index >= 0) text = `${text.slice(0, index).trimEnd()} [已脱敏]`;
  text = text.replace(/[A-Za-z\d_+./=-]{24,}/g, '[已脱敏]').replace(/\s+/g, ' ').trim();
  if (!text) return OMITTED_ERROR;
  return text.length <= MAX_ERROR_SUMMARY_CHARS ? text : `${text.slice(0, MAX_ERROR_SUMMARY_CHARS - 1)}…`;
}

async function upstreamErrorSummary(response: Response, apiKey: string): Promise<string> {
  const body = response.body;
  if (!(body instanceof Readable)) return OMITTED_ERROR;
  try {
    const media = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const json = media === 'application/json' || media.endsWith('+json');
    if (media && !json && media !== 'text/plain') return OMITTED_ERROR;
    if (Number(response.headers.get('content-length')) > MAX_ERROR_BODY_BYTES) return '上游错误正文过长，已省略';
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_ERROR_BODY_BYTES) return '上游错误正文过长，已省略';
      chunks.push(bytes);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).trim();
    if (!json && !/^[{[\"]/.test(text)) return safeErrorText(text, apiKey);
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw)) return OMITTED_ERROR;
    const error = isRecord(raw.error) ? raw.error : undefined;
    const message = [error?.message, raw.message, raw.detail, raw.error, error?.detail, raw.title].find(item => typeof item === 'string');
    return safeErrorText(message, apiKey);
  } catch {
    return OMITTED_ERROR;
  } finally {
    body.destroy();
  }
}

interface UpstreamResponse {
  buffer: Buffer;
  contentType?: string;
  status: number;
}

export class NovelAIClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly agent: HttpAgent;

  constructor(private readonly apiKey: string, options: NovelAIClientOptions | string = {}) {
    if (!apiKey) throw new Error('缺少 NovelAI API 密钥');
    const config = typeof options === 'string' ? { baseUrl: options } : options;
    const address = config.baseUrl ?? (process.env.UPSTREAM_BASE_URL?.trim() || DEFAULT_UPSTREAM_BASE_URL);
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('NovelAI 接口地址必须是 HTTP 或 HTTPS 地址');
    }
    this.baseUrl = url.href.replace(/\/$/, '');
    this.timeoutMs = checkInteger(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs', 1, 2147483647);
    const proxy = url.protocol === 'https:'
      ? process.env.HTTPS_PROXY || process.env.HTTP_PROXY
      : process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
    this.agent = !isLocalUpstream(url) && proxy ? new HttpsProxyAgent(proxy) : url.protocol === 'https:' ? directHttps : directHttp;
  }

  private async request(path: string, body?: object, maxBytes = MAX_IMAGE_RESPONSE_BYTES): Promise<UpstreamResponse> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const correlationId = Array.from({ length: 6 }, () => CORRELATION_ALPHABET[randomInt(CORRELATION_ALPHABET.length)]).join('');
    const route = path.split('?')[0];
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Origin: 'https://novelai.net',
      Referer: 'https://novelai.net/',
      'x-correlation-id': correlationId,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    };
    let response: Response | undefined;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        agent: this.agent, redirect: 'manual', signal, size: maxBytes,
      });
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        return { buffer, contentType: response.headers.get('content-type') ?? undefined, status: response.status };
      }
    } catch {
      const location = response ? `HTTP ${response.status} ${route}` : route;
      throw new Error(`NovelAI ${signal.aborted ? '请求超时' : '请求失败'}（${location}）`);
    }
    const summary = await upstreamErrorSummary(response, this.apiKey);
    throw new Error(`NovelAI HTTP ${response.status} ${route}（请求编号 ${correlationId}）：${summary}`);
  }

  private async readJson(path: string): Promise<{ raw: unknown; status: number }> {
    const { buffer, status } = await this.request(path, undefined, MAX_JSON_RESPONSE_BYTES);
    try {
      return { raw: JSON.parse(buffer.toString('utf8')), status };
    } catch {
      throw new Error(`NovelAI HTTP ${status} ${path.split('?')[0]}：上游返回了无法解析的 JSON`);
    }
  }

  private async requestImages(path: string, body: object): Promise<UnpackedImage[]> {
    const { buffer, contentType, status } = await this.request(path, body);
    try {
      return unpackImageResponse(buffer, contentType);
    } catch {
      throw new Error(`NovelAI HTTP ${status} ${path}：上游未返回可解包的图片`);
    }
  }

  async generateImage(params: ImageGenerationParams): Promise<GenerationResult> {
    const { payload, requestedModel, fallbackNotice } = buildGenerationRequest(params);
    const { buffer, contentType } = await this.request('/ai/generate-image', payload);
    return {
      images: unpackImageResponse(buffer, contentType),
      seed: payload.parameters.seed,
      model: payload.model,
      requestedModel,
      ...(fallbackNotice === undefined ? {} : { fallbackNotice }),
      rawBuffer: buffer,
    };
  }

  async generateImageBuffer(params: ImageGenerationParams): Promise<Buffer> {
    const { payload } = buildGenerationRequest(params);
    return (await this.request('/ai/generate-image', payload)).buffer;
  }

  async augmentImage(params: AugmentImageParams): Promise<UnpackedImage[]> {
    const { req_type, image, width, height, emotion, prompt, defry } = params;
    if (!AUGMENT_REQ_TYPES.includes(req_type)) throw new Error('不支持该导演工具');
    if (req_type === 'emotion' && (emotion === undefined || !EMOTION_MOODS.includes(emotion))) {
      throw new Error(`emotion 必须是受支持的情绪。可选情绪为 ${EMOTION_MOODS.join('、')}`);
    }
    const supportsDefry = req_type === 'colorize' || req_type === 'emotion';
    return this.requestImages('/ai/augment-image', {
      image: requireImage(image), req_type, width, height,
      ...(supportsDefry ? { defry: checkInteger(defry ?? 0, 'defry', 0, 5) } : {}),
      ...(req_type === 'emotion' ? { prompt: `${emotion};;${prompt ?? ''}` } : { prompt }),
    });
  }

  async upscaleImage(params: UpscaleImageParams): Promise<UnpackedImage[]> {
    const { image, model = DEFAULT_UPSCALE_MODEL, declared_blur_sigma } = params;
    return this.requestImages('/ai/upscale', {
      image: requireImage(image), model,
      ...(declared_blur_sigma === undefined ? {} : { declared_blur_sigma }),
    });
  }

  async encodeVibe(params: EncodeVibeParams): Promise<string> {
    const { image, model, information_extracted = 1, mask, crop_to_mask } = params;
    if (!ENCODE_VIBE_MODELS.includes(model)) throw new Error('独立氛围编码仅支持 V4.5 Full 和 V4.5 Curated 模型');
    const path = '/ai/encode-vibe';
    const { buffer, status, contentType } = await this.request(path, {
      image: requireImage(image), model,
      information_extracted: checkRange(information_extracted, 'information_extracted', 0, 1),
      ...(mask === undefined ? {} : { mask: requireImage(mask, 'mask') }),
      ...(crop_to_mask === undefined ? {} : { crop_to_mask }),
    });
    if (!buffer.length || contentType?.toLowerCase().startsWith('text/html')) throw new Error(`NovelAI HTTP ${status} ${path}：上游未返回有效的氛围编码`);
    return buffer.toString('base64');
  }

  async suggestTags(params: SuggestTagsParams): Promise<{ tags: TagSuggestion[] }> {
    const { prompt, lang = 'en' } = params;
    if (lang !== 'en' && lang !== 'jp') throw new Error('lang 必须为 en 或 jp');
    const path = '/ai/generate-image/suggest-tags';
    const query = new URLSearchParams({ model: resolveImageModel(params.model), prompt, lang });
    const { raw, status } = await this.readJson(`${path}?${query}`);
    const tags = Array.isArray(raw) ? raw : isRecord(raw) ? raw.tags : undefined;
    if (!Array.isArray(tags) || !tags.every(isTagSuggestion)) throw new Error(`NovelAI HTTP ${status} ${path}：上游返回了无效的标签列表`);
    return { tags };
  }

  async getSubscription(): Promise<{ raw: Record<string, unknown>; summary: string }> {
    const path = '/v1/usage';
    const { raw, status } = await this.readJson(path);
    if (!isRecord(raw)) throw new Error(`NovelAI HTTP ${status} ${path}：上游返回了无效的用量对象`);
    return { raw, summary: usageSummary(raw) };
  }
}
