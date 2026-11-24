import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { NovelAIClient } from '../dist/novelai-client.js';
import { ENCODE_VIBE_MODELS, MODEL_REGISTRY, alignDimension, computeVarietySigma, normalizeSeed } from '../dist/model-registry.js';
import { AUGMENT_REQ_TYPES, DEFAULT_MODEL, EMOTION_MOODS, IMAGE_MODELS } from '../dist/types.js';

const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 30, g: 100, b: 120, alpha: 0.7 } } }).png().toBuffer();
const image = png.toString('base64');
const v5Full = 'nai-diffusion-5-full';
const v5Curated = 'nai-diffusion-5-curated';
const v45Full = 'nai-diffusion-4-5-full';
const v45Curated = 'nai-diffusion-4-5-curated';

async function mockNovelAI(t, respond = (_request, res) => res.writeHead(200, { 'Content-Type': 'image/png' }).end(png)) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const request = { method: req.method, url: new URL(req.url, 'http://localhost'), headers: req.headers, body };
      requests.push(request);
      respond(request, res);
    } catch {
      res.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { client: new NovelAIClient('test-key', { baseUrl }), baseUrl, requests };
}

function withEnv(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    });
  }
}

test('仅四个图像模型，V5 Full 默认；生成保留各模型的提示词、预设、请求头和原图', async t => {
  const { client, requests } = await mockNovelAI(t);
  const cases = [[v5Full, 4, 23, 7, false], [v5Curated, 4, 23, 7, false], [v45Full, 3, 28, 6, true], [v45Curated, 3, 28, 5, true]];
  assert.equal(DEFAULT_MODEL, v5Full);
  assert.deepEqual(IMAGE_MODELS, cases.map(([model]) => model));
  assert.deepEqual(Object.keys(MODEL_REGISTRY).sort(), [...IMAGE_MODELS].sort());
  assert.deepEqual(ENCODE_VIBE_MODELS, [v45Full, v45Curated]);
  for (const [model, version, steps, scale, brownian] of cases) {
    const result = await client.generateImage({ prompt: 'clouds', ...(model === v5Full ? {} : { model }), seed: 123, noise_schedule: 'native' });
    const { body, headers, method, url } = requests.at(-1);
    const p = body.parameters;
    assert.equal(method, 'POST');
    assert.equal(url.pathname, '/ai/generate-image');
    assert.equal(headers.authorization, 'Bearer test-key');
    assert.equal(headers.origin, 'https://novelai.net');
    assert.equal(headers.referer, 'https://novelai.net/');
    assert.match(headers['x-correlation-id'], /^[0-9A-Za-z]{6}$/);
    assert.equal(body.model, model);
    assert.equal(body.action, 'generate');
    assert.equal(p.params_version, version);
    assert.equal(p.n_samples, 1);
    assert.equal(p.steps, steps);
    assert.equal(p.scale, scale);
    assert.equal(p.prefer_brownian, brownian);
    assert.equal(p.deliberate_euler_ancestral_bug, false);
    assert.equal(p.noise_schedule, 'karras');
    assert.deepEqual(p.v4_prompt.caption, { base_caption: 'clouds', char_captions: [] });
    assert.equal(p.v4_negative_prompt.legacy_uc, false);
    if (version === 4) {
      assert.equal(p.ucPresetId, 'heavy');
      assert.equal(p.qualityPresetId, 'standard');
      assert.ok(!('ucPreset' in p) && !('qualityToggle' in p));
    } else {
      assert.equal(p.ucPreset, 0);
      assert.equal(p.qualityToggle, true);
      assert.ok(!('ucPresetId' in p) && !('qualityPresetId' in p));
    }
    assert.equal(result.seed, 123);
    assert.equal(result.model, model);
    assert.equal(result.requestedModel, model);
    assert.deepEqual(result.rawBuffer, png);
    assert.deepEqual(result.images[0].buffer, png);
  }
  for (const model of ['nai-diffusion-5-full-medium', 'nai-diffusion-4-full', 'nai-diffusion-4-curated-preview', 'nai-diffusion-3', 'nai-diffusion-furry-3']) {
    await assert.rejects(client.generateImage({ prompt: 'clouds', model }), /不支持该模型/);
  }
  assert.equal(requests.length, 4);
});

