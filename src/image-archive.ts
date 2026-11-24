import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, opendir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sniffImageFormat } from './response-unpack.js';
import type { ImageExtension, ImageGenerationParams, ImageMimeType } from './types.js';

export const IMAGE_PATH = '/novelai-images/';
export const ARCHIVE_ID_REGEX = /^[A-Za-z0-9_-]{43}$/;
export const DEFAULT_IMAGE_TTL_MS = 300_000;
const IMAGE_FILENAME = /^([A-Za-z0-9_-]{43})\.(png|webp|jpg)$/;
const IMAGE_EXTENSIONS = ['png', 'webp', 'jpg'] as const;
const PENDING_DIRECTORY = /^\.pending-[A-Za-z0-9]{6}$/; // mkdtemp 的旧暂存目录，仅凭名字不足以认定归属。
const FS_TIMEOUT = 15_000;
const MAX_ARCHIVED_IMAGE_BYTES = 96 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;

export interface ArchiveMetadataInput {
  tool: string;
  action: string;
  private?: boolean;
  model?: string;
  width?: number;
  height?: number;
  seed?: number;
  prompt_preview?: string;
  note?: string;
}

export interface ArchivedImageMetadata extends Partial<ArchiveMetadataInput> {
  schema_version: 1 | 2;
  id: string;
  created_at: string;
  mime_type: ImageMimeType;
  ext?: ImageExtension;
  size_bytes: number;
}

export interface SavedArchivedImage {
  id: string;
  ext: ImageExtension;
  mimeType: ImageMimeType;
  filename: `${string}.${ImageExtension}`;
}

function publicImagePath(base: URL): string {
  return base.pathname.replace(/\/+$/, '') + IMAGE_PATH;
}

export function archivePublicUrl(base: URL, id: string, ext: ImageExtension): string {
  if (!ARCHIVE_ID_REGEX.test(id) || !IMAGE_EXTENSIONS.includes(ext)) throw new Error('归档图片 ID 或格式无效');
  return `${base.origin}${publicImagePath(base)}${id}.${ext}`;
}

// 也识别本站命名空间内的不规范链接，以便输入层拒绝而不是交给网络下载。
export function isArchivePublicPath(url: URL, base: URL): boolean {
  return url.origin === base.origin && url.pathname.startsWith(publicImagePath(base));
}

export function extractArchiveId(input: string, publicOrigin?: URL): string | null {
  if (ARCHIVE_ID_REGEX.test(input)) return input;
  if (!publicOrigin || !/^https?:\/\//i.test(input)) return null;
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  if (!isArchivePublicPath(url, publicOrigin) || url.username || url.password) return null;
  // 用原始路径比对，拒绝查询、片段、反斜线及 URL 解析器消解过的 ../。
  const pathStart = input.indexOf('/', input.indexOf('//') + 2);
  if (input.slice(pathStart) !== url.pathname) return null;
  return IMAGE_FILENAME.exec(url.pathname.slice(publicImagePath(publicOrigin).length))?.[1] ?? null;
}

function missingArchive(): NodeJS.ErrnoException {
  return Object.assign(new Error('归档图像不存在或已过期'), { code: 'ENOENT' });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code));
}

function validateTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) throw new RangeError('图像有效期必须是非负整数毫秒');
}

function expired(metadata: ArchivedImageMetadata, ttlMs: number): boolean {
  return Date.now() - Date.parse(metadata.created_at) >= ttlMs;
}

async function realDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw missingArchive();
  return info;
}

