import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ENCODE_VIBE_MODELS } from './model-registry.js';
import type { Model } from './types.js';

const VIBE_ID = /^vibe_[a-f0-9]{16}$/;
const HASH_KEY = /^[a-f0-9]{64}$/;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const MAX_MEMORY_ENTRIES = 128;
const FILE_TIMEOUT = 10_000;

export interface VibeCacheEntry {
  id: string;
  model: Model;
  information_extracted: number;
  encoded_vibe: string;
  created_at: string;
}

export function vibeCacheKey(
  image: Buffer,
  model: Model,
  informationExtracted: number,
  mask?: Buffer,
  cropToMask = false,
): string {
  const maskHash = mask ? createHash('sha256').update(mask).digest('hex') : '';
  const hash = createHash('sha256').update(image).update(`|${model}|${informationExtracted.toFixed(4)}|${maskHash}`);
  // 遮罩裁剪会改变上游编码，启用时使用独立键。
  if (cropToMask) hash.update('|crop_to_mask');
  return hash.digest('hex');
}

function vibeId(key: string): string {
  if (!HASH_KEY.test(key)) throw new Error('无效的 Vibe 缓存键');
  return `vibe_${key.slice(0, 16)}`;
}

export class VibeCache {
  private readonly dataDir?: string;
  private readonly memory = new Map<string, VibeCacheEntry>();
  private readonly pending = new Map<string, Promise<VibeCacheEntry>>();
  private memoryBytes = 0;

  constructor(dataDir?: string) {
    if (dataDir) this.dataDir = resolve(dataDir);
  }

  private async cacheDirectory(create: boolean): Promise<string> {
    const root = this.dataDir!;
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await lstat(root)).isDirectory()) throw new Error('Vibe 数据目录不能是链接');
    const directory = join(root, '.vibe-cache');
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new Error('Vibe 缓存目录不能是链接');
    return directory;
  }

  private remember(entry: VibeCacheEntry): void {
    const prior = this.memory.get(entry.id);
    if (prior) {
      this.memoryBytes -= prior.encoded_vibe.length;
      this.memory.delete(entry.id);
    }
    this.memory.set(entry.id, entry);
    this.memoryBytes += entry.encoded_vibe.length;
    for (const [id, old] of this.memory) {
      if (this.memoryBytes <= MAX_MEMORY_BYTES && this.memory.size <= MAX_MEMORY_ENTRIES) break;
      this.memory.delete(id);
      this.memoryBytes -= old.encoded_vibe.length;
    }
  }

  async getByHashKey(key: string): Promise<VibeCacheEntry | undefined> {
    return this.getById(vibeId(key));
  }

  async getById(id: string): Promise<VibeCacheEntry | undefined> {
    if (!VIBE_ID.test(id)) return undefined;
    const cached = this.memory.get(id);
    if (cached) {
      this.remember(cached);
      return cached;
    }
    if (!this.dataDir) return undefined;

    try {
      const filename = join(await this.cacheDirectory(false), `${id}.json`);
      const info = await lstat(filename);
      if (!info.isFile() || info.size > MAX_ENTRY_BYTES + 1024) return undefined;
      const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let entry: VibeCacheEntry | null;
      try {
        const current = await file.stat();
        if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size) return undefined;
        const bytes = Buffer.allocUnsafe(current.size);
        const signal = AbortSignal.timeout(FILE_TIMEOUT);
        for (let offset = 0; offset < bytes.length;) {
          signal.throwIfAborted();
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) return undefined;
          offset += bytesRead;
        }
        entry = JSON.parse(bytes.toString('utf8'));
      } finally {
        await file.close();
      }
      if (!entry || entry.id !== id || !ENCODE_VIBE_MODELS.includes(entry.model)
        || typeof entry.encoded_vibe !== 'string' || !entry.encoded_vibe || entry.encoded_vibe.length > MAX_ENTRY_BYTES
        || !Number.isFinite(entry.information_extracted) || entry.information_extracted < 0 || entry.information_extracted > 1
        || typeof entry.created_at !== 'string' || !Number.isFinite(Date.parse(entry.created_at))) {
        return undefined;
      }
      this.remember(entry);
      return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('读取 Vibe 缓存失败，将根据输入重新解析该参考。');
      }
      return undefined;
    }
  }

  async set(key: string, value: Omit<VibeCacheEntry, 'id' | 'created_at'>): Promise<VibeCacheEntry> {
    const entry = { id: vibeId(key), ...value, created_at: new Date().toISOString() };
    if (!value.encoded_vibe || value.encoded_vibe.length > MAX_ENTRY_BYTES) {
      throw new Error('上游返回的 Vibe 编码为空或超出缓存大小限制');
    }
    this.remember(entry);
    if (this.dataDir) {
      let temporary: string | undefined;
      try {
        const directory = await this.cacheDirectory(true);
        const path = join(directory, `.pending-${randomUUID()}`);
        const file = await open(path, 'wx', 0o600);
        temporary = path;
        try {
          await file.writeFile(JSON.stringify(entry), { signal: AbortSignal.timeout(FILE_TIMEOUT) });
        } finally {
          await file.close();
        }
        await rename(path, join(directory, `${entry.id}.json`));
      } catch {
        console.error('写入 Vibe 磁盘缓存失败，本次编码已存入内存。');
        if (temporary) await unlink(temporary).catch(() => {});
      }
    }
    return entry;
  }

  async getOrEncode(
    key: string,
    model: Model,
    informationExtracted: number,
    encode: () => Promise<string>,
  ): Promise<VibeCacheEntry> {
    const pending = this.pending.get(key);
    if (pending) return pending;
    const work = (async () => {
      const cached = await this.getByHashKey(key);
      if (cached) return cached;
      return this.set(key, {
        model, information_extracted: informationExtracted, encoded_vibe: await encode(),
      });
    })();
    this.pending.set(key, work);
    try {
      return await work;
    } finally {
      this.pending.delete(key);
    }
  }
}