test('单图不做隐式转换，任何显式非 1 的 n_samples 都不会请求上游', async t => {
  const { client, requests } = await mockNovelAI(t);
  for (const n_samples of [null, undefined, 0, -1, 2, 8, 1.5, NaN, '1', true]) {
    for (const method of ['generateImage', 'generateImageBuffer']) {
      await assert.rejects(client[method]({ prompt: 'rose', n_samples }), /n_samples.*1/);
    }
  }
  assert.equal(requests.length, 0);
  for (const extras of [{}, { n_samples: 1 }]) {
    assert.deepEqual(await client.generateImageBuffer({ prompt: 'rose', ...extras }), png);
    assert.equal(requests.at(-1).body.parameters.n_samples, 1);
  }
});

test('V5 透明标签、角色正负提示词、预设和采样边界', async t => {
  const { client, requests } = await mockNovelAI(t);
  const characterPrompts = [{ prompt: 'blue hair', uc: 'hat', center: { x: 0.25, y: 0.75 }, enabled: true }];
  await client.generateImage({
    prompt: 'clouds', steps: 33, sampler: 'k_euler', cfg_rescale: 0.7, ucPresetId: 'none', qualityPresetId: 'light',
    image_format: 'webp', transparent_background: true, characterPrompts, negative_prompt: 'text', use_coords: false,
    variety_plus: true, prefer_brownian: true, uncond_scale: 0, seed: 2 ** 32,
  });
  const { input, parameters: p } = requests.at(-1).body;
  assert.match(input, /\btransparent background\b/);
  assert.equal(p.v4_prompt.caption.base_caption, input);
  assert.deepEqual(p.v4_prompt.caption.char_captions, [{ char_caption: 'blue hair', centers: [{ x: 0.25, y: 0.75 }] }]);
  assert.deepEqual(p.v4_negative_prompt.caption, { base_caption: 'text', char_captions: [{ char_caption: 'hat', centers: [{ x: 0.25, y: 0.75 }] }] });
  assert.deepEqual(p.characterPrompts, characterPrompts);
  assert.equal(p.v4_prompt.use_coords, false);
  assert.equal(p.v4_prompt.use_order, true);
  assert.equal(p.straight_alpha, true);
  assert.equal(p.tag_hint_transparent_background, true);
  assert.equal(p.image_format, 'webp');
  assert.equal(p.steps, 33);
  assert.equal(p.sampler, 'k_euler');
  assert.equal(p.cfg_rescale, 0.7);
  assert.equal(p.ucPresetId, 'none');
  assert.equal(p.qualityPresetId, 'light');
  assert.equal(p.skip_cfg_above_sigma, null);
  assert.equal(p.prefer_brownian, true);
  assert.equal(p.uncond_scale, 0.00001);
  assert.equal(p.seed, 4294967288);
  await client.generateImage({ prompt: 'flowers, TRANSPARENT BACKGROUND', transparent_background: true });
  assert.equal(requests.at(-1).body.input, 'flowers, TRANSPARENT BACKGROUND');
  await assert.rejects(client.generateImage({ prompt: 'clouds', model: v45Full, transparent_background: true }), /透明/);
  assert.equal(requests.length, 2);
});

