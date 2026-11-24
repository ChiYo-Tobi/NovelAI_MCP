import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ErrorCode, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { FreeQuota } from './free-quota.js';
import { cleanupExpiredImages, IMAGE_PATH, loadArchivedImage } from './image-archive.js';
import { createNovelAIMcpServer } from './mcp-tools.js';
import { NovelAIClient } from './novelai-client.js';
import { getRuntimeOptions, parseAllowedOrigins, prepareDirectories } from './runtime.js';
import type { AppOptions } from './runtime.js';
import { VibeCache } from './vibe-cache.js';

const SESSION_TIMEOUT = 30 * 60_000;
const IMAGE_FILENAME = /^([A-Za-z0-9_-]{43})\.(png|webp|jpg)$/;
const BEARER = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i;
const parseMcpBody = express.json({ limit: '50mb' });

type Mode = 'free' | 'paid';
interface Session {
  transport: StreamableHTTPServerTransport;
  mode: Mode;
  fingerprint: Buffer;
  lastActivity: number;
}

function rpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', id: null, error: { code, message } });
}

const handleHttpError: ErrorRequestHandler = (error, _req, res, _next) => {
  if (res.headersSent) {
    res.destroy();
  } else if (error?.type === 'entity.too.large') {
    rpcError(res, 413, ErrorCode.InvalidRequest, '请求体超过 50 MB');
  } else if (error?.type === 'entity.parse.failed') {
    rpcError(res, 400, ErrorCode.ParseError, '请求体必须是有效的 JSON');
  } else if (typeof error?.status === 'number' && error.status >= 400 && error.status < 500) {
    rpcError(res, error.status, ErrorCode.InvalidRequest, '请求格式无效');
  } else {
    console.error('MCP HTTP 请求处理失败');
    rpcError(res, 500, ErrorCode.InternalError, 'MCP HTTP 请求处理失败');
  }
};

type Credentials = { mode: Mode; key: string };
type McpResponse = Response<unknown, { auth: Credentials & { fingerprint: Buffer; session?: Session } }>;

function credentials(req: Request, defaultApiKey: string): Credentials | undefined {
  // req.get()/req.headers normally discard duplicate Authorization headers in Node.
  const values = req.headersDistinct.authorization;
  if (values === undefined) return { mode: 'free', key: defaultApiKey };
  const match = values.length === 1 && BEARER.exec(values[0]);
  return match ? { mode: 'paid', key: match[1] } : undefined;
}

