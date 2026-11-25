// Hosted acceptance only; neither mode runs as part of npm test. No automatic retries.
// --stateless-smoke is read-only. Only --live may consume quota/credit and test the 300s image TTL.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';

const base = 'https://api.chiyotobi.party';
const endpoint = `${base}/mcp/mcp`;
const [mode, ...options] = process.argv.slice(2);
const usage = 'Choose --stateless-smoke [--idle-minutes N] (read-only) or --live (billable).';
let idleMinutes = 0;
if (mode === '--stateless-smoke' && options.length === 2 && options[0] === '--idle-minutes') {
  idleMinutes = Number(options[1]);
  // A larger delay would overflow Node’s timer and turn the idle test into an immediate retry.
  if (!/^[1-9]\d*$/.test(options[1]) || idleMinutes * 60_000 > 2_147_483_647) throw Error(usage);
} else if (!['--stateless-smoke', '--live'].includes(mode) || options.length !== 0) {
  throw Error(usage);
}
const apiKey = process.env.QIANDAI_MCP_API_KEY;
if (!apiKey) throw Error('Set QIANDAI_MCP_API_KEY to a personal key for the two-mode check.');
const template = await readFile(new URL('../prompts/novelAI_prompt.md', import.meta.url), 'utf8');
let seq = 0;
const imageIds = [];
const hash = data => createHash('sha256').update(data).digest('hex');
const log = (message) => console.log(`PASS ${message}`);
const clean = (value) => String(value).replaceAll(apiKey, '[redacted]').replace(/Bearer\s+\S+|sk-[\w-]+|[\w+/=]{100,}/gi, '[redacted]').slice(0,350);

async function wire({ key, version, legacyId, method = 'POST', body, rawAuthorization }, expectedStatus = 200) {
  const response = await fetch(endpoint, { method, headers: {
    Accept: method === 'GET' ? 'text/event-stream' : 'application/json, text/event-stream', Origin: 'https://desktop.example',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(rawAuthorization !== undefined ? { Authorization: rawAuthorization } : key ? { Authorization: `Bearer ${key}` } : {}),
    ...(version ? { 'MCP-Protocol-Version': version } : {}),
    ...(legacyId ? { 'Mcp-Session-Id': legacyId } : {}), // compatibility probe only
  }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(150000) });
  try {
    assert.ok(!response.headers.has('Mcp-Session-Id'), 'server must not issue or echo an MCP session ID');
    assert.equal(response.status, expectedStatus, `${body?.method ?? method}: expected HTTP ${expectedStatus}, got ${response.status}`);
    if (expectedStatus >= 400) return;
    const text = await response.text(); // a POST response must finish, even when framed as SSE
    if (expectedStatus === 202) {
      assert.equal(text.length, 0, 'notifications/initialized must return an empty 202');
      return;
    }
    let data;
    try {
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        const events = text.split(/\r?\n\r?\n/).map(chunk => chunk.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean).map(s => JSON.parse(s));
        data = events.find(event => event?.id === body.id);
      } else {
        data = JSON.parse(text);
      }
    } catch { throw Error(`${body.method}: invalid JSON-RPC response`); }
    assert.ok(data?.jsonrpc === '2.0' && data.id === body.id, `${body.method}: missing matching JSON-RPC response`);
    if (data.error) throw Error(clean(data.error.message));
    assert.ok(data.result, `${body.method}: missing result`);
    return data.result;
  } finally {
    // Do not wait for an unexpected standalone GET stream to end.
    if (!response.bodyUsed) await response.body?.cancel();
  }
}
const req = (method, params = {}) => ({ jsonrpc: '2.0', id: ++seq, method, params });
const rpc = (client, method, params) => wire({ ...client, body: req(method, params) });
async function init(key) {
  const result = await rpc({ key }, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'acceptance', version: '1' },
  });
  assert.ok(result.serverInfo && typeof result.protocolVersion === 'string' && result.protocolVersion.length, 'initialize must negotiate a version');
  const client = { key, version: result.protocolVersion };
  await wire({ ...client, body: { jsonrpc: '2.0', method: 'notifications/initialized' } }, 202);
  return client;
}
const call = (s, name, args = {}) => rpc(s, 'tools/call', {name, arguments:args});
const textOf = r => r.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
async function denied(s,name,args) {
  const r = await call(s,name,args); assert.equal(r.isError,true,`${name} should be denied`);
  const t = textOf(r); assert.ok(t.length && !/"(?:balance|remaining)"\s*:/.test(t)); return t;
}
async function image(s,name,args,model) {
  const r=await call(s,name,args); if(r.isError) throw Error(`${name}: ${clean(textOf(r))}`);
  const receipt=textOf(r); assert.ok(receipt.includes(model) && /5 分钟/.test(receipt), 'receipt model/ttl');
  const bytes=r.content.filter(c=>c.type==='image'); assert.equal(bytes.length,1);
  const match=/https:\/\/api\.chiyotobi\.party\/mcp\/novelai-images\/([A-Za-z0-9_-]{43})\.(png|webp|jpg)/.exec(receipt);
  assert.ok(match && receipt.includes(`image_id ${match[1]}`), 'short URL and image ID');
  const download=await fetch(match[0],{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)});
  assert.equal(download.status,200); assert.equal(download.headers.get('content-type')?.split(';')[0],bytes[0].mimeType);
  assert.ok(hash(Buffer.from(await download.arrayBuffer()))===hash(Buffer.from(bytes[0].data,'base64')),'link equals MCP image bytes');
  imageIds.push(match[1]); return { id:match[1],url:match[0],at:Date.now() };
}
const freeNames=['generate_image','get_nai_prompt'];
const paidNames=[...freeNames,'img2img','inpaint_image','augment_image','upscale_image','encode_vibe','get_subscription','suggest_tags'].sort();
async function checkList(client, expected) {
  const { tools } = await rpc(client, 'tools/list');
  assert.deepEqual(tools.map(t => t.name).sort(), expected);
}
async function checkCatalog(client, expected) {
  await checkList(client, expected);
  const prompt = await call(client, 'get_nai_prompt');
  assert.ok(!prompt.isError && textOf(prompt).endsWith(template), 'missing complete bundled template');
}
async function subscription(client) {
  const wallet = await call(client, 'get_subscription');
  assert.ok(!wallet.isError, 'personal get_subscription failed');
  for (const item of wallet.content.filter(x => x.type === 'text')) {
    let raw;
    try { raw = JSON.parse(item.text); } catch { continue; }
    if (raw?.unit && raw.usage) return raw;
  }
  throw Error('get_subscription did not return the original usage JSON');
}
async function checkStateless(free, paid) {
  await checkCatalog(free, freeNames);
  await checkCatalog(paid, paidNames);
  log('no-ID handshakes and notifications; anonymous=2, personal=9; complete templates');

  // Same unrelated ID throughout, no new initialize. Changing only Authorization must change access.
  const legacy = { ...free, legacyId: randomUUID() };
  const personal = { ...legacy, key: paid.key };
  await checkList(legacy, freeNames);
  await checkList(personal, paidNames);
  await subscription(personal);
  await checkList(legacy, freeNames);
  assert.match(await denied(legacy, 'get_subscription', {}), /免费体验/);
  for (const rawAuthorization of ['Basic invalid', 'Bearer']) {
    await wire({ ...legacy, rawAuthorization, body: req('tools/list') }, 401);
  }
  for (const client of [free, personal]) {
    for (const method of ['GET', 'DELETE']) await wire({ ...client, method }, 405);
  }
  log('legacy ID ignored across credential changes; malformed auth 401; GET/DELETE 405');
}

