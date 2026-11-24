import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import sharp from 'sharp';
import { startHttpServer } from '../dist/http-app.js';
import { getRuntimeOptions, prepareDirectories } from '../dist/runtime.js';

// All connections terminate on loopback; never inherit service credentials or call an external upstream.
const defaultKey = 'test-free-key';
const personalKey = 'test-paid-key';
const rejectedKey = 'test-rejected-key';
const imageBase = new URL('https://images.example.test/public/prefix');
const clientInfo = { name: 'transport-test', version: '1' };
const protocolVersion = '2025-11-25';
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo } };
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const rpcHeaders = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
const freeTools = ['generate_image', 'get_nai_prompt'];
const paidTools = [...freeTools, 'img2img', 'inpaint_image', 'augment_image', 'upscale_image', 'encode_vibe', 'suggest_tags', 'get_subscription'].sort();
const entry = fileURLToPath(new URL('../dist/streamable-http-server.js', import.meta.url));
const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#2381ae' } }).png().toBuffer();

function fetchLocal(url, options = {}) {
  assert.equal(new URL(url).hostname, '127.0.0.1');
  return fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000), ...options });
}
function post(url, body, headers = {}) {
  return fetchLocal(url, { method: 'POST', headers: { ...rpcHeaders, ...headers }, body: JSON.stringify(body) });
}
async function rpcResult(response) {
  assert.equal(response.status, 200);
  const text = await response.text();
  const data = text.split(/\r?\n/).find(line => line.startsWith('data:') && line.slice(5).trim());
  const msg = JSON.parse(data ? data.slice(5) : text);
  assert.equal(msg.error, undefined);
  return msg.result;
}
async function rpcError(response, status) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, null);
  assert.equal(typeof body.error.code, 'number');
  assert.equal(typeof body.error.message, 'string');
  assert.doesNotMatch(JSON.stringify(body), /test-(?:free|paid|rejected)-key/);
  return body.error;
}
async function initSession(url, headers = {}) {
  const response = await post(url, init, headers);
  const id = response.headers.get('Mcp-Session-Id');
  assert.equal((await rpcResult(response)).protocolVersion, protocolVersion);
  assert.ok(id);
  return { 'Mcp-Session-Id': id, 'MCP-Protocol-Version': protocolVersion };
}

async function fixture(t, { seed, ...overrides } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nai-http-'));
  const archiveDir = join(root, 'images');
  const dataDir = join(root, 'data');
  let service;
  t.after(async () => {
    try { await service?.close(); } finally { await rm(root, { recursive: true, force: true }); }
  });
  await seed?.(archiveDir, dataDir);
  service = await startHttpServer({
    defaultApiKey: defaultKey, imageOrigin: imageBase, imageTtlMs: 300_000, archiveDir, dataDir,
    bindHost: '127.0.0.1', port: 0, upstreamBaseUrl: 'http://127.0.0.1:1', ...overrides,
  });
  const origin = `http://127.0.0.1:${service.server.address().port}`;
  return { ...service, origin, mcp: new URL('/mcp', origin), archiveDir, dataDir };
}

async function mockUpstream(t) {
  const calls = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume request before replying */ }
    const auth = req.headers.authorization;
    calls.push({ route: req.url, auth });
    if (auth === `Bearer ${rejectedKey}`) return res.writeHead(401).end();
    if (req.url === '/ai/generate-image') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(png);
    res.writeHead(404).end();
  });
  server.listen({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { calls, upstreamBaseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function sdk(mcp, headers = {}) {
  const client = new Client(clientInfo);
  const transport = new StreamableHTTPClientTransport(mcp, { requestInit: { headers } });
  try { await client.connect(transport, { timeout: 8_000 }); }
  catch (error) { await client.close(); throw error; }
  return { client, transport };
}

test('真实 SDK 握手与 tools/list：仅省略 Authorization 使用免费工具及默认 Key；显式 Key 失败不重试', { timeout: 30_000 }, async t => {
  const { calls, upstreamBaseUrl } = await mockUpstream(t);
  const { mcp, origin, dataDir, archiveDir } = await fixture(t, { upstreamBaseUrl });
  const generation = { name: 'generate_image', arguments: { base_prompt: 'green leaves', width: 64, height: 64, seed: 1 } };
  for (const [key, names] of [[undefined, freeTools], [personalKey, paidTools], [rejectedKey, paidTools]]) {
    const { client, transport } = await sdk(mcp, key ? { Authorization: `bEaReR ${key}` } : {});
    try {
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), names);
      const result = await client.callTool(generation);
      if (key === rejectedKey) {
        assert.equal(result.isError, true);
        assert.doesNotMatch(JSON.stringify(result), /test-(?:free|paid|rejected)-key/);
      } else {
        assert.notEqual(result.isError, true, result.content[0]?.text);
        const match = /\((https:\/\/[^)]+)\)/.exec(result.content[0].text);
        assert.ok(match, 'expected an absolute HTTPS image link');
        const url = new URL(match[1]);
        assert.equal(url.origin, imageBase.origin);
        assert.match(url.pathname, /^\/public\/prefix\/novelai-images\/[A-Za-z0-9_-]{43}\.png$/);
        const download = await fetchLocal(new URL(url.pathname.slice(imageBase.pathname.length), origin));
        assert.equal(download.status, 200);
        assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
      }
      const headers = { 'Mcp-Session-Id': transport.sessionId, ...(key ? { Authorization: `Bearer ${key}` } : {}) };
      await transport.terminateSession();
      await rpcError(await post(mcp, list, headers), 404);
    } finally { await client.close(); }
  }
  assert.deepEqual(calls.map(c => c.auth), [defaultKey, personalKey, rejectedKey].map(key => `Bearer ${key}`));
  assert.ok(calls.every(c => c.route === '/ai/generate-image'));
  assert.ok((await readdir(dataDir)).includes('free-quota.json'));
  assert.ok(!(await readdir(archiveDir)).includes('free-quota.json'));
});

