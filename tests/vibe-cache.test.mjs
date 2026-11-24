import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { cleanupExpiredImages, saveArchivedImage } from '../dist/image-archive.js';
import { VibeCache, vibeCacheKey } from '../dist/vibe-cache.js';

const model = 'nai-diffusion-4-5-full';
const image = Buffer.from('image bytes');
const mask = Buffer.from('mask bytes');
const encoded = Buffer.from('encoded vibe').toString('base64');

test('Vibe 键使用原始图片字节、模型、四位提取比例和遮罩摘要', () => {
  const maskHash = createHash('sha256').update(mask).digest('hex');
  const expected = createHash('sha256').update(image).update(`|${model}|0.1235|${maskHash}`).digest('hex');
  assert.equal(vibeCacheKey(image, model, 0.12346, mask), expected);
  assert.equal(vibeCacheKey(image, model, 0.12349, mask), expected);
  assert.notEqual(vibeCacheKey(image, model, 0.12346, mask, true), expected);
  assert.notEqual(vibeCacheKey(image, model, 0.12346), expected);
});

test('并发编码去重；Vibe 在 dataDir 持久化，不依赖图像归档', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nai-vibe-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const cache = new VibeCache(dataDir);
  const key = vibeCacheKey(image, model, 0.5);
  let encodes = 0;
  const encode = async () => {
    encodes++;
    return encoded;
  };
  const [first, second] = await Promise.all([
    cache.getOrEncode(key, model, 0.5, encode),
    cache.getOrEncode(key, model, 0.5, encode),
  ]);
  assert.equal(encodes, 1);
  assert.deepEqual(first, second);
  assert.equal(first.id, `vibe_${key.slice(0, 16)}`);
  assert.equal(first.encoded_vibe, encoded);
  const filename = join(dataDir, '.vibe-cache', `${first.id}.json`);
  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), first);

  const archiveDir = join(root, 'images');
  await mkdir(archiveDir);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ccbbaa' } }).png().toBuffer();
  // 即使旧部署把两类数据放在同一目录，过期清理也只接触图片归档。
  for (const directory of [archiveDir, dataDir]) {
    const { id } = await saveArchivedImage(directory, png, { tool: 'generate_image', action: 'generate' });
    await cleanupExpiredImages(directory, 0);
    await assert.rejects(stat(join(directory, id)), { code: 'ENOENT' });
  }
  assert.deepEqual(await readdir(archiveDir), []);
  assert.deepEqual(await readdir(dataDir), ['.vibe-cache']);
  const restarted = new VibeCache(dataDir);
  assert.deepEqual(await restarted.getByHashKey(key), first);
  assert.deepEqual(await restarted.getById(first.id), first);
  assert.deepEqual(await restarted.getOrEncode(key, model, 0.5, encode), first);
  assert.equal(encodes, 1);
  assert.equal(await restarted.getById('../metadata'), undefined);

  await writeFile(filename, '{"encoded_vibe": false}');
  assert.equal(await new VibeCache(dataDir).getById(first.id), undefined);
});

test('缓存目录是链接时不跨目录读写，编码仍可从内存按 ID 获取', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nai-vibe-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const outside = join(root, 'outside');
  await Promise.all([mkdir(dataDir), mkdir(outside)]);
  await symlink(outside, join(dataDir, '.vibe-cache'), process.platform === 'win32' ? 'junction' : 'dir');
  const key = vibeCacheKey(image, model, 0.5);
  const id = `vibe_${key.slice(0, 16)}`;
  const target = join(outside, `${id}.json`);
  const fixture = JSON.stringify({ id, model, information_extracted: 0.5, encoded_vibe: 'YQ==', created_at: new Date().toISOString() });
  await writeFile(target, fixture);
  const cache = new VibeCache(dataDir);
  assert.equal(await cache.getById(id), undefined);
  const entry = await cache.set(key, { model, information_extracted: 0.5, encoded_vibe: encoded });
  assert.equal((await cache.getById(entry.id)).encoded_vibe, encoded);
  assert.equal(await readFile(target, 'utf8'), fixture);
});

test('编码失败不缓存，后续请求可以重新编码', async () => {
  const cache = new VibeCache();
  const key = vibeCacheKey(image, model, 1);
  await assert.rejects(cache.getOrEncode(key, model, 1, async () => { throw new Error('编码失败'); }), /编码失败/);
  assert.equal(await cache.getByHashKey(key), undefined);
  assert.equal((await cache.getOrEncode(key, model, 1, async () => encoded)).encoded_vibe, encoded);
});
