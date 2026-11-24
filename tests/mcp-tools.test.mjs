import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import sharp from 'sharp';
import { createNovelAIMcpServer, TOOL_COUNT } from '../dist/mcp-tools.js';
import { DEFAULT_MODEL, IMAGE_MODELS } from '../dist/types.js';
import { VibeCache } from '../dist/vibe-cache.js';

const descriptions = {
  generate_image: '按提示词纯文生图',
  img2img: '基于源图按提示词重绘整张图，strength默认0.7',
  inpaint_image: '绘源图指定区域，需提供mask_image（黑留白改）或mask_regions，局部重绘不支持vibe_references',
  augment_image: '导演图像处理工具，对源图执行抽线稿、素描、上色、画面清理、改表情、去背景（返回多图）或像素对齐',
  upscale_image: '对源图进行4倍超分辨率放大；默认自动将超过1MP的输入等比缩小到上限内再放大',
  encode_vibe: '为V4.5模型预编码一张风格参考图，返回可复用的vibe_id（仅限相同模型用于generate_image或img2img，不可用于局部重绘或下载原图）',
  suggest_tags: '按提示词片段查询NovelAI标签补全建议，支持英语（en）和日语（jp），返回标签JSON',
  get_subscription: '查询当前个人API Key的账户余额与用量',
  get_nai_prompt: '获取NovelAI提示词写作模板与格式规范。首次调用generate_image前必须先调用本工具',
};
const names = Object.keys(descriptions);
const v45 = 'nai-diffusion-4-5-full';
const freeOnly = '当前为免费体验模式，仅支持文生图（generate_image）与提示词模板（get_nai_prompt）。请在请求头配置 Authorization: Bearer <您的API_KEY> 解锁全部功能。';
const imageOrigin = new URL('https://images.example.invalid/gateway/novelai');
const promptFile = new URL('../prompts/novelAI_prompt.md', import.meta.url);
const canvas = () => sharp({ create: { width: 101, height: 190, channels: 3, background: '#b53022' } });
const [png, webp, jpeg, gif] = await Promise.all([canvas().png(), canvas().webp(), canvas().jpeg(), canvas().gif()].map(image => image.toBuffer()));
const source = `data:image/png;base64,${png.toString('base64')}`;
const encoded = Buffer.from('opaque-vibe').toString('base64');
const region = { shape: 'ellipse', x: 0.1, y: 0.2, width: 0.4, height: 0.5 };
const outputs = {
  png: { buffer: png, ext: 'png', mimeType: 'image/png', seed: 42 },
  webp: { buffer: webp, ext: 'webp', mimeType: 'image/webp' },
  jpg: { buffer: jpeg, ext: 'jpg', mimeType: 'image/jpeg' },
};
const generation = (params, image = outputs.png) => ({
  images: [image], model: params.model, requestedModel: params.model, seed: params.seed ?? 12, rawBuffer: image.buffer,
});

async function temp(t) {
  const path = await mkdtemp(join(tmpdir(), 'nai-mcp-tool-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function connect(t, options) {
  const client = new Client({ name: '工具测试', version: '1.0.0' });
  const server = createNovelAIMcpServer(options);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverSide);
  await client.connect(clientSide);
  return { client, call: (name, args) => client.callTool({ name, arguments: args }) };
}
function success(result) {
  assert.ok(!result.isError, result.content[0]?.text);
  return result.content;
}
function rejected(result, message) {
  assert.equal(result.isError, true, result.content[0]?.text);
  assert.equal(result.content[0].type, 'text');
  if (message instanceof RegExp) assert.match(result.content[0].text, message);
  else assert.equal(result.content[0].text, message);
}
function imageContent(content, index, image) {
  assert.deepEqual(content[index], { type: 'image', mimeType: image.mimeType, data: image.buffer.toString('base64') });
}
function receiptLink(line, ext) {
  const match = /image_id ([A-Za-z0-9_-]{43}) · \[查看或下载图片\]\(([^)]+)\)/.exec(line);
  assert.ok(match, line);
  const [, id, url] = match;
  assert.equal(url, `${imageOrigin.href}/novelai-images/${id}.${ext}`);
  return { id, url };
}
// Record even unexpected calls: an assertion thrown inside a mock can otherwise look like a successful rejection.
function upstream(impl = {}) {
  const calls = [];
  const client = Object.fromEntries(['generateImage', 'augmentImage', 'upscaleImage', 'encodeVibe', 'getSubscription', 'suggestTags'].map(name => [name, async (...args) => {
    calls.push({ name, args });
    if (!impl[name]) throw new Error(`意外的上游调用：${name}`);
    return impl[name](...args);
  }]));
  return { client, calls };
}

