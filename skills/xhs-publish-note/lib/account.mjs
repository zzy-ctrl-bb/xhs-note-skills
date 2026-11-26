import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish?source=official';
export const IMAGE_PUBLISH_URL = PUBLISH_URL + '&from=menu&target=image';
const creatorOrigin = new URL(PUBLISH_URL).origin;

function expectedAccount(value) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/u.test(value)) {
    throw new Error('请填写小红书创作者中心显示的完整昵称或小红书号。');
  }
  return value.trim().normalize('NFC');
}

function accountHash(account) {
  return createHash('sha256').update(account).digest('hex');
}

function loginRequired(message) {
  return Object.assign(new Error(message), {code:'XHS_LOGIN_REQUIRED'});
}

export async function loginStatus(stateDir, account, nickname, launch = openBrowser) {
  const key = expectedAccount(account);
  const expected = expectedAccount(nickname);
  const mapped = await confirmedNickname(stateDir, key);
  if (mapped && mapped !== expected) {
    return {status:'account_mismatch', reason:'本机昵称映射与本篇授权的目标昵称不一致，请核实目标账号。'};
  }
  const file = join(stateDir, 'accounts', accountHash(key) + '.json');
  const stat = await lstat(file).catch(err => { if (err.code !== 'ENOENT') throw err; });
  if ((!mapped && expected !== key) || !stat?.isFile() || (stat.mode & 0o077) !== 0) {
    return {status:'needs_login', reason:'此设备需要由账号持有人在小红书创作者中心扫码核实目标账号。'};
  }
  const browser = await launch({headless:true});
  try {
    const session = await openAccount(browser, {stateDir, account:key, requiredNickname:expected, timeout:30000});
    await session.context.close();
    return {status:'ready', displayName:session.displayName};
  } catch (error) {
    if (error.code === 'XHS_LOGIN_REQUIRED') return {status:'needs_login', reason:error.message};
    throw error;
  } finally { await browser.close(); }
}

async function confirmedNickname(stateDir, account) {
  const file = join(stateDir, 'account-nicknames', accountHash(account) + '.txt');
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > 1024) throw new Error('昵称映射必须是单行文本文件。');
    const nickname = (await handle.readFile('utf8')).replace(/\r?\n$/u, '');
    if (!nickname.trim() || /[\r\n\0\u2028\u2029\uFFFD]/u.test(nickname)) {
      throw new Error('昵称映射必须只包含一个完整的当前昵称。');
    }
    return expectedAccount(nickname);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readSession(file, { imported = false } = {}) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || (!imported && (stat.mode & 0o077) !== 0)) {
      throw loginRequired('账号会话文件类型、大小或权限异常，请重新运行 login 完成扫码。');
    }
    const state = JSON.parse(await handle.readFile('utf8'));
    if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
      throw loginRequired('账号会话文件格式异常，请重新运行 login 完成扫码。');
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw loginRequired(imported ? '指定的迁移会话文件不存在。' : '此账号尚无本工具的登录记录，请先运行 login 并扫码。');
    }
    if (error instanceof SyntaxError) throw loginRequired('账号会话文件无法解析，请重新运行 login 完成扫码。');
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function lastVerifiedAccount(stateDir) {
  let text;
  try {
    text = await readFile(join(stateDir, 'last-account.txt'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('尚无上次核对成功的账号，请使用 --account 指定完整昵称。');
    throw error;
  }
  return expectedAccount(text.replace(/\r?\n$/u, ''));
}

async function hasPrivateAccountMarker(file, expected) {
  let handle;
  try {
    const directory = await lstat(dirname(file));
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) return false;
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid()) || stat.size !== Buffer.byteLength(expected)) return false;
    return (await handle.readFile('utf8')) === expected;
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'EACCES'].includes(error.code)) return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writePrivateFile(file, text) {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await lstat(dir)).isDirectory()) throw new Error('账号会话目录异常。');
  await chmod(dir, 0o700);
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

