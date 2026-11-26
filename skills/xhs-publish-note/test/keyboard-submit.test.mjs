import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { keyboardSubmitAction } from '../lib/keyboard-submit.mjs';

const editorURL = 'https://creator.xiaohongshu.com/publish/publish';
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

async function offlineEditor(t, buttons) {
  const context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
  t.after(() => context.close());
  await context.route('**/*', route => {
    if (route.request().isNavigationRequest() && route.request().url() === editorURL) {
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html lang="zh"><button id="sidebar">发布笔记</button><x-fixture-actions></x-fixture-actions></html>',
      });
    }
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(editorURL);
  await page.evaluate(specs => {
    window.keyEvents = [];
    window.activations = [];
    function observe(button) {
      button.addEventListener('keydown', event => {
        if (event.key === 'Enter') window.keyEvents.push({
          id: button.id, focused: button.getRootNode().activeElement === button, trusted: event.isTrusted,
        });
      });
      button.addEventListener('click', () => window.activations.push(button.id));
    }
    observe(document.querySelector('#sidebar'));
    // These are native accessible buttons in a fixture-owned compound control.
    // Only the fixture records their events; the production action uses Tab/Enter.
    const root = document.querySelector('x-fixture-actions').attachShadow({ mode: 'closed' });
    for (const { id, name, disabled, ariaDisabled } of specs) {
      const button = document.createElement('button');
      button.id = id;
      button.textContent = name;
      button.disabled = Boolean(disabled);
      if (ariaDisabled) button.setAttribute('aria-disabled', 'true');
      observe(button);
      root.append(button);
    }
    document.getElementById('sidebar').focus();
  }, buttons);
  return page;
}

test('标准键盘焦点到达唯一启用的发布按钮后，Enter 仅激活一次', async t => {
  const page = await offlineEditor(t, [
    { id: 'draft', name: '暂存离开' },
    { id: 'unavailable', name: '发布', ariaDisabled: true },
    { id: 'target', name: '发布' },
    { id: 'next', name: '发布笔记' },
  ]);
  const action = await keyboardSubmitAction(page);
  assert.ok(action);
  assert.deepEqual(await page.evaluate(() => window.activations), []);
  await action.click();
  assert.deepEqual(await page.evaluate(() => window.keyEvents), [{ id: 'target', focused: true, trusted: true }]);
  assert.deepEqual(await page.evaluate(() => window.activations), ['target']);
});

const stoppedCases = [
  ['只有侧栏近似文案', []],
  ['两个可用的同名按钮', [{ id: 'one', name: '发布' }, { id: 'two', name: '发布' }]],
  ['原生禁用按钮', [{ id: 'disabled', name: '发布', disabled: true }]],
  ['ARIA 禁用按钮', [{ id: 'ariaDisabled', name: '发布', ariaDisabled: true }]],
];
for (const [label, buttons] of stoppedCases) {
  test(label + '时不发送按键，返回空操作', async t => {
    const page = await offlineEditor(t, buttons);
    assert.equal(await keyboardSubmitAction(page), null);
    assert.deepEqual(await page.evaluate(() => [window.keyEvents, window.activations]), [[], []]);
  });
}

test('准备完成后按钮变为多义，点击前重查并停止', async t => {
  const page = await offlineEditor(t, [{ id: 'target', name: '发布' }]);
  const action = await keyboardSubmitAction(page);
  assert.ok(action);
  await page.locator('#sidebar').evaluate(button => { button.textContent = '发布'; });
  await assert.rejects(action.click(), /未聚焦唯一/);
  assert.deepEqual(await page.evaluate(() => [window.keyEvents, window.activations]), [[], []]);
});
