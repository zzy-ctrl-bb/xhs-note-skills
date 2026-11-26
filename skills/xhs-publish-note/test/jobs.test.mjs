import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  finishSubmission, freezeNote, getSubmission, loadNote, reconcileSubmission, reserveSubmission,
} from '../lib/jobs.mjs';

async function tempDirectory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'xhs-job-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeNote(t) {
  const dir = await tempDirectory(t);
  await writeFile(path.join(dir, 'title.txt'), '\uFEFF雨天日记\r\n');
  await writeFile(path.join(dir, 'content.txt'), '第一段\r\n\r\n 第二段  \r\n');
  await writeFile(path.join(dir, '01.png'), Buffer.from('image-one'));
  return dir;
}

test('preserves paragraph whitespace and naturally sorts images, ignoring Finder metadata', async t => {
  const dir = await makeNote(t);
  await writeFile(path.join(dir, '10.JPG'), Buffer.from('ten'));
  await writeFile(path.join(dir, '2.webp'), Buffer.from('two'));
  await writeFile(path.join(dir, '._01.png'), Buffer.from('sidecar'));
  const note = await loadNote(dir);
  assert.equal(note.title, '雨天日记');
  assert.equal(note.body, '第一段\n\n 第二段  \n');
  assert.deepEqual(note.images.map(file => path.basename(file)), ['01.png', '2.webp', '10.JPG']);
  await rename(path.join(dir, '01.png'), path.join(dir, '1.png'));
  const renamed = await loadNote(dir);
  assert.equal(renamed.fingerprint, note.fingerprint);
  await writeFile(path.join(dir, '2.webp'), 'different');
  assert.notEqual((await loadNote(dir)).fingerprint, note.fingerprint);
});

test('accepts Chinese names and a single image directory; refuses ambiguous layouts', async t => {
  const dir = await makeNote(t);
  await rename(path.join(dir, 'title.txt'), path.join(dir, '标题.txt'));
  await rename(path.join(dir, 'content.txt'), path.join(dir, '正文.txt'));
  await mkdir(path.join(dir, '图片'));
  await rename(path.join(dir, '01.png'), path.join(dir, '图片', '封面.png'));
  const note = await loadNote(dir);
  assert.equal(note.images[0], path.join(dir, '图片', '封面.png'));
  await writeFile(path.join(dir, '02.jpg'), 'image');
  await assert.rejects(loadNote(dir), /集中放在一处/);
  await writeFile(path.join(dir, 'title.txt'), '另一标题');
  await assert.rejects(loadNote(dir), /标题.txt/);
});

test('refuses oversized input, missing pictures and non-UTF8 copy', async t => {
  const dir = await makeNote(t);
  await writeFile(path.join(dir, 'title.txt'), '树'.repeat(21));
  await assert.rejects(loadNote(dir), /20/);
  await writeFile(path.join(dir, 'title.txt'), '树'.repeat(20));
  await writeFile(path.join(dir, 'content.txt'), Buffer.from([0xff, 0xfe, 0x31, 0x00]));
  await assert.rejects(loadNote(dir), /UTF-8/);
  await writeFile(path.join(dir, 'content.txt'), '正文');
  await rm(path.join(dir, '01.png'));
  await assert.rejects(loadNote(dir), /当前为 0 张/);
  for (let i = 1; i <= 19; i++) await writeFile(path.join(dir, i + '.png'), 'image');
  await assert.rejects(loadNote(dir), /当前为 19 张/);
});

test('racing submitters only reserve once; pending and submitted both prevent repeats', async t => {
  const note = await loadNote(await makeNote(t));
  const stateDir = await tempDirectory(t);
  assert.equal(await getSubmission(stateDir, 'A', note), null);
  const outcomes = await Promise.allSettled(
    Array.from({ length: 12 }, () => reserveSubmission(stateDir, 'A', note)),
  );
  const winners = outcomes.filter(x => x.status === 'fulfilled');
  assert.equal(winners.length, 1);
  assert.equal((await getSubmission(stateDir, 'A', note)).status, 'pending');
  await assert.rejects(reconcileSubmission(stateDir, 'A', note, 'not-submitted'), /进程仍可能运行/);
  const saved = await finishSubmission(winners[0].value, 'submitted', { result: '审核中' });
  assert.equal(saved.details.result, '审核中');
  assert.equal((await getSubmission(stateDir, 'A', note)).status, 'submitted');
  await assert.rejects(reserveSubmission(stateDir, 'A', note), /重复提交/);
  await assert.rejects(reconcileSubmission(stateDir, 'A', note, 'not-submitted'), /仅可核查/);
  assert.equal(await getSubmission(stateDir, 'B', note), null);
});

test('unknown results require explicit reconciliation before retry; old receipt cannot overwrite a new attempt', async t => {
  const note = await loadNote(await makeNote(t));
  const stateDir = await tempDirectory(t);
  const reservation = await reserveSubmission(stateDir, 'A', note);
  const unknown = await finishSubmission(reservation, 'unknown');
  await assert.rejects(reserveSubmission(stateDir, 'A', note), /重复提交/);
  await assert.rejects(reconcileSubmission(stateDir, 'A', note, 'submitted', { expectedAttempt: 'outdated' }), /已变化/);
  await reconcileSubmission(stateDir, 'A', note, 'not-submitted', { expectedAttempt: unknown.attempt });
  const retry = await reserveSubmission(stateDir, 'A', note);
  await assert.rejects(finishSubmission(reservation, 'submitted'), /不匹配/);
  await finishSubmission(retry, 'unknown');
  const saved = await reconcileSubmission(stateDir, 'A', note, 'submitted', { reason: '在内容管理看到对应笔记' });
  assert.equal(saved.status, 'submitted');
  assert.equal(saved.reconciled, true);
});