for (const mode of ['paid', 'free']) {
  test(`${mode} 仅公布可执行的工具；提示词原样返回且无上游请求`, async t => {
    const api = upstream();
    const { client, call } = await connect(t, { mode, client: api.client });
    const { tools } = await client.listTools();
    assert.equal(TOOL_COUNT, 9);
    assert.deepEqual(tools.map(x => x.name), mode === 'paid' ? names : ['generate_image', 'get_nai_prompt']);
    const capabilities = client.getServerCapabilities();
    assert.ok(capabilities.tools);
    assert.equal(capabilities.prompts, undefined);
    assert.equal(capabilities.resources, undefined);
    assert.match(client.getInstructions(), /首次.*先调用 get_nai_prompt/);
    assert.equal(DEFAULT_MODEL, 'nai-diffusion-5-full');
    assert.deepEqual([...IMAGE_MODELS].sort(), [DEFAULT_MODEL, 'nai-diffusion-5-curated', v45, 'nai-diffusion-4-5-curated'].sort());
    for (const definition of tools) {
      assert.equal(definition.description, descriptions[definition.name], definition.name);
      assert.equal(definition.inputSchema.additionalProperties, false, definition.name);
      if (names.slice(0, 3).includes(definition.name)) {
        const fields = definition.inputSchema.properties;
        assert.equal(fields.model.default, DEFAULT_MODEL);
        assert.deepEqual(fields.model.enum, [...IMAGE_MODELS]);
        assert.equal(fields.n_samples.const, 1);
        assert.equal(fields.n_samples.default, 1);
      }
    }
    const prompt = tools.find(x => x.name === 'get_nai_prompt');
    assert.equal(prompt.annotations.readOnlyHint, true);
    assert.equal(prompt.annotations.openWorldHint, false);
    const template = await readFile(promptFile, 'utf8');
    assert.notEqual(template.trim(), '');
    assert.deepEqual(success(await call(prompt.name)), [{ type: 'text', text: template }]);
    rejected(await call(prompt.name, { path: 'other.md' }), /path/);
    if (mode === 'free') {
      const fields = tools[0].inputSchema.properties;
      assert.equal(fields.width.multipleOf, 64);
      assert.equal(fields.height.multipleOf, 64);
      assert.equal(fields.steps.maximum, 28);
      assert.equal(fields.character_references, undefined);
      assert.equal(fields.vibe_references, undefined);
      for (const name of [...names.filter(n => n !== 'generate_image' && n !== 'get_nai_prompt'), 'unknown']) {
        rejected(await call(name, { unexpected: true }), freeOnly);
      }
    } else {
      assert.equal(tools.find(x => x.name === 'inpaint_image').inputSchema.properties.vibe_references, undefined);
      rejected(await call('unknown'), /未知工具/);
    }
    assert.deepEqual(api.calls, []);
  });
}

test('免费无效请求全部在配额和上游前拒绝，包括原始尺寸、引用空数组、编辑动作和未声明字段', async t => {
  const api = upstream();
  let reservations = 0;
  const { call } = await connect(t, { mode: 'free', client: api.client, quota: { run: () => { reservations++; throw new Error('不应进入配额'); } } });
  const invalid = [
    [{ width: 831 }, /width.*64/], [{ height: 1215 }, /height.*64/], [{ width: 1024, height: 1088 }, /1,048,576/],
    [{ width: 1024 }, /1,048,576/], [{ steps: 29 }, /steps.*28/], [{ steps: '28' }, /steps/], [{ model: 'unknown' }, /不支持该模型.*可选模型/],
    [{ base_prompt: '  ' }, /base_prompt/], [{ character_references: [] }, /character_references.*请配置个人 API Key/], [{ vibe_references: [] }, /vibe_references.*请配置个人 API Key/],
    [{ character_references: [{ image: source, type: 'character' }] }, /character_references/],
    [{ vibe_references: [{ image: source }] }, /vibe_references/], [{ n_samples: 2 }, /n_samples.*1/],
    [{ source_image: source }, /source_image/], [{ image: source }, /image/], [{ action: 'infill' }, /action/],
    [{ mask: source }, /mask/], [{ mask_regions: [region] }, /mask_regions/], [{ controlnet_condition: source }, /controlnet_condition/],
    [{ reference_image_multiple: [] }, /reference_image_multiple/], [{ parameters: { image: source } }, /parameters/],
    [{ characters: [{ prompt: '人物', image: source }] }, /image/], [{ surprise: true }, /surprise/],
    [{ model: v45, characters: Array.from({ length: 7 }, () => ({ prompt: '人物' })) }, /6/],
  ];
  for (const [fields, message] of invalid) rejected(await call('generate_image', { base_prompt: '山水', ...fields }), message);
  assert.equal(reservations, 0);
  assert.deepEqual(api.calls, []);
});

