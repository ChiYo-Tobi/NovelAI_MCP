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
const secondKey = 'test-other-key';
const rejectedKey = 'test-rejected-key';
const balances = new Map([[`Bearer ${personalKey}`, 17], [`Bearer ${secondKey}`, 83]]);
const imageBase = new URL('https://images.example.test/public/prefix');
const clientInfo = { name: 'transport-test', version: '1' };
const protocolVersion = '2025-11-25';
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo } };
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const rpcHeaders = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
const freeTools = ['generate_image', 'get_nai_prompt'];
const paidTools = [...freeTools, 'img2img', 'inpaint_image', 'augment_image', 'upscale_image', 'encode_vibe', 'suggest_tags', 'get_subscription'].sort();
const entry = fileURLToPath(new URL('../dist/streamable-http-server.js', import.meta.url));
const testDir = tmpdir();
const legacyHeaders = { 'Mcp-Session-Id': '99033450-36e6-40e8-94f8-c8fcd7b8bb2b', 'MCP-Protocol-Version': protocolVersion };
const generation = { name: 'generate_image', arguments: { base_prompt: 'green leaves', width: 64, height: 64, seed: 1 } };
const promptTool = { name: 'get_nai_prompt', arguments: {} };
const subscription = { name: 'get_subscription', arguments: {} };
const callTool = (params, id = 3) => ({ jsonrpc: '2.0', id, method: 'tools/call', params });
const auth = key => key === undefined ? {} : { Authorization: `Bearer ${key}` };
const toolNames = result => result.tools.map(tool => tool.name).sort();
const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#2381ae' } }).png().toBuffer();

function assertNoSessionId(response) {
  assert.equal(response.headers.get('Mcp-Session-Id'), null);
  assert.doesNotMatch(response.headers.get('Access-Control-Expose-Headers') ?? '', /\bmcp-session-id\b/i);
}
async function fetchLocal(url, options = {}) {
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const timeout = AbortSignal.timeout(10_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const response = await fetch(url, { ...options, redirect: 'error', signal });
  assertNoSessionId(response);
  return response;
}
function post(url, body, headers = {}) {
  return fetchLocal(url, { method: 'POST', headers: { ...rpcHeaders, ...headers }, body: JSON.stringify(body) });
}
// A single POST may return JSON or a finite SSE stream. Ignore SSE comments/priming events,
// but require exactly one JSON-RPC reply on this HTTP request, with that request's id.
async function postResult(url, body, headers = {}) {
  const response = await post(url, body, headers);
  assert.equal(response.status, 200);
  const media = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  let messages;
  if (media === 'application/json') {
    messages = [].concat(await response.json());
  } else {
    assert.equal(media, 'text/event-stream');
    messages = (await response.text()).split(/\r?\n\r?\n/)
      .map(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n').trim())
      .filter(Boolean).map(data => JSON.parse(data));
  }
  const replies = messages.filter(msg => 'result' in msg || 'error' in msg);
  assert.equal(replies.length, 1);
  const [msg] = replies;
  assert.equal(msg.jsonrpc, '2.0');
  assert.equal(msg.id, body.id);
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
  assert.doesNotMatch(JSON.stringify(body), /test-(?:free|paid|other|rejected)-key/);
  return body.error;
}
function assertPrompt(result) {
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0]?.type, 'text');
  assert.match(result.content[0].text, /\S/);
}
function assertBalance(result, expected) {
  assert.notEqual(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[1].text), { balance: expected });
}

async function fixture(t, { seed, ...overrides } = {}) {
  const root = await mkdtemp(join(testDir, '.nai-http-'));
  const archiveDir = join(root, 'images');
  const dataDir = join(root, 'data');
  const options = {
    defaultApiKey: defaultKey, imageOrigin: imageBase, imageTtlMs: 300_000, archiveDir, dataDir,
    bindHost: '127.0.0.1', port: 0, upstreamBaseUrl: 'http://127.0.0.1:1', ...overrides,
  };
  let service;
  t.after(async () => {
    try { await service?.close(); } finally { await rm(root, { recursive: true, force: true }); }
  });
  await seed?.(archiveDir, dataDir);
  service = await startHttpServer(options);
  const port = service.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  async function restart() {
    await service.close();
    service = await startHttpServer({ ...options, port });
    return service;
  }
  return { ...service, origin, mcp: new URL('/mcp', origin), archiveDir, dataDir, restart };
}

