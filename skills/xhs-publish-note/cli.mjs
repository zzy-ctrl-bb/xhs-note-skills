#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { accountDiagnostics, openAccount, openBrowser } from './lib/account.mjs';
import { editorDiagnostics, prepareEditor } from './lib/editor.mjs';
import { freezeNote, getSubmission, loadNote, reconcileSubmission } from './lib/jobs.mjs';
import { openImageEntry } from './lib/navigation.mjs';
import { keyboardSubmitAction } from './lib/keyboard-submit.mjs';
import { findManagedNote, matchSubmission } from './lib/manage.mjs';
import { submitOnce } from './lib/receipt.mjs';

process.umask(0o077);
const stateDir = path.resolve(process.env.XHS_PUBLISH_STATE_DIR || path.join(homedir(), '.local', 'state', 'xhs-publish-note'));
const help = `小红书图文发布助手
  node cli.mjs check 稿件目录 [--title 发布短标题] [--json]
  node cli.mjs login --account 本机账号键 --nickname 官网昵称
  node cli.mjs preview 稿件目录 --account 本机账号键 [--nickname 官网昵称] [--keep-open]
  node cli.mjs publish 稿件目录 --account 本机账号键 --nickname 官网昵称 --confirm-fingerprint 定稿指纹 --submit
  node cli.mjs status 稿件目录 --account 本机账号键
  node cli.mjs lookup 稿件目录 --account 本机账号键 --verify-submission
  node cli.mjs reconcile 稿件目录 --account 本机账号键 --decision submitted或not-submitted --attempt 原任务号 --reason 核查说明
check 纯本地，preview 会向创作者中心上传素材并填表。正式提交使用 check 给出的定稿指纹。
所有稿件操作支持 --title。覆盖原题后，用相同标题继续核查；--json 输出机器可读结果。
本机凭据和回执位于 ~/.local/state/xhs-publish-note，可在首次使用前通过 XHS_PUBLISH_STATE_DIR 指定固定目录。`;

const stageNames = {
  'manual-image-tab': '请在此 Chrome 窗口手动点击一次「上传图文」，看到「上传图片」后程序会继续',
  'image-tab-ready': '已进入图文面板',
  'text-verified': '已逐段核对标题和正文',
  'preview-ready': '图文预览已核验',
  'ready-to-publish': '发布控件可操作',
};

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      account: { type: 'string' },
      nickname: { type: 'string' },
      title: { type: 'string' },
      filter: { type: 'string' },
      'verify-submission': { type:'boolean' },
      submit: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'keep-open': { type: 'boolean' },
      'confirm-fingerprint': { type: 'string' },
      json: { type: 'boolean' },
      decision: { type: 'string' },
      attempt: { type: 'string' },
      reason: { type: 'string' },
    },
  });
  if (values.help || !positionals.length) return { action: 'help' };
  let [action, folder] = positionals;
  if(values['verify-submission'] && (action!=='lookup' || values.filter)) {
    throw Error('--verify-submission 仅用于 lookup，自动核查已发布和审核中分栏。');
  }
  if (values.filter !== undefined && (action !== 'lookup' || !['已发布', '审核中'].includes(values.filter))) {
    throw new Error('--filter 仅用于 lookup，接受「已发布」或「审核中」。');
  }
  if (!['login', 'check', 'preview', 'publish', 'status', 'reconcile', 'lookup'].includes(action)) {
    throw new Error('未知操作，请运行 node cli.mjs --help 查看用法。');
  }
  if (positionals.length !== (action === 'login' ? 1 : 2)) {
    throw new Error('请检查参数及稿件目录，可运行 node cli.mjs --help 查看用法。');
  }
  if (values.submit && (action !== 'publish' || values['dry-run'])) {
    throw new Error('--submit 只能单独用于 publish。');
  }
  if (values['dry-run'] && !['publish', 'preview'].includes(action)) {
    throw new Error('--dry-run 仅用于预览。');
  }
  if (values['dry-run']) action = 'preview';
  if (values['keep-open'] && !['preview','publish','lookup'].includes(action)) {
    throw new Error('--keep-open 适用于预览、发布或查看发布结果。');
  }
  if (action === 'publish' && !values.submit) {
    throw new Error('正式提交需要 --submit。若要先看效果，请用 preview。');
  }
  const account = values.account?.trim().normalize('NFC');
  if (action !== 'check' && !account) throw new Error('请通过 --account 显式指定本机账号键。');
  if (values.nickname !== undefined && !['login', 'preview', 'publish'].includes(action)) {
    throw new Error('--nickname 用于 login、preview 或 publish。');
  }
  if ((['login', 'publish'].includes(action) || values.nickname !== undefined) && !values.nickname?.trim()) {
    throw new Error('请通过 --nickname 指定本次授权的官网昵称。');
  }
  if (action === 'publish' && !/^[0-9a-f]{64}$/u.test(values['confirm-fingerprint'] || '')) {
    throw new Error('正式提交必须使用 --confirm-fingerprint 和已获授权的定稿指纹。');
  }
  if (values['confirm-fingerprint'] !== undefined && action !== 'publish') {
    throw new Error('--confirm-fingerprint 仅用于正式发布。');
  }
  if (action === 'login' && values.title !== undefined) throw new Error('--title 仅用于稿件操作。');
  if (action === 'reconcile' && (!['submitted', 'not-submitted'].includes(values.decision) || !values.attempt || !values.reason?.trim())) {
    throw new Error('核查记录需要有效的 --decision、status 显示的 --attempt 及 --reason。');
  }
  return { action, folder, account, options: values };
}