test('a terminated publisher leaves a persistent block that manual reconciliation can clear', async t => {
  const note = await loadNote(await makeNote(t));
  const stateDir = await tempDirectory(t);
  const script = `import {reserveSubmission} from ${JSON.stringify(new URL('../lib/jobs.mjs', import.meta.url).href)};
    await reserveSubmission(process.argv[1], 'A', JSON.parse(process.argv[2]));`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, stateDir, JSON.stringify(note)]);
  await assert.rejects(reserveSubmission(stateDir, 'A', note), /重复提交/);
  assert.equal((await reconcileSubmission(stateDir, 'A', note, 'not-submitted')).status, 'not-submitted');
  const retry = await reserveSubmission(stateDir, 'A', note);
  assert.equal((await finishSubmission(retry, 'submitted')).status, 'submitted');
});

test('reads post.md and its declared image table; keeps tags, excludes contact sheet, respects explicit page order', async t => {
  const dir = await tempDirectory(t);
  for (const name of ['cover.jpg', '01.jpg', '02.jpg', 'contact_sheet.jpg', '选图参考.jpg', '原始素材.heic']) {
    await writeFile(path.join(dir, name), '图片' + name);
  }
  await writeFile(path.join(dir, 'post.md'),
    '# 一篇正式稿\n\n原文第一段\n\n原文第二段\n\n## 备选标题\n备选甲\n备选乙\n\n## 标签\n#标签一 #标签二\n');
  await writeFile(path.join(dir, 'manifest.md'), [
    '# 制作说明', '', '## 输出路径', '| 文件 | 用途 |', '| --- | --- |',
    '|`/old/path/cover.jpg`|封面|', '|`/old/path/02.jpg`|图一|', '|`/old/path/01.jpg`|图二|',
    '|`/old/path/contact_sheet.jpg`|接触表|', '|`/old/path/post.md`|文案|',
    '## 选图说明', '|`候补.jpg`|已排除|',
  ].join('\n'));
  const note = await loadNote(dir);
  assert.equal(note.title, '一篇正式稿');
  assert.equal(note.body, '原文第一段\n\n原文第二段\n\n#标签一 #标签二');
  assert.deepEqual(note.images.map(file => path.basename(file)), ['cover.jpg', '02.jpg', '01.jpg']);
  assert.deepEqual(new Set(note.excludedImages), new Set(['contact_sheet.jpg', '选图参考.jpg', '原始素材.heic']));
  await rm(path.join(dir, '02.jpg'));
  await assert.rejects(loadNote(dir), /02.jpg.*缺失/);
});

test('surfaces overlong source title and applies only an explicit short title; rejects conflicting copies', async t => {
  const dir = await tempDirectory(t);
  await writeFile(path.join(dir, 'post.md'), '# ' + '树'.repeat(25) + '\n\n正文。\n');
  await writeFile(path.join(dir, 'cover.jpg'), 'cover');
  await writeFile(path.join(dir, '01.jpg'), '1');
  await assert.rejects(loadNote(dir), { code: 'TITLE_TOO_LONG', sourceTitle: '树'.repeat(25), message: /25 字，超过 20/ });
  const note = await loadNote(dir, { titleOverride: '短标题' });
  assert.equal(note.sourceTitle, '树'.repeat(25));
  assert.equal(note.title, '短标题');
  assert.equal(note.textSource, 'post.md');
  const alternate = await loadNote(dir, { titleOverride: '另一标题' });
  assert.notEqual(alternate.fingerprint, note.fingerprint);
  await writeFile(path.join(dir, 'title.txt'), '另一标题');
  await assert.rejects(loadNote(dir, { titleOverride: '短标题' }), /无法确认使用哪一份文案/);
});

test('detects ambiguous Markdown headings, covers and numbered pages', async t => {
  const dir = await tempDirectory(t);
  await writeFile(path.join(dir, 'post.md'), '# 正式标题\n\n正文\n# 第二条标题\n');
  await writeFile(path.join(dir, '01.jpg'), '1');
  await assert.rejects(loadNote(dir), /多个一级标题/);
  await writeFile(path.join(dir, 'post.md'), '# 正式标题\n\n正文\n');
  await writeFile(path.join(dir, 'cover.jpg'), 'cover');
  await writeFile(path.join(dir, '封面.png'), 'cover2');
  await assert.rejects(loadNote(dir), /明确唯一封面/);
  await rm(path.join(dir, '封面.png'));
  await writeFile(path.join(dir, '1.jpg'), 'another1');
  await assert.rejects(loadNote(dir), /重复编号/);
  await rm(path.join(dir, '1.jpg'));
  await writeFile(path.join(dir, '参考图片.png'), 'reference');
  await assert.rejects(loadNote(dir), /无法确定.*是否用于发布/);
});


test('the private upload snapshot fixes the approved bytes before a browser or human can delay the upload', async t => {
  const source = await makeNote(t);
  const note = await loadNote(source);
  const bytes = await readFile(note.images[0]);
  const frozen = await freezeNote(note, note.fingerprint);
  t.after(() => rm(frozen.folder, {recursive:true, force:true}));
  await writeFile(note.images[0], '文件在打开浏览器后已替换');
  assert.notEqual(frozen.images[0], note.images[0]);
  assert.deepEqual(await readFile(frozen.images[0]), bytes);
  assert.equal((await loadNote(frozen.folder)).fingerprint, note.fingerprint);
  await assert.rejects(freezeNote(note, note.fingerprint), /内容已变/);
});
