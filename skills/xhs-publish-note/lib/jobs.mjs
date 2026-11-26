import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdir, mkdtemp, open, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';

const filenames = {
  title: ['标题.txt', 'title.txt'],
  body: ['正文.txt', 'body.txt', 'content.txt'],
};
const imageDirectories = ['图片', 'images'];
const supportedImages = /\.(?:jpe?g|png|webp)$/i;
const otherImages = /\.(?:gif|heic|heif|avif|jpe|bmp|tiff?|svg|dng|psd|jfif)$/i;
const naturalOrder = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'variant' });

function oneTextFile(root, entries, field) {
  const choices = entries.filter(entry => filenames[field].includes(entry.name.toLowerCase()));
  if (choices.length !== 1 || !choices[0].isFile()) {
    throw new Error(`请在稿件目录放置一个 ${filenames[field].join(' 或 ')}，找到 ${choices.map(x => x.name).join('、') || '0 个'}。`);
  }
  return path.join(root, choices[0].name);
}

async function readText(file) {
  const bytes = await readFile(file);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${path.basename(file)} 应为 UTF-8 文本，请另存后再试。`);
  }
  if (text.includes('\0')) throw new Error(`${path.basename(file)} 含有空字符，请检查文本编码。`);
  return text.replace(/\r\n?/g, '\n');
}

function listImages(root, entries) {
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!supportedImages.test(entry.name) && !otherImages.test(entry.name)) continue;
    if (!entry.isFile()) throw new Error(`请使用普通图片文件：${entry.name}`);
    files.push(path.join(root, entry.name));
  }
  return files.sort((a, b) => {
    const aName = path.basename(a);
    const bName = path.basename(b);
    return naturalOrder.compare(aName, bName) || Buffer.from(aName).compare(Buffer.from(bName));
  });
}


const referenceImage = /^(?:contact[-_ ]?sheet|接触表|联系表|总览图|预览拼图)\./iu;
const coverImage = /^(?:cover|封面)\./iu;

function namedEntry(entries, name) {
  const matches = entries.filter(entry => entry.name.toLowerCase() === name);
  if (matches.length > 1 || (matches.length && !matches[0].isFile())) {
    throw new Error(`请保留唯一的普通文件 ${name}。`);
  }
  return matches[0]?.name;
}

function postMarkdown(text) {
  const lines = text.split('\n');
  const first = lines.findIndex(line => line.trim());
  const title = lines[first]?.match(/^#\s+(.+?)\s*$/u)?.[1];
  if (!title || /^(?:备选标题|标题备选|标题|正文|图文包说明)$/u.test(title)) {
    throw new Error('post.md 需要以唯一正式标题开头，如“# 标题文字”。');
  }
  const content = [];
  let skipDepth = 0;
  for (const line of lines.slice(first + 1)) {
    const head = line.match(/^(#{1,6})[ \t]+(.+?)\s*$/u);
    if (head && skipDepth && head[1].length <= skipDepth) skipDepth = 0;
    if (skipDepth) continue;
    if (head) {
      if (/^(?:备选标题|标题备选|候选标题|备用标题|制作说明|发布说明|选图说明)(?:[（(：:].*)?$/u.test(head[2])) {
        skipDepth = head[1].length;
        continue;
      }
      if (head[1].length === 1) throw new Error('post.md 出现多个一级标题，无法确定唯一的正式标题。');
      if (/^(?:正文|笔记正文|标签|话题|话题标签)$/u.test(head[2])) continue;
      throw new Error(`post.md 的“${head[2]}”段落用途不明确，请标明正文、话题标签或备选标题。`);
    }
    if (/^(?:备选标题|标题备选|候选标题|备用标题|制作说明|发布说明)\s*[：:]/u.test(line)) {
      throw new Error('post.md 中的备选或制作信息缺少段落边界，请用“## 备选标题”等标题单独分段。');
    }
    content.push(line);
  }
  // Markdown blank lines around the title and final paragraph are file structure.
  return { title, body: content.join('\n').replace(/^\n+|\n+$/gu, '') };
}

async function readCopy(root, entries) {
  const post = namedEntry(entries, 'post.md');
  if (post) {
    if (entries.some(entry => [...filenames.title, ...filenames.body].includes(entry.name.toLowerCase()))) {
      throw new Error('同时发现 post.md 和分开的标题或正文 TXT，无法确认使用哪一份文案。');
    }
    return { ...postMarkdown(await readText(path.join(root, post))), textSource: post };
  }
  const titleFile = oneTextFile(root, entries, 'title');
  const bodyFile = oneTextFile(root, entries, 'body');
  const [title, body] = await Promise.all([readText(titleFile), readText(bodyFile)]);
  return { title: title.replace(/\n$/, ''), body, textSource: path.basename(titleFile) + ' + ' + path.basename(bodyFile) };
}

function manifestImageNames(text) {
  const lines = text.split('\n');
  const heading = /^##[ \t]+(?:输出路径|发布图片顺序|配图顺序)\s*$/u;
  const sections = lines.flatMap((line, i) => heading.test(line) ? [i] : []);
  if (!sections.length) return null;
  if (sections.length > 1) throw new Error('manifest.md 含多个配图清单，无法确定唯一的发布顺序。');
  const names = [];
  for (const line of lines.slice(sections[0] + 1)) {
    if (/^#{1,2}\s/u.test(line)) break;
    const firstCell = line.match(/^\s*\|\s*([^|]+?)\s*\|/u)?.[1]?.replace(/^`|`$/gu, '');
    if (!firstCell) continue;
    // Historical export paths identify files by basename. Never dereference a manifest path.
    const name = firstCell.split(/[\\/]/u).at(-1);
    if ((supportedImages.test(name) || otherImages.test(name)) && !referenceImage.test(name)) names.push(name);
  }
  if (!names.length) throw new Error('manifest.md 的配图清单中未找到图片文件行。');
  return names;
}

async function selectImages(root, entries, images, isMarkdown) {
  const manifest = namedEntry(entries, 'manifest.md');
  const declared = manifest ? manifestImageNames(await readText(path.join(root, manifest))) : null;
  const usable = images.filter(file => !referenceImage.test(path.basename(file)));
  const byName = new Map(usable.map(file => [path.basename(file).toLowerCase(), file]));
  if (byName.size !== usable.length) throw new Error('存在大小写重复的图片名，请明确要发布的版本。');
  let ordered = usable;
  if (declared) {
    ordered = declared.map(name => {
      const file = byName.get(name.toLowerCase());
      if (!file) throw new Error(`图片清单中的 ${name} 在本地稿件目录中缺失。`);
      return file;
    });
    if (new Set(ordered).size !== ordered.length) throw new Error('图片清单含重复配图。');
  } else if (isMarkdown) {
    // A prepared Markdown package can also carry working files. Only a labelled cover
    // and numbered pages can be ordered safely without a declared output table.
    for (const file of usable) {
      const name = path.basename(file);
      if (!coverImage.test(name) && !/^\d+[._ -]/u.test(name)) {
        throw new Error(`无法确定 ${name} 是否用于发布，请在 manifest.md 的“## 输出路径”表格中列明成品图片。`);
      }
    }
  }
  const unsupported = ordered.find(file => !supportedImages.test(file));
  if (unsupported) throw new Error(`请先把 ${path.basename(unsupported)} 转为 JPG、PNG 或 WebP。`);
  const covers = ordered.filter(file => coverImage.test(path.basename(file)));
  if (covers.length > 1) throw new Error('存在多张标为 cover 或封面的图片，请明确唯一封面。');
  if (covers.length === 1) ordered = [covers[0], ...ordered.filter(file => file !== covers[0])];
  if (!declared && isMarkdown) {
    const numbers = ordered.flatMap(file => {
      const digits = path.basename(file).match(/^(\d+)/u)?.[1];
      return digits === undefined ? [] : [Number(digits)];
    });
    if (new Set(numbers).size !== numbers.length) throw new Error('内页图片有重复编号，请明确配图顺序。');
  }
  const selected = new Set(ordered);
  return { images: ordered, excludedImages: images.filter(file => !selected.has(file)).map(file => path.basename(file)) };
}