test('V4.5 保留预设和有效尺寸的 Variety+，明确阈值优先，ddim_v3 省略噪声调度', async t => {
  const { client, requests } = await mockNovelAI(t);
  assert.equal(computeVarietySigma(58, 832, 1216), 58);
  assert.equal(computeVarietySigma(58, 1024, 1024), 60);
  assert.equal(alignDimension(100), 128);
  for (const value of [-1, 0, undefined]) {
    const result = normalizeSeed(value);
    assert.ok(Number.isInteger(result) && result >= 1 && result <= 4294967288);
  }
  const input = { prompt: 'rose', model: v45Full, variety_plus: true };
  const raw = await client.generateImageBuffer({ ...input, ucPreset: 1, qualityToggle: false, sampler: 'ddim_v3', noise_schedule: 'native', width: 1024, height: 1024 });
  const p = requests[0].body.parameters;
  assert.deepEqual(raw, png);
  assert.equal(p.ucPreset, 1);
  assert.equal(p.qualityToggle, false);
  assert.equal(p.sampler, 'ddim_v3');
  assert.ok(!('noise_schedule' in p));
  assert.equal(p.skip_cfg_above_sigma, 60);
  for (const skip_cfg_above_sigma of [9, null]) {
    await client.generateImage({ ...input, skip_cfg_above_sigma });
    assert.equal(requests.at(-1).body.parameters.skip_cfg_above_sigma, skip_cfg_above_sigma);
  }
});

test('四种重绘模型均同代，仅 V5 Curated 报告映射；保留原图参数与角色限制', async t => {
  const { client, requests } = await mockNovelAI(t);
  const character = { prompt: 'rose', uc: '', center: { x: 0.5, y: 0.5 }, enabled: true };
  const seven = Array(7).fill(character);
  const input = { prompt: 'rose', action: 'infill', image, mask: image, sampler: 'ddim', seed: 355 };
  const result = await client.generateImage({ ...input, model: v5Curated, inpaintImg2ImgStrength: 0.63, noise: 0.15, characterPrompts: seven, transparent_background: true });
  assert.equal(result.requestedModel, v5Curated);
  assert.equal(result.model, `${v5Full}-inpainting`);
  assert.match(result.fallbackNotice, /同代.*nai-diffusion-5-full-inpainting/);
  let p = requests.at(-1).body.parameters;
  assert.equal(p.params_version, 4);
  assert.equal(p.scale, 7);
  assert.equal(p.steps, 23);
  assert.equal(p.image, image);
  assert.equal(p.mask, image);
  assert.equal(p.add_original_image, true);
  assert.equal(p.sampler, 'k_euler_ancestral');
  assert.equal(p.straight_alpha, true);
  assert.equal(p.inpaintImg2ImgStrength, 0.63);
  assert.equal(p.noise, 0.15);
  assert.deepEqual(p.img2img, { strength: 0.63, color_correct: true, noise: 0.15, extra_noise_seed: 355 });
  for (const model of [v5Full, v45Full, v45Curated]) {
    const result = await client.generateImage({ ...input, model, add_original_image: false, sampler: 'ddim_v3' });
    assert.equal(result.requestedModel, model);
    assert.equal(result.model, `${model}-inpainting`);
    assert.equal(requests.at(-1).body.model, result.model);
    assert.equal(result.fallbackNotice, undefined);
    p = requests.at(-1).body.parameters;
    assert.equal(p.sampler, 'k_euler_ancestral');
    assert.equal(p.add_original_image, false);
    assert.equal(p.inpaintImg2ImgStrength, 1);
    assert.equal(p.noise, 0);
    assert.ok(!('img2img' in p));
  }
  await client.generateImage({ ...input, inpaintImg2ImgStrength: 0.5 });
  assert.deepEqual(requests.at(-1).body.parameters.img2img, { strength: 0.5, color_correct: true, extra_noise_seed: 355 });
  await assert.rejects(client.generateImage({ ...input, characterPrompts: Array(33).fill(character) }), /32/);
  await assert.rejects(client.generateImage({ ...input, model: v45Curated, characterPrompts: seven }), /6/);
  await assert.rejects(client.generateImage({ ...input, model: v45Curated, transparent_background: true }), /透明/);
  assert.equal(requests.length, 5);
});

test('图生图默认去噪、色彩修正与种子，可显式覆盖', async t => {
  const { client, requests } = await mockNovelAI(t);
  const input = { prompt: 'clouds', action: 'img2img', seed: 17, image };
  await client.generateImage(input);
  let p = requests.at(-1).body.parameters;
  assert.equal(p.image, image);
  assert.equal(p.strength, 0.7);
  assert.equal(p.noise, 0);
  assert.equal(p.extra_noise_seed, 17);
  assert.equal(p.color_correct, true);
  await client.generateImage({ ...input, color_correct: false, extra_noise_seed: 22, strength: 0, noise: 0.2 });
  p = requests.at(-1).body.parameters;
  assert.equal(p.strength, 0);
  assert.equal(p.noise, 0.2);
  assert.equal(p.extra_noise_seed, 22);
  assert.equal(p.color_correct, false);
});