test('免费默认、四个模型及边界尺寸均走一次共享配额，模板不占用配额', async t => {
  const events = [];
  const api = upstream({ generateImage: async params => {
    events.push(['generate', params.model]);
    assert.equal(params.action, 'generate');
    assert.equal(params.n_samples, 1);
    assert.ok(!('image' in params) && !('mask' in params) && !('characterReferences' in params) && !('vibeReferences' in params));
    return generation(params);
  } });
  const quota = { run: async (model, generate) => {
    events.push(['reserve', model]);
    const actual = await generate();
    assert.ok(Array.isArray(actual.images), 'run 回调只返回上游原始结果，不含本地回执');
    events.push(['complete', model]);
    return actual;
  } };
  const { call } = await connect(t, { mode: 'free', client: api.client, quota });
  success(await call('get_nai_prompt'));
  const cases = [undefined, ...IMAGE_MODELS];
  for (const model of cases) {
    const args = model ? { model, width: 1024, height: 1024, steps: 28, n_samples: 1 } : {};
    const content = success(await call('generate_image', { base_prompt: '松林', characters: [{ prompt: '旅人' }], ...args }));
    imageContent(content, 1, outputs.png);
  }
  assert.deepEqual(events, cases.flatMap(m => ['reserve', 'generate', 'complete'].map(e => [e, m ?? DEFAULT_MODEL])));
  assert.equal(api.calls.length, cases.length);
  assert.deepEqual([api.calls[0].args[0].width, api.calls[0].args[0].height], [832, 1216]);
});

test('免费配额缺失或拒绝时不调用上游；只将上游本身的异常交给配额处理', async t => {
  const api = upstream({ generateImage: async () => { throw new Error('生成未成功'); } });
  const request = { base_prompt: '海边' };
  for (const [quota, message] of [[undefined, /配额/], [{ run: () => { throw new Error('额度用尽'); } }, /额度用尽/]]) {
    const { call } = await connect(t, { mode: 'free', client: api.client, quota });
    rejected(await call('generate_image', request), message);
  }
  assert.equal(api.calls.length, 0);
  const errors = [];
  const { call } = await connect(t, { mode: 'free', client: api.client, quota: { async run(_model, generate) {
    try { return await generate(); } catch (error) { errors.push(error.message); throw error; }
  } } });
  rejected(await call('generate_image', request), /生成未成功/);
  assert.deepEqual(errors, ['生成未成功']);
  assert.equal(api.calls.length, 1);
});

test('上游成功后归档失败仍然计入免费配额，保留原始 MCP 图片，不承诺下载链接', async t => {
  const archiveDir = join(await temp(t), 'not-a-directory');
  await writeFile(archiveDir, 'not a directory');
  let committed = 0;
  const api = upstream({ generateImage: async params => generation(params, outputs.webp) });
  const { call } = await connect(t, { mode: 'free', client: api.client, archiveDir, imageOrigin, quota: { async run(_model, generate) {
    const actual = await generate();
    assert.equal(actual.images[0], outputs.webp);
    committed++;
    return actual;
  } } });
  const content = success(await call('generate_image', { base_prompt: '海边' }));
  assert.match(content[0].text, /服务器保存失败.*请勿.*自动重新出图/);
  assert.doesNotMatch(content[0].text, /image_id|分钟内有效/);
  assert.equal(committed, 1);
  assert.equal(api.calls.length, 1);
  imageContent(content, 1, outputs.webp);
});

