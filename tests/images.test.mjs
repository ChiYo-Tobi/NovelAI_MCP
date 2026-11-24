import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import {
  ARCHIVE_ID_REGEX,
  IMAGE_PATH,
  archivePublicUrl,
  cleanupExpiredImages,
  extractArchiveId,
  loadArchivedImage,
  saveArchivedImage,
  saveImage,
} from '../dist/image-archive.js';
import {
  extractPngTextMetadata,
  fitImageToMaxPixels,
  generateMaskFromRegions,
  getImageDimensions,
  isPrivateOrReservedIp,
  prepareImg2ImgImage,
  prepareInpaintMask,
  preparePreciseReferenceImage,
  prepareV3VibeImage,
  resolveImageInput,
} from '../dist/image-input.js';
import { unpackImageResponse } from '../dist/response-unpack.js';

function image(width, height, background = '#c03c00') {
  return sharp({ create: { width, height, channels: 3, background } });
}

async function tempArchive(t) {
  const directory = await mkdtemp(join(tmpdir(), 'novelai-images-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('响应解包根据实际字节识别裸 PNG、WebP、JPEG 及带种子的 JSON', async () => {
  const png = await image(24, 16).png().toBuffer();
  const webp = await image(24, 16).webp().toBuffer();
  const jpg = await image(24, 16).jpeg().toBuffer();
  for (const [buffer, ext, mimeType] of [
    [png, 'png', 'image/png'],
    [webp, 'webp', 'image/webp'],
    [jpg, 'jpg', 'image/jpeg'],
  ]) {
    assert.deepEqual(unpackImageResponse(buffer), [{ buffer, ext, mimeType }]);
  }
  const json = Buffer.from(JSON.stringify({
    images: [{ image: webp.toString('base64'), index: 2, seed: 41 }, { image: jpg.toString('base64') }],
  }));
  assert.deepEqual(unpackImageResponse(json, 'application/json; charset=utf-8'), [
    { buffer: webp, ext: 'webp', mimeType: 'image/webp', index: 2, seed: 41 },
    { buffer: jpg, ext: 'jpg', mimeType: 'image/jpeg' },
  ]);
  assert.deepEqual(unpackImageResponse(json), unpackImageResponse(json, 'application/json'));
  assert.throws(() => unpackImageResponse(Buffer.from('oops')), /magic bytes.*6f6f7073/i);
  assert.throws(() => unpackImageResponse(Buffer.from('{"images":[{"image":"AAAA"}]}')), /magic bytes/i);
});

test('ZIP 返回全部非目录影像且以条目路径排序，媒体类型由字节决定', async () => {
  const png = await image(16, 16).png().toBuffer();
  const webp = await image(16, 16).webp().toBuffer();
  const jpg = await image(16, 16).jpeg().toBuffer();
  const zip = new AdmZip();
  zip.addFile('sub/3.png', png);
  zip.addFile('1.png', webp);
  zip.addFile('doc.txt', Buffer.from('忽略文本'));
  zip.addFile('2.JPEG', jpg);
  const images = unpackImageResponse(zip.toBuffer());
  assert.deepEqual(images.map(item => item.filename), ['1.png', '2.JPEG', 'sub/3.png']);
  assert.deepEqual(images.map(item => item.buffer), [webp, jpg, png]);
  assert.deepEqual(images.map(item => item.ext), ['webp', 'jpg', 'png']);
  const empty = new AdmZip();
  empty.addFile('readme.txt', Buffer.from('无图像'));
  assert.throws(() => unpackImageResponse(empty.toBuffer()), /图像/);
});

const generated = { tool: 'generate_image', action: 'generate' };
const notFound = { code: 'ENOENT' };
const old = new Date('2000-01-01T00:00:00.000Z');

async function readMetadata(directory, id) {
  return JSON.parse(await readFile(join(directory, id, 'metadata.json'), 'utf8'));
}

async function patchMetadata(directory, id, fields) {
  const metadata = { ...await readMetadata(directory, id), ...fields };
  await writeFile(join(directory, id, 'metadata.json'), JSON.stringify(metadata));
}

test('归档使用随机 43 位 ID；原始 PNG、WebP、JPEG 逐字节往返，兼容 v1 PNG', async t => {
  const directory = await tempArchive(t);
  const png = await image(32, 32).png().toBuffer();
  const oldId = await saveImage(directory, png, { model: 'nai-diffusion-5-curated', width: 32, height: 32, seed: 42 });
  const legacy = await loadArchivedImage(directory, oldId);
  assert.equal(legacy.metadata.schema_version, 1);
  assert.equal(legacy.metadata.seed, 42);
  assert.deepEqual(legacy.buffer, png);
  const ids = new Set([oldId]);
  for (const [buffer, ext, mimeType] of [
    [png, 'png', 'image/png'], [await image(32, 32).webp().toBuffer(), 'webp', 'image/webp'],
    [await image(32, 32).jpeg().toBuffer(), 'jpg', 'image/jpeg'], [png, 'png', 'image/png'],
  ]) {
    const saved = await saveArchivedImage(directory, buffer, { ...generated, seed: 43, prompt_preview: '新图片' });
    assert.match(saved.id, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!ids.has(saved.id));
    ids.add(saved.id);
    assert.deepEqual(saved, { id: saved.id, filename: `${saved.id}.${ext}`, ext, mimeType });
    const path = join(directory, saved.id);
    assert.deepEqual((await readdir(path)).sort(), [`image.${ext}`, 'metadata.json']);
    assert.deepEqual(await readFile(join(path, `image.${ext}`)), buffer);
    const loaded = await loadArchivedImage(directory, saved.id);
    assert.deepEqual(loaded.buffer, buffer);
    assert.equal(loaded.ext, ext);
    assert.equal(loaded.mimeType, mimeType);
    assert.equal(loaded.metadata.size_bytes, buffer.length);
    assert.equal(loaded.metadata.prompt_preview, '新图片');
    if (process.platform !== 'win32') {
      assert.equal((await stat(path)).mode & 0o777, 0o700);
      for (const name of [`image.${ext}`, 'metadata.json']) assert.equal((await stat(join(path, name))).mode & 0o777, 0o600);
    }
    if (ext === 'jpg') {
      await patchMetadata(directory, saved.id, { ext: 'webp' });
      assert.equal((await loadArchivedImage(directory, saved.id)).mimeType, 'image/jpeg');
    }
  }
  assert.deepEqual(new Set(await readdir(directory)), ids);
  await assert.rejects(saveArchivedImage(directory, Buffer.from('GIF89a'), generated), /格式/);
  await assert.rejects(loadArchivedImage(directory, '../image.png'), /归档.*ID/);
});

test('归档元数据大小、ID 与磁盘文件类型受限', async t => {
  const directory = await tempArchive(t);
  const png = await image(16, 16).png().toBuffer();
  // 中文字符按 UTF-8 字节而不是 JS 字符数计限；失败不遗留暂存项。
  await assert.rejects(saveArchivedImage(directory, png, { ...generated, note: '甲'.repeat(350_000) }), /元数据.*大小/);
  assert.deepEqual(await readdir(directory), []);
  const { id } = await saveArchivedImage(directory, png, generated);
  await patchMetadata(directory, id, { id: 'A'.repeat(43) });
  await assert.rejects(loadArchivedImage(directory, id), /元数据/);
  await writeFile(join(directory, id, 'metadata.json'), Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(loadArchivedImage(directory, id), /大小限制/);
});

test('公网链接同时匹配原站和完整前缀；本地路由不带前缀', async t => {
  const directory = await tempArchive(t);
  const bytes = await image(16, 16).webp().toBuffer();
  const saved = await saveArchivedImage(directory, bytes, generated);
  assert.equal(IMAGE_PATH, '/novelai-images/');
  assert.match(saved.id, ARCHIVE_ID_REGEX);
  assert.equal(extractArchiveId(saved.id), saved.id);
  for (const [basePath, prefix] of [['', ''], ['/', ''], ['/mcp', '/mcp'], ['/mcp/', '/mcp'], ['/a/b/', '/a/b']]) {
    const origin = new URL(`https://127.0.0.1:444${basePath}`);
    const url = `${origin.origin}${prefix}/novelai-images/${saved.filename}`;
    const options = { archiveDir: directory, imageOrigin: origin };
    assert.equal(archivePublicUrl(origin, saved.id, saved.ext), url);
    assert.equal(extractArchiveId(url, origin), saved.id);
    assert.deepEqual(await resolveImageInput(url, options), bytes);
    for (const invalid of [
      `${url}?q=1`, `${url}#`, url.replace(IMAGE_PATH, '/x/../novelai-images/'),
      url.replace('.webp', '.html'),
    ]) {
      assert.equal(extractArchiveId(invalid, origin), null);
      await assert.rejects(resolveImageInput(invalid, options), /本站归档图像链接无效/);
    }
    await assert.rejects(resolveImageInput(url.replace('.webp', '.jpg'), options), notFound);
    await assert.rejects(resolveImageInput(url, { imageOrigin: origin }), /归档目录/);
    for (const mismatch of [
      url.replace(':444', ':443'), url.replace('127.0.0.1', '127.0.0.2'),
      url.replace(IMAGE_PATH, '/another-prefix/novelai-images/'),
      ...(prefix ? [url.replace(prefix + IMAGE_PATH, IMAGE_PATH)] : []),
    ]) {
      assert.equal(extractArchiveId(mismatch, origin), null);
      await assert.rejects(resolveImageInput(mismatch, options), /公网|保留/);
    }
  }
});

test('ID 和公网前缀输入实时执行 TTL，正好到期即 ENOENT（清理前亦然）', async t => {
  const archiveDir = await tempArchive(t);
  const png = await image(16, 16).png().toBuffer();
  const { id } = await saveArchivedImage(archiveDir, png, generated);
  const created = Date.parse((await readMetadata(archiveDir, id)).created_at);
  const imageOrigin = new URL('https://127.0.0.1/mcp/');
  const url = archivePublicUrl(imageOrigin, id, 'png');
  let now = created;
  t.mock.method(Date, 'now', () => now);
  for (const ttl of [300_000, 1_234]) {
    const options = { archiveDir, imageOrigin, ...(ttl !== 300_000 && { imageTtlMs: ttl }) };
    const load = () => loadArchivedImage(archiveDir, id, ttl === 300_000 ? undefined : { ttlMs: ttl });
    now = created + ttl - 1;
    assert.deepEqual((await load()).buffer, png);
    for (const ref of [id, url]) assert.deepEqual(await resolveImageInput(ref, options), png);
    now++;
    await assert.rejects(load(), notFound);
    for (const ref of [id, url]) await assert.rejects(resolveImageInput(ref, options), notFound);
    now++;
    await assert.rejects(load(), notFound);
    assert.deepEqual(await readFile(join(archiveDir, id, 'image.png')), png);
  }
  await assert.rejects(loadArchivedImage(archiveDir, id, { ttlMs: NaN }), /有效期/);
  await assert.rejects(cleanupExpiredImages(archiveDir, -1), /有效期/);
  await assert.rejects(resolveImageInput('X'.repeat(43), { archiveDir, imageOrigin }), notFound);
  await assert.rejects(resolveImageInput(archivePublicUrl(imageOrigin, 'X'.repeat(43), 'png'), { archiveDir, imageOrigin }), notFound);
});

test('私有条目对公开下载和工具输入不可见', async t => {
  const archiveDir = await tempArchive(t);
  const bytes = await image(16, 16).png().toBuffer();
  const { id } = await saveArchivedImage(archiveDir, bytes, { ...generated, private: true });
  const imageOrigin = new URL('https://127.0.0.1/mcp');
  assert.deepEqual((await loadArchivedImage(archiveDir, id)).buffer, bytes);
  await assert.rejects(loadArchivedImage(archiveDir, id, { publicOnly: true }), notFound);
  for (const ref of [id, archivePublicUrl(imageOrigin, id, 'png')]) {
    await assert.rejects(resolveImageInput(ref, { archiveDir, imageOrigin }), notFound);
  }
});

test('清理只删除到期的自有归档和可识别的旧暂存目录', async t => {
  const directory = await tempArchive(t);
  const bytes = await image(16, 16).png().toBuffer();
  const save = async () => (await saveArchivedImage(directory, bytes, generated)).id;
  const [due, fresh, contaminated, staged, legacy, wrongId] = await Promise.all([
    save(), save(), save(), save(), saveImage(directory, bytes, { seed: 3 }), save(),
  ]);
  const now = Date.now();
  const ttl = 300_000;
  t.mock.method(Date, 'now', () => now);
  for (const id of [due, legacy, contaminated, staged, wrongId]) {
    await patchMetadata(directory, id, { created_at: new Date(now - ttl).toISOString() });
  }
  await patchMetadata(directory, fresh, { created_at: new Date(now - ttl + 1).toISOString() });
  await patchMetadata(directory, wrongId, { id: fresh });
  await writeFile(join(directory, contaminated, 'user-note.txt'), '保留');
  await rename(join(directory, staged), join(directory, '.pending-ABC123'));
  await utimes(join(directory, '.pending-ABC123'), old, old);
  const unrelated = ['.vibe-cache', '.pending-ZZ1234', 'quota', 'B'.repeat(43)];
  for (const name of unrelated) {
    await mkdir(join(directory, name));
    await writeFile(join(directory, name, 'keep.json'), '保留');
    await utimes(join(directory, name), old, old);
  }
  const plainFile = join(directory, 'C'.repeat(43));
  await writeFile(plainFile, '不是归档');
  await writeFile(join(directory, 'quota.json'), '额度');
  assert.equal(await cleanupExpiredImages(directory, ttl), undefined);
  await cleanupExpiredImages(directory, ttl); // 可安全重复调用。
  for (const name of [due, legacy, '.pending-ABC123']) await assert.rejects(lstat(join(directory, name)), notFound);
  assert.deepEqual((await loadArchivedImage(directory, fresh, { ttlMs: ttl })).buffer, bytes);
  for (const name of unrelated) assert.equal(await readFile(join(directory, name, 'keep.json'), 'utf8'), '保留');
  assert.equal(await readFile(join(directory, contaminated, 'user-note.txt'), 'utf8'), '保留');
  assert.deepEqual(await readFile(join(directory, wrongId, 'image.png')), bytes);
  assert.equal(await readFile(plainFile, 'utf8'), '不是归档');
  assert.equal(await readFile(join(directory, 'quota.json'), 'utf8'), '额度');
});

test('读取和清理均不跟随归档根或 ID 目录链接', async t => {
  const directory = await tempArchive(t);
  const outside = await tempArchive(t);
  const bytes = await image(16, 16).png().toBuffer();
  const { id } = await saveArchivedImage(outside, bytes, generated);
  const rootLink = join(directory, 'archive-link');
  const idLink = join(directory, id);
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(outside, rootLink, type);
  await symlink(join(outside, id), idLink, type);
  await assert.rejects(loadArchivedImage(rootLink, id), notFound);
  await assert.rejects(saveArchivedImage(rootLink, bytes, generated), notFound);
  await assert.rejects(loadArchivedImage(directory, id), notFound);
  await cleanupExpiredImages(rootLink, 0);
  await cleanupExpiredImages(directory, 0);
  assert.ok((await lstat(rootLink)).isSymbolicLink());
  assert.ok((await lstat(idLink)).isSymbolicLink());
  assert.deepEqual(await readFile(join(outside, id, 'image.png')), bytes);
});

test('清理保留伪图像以及内部文件被替换为链接的目录', async t => {
  const directory = await tempArchive(t);
  const outside = await tempArchive(t);
  const png = await image(16, 16).png().toBuffer();
  const forged = await saveArchivedImage(directory, png, generated);
  const forgedPath = join(directory, forged.id, 'image.png');
  const otherBytes = Buffer.alloc(png.length, 0x41);
  await writeFile(forgedPath, otherBytes);
  await cleanupExpiredImages(directory, 0);
  assert.deepEqual(await readFile(forgedPath), otherBytes);
  for (const name of ['metadata.json', 'image.png']) {
    const { id } = await saveArchivedImage(directory, png, generated);
    const path = join(directory, id, name);
    const target = join(outside, name);
    const original = await readFile(path);
    await rename(path, target);
    try {
      await symlink(target, path, 'file');
    } catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
      // Windows 非特权账户仍可用 junction 测试同一个叶节点不能是重解析点。
      await symlink(outside, path, 'junction');
    }
    await assert.rejects(loadArchivedImage(directory, id), notFound);
    await cleanupExpiredImages(directory, 0);
    assert.ok((await lstat(path)).isSymbolicLink());
    assert.deepEqual(await readFile(target), original);
  }
});

test('纯 Base64、数据链接和 GIF 可导入；任意传输都不接受 file: 或本地路径', async t => {
  const directory = await tempArchive(t);
  const png = await image(16, 16).png().toBuffer();
  const gif = await image(16, 16).gif().toBuffer();
  assert.deepEqual(await resolveImageInput(png.toString('base64'), {}), png);
  assert.deepEqual(await resolveImageInput(`data:image/gif;base64,${gif.toString('base64')}`, {}), gif);
  assert.deepEqual(await resolveImageInput(gif.toString('base64').replace(/=+$/, ''), {}), gif);
  const path = join(directory, 'source.png');
  await writeFile(path, png);
  for (const ref of [path, `file://${path}`, 'FILE:source.png', './source.png', '../source.png', 'C:\\source.png', '\\\\host\\source.png']) {
    await assert.rejects(resolveImageInput(ref, {}), /禁止读取本地文件/);
  }
  await assert.rejects(resolveImageInput('data:image/png;base64,@@@', {}), /Base64/i);
  await assert.rejects(resolveImageInput(`data:image/png;base64,${png.toString('base64')}****`, {}), /Base64/i);
});

test('HTTPS 入口拒绝私有、保留、回环及映射地址', async () => {
  const blocked = [
    '0.0.0.0', '10.20.38.2', '100.127.0.8', '127.1.2.3', '169.254.169.254', '172.31.9.9',
    '192.0.2.1', '192.168.1.2', '198.18.0.1', '198.51.100.10', '203.0.113.10', '224.0.0.1',
    '240.0.0.0', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:a00:1',
    'fc00::1', 'fd00:ec2::254', 'fe80::1', 'ff02::1', '2001:db8::2', '2002:7f00:1::', '3fff::1',
  ];
  for (const ip of blocked) assert.equal(isPrivateOrReservedIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']) {
    assert.equal(isPrivateOrReservedIp(ip), false, ip);
  }
  for (const host of ['127.0.0.1', '127.1', '[::1]', '[::ffff:127.0.0.1]']) {
    await assert.rejects(resolveImageInput(`https://${host}/image.png`, {}), /公网|保留/);
  }
  await assert.rejects(resolveImageInput('http://8.8.8.8/a.png', {}), /HTTPS/i);
  await assert.rejects(resolveImageInput('https://person:password@8.8.8.8/a.png', {}), /凭据/);
});

test('Sharp 图像预处理输出正确像素，参考图居中并以不透明黑色填充', async () => {
  const source = await image(48, 36).webp({ lossless: true }).toBuffer();
  const png = await prepareImg2ImgImage(source, 48, 36);
  assert.deepEqual(await getImageDimensions(png), { width: 48, height: 36, format: 'png' });
  for (const [width, height, expectedWidth, expectedHeight] of [
    [40, 87, 1024, 1536], [87, 40, 1536, 1024], [48, 48, 1472, 1472],
  ]) {
    const colored = await image(width, height).png().toBuffer();
    const precise = await preparePreciseReferenceImage(colored);
    assert.deepEqual(await getImageDimensions(precise), { width: expectedWidth, height: expectedHeight, format: 'png' });
    const metadata = await sharp(precise).metadata();
    assert.equal(metadata.hasAlpha, false);
    if (width !== height) {
      const pixel = await sharp(precise).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
      assert.deepEqual([...pixel], [0, 0, 0]);
    }
  }
  const transparent = await sharp({
    create: { width: 40, height: 20, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } },
  }).png().toBuffer();
  const vibe = await prepareV3VibeImage(transparent);
  assert.deepEqual(await getImageDimensions(vibe), { width: 448, height: 448, format: 'png' });
  assert.deepEqual(await sharp(vibe).stats().then(stats => stats.channels.map(channel => channel.max)), [0, 0, 0]);
});