test('精确参考五组参数等长并反转忠实度，Vibe 与精确参考互斥', async t => {
  const { client, requests } = await mockNovelAI(t);
  const input = { prompt: 'rose', model: v45Full, characterReferences: [
    { image, type: 'character&style', strength: 0.83, fidelity: 0.28336 }, { image, type: 'costume', strength: 0.38, fidelity: 1 },
  ] };
  await client.generateImage(input);
  const p = requests.at(-1).body.parameters;
  assert.deepEqual(p.director_reference_images, [image, image]);
  assert.deepEqual(p.director_reference_descriptions, ['character&style', 'costume'].map(type => ({ caption: { base_caption: type, char_captions: [] }, legacy_uc: false })));
  assert.deepEqual(p.director_reference_information_extracted, [1, 1]);
  assert.deepEqual(p.director_reference_strength_values, [0.83, 0.38]);
  assert.deepEqual(p.director_reference_secondary_strength_values, [0.7166, 0]);
  await assert.rejects(client.generateImage({ ...input, vibeReferences: [{ encoded_vibe: image }] }), /同时|互斥/);
  await assert.rejects(client.generateImage({ ...input, reference_image_multiple: [image] }), /同时|互斥/);
  await assert.rejects(client.generateImage({ ...input, model: v5Full }), /精确参考/);
  assert.equal(requests.length, 1);
});

test('同代重绘拒绝所有来源的 Vibe（包括混用），不会编码、请求或回退', async t => {
  const { client, requests } = await mockNovelAI(t);
  for (const model of IMAGE_MODELS) {
    for (const ref of [
      { vibeReferences: [{ image }] }, { vibeReferences: [{ encoded_vibe: image }] }, { vibeReferences: [{ vibe_id: 'saved' }] },
      { reference_image_multiple: [image] }, { characterReferences: [{ image, type: 'style' }], vibeReferences: [{ image }] },
    ]) {
      await assert.rejects(client.generateImage({ prompt: 'clouds', action: 'infill', model, image, mask: image, ...ref }), /局部重绘.*Vibe.*不会回退/);
    }
  }
  assert.equal(requests.length, 0);
});

test('V4.5 非重绘的 Vibe 仅使用编码及对应强度，并校验上限', async t => {
  const { client, requests } = await mockNovelAI(t);
  const input = { prompt: 'clouds', vibeReferences: [{ encoded_vibe: 'YmluYXJ5', strength: 0.77 }] };
  for (const [model, action] of [[v45Full, 'generate'], [v45Curated, 'img2img']]) {
    await client.generateImage({ ...input, model, action, image, reference_image_multiple: [image], reference_strength_multiple: [0.3], normalize_reference_strength_multiple: false });
    const p = requests.at(-1).body.parameters;
    assert.deepEqual(p.reference_image_multiple, ['YmluYXJ5', image]);
    assert.deepEqual(p.reference_strength_multiple, [0.77, 0.3]);
    assert.equal(p.normalize_reference_strength_multiple, false);
    assert.ok(!('reference_information_extracted_multiple' in p));
  }
  await assert.rejects(client.generateImage(input), /Vibe/);
  await assert.rejects(client.generateImage({ ...input, model: v45Full, vibeReferences: [{ image }] }), /encoded_vibe/);
  await assert.rejects(client.generateImage({ ...input, model: v45Curated, vibeReferences: Array(17).fill(input.vibeReferences[0]) }), /16/);
  assert.equal(requests.length, 2);
});