async function writeArchive(
  archiveDir: string, image: Buffer, ext: ImageExtension, metadata: ArchivedImageMetadata,
): Promise<void> {
  if (image.length > MAX_ARCHIVED_IMAGE_BYTES) throw new Error('归档图像超过大小限制');
  const json = JSON.stringify(metadata) + '\n';
  if (Buffer.byteLength(json) > MAX_METADATA_BYTES) throw new RangeError('归档元数据超过大小限制');
  const signal = AbortSignal.timeout(FS_TIMEOUT);
  const root = resolve(archiveDir);
  await realDirectory(root);
  const stagingDir = await mkdtemp(join(root, '.pending-'));
  const imagePath = join(stagingDir, `image.${ext}`);
  const metadataPath = join(stagingDir, 'metadata.json');
  try {
    const options = { mode: 0o600, flag: 'wx', signal } as const;
    await writeFile(imagePath, image, options);
    await writeFile(metadataPath, json, options);
    signal.throwIfAborted();
    await rename(stagingDir, join(root, metadata.id));
  } catch (error) {
    // 暂存目录只有这两个自有文件；不递归清除意外出现的内容。
    await Promise.allSettled([unlink(imagePath), unlink(metadataPath)]);
    await rmdir(stagingDir).catch(() => {});
    throw error;
  }
}

export async function saveImage(archiveDir: string, png: Buffer, params: ImageGenerationParams): Promise<string> {
  if (sniffImageFormat(png)?.ext !== 'png') throw new Error('旧版 PNG 归档只接受 PNG 图像');
  const id = randomBytes(32).toString('base64url');
  await writeArchive(archiveDir, png, 'png', {
    schema_version: 1, id, created_at: new Date().toISOString(), model: params.model,
    width: params.width, height: params.height, seed: params.seed, mime_type: 'image/png', size_bytes: png.length,
  });
  return id;
}

export async function saveArchivedImage(
  archiveDir: string, image: Buffer, input: ArchiveMetadataInput,
): Promise<SavedArchivedImage> {
  const format = sniffImageFormat(image);
  if (!format) throw new Error('无法归档未知格式的图像');
  const { ext, mimeType } = format;
  const id = randomBytes(32).toString('base64url');
  const { tool, action, private: isPrivate, model, width, height, seed, prompt_preview, note } = input;
  await writeArchive(archiveDir, image, ext, {
    tool, action, private: isPrivate, model, width, height, seed, prompt_preview, note,
    schema_version: 2, id, created_at: new Date().toISOString(), mime_type: mimeType, ext, size_bytes: image.length,
  });
  return { id, ext, mimeType, filename: `${id}.${ext}` };
}

async function readArchiveFile(path: string, limit: number, signal: AbortSignal, prefixBytes = limit): Promise<Buffer> {
  signal.throwIfAborted();
  // Windows 没有 O_NOFOLLOW。同时检查路径和打开的文件，管道、链接、目录都不是图像。
  const before = await lstat(path);
  if (!before.isFile()) throw missingArchive();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) throw missingArchive();
    if (info.size > limit) throw new RangeError('归档文件超过大小限制');
    // 即便文件在读取期间增长，也不会突破上限。
    const buffer = Buffer.allocUnsafe(Math.min(info.size, prefixBytes));
    for (let offset = 0; offset < buffer.length;) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw missingArchive();
      offset += bytesRead;
    }
    signal.throwIfAborted();
    return buffer;
  } finally {
    await file.close();
  }
}

async function readMetadata(path: string, id: string | undefined, signal: AbortSignal): Promise<ArchivedImageMetadata> {
  const raw = await readArchiveFile(join(path, 'metadata.json'), MAX_METADATA_BYTES, signal);
  const m: ArchivedImageMetadata | null = JSON.parse(raw.toString('utf8'));
  if (!m || (m.schema_version !== 1 && m.schema_version !== 2) || typeof m.id !== 'string' ||
      !ARCHIVE_ID_REGEX.test(m.id) || (id !== undefined && m.id !== id) ||
      typeof m.created_at !== 'string' || !Number.isFinite(Date.parse(m.created_at)) ||
      !Number.isSafeInteger(m.size_bytes) || m.size_bytes <= 0 || m.size_bytes > MAX_ARCHIVED_IMAGE_BYTES ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(m.mime_type) ||
      (m.ext !== undefined && !IMAGE_EXTENSIONS.includes(m.ext)) ||
      (m.private !== undefined && typeof m.private !== 'boolean')) {
    throw new SyntaxError('归档元数据无效');
  }
  return m;
}