async function mockUpstream(t, beforeReply) {
  const calls = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume request before replying */ }
    const call = { method: req.method, route: req.url, auth: req.headers.authorization };
    calls.push(call);
    await beforeReply?.(call);
    if (call.auth === `Bearer ${rejectedKey}`) return res.writeHead(401).end();
    if (call.method === 'GET' && call.route === '/v1/usage' && balances.has(call.auth)) {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ balance: balances.get(call.auth) }));
    }
    if (call.method === 'POST' && call.route === '/ai/generate-image') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(png);
    res.writeHead(404).end();
  });
  server.listen({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { calls, upstreamBaseUrl: `http://127.0.0.1:${server.address().port}` };
}

// Hold one upstream response so another request (or shutdown) provably overlaps it, without sleeps.
function pauseFirstReply() {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let first = true;
  return {
    beforeReply() {
      if (!first) return;
      first = false;
      entered.resolve();
      return gate.promise;
    },
    waitFor: pending => Promise.race([entered.promise, pending.then(() => assert.fail('工具未到达 mock 上游'))]),
    release: gate.resolve,
  };
}

async function sdk(mcp, headers = {}) {
  const client = new Client(clientInfo);
  const posts = [];
  const transport = new StreamableHTTPClientTransport(mcp, {
    requestInit: { headers },
    fetch: (url, options) => {
      if (options.method === 'POST') posts.push(JSON.parse(options.body).method);
      return fetchLocal(url, options);
    },
  });
  try { await client.connect(transport, { timeout: 8_000 }); }
  catch (error) { await client.close(); throw error; }
  return { client, transport, posts };
}

test('真实 SDK 握手不发 ID；仅省略 Authorization 使用免费工具及默认 Key，个人 Key 上游失败不重试', { timeout: 30_000 }, async t => {
  const { calls, upstreamBaseUrl } = await mockUpstream(t);
  const { mcp, origin, dataDir, archiveDir, close } = await fixture(t, { upstreamBaseUrl });
  for (const [key, names] of [[undefined, freeTools], [personalKey, paidTools], [rejectedKey, paidTools]]) {
    const { client, transport } = await sdk(mcp, key ? { Authorization: `bEaReR ${key}` } : {});
    try {
      assert.equal(transport.sessionId, undefined);
      assert.deepEqual(toolNames(await client.listTools()), names);
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
      assert.equal(transport.sessionId, undefined);
    } finally { await client.close(); }
  }
  await close();
  assert.deepEqual(calls, [defaultKey, personalKey, rejectedKey].map(key => ({
    method: 'POST', route: '/ai/generate-image', auth: `Bearer ${key}`,
  })));
  assert.ok((await readdir(dataDir)).includes('free-quota.json'));
  assert.ok(!(await readdir(archiveDir)).includes('free-quota.json'));
});

test('同一 SDK Client 空闲 31 分钟后不重新 initialize，直接调用不计费工具', { timeout: 15_000 }, async t => {
  const { calls, upstreamBaseUrl } = await mockUpstream(t);
  const { mcp } = await fixture(t, { upstreamBaseUrl });
  const { client, transport, posts } = await sdk(mcp);
  try {
    // Move only wall time: real HTTP I/O and request deadlines must keep working.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(31 * 60_000);
    assertPrompt(await client.callTool(promptTool));
    assert.deepEqual(posts, ['initialize', 'notifications/initialized', 'tools/call']);
    assert.equal(transport.sessionId, undefined);
  } finally { await client.close(); }
  assert.deepEqual(calls, []);
});

test('相同旧会话 ID 与 JSON-RPC id 的并发请求：个人 Key A/B 只收到自己的用量，匿名仍为免费模式', { timeout: 20_000 }, async t => {
  const pause = pauseFirstReply();
  const { calls, upstreamBaseUrl } = await mockUpstream(t, pause.beforeReply);
  const { mcp, close } = await fixture(t, { upstreamBaseUrl });
  const send = (body, key) => postResult(mcp, { ...body, id: 7 }, { ...legacyHeaders, ...auth(key) });
  const usage = callTool(subscription);
  const first = send(usage, personalKey);
  try {
    await pause.waitFor(first);
    // Complete B and both catalogs while A's upstream response is still held.
    const [second, denied, free, paid] = await Promise.all([
      send(usage, secondKey), send(usage), send(list), send(list, secondKey),
    ]);
    assertBalance(second, 83);
    assert.equal(denied.isError, true);
    assert.deepEqual(toolNames(free), freeTools);
    assert.deepEqual(toolNames(paid), paidTools);
  } finally { pause.release(); }
  assertBalance(await first, 17);
  const rejected = await send(usage, rejectedKey);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /401/);
  assert.ok(!JSON.stringify(rejected).includes(rejectedKey));
  await close();
  assert.deepEqual(calls, [personalKey, secondKey, rejectedKey].map(key => ({
    method: 'GET', route: '/v1/usage', auth: `Bearer ${key}`,
  })));
});

