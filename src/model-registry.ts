import { randomInt } from 'node:crypto';
import { IMAGE_MODELS, resolveImageModel } from './types.js';
import type { Action, ImageGenerationParams, Model } from './types.js';

export interface ModelCapability {
  paramsVersion: 3 | 4;
  defaultSteps: number;
  defaultScale: number;
  maxCharacters: number;
  supportsVibe: boolean;
  supportsVibeInInpaint: false;
  vibeRequiresEncode: boolean;
  supportsPreciseRef: boolean;
  supportsTransparent: boolean;
  varietyBase: number | null;
  preferBrownian: boolean;
  inpaintingModel: string;
  inpaintingFallbackNotice?: string;
}

const v5 = {
  paramsVersion: 4,
  defaultSteps: 23,
  defaultScale: 7,
  maxCharacters: 32,
  supportsVibe: false,
  supportsVibeInInpaint: false,
  vibeRequiresEncode: false,
  supportsPreciseRef: false,
  supportsTransparent: true,
  varietyBase: null,
  preferBrownian: false,
} as const;

const v45 = {
  paramsVersion: 3,
  defaultSteps: 28,
  defaultScale: 6,
  maxCharacters: 6,
  supportsVibe: true,
  supportsVibeInInpaint: false,
  vibeRequiresEncode: true,
  supportsPreciseRef: true,
  supportsTransparent: false,
  varietyBase: 58,
  preferBrownian: true,
} as const;

export const MODEL_REGISTRY: Readonly<Record<Model, ModelCapability>> = {
  'nai-diffusion-5-full': { ...v5, inpaintingModel: 'nai-diffusion-5-full-inpainting' },
  'nai-diffusion-5-curated': {
    ...v5,
    inpaintingModel: 'nai-diffusion-5-full-inpainting',
    inpaintingFallbackNotice: 'V5 Curated 无独立重绘模型，已使用同代 nai-diffusion-5-full-inpainting。',
  },
  'nai-diffusion-4-5-full': { ...v45, inpaintingModel: 'nai-diffusion-4-5-full-inpainting' },
  'nai-diffusion-4-5-curated': { ...v45, defaultScale: 5, inpaintingModel: 'nai-diffusion-4-5-curated-inpainting' },
};

export const ENCODE_VIBE_MODELS = IMAGE_MODELS.filter(model => MODEL_REGISTRY[model].vibeRequiresEncode);
export const MAX_SEED = 4294967288;
export const MAX_VIBE_REFERENCES = 16;

export function computeVarietySigma(base: number, width: number, height: number): number {
  return Math.ceil(base * Math.sqrt((4 * Math.floor(width / 8) * Math.floor(height / 8)) / (4 * 104 * 152)));
}

export function normalizeSeed(seed?: number): number {
  if (seed === undefined || !Number.isFinite(seed) || seed <= 0) return randomInt(1, MAX_SEED + 1);
  return Math.max(1, Math.min(MAX_SEED, Math.trunc(seed)));
}

export function alignDimension(val: number, min = 64, max = 49152): number {
  const lower = Math.ceil(min / 64) * 64;
  const upper = Math.floor(max / 64) * 64;
  if (!Number.isFinite(val) || val <= 0 || !Number.isFinite(lower) || !Number.isFinite(upper) || lower < 64 || lower > upper) {
    throw new Error('图片尺寸和对齐范围必须为有效正数');
  }
  return Math.max(lower, Math.min(upper, Math.round(val / 64) * 64));
}

export function resolveGenerationModel(value?: unknown, action: Action = 'generate'): {
  requestedModel: Model;
  model: string;
  capability: ModelCapability;
  fallbackNotice?: string;
} {
  const requestedModel = resolveImageModel(value);
  const capability = MODEL_REGISTRY[requestedModel];
  if (action !== 'infill') return { requestedModel, model: requestedModel, capability };
  return {
    requestedModel,
    model: capability.inpaintingModel,
    capability,
    fallbackNotice: capability.inpaintingFallbackNotice,
  };
}

export function validateGenerationFeatures(params: ImageGenerationParams, capability: ModelCapability): void {
  const vibeCount = (params.vibeReferences?.length ?? 0) + (params.reference_image_multiple?.length ?? 0);
  if (vibeCount > 0 && params.action === 'infill') {
    throw new Error('同代局部重绘不支持任何 Vibe Transfer 参考，不会回退到其他模型；请移除 Vibe 参考。');
  }
  if ((params.characterPrompts?.length ?? 0) > capability.maxCharacters) {
    throw new Error(`当前模型最多支持 ${capability.maxCharacters} 个独立角色提示词`);
  }
  if (params.transparent_background && !capability.supportsTransparent) {
    throw new Error('实际出图模型不支持透明背景，请选择支持该功能的 V5 模型');
  }
  const hasPrecise = Boolean(params.characterReferences?.length);
  if (hasPrecise && vibeCount > 0) throw new Error('精确参考与 Vibe Transfer 不能同时使用');
  if (hasPrecise && !capability.supportsPreciseRef) throw new Error('精确参考仅支持 V4.5 模型');
  if (vibeCount > 0 && !capability.supportsVibe) throw new Error('Vibe Transfer 仅支持 V4.5 非局部重绘请求');
  if (vibeCount > MAX_VIBE_REFERENCES) throw new Error(`Vibe Transfer 最多支持 ${MAX_VIBE_REFERENCES} 张参考图`);
}