test('导演工具覆盖 8 种操作、24 个情绪与三张去背景原图', async t => {
  const { client, requests } = await mockNovelAI(t, ({ body }, res) => {
    if (body.req_type === 'bg-removal') {
      const zip = new AdmZip();
      for (const entry of ['mask.png', 'image.png', 'generated.png']) zip.addFile(entry, png);
      res.writeHead(200, { 'Content-Type': 'application/zip' }).end(zip.toBuffer());
    } else res.writeHead(200).end(png);
  });
  assert.equal(EMOTION_MOODS.length, 24);
  assert.equal(new Set(EMOTION_MOODS).size, 24);
  for (const mood of ['laughing', 'irritated', 'worried', 'love', 'hurt', 'playful']) assert.ok(EMOTION_MOODS.includes(mood));
  for (const invalid of ['amused', 'annoyed', 'proud', 'panicked', 'crying', 'relieved']) assert.ok(!EMOTION_MOODS.includes(invalid));
  assert.equal(AUGMENT_REQ_TYPES.length, 8);
  for (const req_type of AUGMENT_REQ_TYPES) {
    const images = await client.augmentImage({ image, req_type, width: 64, height: 64, emotion: 'happy', prompt: 'blue eyes', defry: 4 });
    const { url, method, body } = requests.at(-1);
    assert.equal(method, 'POST');
    assert.equal(url.pathname, '/ai/augment-image');
    assert.equal(body.image, image);
    assert.equal(body.req_type, req_type);
    assert.equal(body.width, 64);
    assert.equal(body.height, 64);
    assert.equal('defry' in body, req_type === 'emotion' || req_type === 'colorize');
    if (req_type === 'emotion') assert.equal(body.prompt, 'happy;;blue eyes');
    if (req_type === 'colorize') assert.equal(body.prompt, 'blue eyes');
    assert.equal(images.length, req_type === 'bg-removal' ? 3 : 1);
    for (const result of images) assert.deepEqual(result.buffer, png);
  }
  await assert.rejects(client.augmentImage({ image, req_type: 'emotion', width: 64, height: 64, emotion: 'bogus' }), /情绪|emotion/);
  await assert.rejects(client.augmentImage({ image, req_type: 'emotion', width: 64, height: 64 }), /情绪|emotion/);
  assert.equal(requests.length, 8);
});

test('放大保留原图、V4.5 编码保留二进制、标签保留查询与上游字段', async t => {
  const tags = [{ tag: '秋', jp_tag: '秋', count: 107, confidence: 0.99 }];
  const bytes = Buffer.from([1, 0x9c, 0, 0x55]);
  const { client, requests } = await mockNovelAI(t, ({ url }, res) => {
    switch (url.pathname) {
      case '/ai/upscale': res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ images: [{ image, seed: 5 }] })); break;
      case '/ai/encode-vibe': res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(bytes); break;
      case '/ai/generate-image/suggest-tags': res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(JSON.stringify({ tags })); break;
      default: res.writeHead(404).end();
    }
  });
  const upscaled = await client.upscaleImage({ image, declared_blur_sigma: 0 });
  assert.equal(upscaled[0].seed, 5);
  assert.deepEqual(upscaled[0].buffer, png);
  assert.deepEqual(requests[0].body, { image, model: v5Full, declared_blur_sigma: 0 });
  assert.equal(requests[0].method, 'POST');
  for (const model of [v45Curated, v45Full]) {
    const body = { image, mask: image, crop_to_mask: false, information_extracted: 0.4, model };
    assert.equal(await client.encodeVibe(body), bytes.toString('base64'));
    assert.deepEqual(requests.at(-1).body, body);
    assert.equal(requests.at(-1).method, 'POST');
  }
  for (const model of [v5Full, v5Curated, 'nai-diffusion-4-full', undefined]) {
    await assert.rejects(client.encodeVibe({ image, model }), /仅支持 V4\.5/);
  }
  assert.deepEqual(await client.suggestTags({ prompt: '秋 & 黄', lang: 'jp' }), { tags });
  const tagsRequest = requests.at(-1);
  assert.equal(tagsRequest.method, 'GET');
  assert.equal(tagsRequest.body, undefined);
  assert.deepEqual(Object.fromEntries(tagsRequest.url.searchParams), { model: v5Full, prompt: '秋 & 黄', lang: 'jp' });
  assert.equal(requests.length, 4);
});