test('付费基础回归：生成、图生图与两种局部遮罩，实际尺寸和 PNG/WebP/JPEG 的原字节、ID、带前缀 URL', async t => {
  const archiveDir = await temp(t);
  const api = upstream({ generateImage: async params => generation(params, ({ generate: outputs.webp, img2img: outputs.jpg, infill: outputs.png })[params.action]) });
  const { call } = await connect(t, { mode: 'paid', client: api.client, archiveDir, imageOrigin });
  const first = success(await call('generate_image', { base_prompt: '星空', seed: 9, image_format: 'webp', width: 65, height: 100 }));
  assert.match(first[0].text, /101×190/);
  assert.match(first[0].text, /图片下载链接 5 分钟内有效，过期将自动清理。$/);
  assert.doesNotMatch(first[0].text, /Anlas|本次消耗/);
  imageContent(first, 1, outputs.webp);
  const { id } = receiptLink(first[0].text, 'webp');
  const second = success(await call('img2img', {
    base_prompt: '星夜', source_image: id, model: v45, n_samples: 1, strength: 0.35, noise: 0.1, extra_noise_seed: 16,
    color_correct: false, characters: [{ prompt: '旅人', negative_prompt: '伞' }],
  }));
  imageContent(second, 1, outputs.jpg);
  receiptLink(second[0].text, 'jpg');
  for (const mask of [{ mask_image: source }, { mask_regions: [region] }]) {
    const painted = success(await call('inpaint_image', { base_prompt: '高光', source_image: id, ...mask, inpaint_strength: 0.6, add_original_image: false }));
    receiptLink(painted[0].text, 'png');
    imageContent(painted, 1, outputs.png);
  }
  assert.deepEqual(api.calls.map(c => c.name), Array(4).fill('generateImage'));
  const [generated, edited, ...painted] = api.calls.map(c => c.args[0]);
  assert.deepEqual([generated.model, generated.width, generated.height, generated.n_samples], [DEFAULT_MODEL, 64, 128, 1]);
  assert.deepEqual([edited.action, edited.width, edited.height, edited.strength, edited.color_correct, edited.noise, edited.extra_noise_seed], ['img2img', 128, 192, 0.35, false, 0.1, 16]);
  assert.deepEqual(edited.characterPrompts, [{ prompt: '旅人', uc: '伞', center: { x: 0.5, y: 0.5 }, enabled: true }]);
  for (const p of painted) {
    assert.deepEqual([p.model, p.action, p.inpaintImg2ImgStrength, p.add_original_image], [DEFAULT_MODEL, 'infill', 0.6, false]);
    const { width, height, format } = await sharp(Buffer.from(p.mask, 'base64')).metadata();
    assert.deepEqual([width, height, format], [128, 192, 'png']);
  }
});

test('付费参数错误及局部重绘任何 vibe_references：不读缓存、不编码、不回退、不调用上游', async t => {
  const api = upstream();
  let cacheReads = 0;
  const vibeCache = { getById: () => { cacheReads++; throw new Error('不应读缓存'); } };
  const { call } = await connect(t, { mode: 'paid', client: api.client, vibeCache });
  const base = { base_prompt: '高光' };
  for (const tool of names.slice(0, 3)) {
    for (const n_samples of [0, 2, '1', null]) rejected(await call(tool, { ...base, n_samples }), /n_samples.*1/);
  }
  for (const model of [undefined, ...IMAGE_MODELS]) {
    for (const vibe_references of [[], [{ image: source }], [{ vibe_id: 'vibe_0000000000000000' }], null]) {
      rejected(await call('inpaint_image', { ...base, model, source_image: 'not-an-image', vibe_references }), /局部重绘.*不支持.*vibe_references/);
    }
  }
  rejected(await call('inpaint_image', { ...base, source_image: source }), /mask_image.*mask_regions/);
  rejected(await call('generate_image', { ...base, width: 2048, height: 2048 }), /3,145,728/);
  rejected(await call('generate_image', { ...base, character_references: [{ image: source, type: 'character' }], vibe_references: [{ image: source }] }), /不能同时/);
  for (const tool of names.slice(0, 3)) {
    const args = tool === 'generate_image' ? base : { ...base, source_image: source, ...(tool === 'inpaint_image' && { mask_regions: [region] }) };
    rejected(await call(tool, { ...args, character_references: [{ image: source, type: 'character' }] }), /默认模型.*显式选择 V4\.5/);
    if (tool !== 'inpaint_image') rejected(await call(tool, { ...args, vibe_references: [{ vibe_id: 'vibe_0000000000000000' }] }), /默认模型.*显式选择 V4\.5/);
    const badModel = await call(tool, { ...args, model: 'nai-diffusion-4-full' });
    rejected(badModel, /不支持该模型.*可选模型/);
    for (const model of IMAGE_MODELS) assert.ok(badModel.content[0].text.includes(model));
  }
  rejected(await call('generate_image', { ...base, model: DEFAULT_MODEL, character_references: [{ image: source, type: 'character' }] }), /V4\.5/);
  rejected(await call('generate_image', { ...base, model: v45, vibe_references: [{ image: source }, { encoded_vibe: '!' }] }), /Base64/);
  rejected(await call('img2img', { ...base, source_image: source, mask: source }), /mask/);
  rejected(await call('augment_image', { source_image: source, req_type: 'emotion' }), /emotion/);
  rejected(await call('encode_vibe', { source_image: source, crop_to_mask: true }), /mask_image/);
  assert.equal(cacheReads, 0);
  assert.deepEqual(api.calls, []);
});

