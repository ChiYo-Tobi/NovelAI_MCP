import { mkdir, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export interface AppOptions {
  defaultApiKey: string;
  upstreamBaseUrl?: string;
  archiveDir: string;
  dataDir: string;
  imageOrigin: URL;
  imageTtlMs: number;
  allowedOrigins?: readonly string[];
}

// URL() accepts userinfo, backslashes, control characters and empty ?/# suffixes;
// none belong in service configuration. Never echo a rejected value (it might contain a key).
function httpUrl(value: string): URL | undefined {
  if (!/^https?:\/\/[^/@]+(?:\/[^?#]*)?$/i.test(value) || /[\s\\?#\x00-\x1f\x7f]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.hostname && !url.username && !url.password) return url;
  } catch { /* invalid URL */ }
  return undefined;
}

export function parseOrigin(value: string): URL | undefined {
  const url = httpUrl(value);
  return url && /^https?:\/\/[^/]+\/?$/i.test(value) ? url : undefined;
}

export function parseAllowedOrigins(values: readonly string[] = ['*']): string[] {
  return values.map(value => {
    if (value === '*') return value;
    const url = parseOrigin(value);
    if (!url) throw new Error('MCP_ALLOWED_ORIGINS 必须是 * 或逗号分隔的 HTTP/HTTPS 源地址');
    return url.origin;
  });
}

// An equality/ancestor check, not a string prefix (e.g. /data and /data-images are siblings).
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function checkDirectories(archiveDir: string, dataDir: string, protectedPaths: string[]): void {
  if (contains(archiveDir, dataDir) || contains(dataDir, archiveDir)) {
    throw new Error('MCP_IMAGE_ARCHIVE_DIR 和 MCP_DATA_DIR 必须是独立目录，不能相同或互相包含');
  }
  for (const dir of [archiveDir, dataDir]) {
    if (dir === parse(dir).root || protectedPaths.some(path => contains(dir, path))) {
      throw new Error('归档和持久化数据必须使用专用子目录，不能使用根目录、工作目录、主目录或临时目录本身及其上级');
    }
  }
}

// Resolve even not-yet-created children of links/junctions before mkdir can touch the wrong tree.
async function projectedRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await projectedRealpath(dirname(path)), basename(path));
  }
}

export async function prepareDirectories(archive: string, data: string) {
  if (!archive.trim() || !data.trim()) throw new Error('归档和持久化目录路径不能为空');
  const lexical = [resolve(archive), resolve(data)] as const;
  const protectedPaths = [process.cwd(), homedir(), tmpdir()].map(path => resolve(path));
  checkDirectories(...lexical, protectedPaths);
  const [archivePath, dataPath, ...protectedReal] = await Promise.all([...lexical, ...protectedPaths].map(projectedRealpath));
  checkDirectories(archivePath, dataPath, protectedReal);
  await Promise.all([archivePath, dataPath].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const [archiveDir, dataDir] = await Promise.all(lexical.map(path => realpath(path)));
  checkDirectories(archiveDir, dataDir, protectedReal);
  return { archiveDir, dataDir };
}

function integer(value: string, name: string, min: number, max: number): number {
  const result = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 的整数`);
  }
  return result;
}

export function getRuntimeOptions(env: NodeJS.ProcessEnv = process.env): AppOptions & { bindHost: string; port: number } {
  const defaultApiKey = env.DEFAULT_NOVELAI_API_KEY;
  if (!defaultApiKey || !/^[A-Za-z0-9._~+/-]+=*$/.test(defaultApiKey)) {
    throw new Error('必须设置有效的 DEFAULT_NOVELAI_API_KEY');
  }
  const imageOrigin = httpUrl(env.MCP_IMAGE_PUBLIC_BASE_URL ?? 'https://api.chiyotobi.party/mcp');
  if (imageOrigin?.protocol !== 'https:') throw new Error('MCP_IMAGE_PUBLIC_BASE_URL 必须是 HTTPS 地址，可包含路径前缀，不可包含凭据、查询或片段');
  const upstreamBaseUrl = env.UPSTREAM_BASE_URL;
  if (upstreamBaseUrl !== undefined && !httpUrl(upstreamBaseUrl)) throw new Error('UPSTREAM_BASE_URL 必须是无凭据、查询或片段的 HTTP/HTTPS 地址');
  return {
    defaultApiKey, upstreamBaseUrl, imageOrigin,
    dataDir: resolve(env.MCP_DATA_DIR ?? 'data'),
    archiveDir: resolve(env.MCP_IMAGE_ARCHIVE_DIR ?? 'outputs'),
    imageTtlMs: integer(env.MCP_IMAGE_TTL_SECONDS ?? '300', 'MCP_IMAGE_TTL_SECONDS', 1, Math.floor(Number.MAX_SAFE_INTEGER / 1000)) * 1000,
    allowedOrigins: parseAllowedOrigins(env.MCP_ALLOWED_ORIGINS?.split(',').map(origin => origin.trim()).filter(Boolean)),
    bindHost: env.MCP_BIND_HOST || '0.0.0.0',
    port: integer(env.PORT ?? '3000', 'PORT', 0, 65_535),
  };
}

export function logFatal(error: unknown): void {
  // Configuration errors above contain only setting names. Filesystem and SDK exceptions can
  // include arbitrary input in their messages; do not dump error objects or request headers.
  console.error('服务运行失败', error instanceof Error && (
    /^(?:MCP_|UPSTREAM_BASE_URL|PORT |必须设置有效的 DEFAULT_NOVELAI_API_KEY|归档和持久化)/.test(error.message)
  ) ? error.message : '请检查服务配置、目录权限和监听端口');
  process.exitCode = 1;
}

export function onShutdown(close: () => Promise<void>): void {
  function stop() {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    void close().catch(logFatal);
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
