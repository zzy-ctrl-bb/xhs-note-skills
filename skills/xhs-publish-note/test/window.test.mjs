import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { waitForReviewWindow } from '../cli.mjs';

test('交互预览保留到关窗，无人值守流程立即返回',async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage();
    await page.setContent('<title>本地预览</title>');
    await waitForReviewWindow(page,false);
    let ended = false;
    const finished = waitForReviewWindow(page,true).then(()=>{ended=true;});
    assert.equal(await page.title(),'本地预览');
    assert.equal(ended,false);
    await page.close();
    await finished;
    assert.equal(ended,true);
    await waitForReviewWindow(page,true);
  } finally {await browser.close();}
});
