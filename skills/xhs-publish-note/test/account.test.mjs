import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, mkdtemp, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { accountDiagnostics, IMAGE_PUBLISH_URL, lastVerifiedAccount, loginStatus, openAccount, openBrowser, PUBLISH_URL, verifyAccount } from '../lib/account.mjs';

test('新机从无会话开始，仅在官网身份正确时登记昵称、保存登录；过期时返回扫码动作',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'xhs-review-login-'));
  const account='稳定测试账号', nickname='目标作者';
  let screen='publish',who='其他作者',launches=0;
  const page={goto:async()=>{},evaluate:async(_fn,args)=>({screen,nicknameCount:screen==='publish'?1:0,idCount:0,matched:args.expected===who})};
  const context={newPage:async()=>page,storageState:async()=>({cookies:[],origins:[]}),close:async()=>{}};
  const browser={newContext:async()=>context,close:async()=>{}};
  const launch=async()=>{launches++;return browser;};
  try {
    assert.equal((await loginStatus(dir,account,nickname,launch)).status,'needs_login');
    assert.equal(launches,0);
    const opts={stateDir:dir,account,requiredNickname:nickname,login:true};
    await assert.rejects(openAccount(browser,opts),/账号与目标不符/);
    assert.deepEqual(await readdir(dir),[]);
    who=nickname;
    await openAccount(browser,opts);
    assert.deepEqual(await loginStatus(dir,account,nickname,launch),{status:'ready',displayName:nickname});
    assert.equal((await loginStatus(dir,account,'不同的昵称',launch)).status,'account_mismatch');
    assert.equal(launches,1);
    await assert.rejects(openAccount(browser,{...opts,requiredNickname:'不同的昵称'}),/已登记的账号昵称/);
    screen='login-or-verification';
    assert.equal((await loginStatus(dir,account,nickname,launch)).status,'needs_login');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('复用安全的同账号标记，每次仍检查顶栏；切号、修复权限和重新登录继续写标记', async () => {
  const dir = await mkdtemp(join(tmpdir(),'xhs-marker-'));
  const account = '本地测试作者';
  const marker = join(dir,'last-account.txt');
  const session = { cookies:[], origins:[] };
  let identity = account, checked = 0;
  const page = {
    goto: async () => {},
    evaluate: async (_fn,args) => {
      checked++;
      return {screen:'publish', nicknameCount:1, idCount:0, matched:args.expected === identity};
    },
  };
  const context = {newPage:async () => page, storageState:async () => session, close:async () => {}};
  const browser = {newContext:async () => context};
  const options = {stateDir:dir, account};
  try {
    await openAccount(browser,{...options,login:true});
    const original = await stat(marker);
    await openAccount(browser,options);
    assert.equal((await stat(marker)).ino,original.ino);
    identity = '其他测试作者';
    await assert.rejects(openAccount(browser,options),/与目标不符/);
    assert.equal((await stat(marker)).ino,original.ino);
    identity = account;
    await writeFile(marker,'另一个本地账号\n');
    await openAccount(browser,options);
    const switched = await stat(marker);
    assert.notEqual(switched.ino,original.ino);
    assert.equal(await lastVerifiedAccount(dir),account);
    await chmod(marker,0o644);
    await openAccount(browser,options);
    const repaired = await stat(marker);
    assert.notEqual(repaired.ino,switched.ino);
    assert.equal(repaired.mode & 0o777,0o600);
    await openAccount(browser,{...options,login:true});
    assert.notEqual((await stat(marker)).ino,repaired.ino);
    assert.equal(checked,6);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});

test('缺少账号会话或迁移参数误用时不打开浏览器', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xhs-empty-account-'));
  try {
    await assert.rejects(lastVerifiedAccount(dir), /尚无上次核对成功/);
    await assert.rejects(openAccount(null, { account: '测试作者', stateDir: dir }), /先运行 login/);
    await assert.rejects(openAccount(null, { account: '测试作者', stateDir: dir, sessionFile: 'external' }), /仅 login/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('离线模拟官网顶栏，校验身份、保存及重载', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xhs-fixture-account-'));
  const browser = await openBrowser({ headless: true });
  try {
    const account = '测试作者';
    // Observed in the creator page top bar; no real account name or session is used here.
    const header = '<div class="d-topbar"><div class="d-topbar-default"><div class="cursor-pointer flex-center user-info"><img alt="头像"><span class="name-box">测试作者</span></div></div></div>';
    const fixture = html => page => page.route('**/*', route => route.fulfill({
      contentType: 'text/html; charset=utf-8', body: html,
    }));
    const options = { stateDir: dir, account, timeout: 10000 };
    const imported = join(dir, 'explicit.json');
    await writeFile(imported, JSON.stringify({ cookies: [], origins: [] }));
    await assert.rejects(openAccount(browser, {
      ...options, login: true, sessionFile: imported, onPage: fixture('<header><span class="user-name">另一个账号</span></header>'),
    }), /与目标不符/);
    assert.deepEqual(await readdir(dir), ['explicit.json']);

    const saved = await openAccount(browser, {
      ...options, login: true, imageEntry: true, sessionFile: imported, onPage: fixture(header),
    });
    assert.equal(saved.page.url(), PUBLISH_URL);
    await saved.context.close();
    assert.equal(await lastVerifiedAccount(dir), account);
    const filenames = await readdir(join(dir, 'accounts'));
    assert.equal(filenames.length, 1);
    assert.equal((await stat(join(dir, 'accounts', filenames[0]))).mode & 0o777, 0o600);
    const { context, page } = await openAccount(browser, { ...options, imageEntry: true, onPage: fixture(header) });
    try {
      assert.equal(page.url(), IMAGE_PUBLISH_URL);
      assert.deepEqual(await accountDiagnostics(page), {
        screen: 'publish', navigationRegions: 1, nicknameCount: 1, idCount: 0,
      });
      await page.setContent('<header><span class="user-name">另一位</span></header><main><h1>测试作者</h1></main>');
      await assert.rejects(verifyAccount(page, account, { timeout: 50 }), /与目标不符/);
      await page.setContent('<main><header><span class="user-name">测试作者</span></header></main>');
      await assert.rejects(verifyAccount(page, account, { timeout: 30 }), /未能/);
      await page.setContent('<header><span class="user-name">测试作者</span><span class="user-name">另一位</span></header>');
      await assert.rejects(verifyAccount(page, account, { timeout: 30 }), /多个身份/);
      await page.setContent(header + '<div role="dialog">安全验证</div>');
      await assert.rejects(verifyAccount(page, account, { timeout: 30 }), /验证界面/);
      await page.setContent('<aside><span class="account-id">小红书号：test_42</span></aside>');
      await verifyAccount(page, 'test_42');
      await page.goto('https://untrusted.invalid/publish/publish');
      await assert.rejects(verifyAccount(page, account, { timeout: 30 }), /external/);
    } finally {
      await context.close();
    }

    // An operator-confirmed rename must keep the same session and ledger account key.
    const nicknameDir = join(dir, 'account-nicknames');
    const hash = createHash('sha256').update(account).digest('hex');
    const nickFile = join(nicknameDir, hash + '.txt');
    await mkdir(nicknameDir);
    await writeFile(nickFile, '新名字\n另一个名字\n');
    await assert.rejects(openAccount(browser, { ...options, onPage: fixture(header) }), /一个完整的当前昵称/);
    await writeFile(nickFile, '新名字\n');
    await assert.rejects(openAccount(browser, { ...options, onPage: fixture(header) }), /与目标不符/);
    const renamedHeader = header.replace('测试作者', '新名字');
    const renamed = await openAccount(browser, { ...options, onPage: fixture(renamedHeader) });
    try {
      assert.equal(renamed.displayName, '新名字');
      assert.equal(await lastVerifiedAccount(dir), account);
      assert.deepEqual(await readdir(join(dir, 'accounts')), [hash + '.json']);
      await renamed.verifyIdentity();
      await renamed.page.setContent(header.replace('</span>', '</span><span class="name-box">新名字</span>'));
      await assert.rejects(renamed.verifyIdentity(), /多个身份/);
      await renamed.page.setContent('<header><span class="user-name">别的账号</span><span class="account-id">新名字</span></header><main>新名字</main>');
      await assert.rejects(renamed.verifyIdentity(), /与目标不符/);
      await renamed.page.setContent(renamedHeader);
      await renamed.verifyIdentity();
    } finally {
      await renamed.context.close();
    }
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test('an explicitly confirmed nickname requires a nickname match even when equal to the local account key', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xhs-nickname-only-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const page = {
    goto: async () => {},
    evaluate: async (_fn, args) => ({screen:'publish',nicknameCount:1,idCount:1,matched:!args.nicknameOnly}),
  };
  const browser = {newContext: async () => ({newPage:async () => page,close:async () => {}})};
  await assert.rejects(openAccount(browser, {stateDir:dir,account:'demo',requiredNickname:'demo',login:true}), /与目标不符/);
});