async function hashImage(file) {
  const digest = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    digest.update(chunk);
    size += chunk.length;
  }
  if (size === 0) throw new Error(`图片为空文件：${path.basename(file)}`);
  return digest.digest('hex');
}

export async function loadNote(folder, { titleOverride } = {}) {
  const root = path.resolve(folder);
  const entries = await readdir(root, { withFileTypes: true });
  const { title: sourceTitle, body, textSource } = await readCopy(root, entries);
  const title = titleOverride ?? sourceTitle;
  if (typeof title !== 'string' || !title.trim() || /[\n\r\u2028\u2029]/u.test(title)) throw new Error('标题必须是非空的单行文字。');
  if (!body.trim()) throw new Error('正文为空，请检查正文文件。');

  const roots = entries.filter(entry => imageDirectories.includes(entry.name.toLowerCase()));
  if (roots.length > 1 || (roots.length === 1 && !roots[0].isDirectory())) {
    throw new Error('请选择一个普通图片目录，命名为 images 或 图片。');
  }
  const loose = listImages(root, entries);
  let images = loose;
  if (roots.length) {
    const subdir = path.join(root, roots[0].name);
    const nested = listImages(subdir, await readdir(subdir, { withFileTypes: true }));
    if (loose.length && nested.length) throw new Error('根目录和图片子目录都有图片，请把本篇配图集中放在一处。');
    if (nested.length) images = nested;
  }
  const selected = await selectImages(root, entries, images, textSource.toLowerCase() === 'post.md');
  images = selected.images;
  if (!images.length || images.length > 18) {
    throw new Error(`本流程每篇接受 1 至 18 张 JPG、PNG 或 WebP，当前为 ${images.length} 张。`);
  }
  if ([...title].length > 20) {
    const error = new Error(`标题“${title}”共 ${[...title].length} 字，超过 20 字上限。请明确指定发布短标题或调整稿件。`);
    error.code = 'TITLE_TOO_LONG';
    error.sourceTitle = sourceTitle;
    throw error;
  }
  const hashes = [];
  for (const image of images) hashes.push(await hashImage(image));
  // Hash actual ordered contents. Moving a note or renaming its files keeps the key.
  const fingerprint = createHash('sha256').update(JSON.stringify([title, body, hashes])).digest('hex');
  return { folder: root, title, sourceTitle, textSource, body, images, excludedImages: selected.excludedImages, fingerprint };
}