function safeError(error) {
  return String(error?.message || error).split('\n')[0]
    .replace(/https?:\/\/[^\s)]+/gu, '[网页地址]')
    .slice(0, 440);
}

export async function waitForReviewWindow(page, keepOpen, print = console.log) {
  if (!keepOpen || !page || page.isClosed()) return;
  print('页面已保留供核对，关掉这个窗口即可结束本次任务。');
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
}

function observePage(page, report) {
  function network(request, result) {
    if (report.network.length >= 60) return;
    const url = new URL(request.url());
    if (url?.protocol === 'https:' || url?.protocol === 'http:') {
      report.network.push({ host: url.hostname, type: request.resourceType(), ...result });
    }
  }
  page.on('requestfailed', request => {
    const error = request.failure()?.errorText?.match(/net::ERR_[A-Z_0-9]+/u)?.[0] || '请求失败';
    network(request, { error });
  });
  page.on('response', response => {
    if (response.status() >= 400) network(response.request(), { status: response.status() });
  });
  page.on('domcontentloaded', () => {
    // Redirect URLs and paths can contain one-time login codes; record a coarse route only.
    const url = new URL(page.url());
    let screen = 'external';
    if (url?.origin === 'https://creator.xiaohongshu.com') {
      if (/^\/publish\/publish\/?$/u.test(url.pathname)) screen = 'publish';
      else if (/\/login(?:\/|$)/u.test(url.pathname)) screen = 'login';
      else screen = 'creator';
    }
    report.events.push({ time: new Date().toISOString(), event: 'document-loaded', screen });
  });
}

// Capture the site's own note preview, which can render after the editable fields.
function findRenderedPreview({ title, excerpt }) {
  const tabs = [...document.querySelectorAll('button,span,div,[role="tab"]')].filter(el =>
    !el.childElementCount && el.textContent.trim() === '笔记预览' && el.getClientRects().length);
  for (const tab of tabs) {
    for (let panel = tab.parentElement; panel && panel !== document.body; panel = panel.parentElement) {
      if (panel.querySelector('textarea,input:not([type="hidden"]),[contenteditable="true"]')) break;
      const text = panel.innerText || '';
      if (text.includes(title) && text.includes(excerpt)) return panel;
    }
  }
  return null;
}

