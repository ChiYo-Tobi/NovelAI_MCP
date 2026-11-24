// Explicit live acceptance (one free generation and four personal-key image operations).
// Never run as part of npm test. Requires the actual public service and its configured 300s TTL.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';

const base = 'https://api.chiyotobi.party';
const endpoint = `${base}/mcp/mcp`;
const apiKey = process.env.QIANDAI_MCP_API_KEY;
if (process.argv[2] !== '--live' || !apiKey) throw new Error('Live billable check: set QIANDAI_MCP_API_KEY and pass --live');
const template = await readFile(new URL('../prompts/novelAI_prompt.md', import.meta.url), 'utf8');
let seq = 0;
const sessions = [];
const imageIds = [];
const hash = data => createHash('sha256').update(data).digest('hex');
const log = (message) => console.log(`PASS ${message}`);
const clean = (value) => String(value).replaceAll(apiKey, '[redacted]').replace(/Bearer\s+\S+|sk-[\w-]+|[\w+/=]{100,}/gi, '[redacted]').slice(0,350);
async function wire({ key, session, method = 'POST', body, rawAuthorization }) {
  const response = await fetch(endpoint, { method, headers: {
    Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Origin: 'https://desktop.example',
    ...(rawAuthorization !== undefined ? { Authorization: rawAuthorization } : key ? { Authorization: `Bearer ${key}` } : {}),
    ...(session ? { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-06-18' } : {}),
  }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(150000) });
  const text = await response.text();
  let data;
  if (text.trim()) {
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const events = text.split(/\r?\n\r?\n/).map(chunk => chunk.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean).map(s => JSON.parse(s));
      data = events.find(event => event.id === body?.id) ?? events.at(-1);
    } else { try { data = JSON.parse(text); } catch { data = {}; } }
  }
  return { status: response.status, data, session: response.headers.get('Mcp-Session-Id') };
}
const req = (method, params = {}) => ({ jsonrpc: '2.0', id: ++seq, method, params });
async function init(key) {
  const result = await wire({ key, body: req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name:'acceptance', version:'1' } }) });
  assert.equal(result.status, 200); assert.ok(result.session && result.data?.result?.serverInfo);
  const s = { key, session:result.session }; sessions.push(s);
  assert.equal((await wire({ ...s, body: { jsonrpc:'2.0', method:'notifications/initialized' } })).status, 202);
  return s;
}
async function rpc(s, method, params) {
  const res = await wire({ ...s, body:req(method,params) }); assert.equal(res.status,200);
  if (res.data?.error) throw Error(clean(res.data.error.message));
  assert.ok(res.data?.result); return res.data.result;
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
const args={base_prompt:'no humans, a red apple on a white plate, still life',width:512,height:512,steps:4,seed:317};
try {
  const root=await fetch(base,{redirect:'manual'}); assert.equal(root.status,200); await root.body?.cancel();
  const health=await fetch(`${base}/mcp/health`); assert.equal(health.status,200); assert.equal((await health.json()).status,'ok'); log('original site and MCP health');
  for(const rawAuthorization of ['Basic invalid','Bearer']) assert.equal((await wire({rawAuthorization,body:req('tools/list')})).status,401);
  const free=await init(), paid=await init(apiKey);
  for(const [s,expected] of [[free,freeNames],[paid,paidNames]]) {
    const list=await rpc(s,'tools/list'); assert.deepEqual(list.tools.map(x=>x.name).sort(),expected);
    const prompt=await call(s,'get_nai_prompt'); assert.ok(!prompt.isError && textOf(prompt).endsWith(template));
  }
  log('malformed auth 401; free=2, paid=9; complete template in both modes');
  for(const attempt of [{...free,key:apiKey},{...paid,key:undefined},{...paid,key:'acceptance-other'}]) {
    const r=await wire({...attempt,body:req('tools/list')}); assert.ok([401,403].includes(r.status));
  }
  for(const name of paidNames.filter(n=>!freeNames.includes(n))) assert.match(await denied(free,name,{}),/免费体验/);
  for(const bad of [{n_samples:2},{width:2048,height:2048},{width:513},{steps:29},{character_references:[]},{vibe_references:[]}]) await denied(free,'generate_image',{...args,...bad});
  for(const bad of [{n_samples:2},{model:'nai-diffusion-3'},{model:'nai-diffusion-5-full-medium'}]) await denied(paid,'generate_image',{...args,...bad});
  log('session isolation, free tool/argument restrictions, single-image and retired model rejection');
  const wallet=await call(paid,'get_subscription'); if(wallet.isError) throw Error(clean(textOf(wallet)));
  const raw=wallet.content.filter(x=>x.type==='text').map(x=>{const at=x.text.indexOf('{');try{return JSON.parse(x.text.slice(at));}catch{return null;}}).find(x=>x?.unit && x?.usage);
  const ref=await fetch(`${base}/v1/usage`,{redirect:'error',headers:{Authorization:`Bearer ${apiKey}`}}); assert.equal(ref.status,200); const reference=await ref.json();
  assert.ok(raw && Object.keys(reference).every(k=>Object.hasOwn(raw,k)) && raw.unit===reference.unit && raw.balance===reference.balance); log(`personal wallet matches /v1/usage (${raw.unit}); no balance or key logged`);
  const full='nai-diffusion-5-full'; const first=await image(free,'generate_image',args,full); log('free default V5 Full generation and byte-identical public link');
  const second=await image(paid,'generate_image',args,full); log('personal default V5 Full');
  for(const model of ['nai-diffusion-5-curated','nai-diffusion-4-5-full']) {await image(paid,'generate_image',{...args,model},model); log(`personal explicit ${model}`);}
  await image(paid,'img2img',{...args,source_image:second.id,strength:0.35},full); log('personal img2img from archived image ID');
  console.log('Waiting for the real 300-second TTL (no additional generation)...');
  await wait(Math.max(0,first.at+302000-Date.now()));
  const gone=await fetch(first.url,{cache:'no-store',redirect:'error'}); assert.equal(gone.status,404); await gone.body?.cancel(); log('expired public image returns 404');
  console.log('Acceptance image IDs:',imageIds.join(' ')); // Verify physical cleanup from the container; links are expired or expiring.
} catch(error) {console.error('FAIL',clean(error.message)); process.exitCode=1;}
finally { await Promise.allSettled(sessions.map(s=>wire({...s,method:'DELETE'}))); }