// Runs in the page. Inspect only the signed-in creator's navigation chrome.
// Never use text from the editor (including the note's own title or body).
function inspectChrome({ origin, expected, nicknameOnly }) {
  if (location.origin !== origin) return { screen: 'external' };
  const publish = /^\/publish\/publish\/?$/u.test(location.pathname);
  if (/(?:^|\/)(?:login|signin)(?:\/|$)/iu.test(location.pathname)) return { screen: 'login' };
  const visible = element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    && element.getClientRects().length > 0 && !element.closest('[hidden], [aria-hidden="true"]');
  const dialogs = document.querySelectorAll('[role=dialog], dialog, .login-container, .login-modal, .login-box, .captcha-container');
  const loginPrompt = [...dialogs].some(el => visible(el) && /扫码登录|验证码登录|手机号登录|扫描二维码|安全验证|请完成验证/u.test(el.innerText));
  if (loginPrompt) return { screen: 'login-or-verification' };

  const navigation = [
    'header', '[role=banner]', 'aside', '[role=navigation]', '.creator-header', '.creator-side-bar',
    '.creator-sidebar', '.header-container', '.header-wrapper', '.d-header', '.d-topbar', '.top-bar', '.side-bar',
  ].join(',');
  const identities = [
    '.user-name', '.username', '.userName', '.nickname', '.nick-name', '.account-name',
    '.creator-name', '.user-nickname', '[data-testid="account-name"]', '[data-testid="user-name"]',
  ].join(',');
  const userRegions = '.user-info, .userInfo, .user, .account-info, .account, .creator-user, .d-header-user, [data-testid="account-menu"]';
  const names = new Set();
  const ids = new Set();
  let regions = 0;

  function record(el, isID = false) {
    if (!visible(el) || el.closest('main, [role=main], article, form, [role=menu], [role=listbox], [contenteditable], .account-list')) return;
    const value = el.innerText?.trim().normalize('NFC');
    if (!value || value.length > 100 || /[\r\n]/u.test(value)) return;
    const label = value.match(/^小红书(?:号|ID)\s*[：:]\s*(\S+)$/iu);
    if (label) ids.add(label[1]);
    else if (isID) ids.add(value);
    else names.add(value);
  }
  for (const nav of document.querySelectorAll(navigation)) {
    if (!visible(nav)) continue;
    regions++;
    nav.querySelectorAll(identities).forEach(el => record(el));
    nav.querySelectorAll('.user-id, .account-id, .red-id, [data-testid="account-id"]').forEach(el => record(el, true));
    for (const user of nav.querySelectorAll(userRegions)) {
      const named = user.querySelectorAll('.name, .name-box, .info-name');
      named.forEach(el => record(el));
      // A few layouts render the nickname as the only text beside the avatar.
      if (!named.length && !user.querySelector(identities) && user.querySelector('img, .avatar')
          && !user.querySelector('button, [role=menu], [role=listbox], a[href]')) record(user);
    }
  }
  const matched = names.has(expected) || (!nicknameOnly && ids.has(expected));
  return {
    screen: publish ? 'publish' : 'creator',
    navigationRegions: regions,
    nicknameCount: names.size,
    idCount: ids.size,
    matched: matched && names.size <= 1 && ids.size <= 1,
  };
}

async function snapshot(page, expected = null, nicknameOnly = false) {
  return page.evaluate(inspectChrome, { origin: creatorOrigin, expected, nicknameOnly });
}

export async function accountDiagnostics(page) {
  try {
    const { matched, ...safe } = await snapshot(page);
    return safe;
  } catch {
    return { screen: 'unavailable' };
  }
}

