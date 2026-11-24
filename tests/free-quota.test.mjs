import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FreeQuota } from '../dist/free-quota.js';

const fiveHours = 5 * 60 * 60 * 1000;
const initial = Date.UTC(2026, 0, 10, 12);
const v5 = 'nai-diffusion-5-full', v5c = 'nai-diffusion-5-curated';
const v45 = 'nai-diffusion-4-5-full', v45c = 'nai-diffusion-4-5-curated';

async function fixture(t, n5 = 0, n45 = 0) {
  const dir = await mkdtemp(join(tmpdir(), 'nai-quota-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'free-quota.json');
  const entries = [...Array(n5).fill('v5'), ...Array(n45).fill('v45')]
    .map(pool => ({ id: randomUUID(), at: initial, pool }));
  if (entries.length) await writeFile(path, JSON.stringify({ version: 1, entries }));
  const clock = { time: initial };
  return { dir, path, clock, read: async () => JSON.parse(await readFile(path, 'utf8')).entries,
    quota: new FreeQuota(dir, () => clock.time) };
}

test('V5 和 V4.5 各自共享 Full / Curated 池，满额不会请求上游，精确到 5 小时边界', async t => {
  const { quota, clock, read } = await fixture(t, 99, 399);
  const upstream = () => 42;
  assert.equal(await quota.run(v5, upstream), 42);
  await assert.rejects(quota.run(v5c, assert.fail), /5 系列.*最早恢复时间：2026-01-10T17:00:00.000Z/);
  assert.equal(await quota.run(v45c, upstream), 42);
  clock.time += fiveHours - 1;
  await assert.rejects(quota.run(v45, assert.fail), /4\.5 系列.*个人 API Key/);
  assert.equal((await read()).length, 500);
  clock.time++;
  await quota.run(v45, upstream);
  await quota.run(v5c, upstream);
  assert.deepEqual((await read()).map(e => e.pool).sort(), ['v45', 'v5']);
});

test('最后一份额度在调用上游前已独占并落盘；并发超限拒绝，重启不清零', async t => {
  const { quota, dir, read } = await fixture(t, 99);
  let release, started, calls = 0;
  const start = new Promise(r => { started = r; });
  const hold = new Promise(r => { release = r; });
  const first = quota.run(v5c, async () => { calls++; started(); return hold; });
  try {
    await start;
    assert.equal((await read()).length, 100);
    const results = await Promise.allSettled(Array.from({ length: 16 }, () => quota.run(v5, () => { calls++; })));
    assert.ok(results.every(r => r.status === 'rejected' && /额度已用尽/.test(r.reason.message)));
    assert.equal(calls, 1);
    await assert.rejects(new FreeQuota(dir, () => initial + 1).run(v5, assert.fail), /额度已用尽/);
  } finally { release('img'); }
  assert.equal(await first, 'img');
});

test('失败只释放自己的 reservation，不影响同池成功项，重启后仍可使用释放的额度', async t => {
  const { quota, read, dir } = await fixture(t, 98);
  let fail;
  const hold = new Promise((_, r) => { fail = r; });
  const first = quota.run(v5, () => hold);
  await quota.run(v5c, async () => 'ok');
  assert.equal((await read()).length, 100);
  const failed = assert.rejects(first, /mock upstream unavailable/);
  fail(new Error('mock upstream unavailable'));
  await failed;
  await quota.flush();
  assert.equal((await read()).length, 99);
  const restarted = new FreeQuota(dir, () => initial);
  assert.equal(await restarted.run(v5, async () => 'image'), 'image');
  await assert.rejects(restarted.run(v5c, assert.fail), /额度已用尽/);
});

test('无效模型、损坏记录及运行中消失的额度文件都不会变成可用空池', async t => {
  const { quota, path } = await fixture(t);
  await assert.rejects(quota.run('unknown', assert.fail), /不支持/);
  await quota.run(v5, () => 'ok');
  await unlink(path);
  await assert.rejects(quota.run(v5, assert.fail), /暂停/);
  for (const corrupt of ['{', '{"version":1,"entries":{}}', '{"version":1,"entries":[{"pool":"oops"}]}']) {
    await writeFile(path, corrupt);
    await assert.rejects(quota.run(v45, assert.fail), /暂停/);
    assert.equal(await readFile(path, 'utf8'), corrupt);
  }
});

test('无法存储额度时不请求上游', async t => {
  const { path } = await fixture(t, 1);
  await assert.rejects(new FreeQuota(path, () => initial).run(v5, assert.fail), /暂停/);
});