// Take a private copy of the actual approved bytes before opening the browser.
// Numeric names preserve the original note's resolved file order, including a manifest override.
export async function freezeNote(note, approvedFingerprint) {
  const folder = await mkdtemp(path.join(tmpdir(), 'xhs-note-snapshot-'));
  try {
    await writeFile(path.join(folder, 'title.txt'), note.title, { mode: 0o600 });
    await writeFile(path.join(folder, 'content.txt'), note.body, { mode: 0o600 });
    for (const [index, image] of note.images.entries()) {
      const name = String(index + 1).padStart(2, '0') + path.extname(image).toLowerCase();
      await copyFile(image, path.join(folder, name));
    }
    const copy = await loadNote(folder);
    if (copy.fingerprint !== approvedFingerprint) throw Error('冻结素材时发现稿件内容已变，请重新验包。');
    return copy;
  } catch (error) {
    await rm(folder, {recursive:true, force:true});
    throw error;
  }
}

function recordDirectory(stateDir, accountKey, note) {
  if (typeof accountKey !== 'string' || !accountKey.trim()) throw new Error('账号标识为空。');
  if (!/^[0-9a-f]{64}$/.test(note.fingerprint)) throw new Error('无效的稿件指纹。');
  const key = createHash('sha256').update(accountKey.trim().normalize('NFC')).digest('hex');
  return path.resolve(stateDir, 'submissions', key, note.fingerprint);
}