test('GET /v1/usage 原样返回；摘要只基于真实存在的字段（包括 0）', async t => {
  const full = {
    balance: 19.25, remaining: '18.75', unit: 'USD', planName: '示例套餐',
    usage: { today: { requests: 0, cost: 1.5, actual_cost: 1.1 }, total: { requests: 87, cost: 12.5, actual_cost: 11.4 } },
    daily_usage: [{ day: '2026-06-01' }], model_stats: { one: { requests: 87 } }, extra: { preserved: [true, null] },
  };
  const payloads = [full, { usage: { today: { actual_cost: 0 } } }, { future: ['ok'] }, { remaining: 1, unit: 'JPY' }, {}];
  let index = 0;
  const { client, requests } = await mockNovelAI(t, (_request, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payloads[index++])));
  for (const [i, expected] of payloads.entries()) {
    const { raw, summary } = await client.getSubscription();
    assert.deepEqual(raw, expected);
    assert.equal(typeof summary, 'string');
    assert.ok(summary.trim());
    assert.equal(requests.at(-1).method, 'GET');
    assert.equal(requests.at(-1).url.pathname, '/v1/usage');
    assert.equal(requests.at(-1).body, undefined);
    if (i === 0) {
      for (const value of ['示例套餐', 'USD', '19.25', '18.75', '请求数 0', '1.5', '1.1', '87', '12.5', '11.4', '每日用量', '模型统计']) assert.ok(summary.includes(value), value);
    } else if (i === 1) {
      assert.match(summary, /今日.*实际费用 0/);
      assert.doesNotMatch(summary, /余额|剩余|请求数|累计|USD|套餐/);
    } else if (i === 3) {
      assert.match(summary, /JPY/);
      assert.doesNotMatch(summary, /余额|USD/);
    } else assert.doesNotMatch(summary, /0|余额|计费|USD|套餐|今日|累计/);
  }
});