async function run({ action, folder, account, options }) {
  if (action === 'help') return console.log(help);
  const print = options.json ? console.error : console.log;
  const noteOptions = { titleOverride: options.title };
  const note = folder ? await loadNote(folder, noteOptions) : undefined;
  if (note) {
    const names = note.images.map(file => path.basename(file));
    const result = { status: 'checked', title: note.title, body: note.body, images: names, fingerprint: note.fingerprint };
    print(`标题：${note.title}\n图片顺序：${names.join(' → ')}`);
    if (action === 'check') {
      print(`素材检查通过，正文 ${[...note.body].length} 字符，定稿指纹 ${note.fingerprint}`);
      return result;
    }
    if (action === 'publish' && options['confirm-fingerprint'] !== note.fingerprint) {
      throw new Error('定稿指纹与本次授权不一致，请重新核对修改后的稿件。');
    }
  }
  print('指定账号：' + account);
  if (action === 'status') {
    const record = await getSubmission(stateDir, account, note);
    print(record ? JSON.stringify(record, null, 2) : '本机暂无此账号、此稿件的提交记录。');
    return { status: record?.status || 'no_record', account, fingerprint: note.fingerprint, record: record ?? null };
  }
  if (action === 'reconcile') {
    const record = await reconcileSubmission(stateDir, account, note, options.decision, {
      expectedAttempt: options.attempt,
      reason: options.reason,
    });
    print('人工核查已记录：' + record.status);
    return { status: record.status, account, fingerprint:note.fingerprint, record };
  }
  if (action === 'publish') {
    const prior = await getSubmission(stateDir, account, note);
    if (prior && prior.status !== 'not-submitted') {
      throw new Error(`已有提交记录：${prior.status}。请用 status 查看，已阻止重发。`);
    }
  }
  let lookupReceipt;
  if(options['verify-submission']) {
    lookupReceipt=await getSubmission(stateDir,account,note);
    if(!lookupReceipt || !['submitted','pending','unknown'].includes(lookupReceipt.status) ||
       lookupReceipt.fingerprint!==note.fingerprint || lookupReceipt.title!==note.title || !Number.isFinite(Date.parse(lookupReceipt.createdAt))) {
      throw Error('此账号与定稿没有对应的提交尝试回执，请核对原账号、成稿目录和历史记录。');
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const runDir = path.join(stateDir, 'runs', `${timestamp}-${randomUUID().slice(0, 8)}`);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const report = {
    action, account, fingerprint: note?.fingerprint, stage: '启动浏览器', events: [], screenshots: [], network: [],
  };
  if (note) {
    report.imageEntry = { requested: 'official-image-url', menuAttempted: false, menuClicked: false, manualPrompted: false };
    report.note = { title: note.title, bodyCharacters: [...note.body].length,
      images: note.images.map(file => path.basename(file)), explicitTitle: options.title !== undefined };
  }
  function event(stage) {
    report.stage = stage;
    report.events.push({ time: new Date().toISOString(), stage });
    print(stage);
  }
  async function screenshot(page, name) {
    try {
      const { screen } = await accountDiagnostics(page);
      if (screen !== 'publish' && screen !== 'creator') return;
      const filename = name + '.png';
      await page.screenshot({ path: path.join(runDir, filename), timeout: 5000 });
      report.screenshots.push(filename);
    } catch (error) {
      report.events.push({ event: '截图未保存', reason: safeError(error) });
    }
  }
  async function diagnostics(page) {
    report.accountUI = await accountDiagnostics(page);
    const { screen, nicknameCount, idCount } = report.accountUI;
    if (screen === 'publish' && (nicknameCount || idCount)) {
      report.editorUI = await editorDiagnostics(page).catch(() => ({ error: '无法读取控件' }));
      await screenshot(page, '现场');
    }
  }

  let browser, context, page, displayName, verifyIdentity;
  let frozen;
  try {
    if (action === 'publish') frozen = await freezeNote(note, options['confirm-fingerprint']);
    browser = await openBrowser();
    const interactiveLogin = action === 'login';
    event(interactiveLogin ? '请在 Chrome 中登录指定账号，最多等待 5 分钟' : '打开创作者中心并核对账号');
    ({ context, page, displayName, verifyIdentity } = await openAccount(browser, {
      stateDir, account,
      login: action === 'login',
      requiredNickname: options.nickname,
      imageEntry: action === 'preview' || action === 'publish',
      timeout: interactiveLogin ? 300000 : 120000,
      onPage: page => observePage(page, report),
      onErrorPage: diagnostics,
    }));
    report.displayName = displayName;
    event('已经核对账号 ' + displayName);
    if (action === 'login') {
      event('登录态已保存');
      return { status: 'logged_in', account, displayName };
    }
    if (action === 'lookup') {
      if(lookupReceipt) {
        const verification={status:'平台状态待核',title:note.title,fingerprint:note.fingerprint,submittedAt:lookupReceipt.createdAt,
          account,displayName,managementEvidence:path.join(runDir,'记录.json'),observations:[]};
        for(const statusFilter of ['已发布','审核中']) {
          let listing;
          try {
            listing=await findManagedNote(page,{account:displayName,title:note.title,statusFilter,timeout:60000});
          } catch(error) {
            verification.observations.push({statusFilter,matched:false,error:safeError(error)});
            if(page.isClosed()) break;
            continue;
          }
          const matched=matchSubmission(listing,note,lookupReceipt);
          verification.observations.push({statusFilter,outcome:listing.outcome,matchCount:listing.matchCount,matched,
            cards:listing.matches.map(({statuses,times})=>({statuses,times}))});
          await screenshot(page,'笔记管理-'+statusFilter);
          if(matched) {
            const hit=listing.matches[0];
            Object.assign(verification,{status:statusFilter,times:hit.times,publishedNoteId:hit.noteId,
              publicUrl:hit.publicUrl ? new URL(hit.publicUrl).origin+new URL(hit.publicUrl).pathname : null});
            break;
          }
        }
        report.verification=verification;
        print(JSON.stringify(verification,null,2));
        event('官网本篇核查结果：'+verification.status);
        return verification;
      }
      report.management = await findManagedNote(page, {account: displayName, title: note.title, statusFilter: options.filter, timeout: 60000});
      print(JSON.stringify(report.management, null, 2));
      await screenshot(page, '笔记管理');
      event('已读取该账号笔记管理的可见列表');
      return report.management;
    }
    event('从官网图文发布入口定位上传面板');
    let button = await prepareEditor(page, frozen ?? note, {
      requirePublishButton: false,
      // The first thumbnail can take over two minutes on the live creator site.
      // The editor advances as soon as the expected thumbnail count is ready.
      timeout: 210000,
      manualTabTimeout: 300000,
      openImageEntry: async () => {
        report.imageEntry.menuAttempted = true;
        event('通过创作者中心「发布笔记」菜单进入图文面板');
        report.imageEntry.menuClicked = await openImageEntry(page);
        return report.imageEntry.menuClicked;
      },
      onStage: async stage => {
        if (stage === 'manual-image-tab') report.imageEntry.manualPrompted = true;
        event(stageNames[stage] || stage.replace(/^image-(\d+)-ready$/u, '已核对图片 $1'));
        if (stage === 'image-tab-ready') {
          const current = new URL(page.url());
          report.imageEntry.imageTargetAtPanelReady = current.origin === 'https://creator.xiaohongshu.com'
            && current.pathname === '/publish/publish' && current.searchParams.get('target') === 'image';
          await screenshot(page, '图文面板');
        }
      },
    });
    await verifyIdentity();
    if (action === 'publish' && !button) {
      button = await keyboardSubmitAction(page);
      if (button) event('已确认浏览器无障碍界面中的唯一「发布」按钮');
    }
    if (action === 'preview') {
      const excerpt = [...note.body.trim().split('\n')[0]].slice(0, 8).join('');
      let preview;
      try {
        preview = await page.waitForFunction(findRenderedPreview, { title: note.title, excerpt }, { timeout: 12000 });
        await preview.asElement().screenshot({ path: path.join(runDir, '手机预览.png'), timeout: 5000 });
        report.screenshots.push('手机预览.png');
        event('创作者中心的手机预览已显示本篇标题及正文开头');
      } catch (error) {
        report.events.push({ event: '手机预览未单独取图，保留整页截图', reason: safeError(error) });
      } finally {
        await preview?.dispose();
      }
    }
    await screenshot(page, '发布前预览');
    if (action === 'preview') {
      event('预览完成，已停在发布前');
      return {status: 'previewed', account, displayName, fingerprint: note.fingerprint, runDir};
    }
    if ((await loadNote(folder, noteOptions)).fingerprint !== note.fingerprint) {
      throw new Error('素材在填表期间发生变化，请重新运行。');
    }
    await verifyIdentity();
    const receipt = await submitOnce({
      page, button, stateDir, account, note, runDir,
      onAttempt: async () => {
        await verifyIdentity();
        event('已记录本次提交，即将激活官网发布按钮');
      },
    });
    event('平台已返回提交回执：' + receipt);
    await screenshot(page, '平台回执');
    return {status: 'submitted', account, displayName, fingerprint: note.fingerprint, runDir};
  } catch (error) {
    report.error = safeError(error);
    if (page && !page.isClosed()) await diagnostics(page).catch(() => {});
    throw error;
  } finally {
    try {
      await writeFile(path.join(runDir, '记录.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
      print('运行记录：' + runDir);
    } catch (error) {
      console.error('运行记录写入失败：' + safeError(error));
      process.exitCode = 1;
    }
    try {
      await waitForReviewWindow(page, options['keep-open'] && browser?.isConnected(), print);
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      if (frozen) await rm(frozen.folder, {recursive:true, force:true}).catch(() => print('临时稿件副本清理失败，请检查本机临时目录。'));
    }
  }
}

export async function runPublisher(args) {
  return run(parse(args));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const result = await runPublisher(argv);
    if (argv.includes('--json') && result !== undefined) console.log(JSON.stringify(result));
  } catch (error) {
    if (process.argv.slice(2).includes('--json')) console.log(JSON.stringify({ status: 'error', reason: safeError(error) }));
    else console.error('停止：' + safeError(error));
    process.exitCode = 1;
  }
}