async function assertMaskGrid(mask, width, height) {
  const data = await sharp(mask).toColourspace('b-w').raw().toBuffer();
  assert.equal(data.length, width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = data[y * width + x];
      assert.ok(color === 0 || color === 255);
      assert.equal(color, data[Math.floor(y / 8) * 8 * width + Math.floor(x / 8) * 8]);
    }
  }
  return (x, y) => data[y * width + x];
}

test('区域蒙版和原图蒙版均为二值 8×8 块，椭圆的四角保持黑色', async () => {
  const regions = await generateMaskFromRegions(64, 64, [{ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }]);
  const regionPixel = await assertMaskGrid(regions, 64, 64);
  assert.equal(regionPixel(16, 16), 255);
  assert.equal(regionPixel(15, 16), 0);
  assert.equal(regionPixel(48, 47), 0);

  const ellipse = await generateMaskFromRegions(64, 64, [{ shape: 'ellipse', x: 0, y: 0, width: 1, height: 1 }]);
  const ellipsePixel = await assertMaskGrid(ellipse, 64, 64);
  assert.equal(ellipsePixel(0, 0), 0);
  assert.equal(ellipsePixel(33, 33), 255);

  const grayscale = Buffer.alloc(30 * 34, 127);
  for (let y = 0; y < 34; y++) grayscale.fill(128, 15 + y * 30, 30 + y * 30);
  const source = await sharp(grayscale, { raw: { width: 30, height: 34, channels: 1 } }).png().toBuffer();
  const imagePixel = await assertMaskGrid(await prepareInpaintMask(source, 64, 72), 64, 72);
  assert.equal(imagePixel(0, 0), 0);
  assert.equal(imagePixel(63, 71), 255);
  await assert.rejects(generateMaskFromRegions(63, 64, []), /8/);
});