// Node's fetch Headers combines duplicate fields: use http.request to exercise true wire duplicates.
function duplicateAuthorization(url, method, headers, values) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: { ...rpcHeaders, ...headers, Authorization: values }, signal: AbortSignal.timeout(5_000) }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(method === 'POST' ? JSON.stringify(headers['Mcp-Session-Id'] ? list : init) : undefined);
  });
}
function sessionRequest(mcp, method, headers) {
  return method === 'POST' ? post(mcp, list, headers) : fetchLocal(mcp, { method, headers: { Accept: 'text/event-stream', ...headers } });
}

test('Authorization 空、错误、合并或重复均拒绝；GET/POST/DELETE 一律校验模式与密钥指纹', { timeout: 30_000 }, async t => {
  const { mcp } = await fixture(t);
  const free = await initSession(mcp);
  const paid = await initSession(mcp, { Authorization: `Bearer ${personalKey}` });
  await rpcError(await post(mcp, init, { Authorization: `Bearer ${defaultKey}` }), 403);
  for (const value of ['', 'Basic abc', 'Bearer ', 'Bearer abc def', 'Bearer abc, Bearer def', 'Bearer key=inside']) {
    const error = await rpcError(await post(mcp, init, { Authorization: value }), 401);
    assert.match(error.message, /Authorization: Bearer <USER_API_KEY>/);
  }
  await rpcError(await fetchLocal(mcp, { method: 'POST', headers: { ...rpcHeaders, ...paid }, body: '{' }), 403);
  await rpcError(await duplicateAuthorization(mcp, 'POST', {}, ['Bearer first', 'Bearer second']), 401);
  for (const method of ['GET', 'POST', 'DELETE']) {
    await rpcError(await sessionRequest(mcp, method, { ...paid, Authorization: '' }), 401);
    await rpcError(await duplicateAuthorization(mcp, method, paid, [`Bearer ${personalKey}`, `Bearer ${personalKey}`]), 401);
    for (const headers of [paid, { ...paid, Authorization: 'Bearer other-key' }, { ...free, Authorization: `Bearer ${defaultKey}` }]) {
      await rpcError(await sessionRequest(mcp, method, headers), 403);
    }
  }
  // A rejected DELETE must not revoke someone else's session. The same identity still works.
  for (const [headers, names] of [[free, freeTools], [{ ...paid, Authorization: `Bearer ${personalKey}` }, paidTools]]) {
    assert.deepEqual((await rpcResult(await post(mcp, list, headers))).tools.map(tool => tool.name).sort(), names);
    assert.equal((await sessionRequest(mcp, 'DELETE', headers)).status, 200);
    await rpcError(await post(mcp, list, headers), 404);
  }
});

test('CORS 默认通配、只读健康状态、旧路由全部不可用', async t => {
  const { origin, mcp } = await fixture(t);
  const options = { headers: { Origin: 'https://an-arbitrary.example.test' } };
  const res = await fetchLocal(new URL('/health', origin), options);
  assert.deepEqual(await res.json(), { status: 'ok' });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Access-Control-Allow-Credentials'), null);
  const session = await initSession(mcp, options.headers);
  assert.equal((await sessionRequest(mcp, 'DELETE', session)).status, 200);
  for (const [method, path] of [['GET', '/sse'], ['POST', '/message'], ['GET', '/admin'], ['POST', '/novelai/not-a-link/mcp'], ['OPTIONS', '/absent']]) {
    assert.equal((await fetchLocal(new URL(path, origin), { method })).status, 404);
  }
});