test('V4.5 参考：显式选择模型后可用精确参考及自动编码；共享数据目录可跨实例复用编码', async t => {
  const archiveDir = await temp(t), dataDir = await temp(t);
  const api = upstream({ encodeVibe: async () => encoded, generateImage: async params => generation(params) });
  const options = { mode: 'paid', client: api.client, archiveDir };
  const { call } = await connect(t, { ...options, vibeCache: new VibeCache(dataDir) });
  const precise = { image: source, type: 'character', strength: 0.8, fidelity: 0.7 };
  success(await call('generate_image', { base_prompt: '海风', model: v45, character_references: [precise] }));
  const p = api.calls[0].args[0];
  assert.equal(p.model, v45);
  assert.equal(p.characterReferences[0].fidelity, 0.7);
  const size = await sharp(Buffer.from(p.characterReferences[0].image, 'base64')).metadata();
  assert.deepEqual([size.width, size.height], [1024, 1536]);

  const vibe = { image: source, information_extracted: 0.75 };
  const generated = success(await call('generate_image', { base_prompt: '民居', model: v45, vibe_references: [vibe] }));
  const [id] = generated[0].text.match(/vibe_[a-f0-9]{16}/);
  assert.equal(api.calls[2].args[0].vibeReferences[0].encoded_vibe, encoded);
  const restarted = await connect(t, { ...options, vibeCache: new VibeCache(dataDir) });
  const summary = JSON.parse(success(await restarted.call('encode_vibe', {
    source_image: source, model: v45, information_extracted: 0.75, include_raw_base64: true,
  }))[0].text);
  assert.deepEqual(summary, { vibe_id: id, model: v45, information_extracted: 0.75, encoded_vibe: encoded });
  success(await restarted.call('img2img', { base_prompt: '壁画', source_image: source, model: v45, vibe_references: [vibe, { vibe_id: id }, { encoded_vibe: encoded }] }));
  assert.deepEqual(api.calls.at(-1).args[0].vibeReferences.map(x => x.encoded_vibe), Array(3).fill(encoded));
  rejected(await restarted.call('generate_image', { base_prompt: '山', model: 'nai-diffusion-4-5-curated', vibe_references: [{ vibe_id: id }] }), /模型不同/);
  rejected(await restarted.call('generate_image', { base_prompt: '山', model: v45, vibe_references: [{ vibe_id: id, information_extracted: 0.5 }] }), /提取比例/);
  assert.deepEqual(api.calls.map(c => c.name), ['generateImage', 'encodeVibe', 'generateImage', 'generateImage']);
});