test('缩放图像满足 1 MP 上限与 8 像素对齐，阈值内维持原始宽高', async () => {
  const source = await image(2100, 1200).webp().toBuffer();
  const resized = await fitImageToMaxPixels(source);
  assert.ok(resized.width * resized.height <= 1048576);
  assert.equal(resized.width % 8, 0);
  assert.equal(resized.height % 8, 0);
  assert.ok(Math.abs(resized.width / resized.height - 1.75) < 0.03);
  assert.deepEqual(await getImageDimensions(resized.buffer), { width: resized.width, height: resized.height, format: 'png' });

  const small = await fitImageToMaxPixels(await image(13, 15).webp().toBuffer());
  assert.deepEqual(await getImageDimensions(small.buffer), { width: 13, height: 15, format: 'png' });
  const extreme = await fitImageToMaxPixels(await image(20_000, 20).png().toBuffer(), 4096);
  assert.ok(extreme.width * extreme.height <= 4096);
  assert.equal(extreme.height, 8);
});

test('PNG 文本解析支持 tEXt、UTF-8 iTXt、压缩 iTXt 和 Comment JSON', async () => {
  function chunk(type, text) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(text.length);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(text, crc32(head.subarray(4))));
    return Buffer.concat([head, text, crc]);
  }
  const png = await image(16, 16).png().toBuffer();
  const withText = Buffer.concat([
    png.subarray(0, -12),
    chunk('tEXt', Buffer.from('Software\0NovelAI')),
    chunk('iTXt', Buffer.from('Description\0\0\0\0\0蓝色的鸟')),
    chunk('iTXt', Buffer.concat([Buffer.from('Comment\0\x01\0\0\0'), deflateSync('{"seed":845,"steps":23}')])),
    png.subarray(-12),
  ]);
  assert.deepEqual(extractPngTextMetadata(withText), {
    Software: 'NovelAI', Description: '蓝色的鸟', Comment: { seed: 845, steps: 23 },
  });
  assert.deepEqual(extractPngTextMetadata(Buffer.from('a')), {});
});