test('显式 CORS allowlist 精确匹配，拒绝未列明的 localhost、图片源、预检和 Host 伪装', async t => {
  const origin = 'https://client.example.test';
  const { mcp } = await fixture(t, { allowedOrigins: [origin] });
  const preflight = { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, mcp-session-id, mcp-protocol-version',
  } };
  const ok = await fetchLocal(mcp, preflight);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), origin);
  assert.match(ok.headers.get('Vary'), /origin/i);
  assert.match(ok.headers.get('Access-Control-Allow-Headers'), /authorization/i);
  assert.match(ok.headers.get('Access-Control-Expose-Headers'), /mcp-session-id/i);
  for (const bad of ['http://localhost', imageBase.origin, origin + '.evil.test', 'null']) {
    await rpcError(await post(mcp, init, { Origin: bad, 'X-Forwarded-Host': 'client.example.test' }), 403);
    const denied = await fetchLocal(mcp, { ...preflight, headers: { ...preflight.headers, Origin: bad } });
    await rpcError(denied, 403);
    assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
  }
});

test('JSON 解析、50 MiB 请求体限制、SDK 协商与会话错误均可恢复', { timeout: 25_000 }, async t => {
  const { mcp } = await fixture(t);
  const syntaxError = await fetchLocal(mcp, { method: 'POST', headers: rpcHeaders, body: '{' });
  assert.equal((await rpcError(syntaxError, 400)).code, -32700);
  const badAuth = await fetchLocal(mcp, { method: 'POST', headers: { ...rpcHeaders, Authorization: 'Basic a' }, body: '{' });
  await rpcError(badAuth, 401);
  const chunk = Buffer.alloc(1024 * 1024, 32);
  const body = (async function* () { for (let i = 0; i < 50; i++) yield chunk; yield ' '; })();
  await rpcError(await fetchLocal(mcp, { method: 'POST', headers: rpcHeaders, duplex: 'half', body }), 413);
  const badAccept = await post(mcp, init, { Accept: 'application/json' });
  assert.equal(badAccept.status, 406);
  assert.equal(badAccept.headers.get('Mcp-Session-Id'), null);
  await badAccept.arrayBuffer();
  await rpcError(await post(mcp, list), 400);
  const session = await initSession(mcp);
  assert.equal((await rpcResult(await post(mcp, list, session))).tools.length, freeTools.length);
});

async function archive(dir, char, { age = 0, privateImage = false } = {}) {
  const id = char.repeat(43);
  await mkdir(join(dir, id), { recursive: true });
  await writeFile(join(dir, id, 'image.png'), png);
  await writeFile(join(dir, id, 'metadata.json'), JSON.stringify({ schema_version: 2, id,
    created_at: new Date(Date.now() - age).toISOString(), private: privateImage, mime_type: 'image/png', ext: 'png', size_bytes: png.length,
  }));
  return id;
}

test('启动前清除过期归档；两次定时清理之间也按 TTL 拒绝 GET/HEAD，不暴露私有及非图片', async t => {
  const ttl = 30_000;
  const { archiveDir, dataDir, origin } = await fixture(t, { imageTtlMs: ttl, seed: async (dir, data) => {
    await archive(dir, 'x', { age: ttl + 5_000 });
    await archive(dir, 'p', { privateImage: true });
    await archive(dir, 'f');
    await archive(data, 'x', { age: ttl + 5_000 }); // Even archive-shaped persistent records must never be swept.
  } });
  await assert.rejects(access(join(archiveDir, 'x'.repeat(43))), { code: 'ENOENT' });
  await access(join(dataDir, 'x'.repeat(43), 'metadata.json'));
  await archive(archiveDir, 's', { age: ttl + 5_000 });
  const url = name => new URL(`/novelai-images/${name}`, origin);
  for (const method of ['GET', 'HEAD']) {
    const ok = await fetchLocal(url('f'.repeat(43) + '.png'), { method });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.equal(ok.headers.get('content-length'), String(png.length));
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.match(ok.headers.get('cache-control'), /no-store/);
    if (method === 'GET') assert.deepEqual(Buffer.from(await ok.arrayBuffer()), png);
    for (const filename of ['s'.repeat(43) + '.png', 'p'.repeat(43) + '.png', 'f'.repeat(43) + '.webp', 'metadata.json', 'free-quota.json']) {
      assert.equal((await fetchLocal(url(filename), { method })).status, 404);
    }
  }
});

