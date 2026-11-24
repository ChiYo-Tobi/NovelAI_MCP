import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Model } from './types.js';

const WINDOW_MS = 5 * 60 * 60 * 1000;
const LIMITS = { v45: 400, v5: 100 } as const;
type Pool = keyof typeof LIMITS;
interface Entry { id: string; pool: Pool; at: number }

function poolFor(model: Model): Pool {
  switch (model) {
    case 'nai-diffusion-5-full': case 'nai-diffusion-5-curated': return 'v5';
    case 'nai-diffusion-4-5-full': case 'nai-diffusion-4-5-curated': return 'v45';
    default: throw new Error('免费体验不支持该模型');
  }
}

function validEntry(item: unknown): item is Entry {
  if (!item || typeof item !== 'object') return false;
  const e = item as Partial<Entry>;
  return typeof e.id === 'string' && /^[a-f0-9-]{36}$/.test(e.id) && (e.pool === 'v45' || e.pool === 'v5')
    && typeof e.at === 'number' && Number.isSafeInteger(e.at) && e.at >= 0;
}

// One instance is shared by all sessions in the single service process. Only mutations are serialized;
// upstream calls may run concurrently, after their reservations have reached durable storage.
export class FreeQuota {
  private readonly file: string;
  private tail: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(private readonly dataDir: string, private readonly now: () => number = Date.now) {
    this.file = join(dataDir, 'free-quota.json');
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const op = this.tail.then(fn);
    this.tail = op.then(() => {}, () => {});
    return op;
  }

  private async read(): Promise<Entry[]> {
    try {
      const handle = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('invalid quota file');
        const state = JSON.parse(await handle.readFile('utf8'));
        if (state?.version !== 1 || !Array.isArray(state.entries) || !state.entries.every(validEntry)
          || new Set(state.entries.map((e: Entry) => e.id)).size !== state.entries.length) throw new Error('invalid quota state');
        this.initialized = true;
        return state.entries;
      } finally { await handle.close(); }
    } catch (error) {
      if (!this.initialized && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('免费额度记录不可读取或格式损坏，已暂停免费生图，请联系管理员。');
    }
  }

  private async save(entries: Entry[]): Promise<void> {
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const file = await open(tmp, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 1, entries }) + '\n', 'utf8');
        await file.sync();
      } finally { await file.close(); }
      await rename(tmp, this.file);
      this.initialized = true;
      if (process.platform !== 'win32') {
        const dir = await open(this.dataDir, 'r');
        try { await dir.sync(); } finally { await dir.close(); }
      }
    } catch {
      throw new Error('免费额度记录无法持久化，已暂停本次操作，请联系管理员。');
    } finally { await unlink(tmp).catch(() => {}); }
  }

  async run<T>(model: Model, generate: () => Promise<T>): Promise<T> {
    const pool = poolFor(model);
    const id = randomUUID();
    await this.serialize(async () => {
      const stored = await this.read();
      const at = this.now();
      const entries = stored.filter(e => e.at > at - WINDOW_MS);
      const used = entries.filter(e => e.pool === pool);
      if (used.length >= LIMITS[pool]) {
        const next = Math.min(...used.map(e => e.at)) + WINDOW_MS;
        throw new Error(`NAI ${pool === 'v45' ? '4.5' : '5'} 系列过去 5 小时的免费体验额度已用尽，预计最早恢复时间：${new Date(next).toISOString()}。请配置个人 API Key 继续使用。`);
      }
      await this.save([...entries, { id, pool, at }]);
    });
    try { return await generate(); }
    catch (error) {
      await this.serialize(async () => {
        const entries = await this.read();
        const cutoff = this.now() - WINDOW_MS;
        await this.save(entries.filter(e => e.id !== id && e.at > cutoff));
      });
      throw error;
    }
  }

  flush(): Promise<void> { return this.tail; }
}