// Keep all generation attempts (even expected rejections) behind the explicit billable mode.
async function live(free, paid) {
  const args={base_prompt:'no humans, a red apple on a white plate, still life',width:512,height:512,steps:4,seed:317};
  const root=await fetch(base,{redirect:'manual'}); assert.equal(root.status,200); await root.body?.cancel();
  const health=await fetch(`${base}/mcp/health`); assert.equal(health.status,200); assert.equal((await health.json()).status,'ok'); log('original site and MCP health');
  for(const name of paidNames.filter(n=>!freeNames.includes(n))) assert.match(await denied(free,name,{}),/免费体验/);
  for(const bad of [{n_samples:2},{width:2048,height:2048},{width:513},{steps:29},{character_references:[]},{vibe_references:[]}]) await denied(free,'generate_image',{...args,...bad});
  for(const bad of [{n_samples:2},{model:'nai-diffusion-3'},{model:'nai-diffusion-5-full-medium'}]) await denied(paid,'generate_image',{...args,...bad});
  log('free tool/argument restrictions, single-image and retired model rejection');
  const raw = await subscription(paid);
  const ref=await fetch(`${base}/v1/usage`,{redirect:'error',headers:{Authorization:`Bearer ${apiKey}`}}); assert.equal(ref.status,200); const reference=await ref.json();
  assert.ok(Object.keys(reference).every(k=>Object.hasOwn(raw,k)) && raw.unit===reference.unit && raw.balance===reference.balance); log('personal wallet matches /v1/usage; no balance or key logged');
  const full='nai-diffusion-5-full'; const first=await image(free,'generate_image',args,full); log('free default V5 Full generation and byte-identical public link');
  const second=await image(paid,'generate_image',args,full); log('personal default V5 Full');
  for(const model of ['nai-diffusion-5-curated','nai-diffusion-4-5-full']) {await image(paid,'generate_image',{...args,model},model); log(`personal explicit ${model}`);}
  await image(paid,'img2img',{...args,source_image:second.id,strength:0.35},full); log('personal img2img from archived image ID');
  console.log('Waiting for the real 300-second TTL (no additional generation)...');
  await wait(Math.max(0,first.at+302000-Date.now()));
  const gone=await fetch(first.url,{cache:'no-store',redirect:'error'}); assert.equal(gone.status,404); await gone.body?.cancel(); log('expired public image returns 404');
  console.log('Acceptance image IDs:',imageIds.join(' ')); // Verify physical cleanup from the container; links are expired or expiring.
}

try {
  const free = await init(), paid = await init(apiKey);
  await checkStateless(free, paid);
  if (mode === '--live') {
    await live(free, paid);
  } else {
    if (idleMinutes) {
      console.log(`Waiting ${idleMinutes} real minutes without MCP traffic or keepalives...`);
      await wait(idleMinutes * 60_000);
      // Reuse the original clients and negotiated versions; no initialize, ID or retry on failure.
      await checkCatalog(free, freeNames);
      await checkCatalog(paid, paidNames);
    }
    await subscription(paid);
    log('read-only smoke complete; no image operations attempted');
  }
} catch (error) {
  console.error('FAIL', clean(error.message));
  process.exitCode = 1;
}