test('付费增强、放大、编码、标签和订阅：只发业务请求，显式查询才取订阅且保留完整 JSON', async t => {
  const archiveDir = await temp(t);
  const raw = { balance: 100, usage: { requests: 4 }, extra: { unchanged: [null, false, 7] } };
  const summary = '账户余额 100，已使用 4 次。';
  const api = upstream({
    augmentImage: async () => [outputs.png, outputs.webp, outputs.jpg], upscaleImage: async () => [outputs.webp], encodeVibe: async () => encoded,
    suggestTags: async () => ({ tags: [{ tag: 'tree', count: 3 }, { tag: 'tree shadow' }] }), getSubscription: async () => ({ raw, summary }),
  });
  let quotaRuns = 0;
  const { call } = await connect(t, { mode: 'paid', client: api.client, archiveDir, imageOrigin, imageTtlMs: 90000, quota: { run: () => { quotaRuns++; throw new Error('付费不应经过免费配额'); } } });
  const input = `data:image/gif;base64,${gif.toString('base64')}`;
  const augmented = success(await call('augment_image', { source_image: input, req_type: 'bg-removal' }));
  for (const [index, image] of Object.values(outputs).entries()) {
    imageContent(augmented, index + 1, image);
    receiptLink(augmented[0].text.split('\n')[index + 1], image.ext);
  }
  assert.match(augmented[0].text, /图片下载链接 90 秒内有效，过期将自动清理。$/);
  success(await call('upscale_image', { source_image: input, declared_blur_sigma: 0.2, auto_fit_1mp: false }));
  const vibe = JSON.parse(success(await call('encode_vibe', { source_image: input, mask_image: source, crop_to_mask: true }))[0].text);
  assert.deepEqual(Object.keys(vibe).sort(), ['information_extracted', 'model', 'vibe_id']);
  assert.deepEqual(JSON.parse(success(await call('suggest_tags', { prompt: 'tree', limit: 1 }))[0].text), { tags: [{ tag: 'tree', count: 3 }] });
  assert.deepEqual(api.calls.map(c => c.name), ['augmentImage', 'upscaleImage', 'encodeVibe', 'suggestTags']);
  for (const { args: [args] } of api.calls.slice(0, 3)) assert.equal((await sharp(Buffer.from(args.image, 'base64')).metadata()).format, 'png');
  assert.deepEqual(api.calls[3].args, [{ prompt: 'tree', model: DEFAULT_MODEL, lang: 'en' }]);
  const info = success(await call('get_subscription'));
  assert.deepEqual(info.map(c => c.type), ['text', 'text']);
  assert.equal(info[0].text, summary);
  assert.deepEqual(JSON.parse(info[1].text), raw);
  assert.deepEqual(api.calls.slice(4), [{ name: 'getSubscription', args: [] }]);
  assert.equal(quotaRuns, 0);
  assert.ok(!(await readdir(archiveDir)).includes('.vibe-cache'), '未注入持久缓存时不能把编码写进图片目录');
});

test('本站带前缀 URL 可直接用于编辑；过期 ID、过期 URL 和本地文件路径均在上游前拒绝', async t => {
  const archiveDir = await temp(t);
  // HTTP 在这里仅能命中本站归档；即使路径规则回归也不会进行网络下载。
  const base = new URL('http://archive.invalid/service/nai/');
  const api = upstream({ generateImage: async params => generation(params) });
  const { call } = await connect(t, { mode: 'paid', client: api.client, archiveDir, imageOrigin: base, imageTtlMs: 90000 });
  const args = { base_prompt: '雪地' };
  const output = success(await call('generate_image', args));
  const [, id, url] = /image_id ([A-Za-z0-9_-]{43}) · \[查看或下载图片\]\(([^)]+)\)/.exec(output[0].text);
  assert.equal(url, `http://archive.invalid/service/nai/novelai-images/${id}.png`);
  success(await call('img2img', { ...args, source_image: url }));
  const metadataFile = join(archiveDir, id, 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  metadata.created_at = new Date(Date.now() - 120000).toISOString(); // 超过自定义 TTL，但未超过默认 5 分钟。
  await writeFile(metadataFile, JSON.stringify(metadata));
  for (const expired of [url, id]) rejected(await call('img2img', { ...args, source_image: expired }), /找不到|过期/);
  rejected(await call('img2img', { ...args, source_image: join(archiveDir, id, 'image.png') }), /禁止读取本地/);
  assert.deepEqual(api.calls.map(c => c.name), ['generateImage', 'generateImage']);
});

test('放大前可等比缩小到 1MP；禁止缩小时拒绝超大输入且不调用上游', async t => {
  const big = await sharp({ create: { width: 1900, height: 900, channels: 3, background: '#123456' } }).png().toBuffer();
  const api = upstream({ upscaleImage: async () => [outputs.png] });
  const { call } = await connect(t, { mode: 'paid', client: api.client });
  const args = { source_image: big.toString('base64') };
  rejected(await call('upscale_image', { ...args, auto_fit_1mp: false }), /auto_fit_1mp/);
  success(await call('upscale_image', args));
  assert.equal(api.calls.length, 1);
  const { width, height } = await sharp(Buffer.from(api.calls[0].args[0].image, 'base64')).metadata();
  assert.equal(width % 8, 0);
  assert.equal(height % 8, 0);
  assert.ok(width * height <= 1048576);
});
