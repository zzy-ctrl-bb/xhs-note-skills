import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { existingReceipt, submitOnce } from '../lib/receipt.mjs';
import { getSubmission } from '../lib/jobs.mjs';
let browser;
before(async()=>{ browser=await chromium.launch({channel:'chrome',headless:true}); });
after(async()=>{ await browser?.close(); });
async function fixture(t) {
  const stateDir=await mkdtemp(path.join(tmpdir(),'xhs-receipt-'));
  const page=await browser.newPage();
  t.after(async()=>{await page.close();await rm(stateDir,{recursive:true});});
  // Serve an offline fixture under the official origin so we can test the origin guard.
  await page.route('**/*', route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: '<form><textarea>发布成功</textarea><div contenteditable=true><span role=alert>发布成功</span></div></form><main><h1>发布成功</h1></main><button>发布</button><output role=status></output>',
  }));
  await page.goto('https://creator.xiaohongshu.com/publish/publish');
  const button=page.getByRole('button',{name:'发布',exact:true});
  await page.evaluate(()=>{window.clicks=0;document.querySelector('button').onclick=()=>{window.clicks++;};});
  return {page,button,stateDir,account:'测试者',note:{title:'测试',fingerprint:'a'.repeat(64)},runDir:stateDir,timeout:400};
}
test('收到平台回执后持久化，重试不会再次点发布',async t=>{
  const args=await fixture(t);
  assert.equal(await existingReceipt(args.page),'');
  await args.page.evaluate(()=>document.querySelector('button').addEventListener('click',()=>{document.querySelector('output').textContent='已提交审核';}));
  assert.equal(await submitOnce(args),'已提交审核');
  const record=await getSubmission(args.stateDir,args.account,args.note);
  assert.equal(record.status,'submitted');
  await args.page.locator('output').evaluate(el=>el.textContent='');
  await assert.rejects(submitOnce(args),/阻止重复/);
  assert.equal(await args.page.evaluate(()=>window.clicks),1);
});
test('提交后无明确回执，保留待核查记录并阻止重发',async t=>{
  const args=await fixture(t);
  await assert.rejects(submitOnce(args),/等待平台回执超时，结果待核查/);
  const record = await getSubmission(args.stateDir,args.account,args.note);
  assert.equal(record.status,'unknown');
  assert.equal(record.details.reason,'等待平台回执超时');
  await assert.rejects(submitOnce(args),/阻止重复/);
  assert.equal(await args.page.evaluate(()=>window.clicks),1);
});
test('点击前已有旧成功提示时不消耗本次提交机会',async t=>{
  const args=await fixture(t);
  await args.page.locator('output').evaluate(el=>el.textContent='发布成功');
  await assert.rejects(submitOnce(args),/点击前/);
  assert.equal(await getSubmission(args.stateDir,args.account,args.note),null);
  assert.equal(await args.page.evaluate(()=>window.clicks),0);
});

test('稿件预览、附带其他文字的提示和异站提示都不能作为平台成功回执', async t => {
  const { page } = await fixture(t);
  await page.setContent('<main><h1>发布成功</h1><article><span role="status">笔记发布成功</span></article></main><div role="dialog">发布成功<br>是你的笔记标题吗？</div>');
  assert.equal(await existingReceipt(page), '');
  await page.goto('https://untrusted.invalid/result');
  await page.setContent('<div role="status">发布成功</div>');
  assert.equal(await existingReceipt(page), '');
});