test('默认服务与私网、loopback、IPv4 mapped 均直连，公网仍选择代理；不解析或连接这些主机', t => {
  // Inspect transport selection only; no socket, DNS lookup or external proxy is used here.
  withEnv(t, { UPSTREAM_BASE_URL: undefined, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:2' });
  const client = new NovelAIClient('test-key');
  assert.equal(client.baseUrl, 'http://qiandaiapi-app:8080');
  const usesProxy = url => Boolean(new NovelAIClient('test-key', { baseUrl: url }).agent?.proxy);
  for (const host of ['qiandaiapi-app', 'localhost.', 'test.localhost', '127.255.2.1', '0x7f000001', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.0.1', '[::1]', '[fd40::15]', '[fc00::8]', '[febf::1]', '[::ffff:192.168.3.5]', '[::ffff:7f00:13]']) assert.equal(usesProxy(`http://${host}`), false, host);
  for (const host of ['public.example', 'api.localhost.example', '8.8.8.8', '172.15.255.255', '172.32.0.0', '192.169.0.1', '[2606:4700::1]', '[::ffff:8.8.8.8]']) assert.equal(usesProxy(`https://${host}`), true, host);
});

test('UPSTREAM_BASE_URL 支持路径，显式 baseUrl 优先；无效代理不影响内网', async t => {
  const { baseUrl, requests } = await mockNovelAI(t, (_request, res) => res.end('{}'));
  withEnv(t, { UPSTREAM_BASE_URL: `${baseUrl}/upstream/`, HTTP_PROXY: 'invalid', HTTPS_PROXY: 'invalid' });
  await new NovelAIClient('test-key').getSubscription();
  await new NovelAIClient('test-key', baseUrl).getSubscription();
  assert.deepEqual(requests.map(({ url }) => url.pathname), ['/upstream/v1/usage', '/v1/usage']);
});

test('每个辅助接口的 HTTP 错误保留状态、路径和安全摘要；不含请求查询且不重试', async t => {
  const { client, requests } = await mockNovelAI(t, (_request, res) => res.writeHead(429, { 'Content-Type': 'application/problem+json' }).end(JSON.stringify({
    error: { message: 'Service busy; try later. Authorization: Bearer reflected-secret' }, api_key: 'separate-secret', debug: { request: 'private-query' },
  })));
  const cases = [
    ['/ai/augment-image', () => client.augmentImage({ image, req_type: 'sketch', width: 64, height: 64 })],
    ['/ai/upscale', () => client.upscaleImage({ image })], ['/ai/encode-vibe', () => client.encodeVibe({ image, model: v45Full })],
    ['/ai/generate-image/suggest-tags', () => client.suggestTags({ prompt: 'private-query' })], ['/v1/usage', () => client.getSubscription()],
  ];
  for (const [path, run] of cases) {
    await assert.rejects(run(), error => {
      assert.ok(error.message.includes(`HTTP 429 ${path}`));
      assert.match(error.message, /Service busy; try later/);
      assert.doesNotMatch(error.message, /reflected-secret|separate-secret|Authorization|Bearer|test-key|private-query|\?/i);
      return true;
    });
  }
  assert.equal(requests.length, cases.length);
});

test('上游错误不泄漏凭据、HTML 或二进制；正文和摘要有界', async t => {
  const cases = [
    ['application/json', JSON.stringify({ message: 'Quota exhausted', secret: 'hidden' }), /Quota exhausted/],
    ['text/plain', 'Failed for test-key: token=hidden', /Failed for/],
    ['text/plain', 'Retry later: https://hidden@test.invalid/', /Retry later/],
    ['text/html', '<h1>hidden</h1>', /省略|安全展示/], ['text/plain', '<html>hidden</html>', /省略|安全展示/],
    ['application/json', JSON.stringify({ detail: '<script>hidden</script>' }), /省略|安全展示/],
    ['application/octet-stream', png, /省略|安全展示/], ['text/plain', Buffer.from([0xff, 0, 7, 0x61]), /省略|安全展示/],
    ['application/json', '{"message":"broken-json-hidden', /省略|安全展示/], ['text/plain', 'Busy '.repeat(300), /Busy/],
    ['text/plain', 'hidden '.repeat(1200), /过长|省略/],
  ];
  let index = 0;
  const { client, requests } = await mockNovelAI(t, (_request, res) => {
    const [media, body] = cases[index++];
    res.writeHead(503, { 'Content-Type': media });
    res.write(body); // No Content-Length: exercise the streamed size limit too.
    res.end();
  });
  for (const [, , expected] of cases) {
    await assert.rejects(client.getSubscription(), error => {
      assert.match(error.message, /HTTP 503 \/v1\/usage/);
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /hidden|test-key|<|>|\ufffd|\u0000/i);
      assert.ok(error.message.length < 250);
      return true;
    });
  }
  assert.equal(requests.length, cases.length);
});

test('畸形的 200、重定向与超时均不重试，也不返回响应正文', async t => {
  let handler = (_request, res) => res.writeHead(200).end('not-json-hidden');
  const { baseUrl, client, requests } = await mockNovelAI(t, (...args) => handler(...args));
  await assert.rejects(client.getSubscription(), /HTTP 200 \/v1\/usage.*JSON/);
  handler = (_request, res) => res.end('[]');
  await assert.rejects(client.getSubscription(), /HTTP 200 \/v1\/usage.*用量/);
  handler = (_request, res) => res.end('{"tags":{}}');
  await assert.rejects(client.suggestTags({ prompt: 'secret-query' }), /HTTP 200 \/ai\/generate-image\/suggest-tags：.*标签/);
  handler = (_request, res) => res.writeHead(307, { Location: `${baseUrl}/unexpected`, 'Content-Type': 'text/html' }).end('<b>hidden</b>');
  await assert.rejects(client.generateImage({ prompt: 'clouds' }), /HTTP 307 \/ai\/generate-image/);
  handler = (_request, res) => res.writeHead(200).write('{');
  const shortClient = new NovelAIClient('test-key', { baseUrl, timeoutMs: 300 });
  await assert.rejects(shortClient.getSubscription(), /超时.*\/v1\/usage/);
  assert.equal(requests.length, 5);
});
