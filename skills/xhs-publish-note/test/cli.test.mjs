import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
async function fixture(t) {
  const noteDir = await mkdtemp(path.join(tmpdir(), 'xhs-public-cli-'));
  t.after(() => rm(noteDir, { recursive: true, force: true }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+VQioAAAAASUVORK5CYII=', 'base64');
  await Promise.all([
    writeFile(path.join(noteDir, 'title.txt'), '露营日记'),
    writeFile(path.join(noteDir, 'content.txt'), '第一段。\n\n第二段。'),
    ...['02.png', 'cover.png', '01.png'].map(f => writeFile(path.join(noteDir, f), png)),
  ]);
  const stateDir = path.join(noteDir, 'private-ledger');
  function invoke(action, ...args) {
    const proc = spawnSync(process.execPath, [cli, action, noteDir, ...args, '--json'], {
      encoding: 'utf8', env: { ...process.env, XHS_PUBLISH_STATE_DIR: stateDir },
    });
    return { code: proc.status, result: JSON.parse(proc.stdout) };
  }
  return { invoke, noteDir, stateDir };
}

test('check is local-only, stable, and independent of browser dependencies', async t => {
  const { invoke, stateDir } = await fixture(t);
  const first = invoke('check');
  assert.equal(first.code, 0);
  assert.deepEqual(first.result.images, ['cover.png', '01.png', '02.png']);
  assert.equal(first.result.body, '第一段。\n\n第二段。');
  assert.match(first.result.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(invoke('check'), first);
  await assert.rejects(access(stateDir), { code: 'ENOENT' });
});

test('missing target, wrong version and preview-with-submit all stop before browser access', async t => {
  const { invoke, noteDir, stateDir } = await fixture(t);
  const fingerprint = invoke('check').result.fingerprint;
  const submit = ['--submit', '--confirm-fingerprint', fingerprint];
  assert.match(invoke('publish', ...submit).result.reason, /account/);
  assert.match(invoke('publish', '--account', 'demo', ...submit).result.reason, /nickname/);
  assert.match(invoke('publish', '--account', 'demo', '--nickname', '作者', '--submit').result.reason, /fingerprint/);
  assert.match(invoke('preview', '--account', 'demo', '--submit').result.reason, /submit/);
  await writeFile(path.join(noteDir, 'content.txt'), '已改过的正文');
  const rejected = invoke('publish', '--account', 'demo', '--nickname', '作者', ...submit);
  assert.equal(rejected.code, 1);
  assert.match(rejected.result.reason, /定稿指纹/);
  await assert.rejects(access(stateDir), { code: 'ENOENT' });
});

test('preview accepts an explicit nickname and still validates the draft before opening Chrome', async t => {
  const { invoke, noteDir, stateDir } = await fixture(t);
  await writeFile(path.join(noteDir, 'title.txt'), '');
  const args = ['--account', 'demo'];
  const withoutNickname = invoke('preview', ...args);
  assert.equal(withoutNickname.code, 1);
  assert.match(withoutNickname.result.reason, /标题/);
  assert.deepEqual(invoke('preview', ...args, '--nickname', '作者'), withoutNickname);
  assert.match(invoke('preview', ...args, '--nickname', ' ').result.reason, /nickname/);
  await assert.rejects(access(stateDir), { code: 'ENOENT' });
});