export async function loadArchivedImage(
  archiveDir: string, id: string, { publicOnly = false, ttlMs = DEFAULT_IMAGE_TTL_MS }: { publicOnly?: boolean; ttlMs?: number } = {},
): Promise<{ buffer: Buffer; mimeType: ImageMimeType; ext: ImageExtension; metadata: ArchivedImageMetadata }> {
  validateTtl(ttlMs);
  if (!ARCHIVE_ID_REGEX.test(id)) throw new Error('归档图片 ID 无效');
  const signal = AbortSignal.timeout(FS_TIMEOUT);
  const root = resolve(archiveDir);
  const path = join(root, id);
  await realDirectory(root);
  await realDirectory(path);
  const metadata = await readMetadata(path, id, signal);
  if ((publicOnly && metadata.private) || expired(metadata, ttlMs)) throw missingArchive();
  // 兼容 v1 及旧元数据的扩展名偏差；只尝试固定文件名，始终按真实字节返回格式。
  const preferred = metadata.ext;
  const extensions = preferred ? [preferred, ...IMAGE_EXTENSIONS.filter(ext => ext !== preferred)] : IMAGE_EXTENSIONS;
  for (const ext of extensions) {
    let buffer: Buffer;
    try {
      buffer = await readArchiveFile(join(path, `image.${ext}`), metadata.size_bytes, signal);
    } catch (error) {
      if (!isMissing(error)) throw error;
      continue;
    }
    const format = sniffImageFormat(buffer);
    if (!format || buffer.length !== metadata.size_bytes) throw new Error('归档图像的格式或大小无效');
    if (expired(metadata, ttlMs)) throw missingArchive();
    return { buffer, ...format, metadata };
  }
  throw missingArchive();
}

async function removeExpiredDirectory(path: string, id: string | undefined, ttlMs: number): Promise<void> {
  const info = await realDirectory(path);
  // 暂存名并非所有权证明；还须是已停用且具有完整、可识别归档内容的暂存目录。
  if (id === undefined && Date.now() - info.mtimeMs < Math.max(ttlMs, 2 * FS_TIMEOUT)) return;
  const signal = AbortSignal.timeout(FS_TIMEOUT);
  const metadata = await readMetadata(path, id, signal);
  if (!expired(metadata, ttlMs)) return;
  const ext = metadata.ext ?? (metadata.schema_version === 1 ? 'png' : undefined);
  if (!ext || metadata.mime_type !== (ext === 'jpg' ? 'image/jpeg' : `image/${ext}`)) return;
  const imageName = `image.${ext}`;
  let fileCount = 0;
  for await (const entry of await opendir(path)) {
    if (!entry.isFile() || (entry.name !== 'metadata.json' && entry.name !== imageName)) return;
    fileCount++;
  }
  if (fileCount !== 2) return;
  const imagePath = join(path, imageName);
  const image = await lstat(imagePath);
  if (!image.isFile() || image.size !== metadata.size_bytes) return;
  // 只读图像头以确认实际格式，不为清理载入整张图片。
  const header = await readArchiveFile(imagePath, metadata.size_bytes, signal, 12);
  if (sniffImageFormat(header)?.ext !== ext) return;
  const current = await realDirectory(path);
  if (current.dev !== info.dev || current.ino !== info.ino) return;
  // 不递归：未知内容、链接目标和其他模块的持久化文件绝不会作为清理项。
  await unlink(imagePath);
  await unlink(join(path, 'metadata.json'));
  await rmdir(path);
}

export async function cleanupExpiredImages(archiveDir: string, ttlMs = DEFAULT_IMAGE_TTL_MS): Promise<void> {
  validateTtl(ttlMs);
  const root = resolve(archiveDir);
  try {
    await realDirectory(root);
    for await (const entry of await opendir(root)) {
      if (!entry.isDirectory()) continue;
      const id = ARCHIVE_ID_REGEX.test(entry.name) ? entry.name : undefined;
      if (!id && !PENDING_DIRECTORY.test(entry.name)) continue;
      try {
        await removeExpiredDirectory(join(root, entry.name), id, ttlMs);
      } catch (error) {
        // 非归档元数据、超限文件、符号链接或并发清理均不得中断其他条目的清理。
        if (!isMissing(error) && !(error instanceof SyntaxError) && !(error instanceof RangeError)) throw error;
      }
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
