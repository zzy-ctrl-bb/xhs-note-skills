import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { findManagedNote, matchSubmission } from '../lib/manage.mjs';

const account = '测试作者';
const title = '本次确认的完整标题';
test('官网确认要求唯一完整标题、原回执和北京发布时间，正确区分审核中、同名旧稿和跨分钟提交',()=>{
  const note={title,fingerprint:'123'};
  const receipt={...note,status:'submitted',createdAt:'2026-11-25T08:34:59Z',updatedAt:'2026-11-25T08:35:03Z'};
  const listing={statusFilter:'已发布',outcome:'found',matchCount:1,matches:[{title,times:['2026-11-25 16:34']}]};
  assert.equal(matchSubmission(listing,note,receipt),true);
  assert.equal(matchSubmission({...listing,statusFilter:'审核中'},note,receipt),true);
  const withTime=value=>({...listing,matches:[{title,times:[value]}]});
  assert.equal(matchSubmission(withTime('发布于 2026年11月25日 16:35'),note,receipt),true);
  for(const value of ['更新时间 2026-11-25 16:34','2026-11-24 16:34','2026-11-25','刚刚','2026-11-25 16:36'])assert.equal(matchSubmission(withTime(value),note,receipt),false);
  assert.equal(matchSubmission({...listing,matchCount:2},note,receipt),false);
  for(const status of ['审核中','审核未通过','可见范围：仅自己可见']){
    assert.equal(matchSubmission({...listing,matches:[{...listing.matches[0],statuses:[status]}]},note,receipt),false);
  }
  assert.equal(matchSubmission(listing,note,{...receipt,fingerprint:'different'}),false);
  assert.equal(matchSubmission({...listing,statusFilter:'全部'},note,receipt),false);
});
const publicUrl = 'https://www.xiaohongshu.com/explore/1234567890abcdef12345678';
const header = '<header><span class="user-name">测试作者</span></header>';
const card = '<article><h3>本次确认的完整标题</h3><span>审核中</span><time>发布于 2026-11-25 10:42</time><a href="' + publicUrl + '">查看笔记</a></article>';
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(t, content) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route('**/*', route => {
    const isManagement = new URL(route.request().url()).pathname === '/new/note-manager';
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: isManagement
      ? header + content
      : header + '<aside><a href="/new/note-manager">笔记管理</a></aside>' });
  });
  await page.goto('https://creator.xiaohongshu.com/publish/publish');
  return page;
}

test('同卡片的完整标题、状态、时间与真实链接', async t => {
  const page = await fixture(t, '<article><h3>其他笔记</h3><span>已公开</span></article>' + card);
  const result = await findManagedNote(page, { account, title, timeout: 3000 });
  assert.equal(result.outcome, 'found');
  assert.deepEqual(result.matches, [{ title, statuses: ['审核中'], times: ['发布于 2026-11-25 10:42'], publicUrl, noteId: '1234567890abcdef12345678' }]);
});

test('相同标题两张卡片待核查', async t => {
  const page = await fixture(t, card + card);
  const result = await findManagedNote(page, { account, title, timeout: 3000 });
  assert.equal(result.outcome, 'ambiguous');
  assert.equal(result.matchCount, 2);
});

test('标题缺少卡片边界时不借用其他笔记的状态或时间', async t => {
  const page = await fixture(t, '<h2>本次确认的完整标题</h2><article><h3>其他</h3><time>2026-11-25</time></article>');
  const result = await findManagedNote(page, { account, title, timeout: 3000 });
  assert.equal(result.outcome, 'unverified');
  assert.deepEqual(result.matches, []);
});

test('官网 BEM 标题子节点回溯到整张卡片，读取同级状态和时间', async t => {
  const first = '<div class="note-card"><div class="note-card__body"><div class="note-card__row note-card__row--header"><div class="note-card__title-group"><span class="note-card__title">本次确认的完整标题</span></div><span class="note-card__status">审核中</span></div><div class="note-card__row"><time>2026-11-25 09:32</time></div></div></div>';
  const other = '<div class="note-card"><span class="note-card__title">另篇笔记</span><span>公开可见</span><time>2026-11-22 10:00</time></div>';
  const page = await fixture(t, '<div role="tablist"><span role="tab">已公开</span></div>' + first + other);
  const result = await findManagedNote(page, { account, title, timeout: 3000 });
  assert.equal(result.outcome, 'found');
  assert.deepEqual(result.matches, [{title, statuses: ['审核中'], times: ['2026-11-25 09:32'], publicUrl: null, noteId: null}]);
});

test('管理分栏要求明确选中，区分旧列表和新出现的条目', async t => {
  const pane = '<div class="tab-list"><div class="tab-item active">审核中</div><div class="tab-item" role="tab">已发布</div></div><main id="list"></main>';
  const interaction = '<script>document.querySelector("[role=tab]").onclick=event=>{document.querySelector(".active").classList.remove("active");event.target.classList.add("active");setTimeout(()=>document.querySelector("main").innerHTML=' + JSON.stringify(card) + ',100)}</script>';
  const page = await fixture(t, pane + interaction);
  const result = await findManagedNote(page, { account, title, statusFilter: '已发布', timeout: 3000 });
  assert.equal(result.statusFilter, '已发布');
  assert.equal(result.outcome, 'found');
});

test('筛选后沿用原列表不能证明归属', async t => {
  const pane = '<div class="tab-list"><div class="tab-item" onclick="this.classList.add(\'active\')">已发布</div></div>';
  const page = await fixture(t, pane + card);
  const result = await findManagedNote(page, { account, title, statusFilter: '已发布', timeout: 550 });
  assert.equal(result.outcome, 'unverified');
});