export async function createStreamableHttpApp(options: AppOptions) {
  const { defaultApiKey, upstreamBaseUrl, imageOrigin, imageTtlMs } = options;
  if (!defaultApiKey) throw new Error('必须设置有效的 DEFAULT_NOVELAI_API_KEY');
  if (!Number.isSafeInteger(imageTtlMs) || imageTtlMs <= 0) throw new Error('MCP_IMAGE_TTL_SECONDS 必须指定有效的图片保留时间');
  if (imageOrigin.protocol !== 'https:' || imageOrigin.username || imageOrigin.password || imageOrigin.search || imageOrigin.hash) {
    throw new Error('MCP_IMAGE_PUBLIC_BASE_URL 必须是无凭据、查询或片段的 HTTPS 地址');
  }
  const allowedOrigins = new Set(parseAllowedOrigins(options.allowedOrigins));
  const allowAnyOrigin = allowedOrigins.has('*');
  const { archiveDir, dataDir } = await prepareDirectories(options.archiveDir, options.dataDir);
  const quota = new FreeQuota(dataDir);
  const vibeCache = new VibeCache(dataDir);
  await cleanupExpiredImages(archiveDir, imageTtlMs);

  const sessions = new Map<string, Session>();
  const serverFingerprint = createHash('sha256').update(defaultApiKey).digest();
  let closing = false;
  async function removeSession(id: string): Promise<void> {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    try { await session.transport.close(); }
    catch { console.error('关闭 MCP 会话失败'); }
  }

  const app = express();
  app.disable('x-powered-by');
  app.enable('case sensitive routing');
  app.enable('strict routing');
  const imagePath = `${IMAGE_PATH}:filename`;
  app.all(['/mcp', '/health', imagePath], (req, res, next) => {
    const origins = req.headersDistinct.origin;
    if (origins && (origins.length !== 1 || (!allowAnyOrigin && !allowedOrigins.has(origins[0])))) {
      rpcError(res, 403, ErrorCode.InvalidRequest, '请求来源未获允许');
      return;
    }
    next();
  }, cors({
    origin: allowAnyOrigin ? '*' : [...allowedOrigins],
    methods: ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'Last-Event-ID'],
    exposedHeaders: ['Mcp-Session-Id', 'MCP-Protocol-Version'],
  }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get(imagePath, async (req, res) => {
    res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    const match = IMAGE_FILENAME.exec(req.params.filename);
    if (!match) return void res.sendStatus(404);
    try {
      const image = await loadArchivedImage(archiveDir, match[1], { publicOnly: true, ttlMs: imageTtlMs });
      if (image.ext !== match[2]) return void res.sendStatus(404);
      res.type(image.mimeType).send(image.buffer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return void res.sendStatus(404);
      throw error;
    }
  });

  function authorize(req: Request, res: McpResponse, next: NextFunction): void {
    res.set('Cache-Control', 'no-store');
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
      res.set('Allow', 'GET, POST, DELETE, OPTIONS');
      return rpcError(res, 405, ErrorCode.InvalidRequest, '不支持此 HTTP 方法');
    }
    const auth = credentials(req, defaultApiKey);
    if (!auth) {
      res.set('WWW-Authenticate', 'Bearer');
      return rpcError(res, 401, -32001, '请提供单个 Authorization: Bearer <USER_API_KEY>，然后重新初始化');
    }
    const fingerprint = auth.mode === 'free' ? serverFingerprint : createHash('sha256').update(auth.key).digest();
    if (auth.mode === 'paid' && timingSafeEqual(fingerprint, serverFingerprint)) {
      return rpcError(res, 403, -32001, '此凭据不能用于个人模式，请使用自己的 API Key 重新初始化');
    }
    const id = req.get('Mcp-Session-Id');
    const session = id === undefined ? undefined : sessions.get(id);
    if (id !== undefined && (!session || session.transport.sessionId !== id)) {
      return rpcError(res, 404, -32001, 'MCP 会话不存在或已关闭，请重新初始化');
    }
    if (session && (session.mode !== auth.mode || !timingSafeEqual(session.fingerprint, fingerprint))) {
      return rpcError(res, 403, -32001, '身份与 MCP 会话不符，请重新初始化');
    }
    res.locals.auth = { ...auth, fingerprint, session };
    next();
  }

  async function handleMcp(req: Request, res: McpResponse): Promise<void> {
    // Recheck liveness after parsing: shutdown, DELETE, or the idle sweep may run as the body arrives.
    if (closing) return rpcError(res, 503, ErrorCode.InternalError, 'MCP 服务正在关闭');
    const { mode, key, fingerprint, session } = res.locals.auth;
    if (session) {
      const id = req.get('Mcp-Session-Id')!;
      if (sessions.get(id) !== session) return rpcError(res, 404, -32001, 'MCP 会话已关闭，请重新初始化');
      if (Date.now() - session.lastActivity >= SESSION_TIMEOUT) {
        await removeSession(id);
        return rpcError(res, 404, -32001, 'MCP 会话已过期，请重新初始化');
      }
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }
    if (req.method !== 'POST' || !isInitializeRequest(req.body)) return rpcError(res, 400, ErrorCode.InvalidRequest, '缺少 MCP 会话 ID');

    const sessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
    // Install before connect() so the SDK chains its own protocol cleanup to this hook.
    transport.onclose = () => { sessions.delete(sessionId); };
    sessions.set(sessionId, { mode, fingerprint, transport, lastActivity: Date.now() });
    try {
      const client = new NovelAIClient(key, { baseUrl: upstreamBaseUrl });
      await createNovelAIMcpServer({ mode, client, archiveDir, imageOrigin, vibeCache, quota, imageTtlMs }).connect(transport);
      if (closing) return rpcError(res, 503, ErrorCode.InternalError, 'MCP 服务正在关闭');
      await transport.handleRequest(req, res, req.body);
    } finally {
      if (!transport.sessionId || res.statusCode !== 200 || !res.headersSent) await removeSession(sessionId);
    }
  }

  app.route('/mcp').all(authorize).post(parseMcpBody, handleMcp).get(handleMcp).delete(handleMcp);
  app.use((_req, res) => res.sendStatus(404));
  app.use(handleHttpError);

  let sweep: Promise<void> | undefined;
  const timer = setInterval(() => {
    const expiredBefore = Date.now() - SESSION_TIMEOUT;
    for (const [id, session] of sessions) if (session.lastActivity <= expiredBefore) void removeSession(id);
    sweep ??= cleanupExpiredImages(archiveDir, imageTtlMs)
      .then(() => {}, () => { console.error('清理过期归档图像失败，将在下一轮重试'); })
      .finally(() => { sweep = undefined; });
  }, 60_000).unref();

  let closed: Promise<void> | undefined;
  function close(): Promise<void> {
    closing = true;
    clearInterval(timer);
    return closed ??= (async () => {
      await Promise.all([sweep, ...[...sessions.keys()].map(removeSession)]);
      await quota.flush();
    })();
  }
  return { app, close };
}

export async function startHttpServer(options = getRuntimeOptions()) {
  const { app, close: closeApp } = await createStreamableHttpApp(options);
  const server = createServer({ headersTimeout: 15_000, requestTimeout: 0 }, app);
  // Node silently discards headers after maxHeadersCount; keep all fields inside its byte limit.
  server.maxHeadersCount = 0;
  try {
    server.listen({ port: options.port, host: options.bindHost });
    await once(server, 'listening');
  } catch (error) {
    await closeApp();
    throw error;
  }
  let closed: Promise<void> | undefined;
  function close(): Promise<void> {
    return closed ??= (async () => {
      const deadline = setTimeout(() => server.closeAllConnections(), 5_000).unref();
      try {
        const listenerClosed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await Promise.all([listenerClosed, closeApp()]);
      } finally {
        clearTimeout(deadline);
      }
    })();
  }
  return { server, close };
}