test('运行选项采用新变量，拒绝危险 URL、无效 TTL 和未配置默认密钥', () => {
  const opts = getRuntimeOptions({ DEFAULT_NOVELAI_API_KEY: defaultKey });
  assert.deepEqual(opts.allowedOrigins, ['*']);
  assert.equal(opts.bindHost, '0.0.0.0');
  assert.equal(opts.port, 3000);
  assert.equal(opts.imageTtlMs, 300_000);
  assert.equal(opts.imageOrigin.href, 'https://api.chiyotobi.party/mcp');
  assert.equal(opts.dataDir, resolve('data'));
  assert.equal(opts.archiveDir, resolve('outputs'));
  const config = { DEFAULT_NOVELAI_API_KEY: defaultKey, MCP_IMAGE_PUBLIC_BASE_URL: imageBase.href, UPSTREAM_BASE_URL: 'http://127.0.0.1:8009/mock',
    MCP_IMAGE_TTL_SECONDS: '12', MCP_ALLOWED_ORIGINS: 'https://web.example.test, http://localhost:8888', PORT: '0' };
  assert.equal(getRuntimeOptions(config).upstreamBaseUrl, config.UPSTREAM_BASE_URL);
  assert.equal(getRuntimeOptions(config).imageOrigin.href, imageBase.href);
  assert.equal(getRuntimeOptions(config).imageTtlMs, 12_000);
  assert.deepEqual(getRuntimeOptions(config).allowedOrigins, ['https://web.example.test', 'http://localhost:8888']);
  assert.throws(() => getRuntimeOptions({ NOVELAI_API_KEY: 'old' }), /DEFAULT_NOVELAI_API_KEY/);
  for (const value of ['http://example.test', 'https://user:secret@example.test', imageBase.href + '?q=1', imageBase.href + '#', '']) {
    assert.throws(() => getRuntimeOptions({ ...config, MCP_IMAGE_PUBLIC_BASE_URL: value }), /MCP_IMAGE_PUBLIC_BASE_URL/);
  }
  for (const value of ['0', '-1', '0.5', 'Infinity', '9007199254740992']) {
    assert.throws(() => getRuntimeOptions({ ...config, MCP_IMAGE_TTL_SECONDS: value }), /MCP_IMAGE_TTL_SECONDS/);
  }
  assert.throws(() => getRuntimeOptions({ ...config, MCP_ALLOWED_ORIGINS: 'https://client.test/path' }), /MCP_ALLOWED_ORIGINS/);
});

test('启动目录同时做 lexical 和 realpath 隔离校验（包含尚未建立的子目录、链接及根目录）', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nai-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  await mkdir(data);
  const alias = join(root, 'alias');
  await symlink(data, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const [a, b] of [[data, data], [data, join(data, 'new')], [join(data, 'new'), data], [alias, data],
    [join(alias, 'new'), data], [data, join(alias, 'new')], [parse(root).root, data], [process.cwd(), data], [tmpdir(), data]]) {
    await assert.rejects(prepareDirectories(a, b), /独立目录|专用子目录/);
  }
  await assert.rejects(access(join(data, 'new')), { code: 'ENOENT' });
  // A lexical child remains forbidden even when a junction points it at a different physical tree.
  const other = join(root, 'external');
  await mkdir(other);
  const child = join(data, 'child-link');
  await symlink(other, child, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareDirectories(data, child), /独立目录/);
  const result = await prepareDirectories(join(root, 'data-images'), data);
  await Promise.all([access(result.archiveDir), access(result.dataDir)]);
});

test('关停同时回收 SDK GET 流、停止监听，重复 close 安全', { timeout: 12_000 }, async t => {
  const { mcp, close, server } = await fixture(t);
  const session = await initSession(mcp);
  const stream = await sessionRequest(mcp, 'GET', session);
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const end = stream.text();
  await Promise.all([close(), close(), end]);
  assert.equal(server.listening, false);
});

test('入口在 SIGTERM 后有序退出且日志不含 Key', { skip: process.platform === 'win32', timeout: 12_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nai-signal-'));
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'ignore', 'pipe'], env: {
    DEFAULT_NOVELAI_API_KEY: defaultKey, MCP_BIND_HOST: '127.0.0.1', PORT: '0',
    MCP_DATA_DIR: join(root, 'data'), MCP_IMAGE_ARCHIVE_DIR: join(root, 'images'), UPSTREAM_BASE_URL: 'http://127.0.0.1:1',
  } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });
  const timeout = { signal: AbortSignal.timeout(8_000) };
  const exited = once(child, 'exit', timeout);
  let log = '';
  child.stderr.on('data', chunk => { log += chunk; });
  await Promise.race([once(child.stderr, 'data', timeout), exited.then(() => assert.fail('提前退出'))]);
  assert.match(log, /\/mcp/);
  assert.ok(child.kill('SIGTERM'));
  assert.deepEqual(await exited, [0, null]);
  assert.ok(!log.includes(defaultKey));
});