async function waitForIdentity(page, account, { timeout, login, nicknameOnly = false }) {
  const deadline = Date.now() + timeout;
  let last = {};
  let returnedToPublish = false;
  do {
    try {
      last = await snapshot(page, account, nicknameOnly);
    } catch (error) {
      if (page.isClosed() || !/context was destroyed|because of a navigation|Cannot find context/iu.test(error.message)) throw error;
      last = { screen: 'navigation' };
    }
    if (last.screen === 'publish' && last.matched) return;
    if (last.screen === 'creator' && last.matched && login && !returnedToPublish) {
      returnedToPublish = true;
      await page.goto(PUBLISH_URL, { waitUntil: 'commit', timeout: Math.max(1, deadline - Date.now()) });
      continue;
    }
    if ((last.screen === 'publish' || last.screen === 'creator') && (last.nicknameCount || last.idCount) && !last.matched) {
      throw loginRequired('创作者中心显示的账号与目标不符，或同时出现多个身份。请核对完整昵称或小红书号。');
    }
    if (!login && (last.screen === 'login' || last.screen === 'login-or-verification')) {
      throw loginRequired('账号已跳转到登录或验证界面，请运行 login 在浏览器内完成验证。');
    }
    if (Date.now() < deadline) await delay(Math.min(250, deadline - Date.now()));
  } while (Date.now() < deadline);
  throw new Error(`未能在发布页确认目标账号。页面状态=${last.screen ?? 'unknown'}，可识别昵称数=${last.nicknameCount ?? 0}，账号标识数=${last.idCount ?? 0}。请核对扫码结果及页面账号区域。`);
}

export async function verifyAccount(page, account, { timeout = 15000 } = {}) {
  await waitForIdentity(page, expectedAccount(account), { timeout, login: false });
}

export async function openBrowser({ headless = false } = {}) {
  const { chromium } = await import('playwright-core');
  return chromium.launch({ channel: 'chrome', headless });
}

export async function openAccount(browser, { stateDir, account, login = false, imageEntry = false, timeout = 90000, sessionFile, onPage, onErrorPage, requiredNickname }) {
  const key = expectedAccount(account);
  const file = join(stateDir, 'accounts', accountHash(key) + '.json');
  if (sessionFile && !login) throw new Error('仅 login 支持一次性迁移显式指定的会话文件。');
  const savedNickname = await confirmedNickname(stateDir, key);
  const requested = requiredNickname === undefined ? null : expectedAccount(requiredNickname);
  if (savedNickname && requested && savedNickname !== requested) throw Error('已登记的账号昵称与本次目标不一致。');
  if (!login && requested && requested !== key && !savedNickname) throw loginRequired('请先在本机登录并核实账号昵称。');
  const nickname = requested ?? savedNickname;
  const displayName = nickname ?? key;
  let storageState;
  if (sessionFile) storageState = await readSession(sessionFile, { imported: true });
  else if (!login) storageState = await readSession(file);
  const context = await browser.newContext({ storageState, locale: 'zh-CN' });
  let page;
  try {
    page = await context.newPage();
    await onPage?.(page);
    await page.goto(imageEntry && !login ? IMAGE_PUBLISH_URL : PUBLISH_URL, { waitUntil: 'commit', timeout });
    const check = (options = {}) => waitForIdentity(page, displayName, {
      timeout: options.timeout ?? 15000, login: options.login ?? false, nicknameOnly: nickname !== null,
    });
    await check({ timeout, login });
    if (login) {
      if (!savedNickname && requested) {
        const parent = join(stateDir, 'account-nicknames');
        await mkdir(parent, {recursive:true, mode:0o700});
        if (!(await lstat(parent)).isDirectory()) throw Error('昵称映射目录异常。');
        const name = join(parent, accountHash(key) + '.txt');
        try {
          const handle = await open(name, 'wx', 0o600);
          try { await handle.writeFile(requested + '\n'); await handle.sync(); }
          finally { await handle.close(); }
        } catch (error) {
          if (error.code !== 'EEXIST' || await confirmedNickname(stateDir, key) !== requested) throw error;
        }
      }
      await writePrivateFile(file, JSON.stringify(await context.storageState({ indexedDB: true })));
    }
    const marker = join(stateDir, 'last-account.txt');
    const markerText = key + '\n';
    if (login || !await hasPrivateAccountMarker(marker, markerText)) {
      await writePrivateFile(marker, markerText);
    }
    return { context, page, displayName, verifyIdentity: () => check() };
  } catch (error) {
    if (onErrorPage && page && !page.isClosed()) {
      const diagnostic = await accountDiagnostics(page);
      if (diagnostic.screen === 'publish' && (diagnostic.nicknameCount || diagnostic.idCount)) {
        await Promise.resolve().then(() => onErrorPage(page)).catch(() => {});
      }
    }
    await context.close().catch(() => {});
    throw error;
  }
}