// Fetch Headers combines duplicate fields. Send separate lines, keeping the real response headers.
async function duplicateAuthorization(url, method, headers, values) {
  assert.equal(url.hostname, '127.0.0.1');
  const response = await new Promise((resolve, reject) => {
    const req = request(url, { method, headers: { ...rpcHeaders, ...headers, Authorization: values }, signal: AbortSignal.timeout(5_000) }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(method === 'POST' ? JSON.stringify(callTool(generation)) : undefined);
  });
  assertNoSessionId(response);
  return response;
}
function nonPost(mcp, method, headers) {
  return fetchLocal(mcp, { method, headers: { Accept: 'text/event-stream', ...headers } });
}

test('错误、重复 Authorization 和显式默认 Key 均不降级；GET/DELETE 先鉴权再判断方法', { timeout: 20_000 }, async t => {
  const { calls, upstreamBaseUrl } = await mockUpstream(t);
  const { mcp } = await fixture(t, { upstreamBaseUrl });
  assert.equal((await postResult(mcp, init, { ...legacyHeaders, ...auth(personalKey) })).protocolVersion, protocolVersion);
  for (const value of ['', 'Basic abc', 'Bearer ', 'Bearer abc def', 'Bearer abc, Bearer def', 'Bearer key=inside']) {
    const response = await post(mcp, callTool(generation), { ...legacyHeaders, Authorization: value });
    assert.match(response.headers.get('WWW-Authenticate') ?? '', /^Bearer\b/i);
    assert.match((await rpcError(response, 401)).message, /Authorization: Bearer <USER_API_KEY>/);
  }
  await rpcError(await post(mcp, init, auth(defaultKey)), 403);
  await rpcError(await duplicateAuthorization(mcp, 'POST', {}, [`Bearer ${personalKey}`, `Bearer ${secondKey}`]), 401);
  for (const method of ['GET', 'POST', 'DELETE']) {
    const send = headers => method === 'POST' ? post(mcp, callTool(generation), headers) : nonPost(mcp, method, headers);
    await rpcError(await send({ ...legacyHeaders, Authorization: '' }), 401);
    await rpcError(await duplicateAuthorization(mcp, method, legacyHeaders, [`Bearer ${personalKey}`, `Bearer ${personalKey}`]), 401);
    await rpcError(await send({ ...legacyHeaders, ...auth(defaultKey) }), 403);
  }
  assert.deepEqual(calls, []);
});

test('有效身份的 GET/DELETE 均以 405 和 Allow 结束，不留独立事件流，也不影响下次 POST', { timeout: 15_000 }, async t => {
  const { mcp } = await fixture(t);
  for (const method of ['GET', 'DELETE']) {
    for (const headers of [{}, auth(personalKey), legacyHeaders, { ...legacyHeaders, ...auth(personalKey) }]) {
      const response = await nonPost(mcp, method, headers);
      assert.equal(response.status, 405);
      assert.deepEqual((response.headers.get('Allow') ?? '').split(',').map(s => s.trim()).sort(), ['OPTIONS', 'POST']);
      assert.doesNotMatch(response.headers.get('Content-Type') ?? '', /text\/event-stream/i);
      await response.arrayBuffer(); // EOF before close(), without aborting a stream.
    }
  }
  assertPrompt(await postResult(mcp, callTool(promptTool), legacyHeaders));
});

test('CORS 默认通配、只读健康状态、旧路由全部不可用', async t => {
  const { origin, mcp } = await fixture(t);
  const options = { headers: { Origin: 'https://an-arbitrary.example.test' } };
  const res = await fetchLocal(new URL('/health', origin), options);
  assert.deepEqual(await res.json(), { status: 'ok' });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Access-Control-Allow-Credentials'), null);
  const initialized = await post(mcp, init, options.headers);
  assert.equal(initialized.status, 200);
  assert.equal(initialized.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(initialized.headers.get('Access-Control-Allow-Credentials'), null);
  await initialized.arrayBuffer();
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
  const allowedHeaders = ok.headers.get('Access-Control-Allow-Headers').toLowerCase().split(',').map(s => s.trim());
  for (const header of ['authorization', 'mcp-session-id', 'mcp-protocol-version']) assert.ok(allowedHeaders.includes(header));
  assert.match(ok.headers.get('Access-Control-Expose-Headers') ?? '', /\bmcp-protocol-version\b/i);
  assert.deepEqual(toolNames(await postResult(mcp, list, { ...legacyHeaders, Origin: origin })), freeTools);
  for (const bad of ['http://localhost', imageBase.origin, origin + '.evil.test', 'null']) {
    await rpcError(await post(mcp, init, { Origin: bad, 'X-Forwarded-Host': 'client.example.test' }), 403);
    const denied = await fetchLocal(mcp, { ...preflight, headers: { ...preflight.headers, Origin: bad } });
    await rpcError(denied, 403);
    assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
  }
});

test('先鉴权再解析 JSON；50 MiB 请求体限制、SDK 内容协商和版本校验后仍可直接调用', { timeout: 25_000 }, async t => {
  const { mcp } = await fixture(t);
  const malformedBody = headers => fetchLocal(mcp, { method: 'POST', headers: { ...rpcHeaders, ...legacyHeaders, ...headers }, body: '{' });
  for (const headers of [{}, auth(personalKey)]) assert.equal((await rpcError(await malformedBody(headers), 400)).code, -32700);
  await rpcError(await malformedBody({ Authorization: 'Basic a' }), 401);
  await rpcError(await malformedBody(auth(defaultKey)), 403);
  const chunk = Buffer.alloc(1024 * 1024, 32);
  const body = (async function* () { for (let i = 0; i < 50; i++) yield chunk; yield ' '; })();
  await rpcError(await fetchLocal(mcp, { method: 'POST', headers: rpcHeaders, duplex: 'half', body }), 413);
  await rpcError(await post(mcp, init, { Accept: 'application/json' }), 406);
  await rpcError(await post(mcp, list, { ...legacyHeaders, 'MCP-Protocol-Version': 'unsupported' }), 400);
  assert.deepEqual(toolNames(await postResult(mcp, list)), freeTools);
  assertPrompt(await postResult(mcp, callTool(promptTool), legacyHeaders));
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
  const root = await mkdtemp(join(testDir, '.nai-paths-'));
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

test('重复 close 排空进行中的工具 POST，停止监听，不重放出图', { timeout: 15_000 }, async t => {
  const pause = pauseFirstReply();
  const { calls, upstreamBaseUrl } = await mockUpstream(t, pause.beforeReply);
  const { mcp, close, server } = await fixture(t, { upstreamBaseUrl });
  const pending = postResult(mcp, callTool(generation), { ...legacyHeaders, Connection: 'close' });
  let closed;
  try {
    await pause.waitFor(pending);
    closed = Promise.all([close(), close()]);
  } finally { pause.release(); }
  const [result] = await Promise.all([pending, closed]);
  assert.notEqual(result.isError, true);
  assert.equal(server.listening, false);
  assert.deepEqual(calls, [{ method: 'POST', route: '/ai/generate-image', auth: `Bearer ${defaultKey}` }]);
});

test('同址独立实例重启清理过期归档；原 SDK Client 直接 call，不重新握手或重放上游', { timeout: 20_000 }, async t => {
  const { calls, upstreamBaseUrl } = await mockUpstream(t);
  const { mcp, server, archiveDir, restart } = await fixture(t, { upstreamBaseUrl });
  // The SDK supplies its own negotiated protocol-version header after initialize.
  const { client, posts } = await sdk(mcp, { 'Mcp-Session-Id': legacyHeaders['Mcp-Session-Id'], ...auth(personalKey), Connection: 'close' });
  try {
    assertBalance(await client.callTool(subscription), 17);
    const expired = await archive(archiveDir, 'e', { age: 360_000 });
    const fresh = await restart();
    assert.notEqual(fresh.server, server);
    assert.equal(server.listening, false);
    await assert.rejects(access(join(archiveDir, expired)), { code: 'ENOENT' });
    assertPrompt(await client.callTool(promptTool));
    assert.deepEqual(posts, ['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
    await fresh.close();
  } finally { await client.close(); }
  assert.deepEqual(calls, [{ method: 'GET', route: '/v1/usage', auth: `Bearer ${personalKey}` }]);
});

test('入口在 SIGTERM 后有序退出且日志不含 Key', { skip: process.platform === 'win32', timeout: 12_000 }, async t => {
  const root = await mkdtemp(join(testDir, '.nai-signal-'));
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