async function readLatest(dir) {
  let files;
  try {
    files = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const name = files.filter(file => /^\d{10}\.json$/.test(file)).sort().at(-1);
  if (!name) return null;
  const record = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
  if (record.revision !== Number.parseInt(name, 10) || !record.attempt ||
      !['pending', 'unknown', 'submitted', 'not-submitted'].includes(record.status)) {
    throw new Error('提交记录无法校验，请保留现场并核查笔记管理。');
  }
  return record;
}

async function appendRevision(dir, previous, fields) {
  const revision = (previous?.revision ?? 0) + 1;
  const record = { ...fields, revision, updatedAt: new Date().toISOString() };
  const encoded = JSON.stringify(record, null, 2) + '\n';
  const dest = path.join(dir, String(revision).padStart(10, '0') + '.json');
  const temporary = path.join(dir, '.' + randomUUID() + '.tmp');
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // link is atomic and never overwrites another writer claiming the same revision.
    try {
      await link(temporary, dest);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('另一个操作已更新提交记录，请先重新查看状态。');
      throw error;
    }
    const directory = await open(dir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return record;
  } finally {
    await unlink(temporary);
  }
}

export async function getSubmission(stateDir, accountKey, note) {
  return readLatest(recordDirectory(stateDir, accountKey, note));
}

export async function reserveSubmission(stateDir, accountKey, note) {
  const dir = recordDirectory(stateDir, accountKey, note);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const previous = await readLatest(dir);
  if (previous && previous.status !== 'not-submitted') {
    throw new Error(`该账号已有此稿的提交记录（${previous.status}），已阻止重复提交。`);
  }
  const attempt = randomUUID();
  await appendRevision(dir, previous, {
    status: 'pending', attempt, pid: process.pid, host: hostname(),
    createdAt: new Date().toISOString(), fingerprint: note.fingerprint, title: note.title,
  });
  return { dir, attempt };
}

export async function finishSubmission(reservation, status, details = {}) {
  if (!['submitted', 'unknown'].includes(status)) throw new Error('回执状态必须是 submitted 或 unknown。');
  const previous = await readLatest(reservation.dir);
  if (previous?.status !== 'pending' || previous.attempt !== reservation.attempt ||
      previous.host !== hostname() || previous.pid !== process.pid) {
    throw new Error('当前任务与提交记录不匹配，已保留原记录。');
  }
  return appendRevision(reservation.dir, previous, { ...previous, status, details });
}

function mayStillBeSubmitting(record) {
  // A PID reused by the OS can delay a reconciliation; it must never permit a duplicate.
  if (record.host !== hostname() || !Number.isSafeInteger(record.pid) || record.pid <= 0) return true;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

export async function reconcileSubmission(stateDir, accountKey, note, decision, details = {}) {
  if (!['submitted', 'not-submitted'].includes(decision)) throw new Error('核查结果必须是 submitted 或 not-submitted。');
  const dir = recordDirectory(stateDir, accountKey, note);
  const previous = await readLatest(dir);
  if (!previous || !['unknown', 'pending'].includes(previous.status)) {
    throw new Error('仅可核查结果待定的提交记录。');
  }
  if (details.expectedAttempt && details.expectedAttempt !== previous.attempt) {
    throw new Error('待核查的提交已变化，请重新查看该账号的笔记管理。');
  }
  if (previous.status === 'pending' && mayStillBeSubmitting(previous)) {
    throw new Error('提交进程仍可能运行，请等待该进程结束后再核查。');
  }
  return appendRevision(dir, previous, { ...previous, status: decision, reconciled: true, details });
}
