import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { editorDiagnostics, prepareEditor } from '../lib/editor.mjs';

let browser, directory, images;
before(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  directory = await mkdtemp(join(tmpdir(), 'xhs-editor-test-'));
  images = ['01.jpg', '02.jpg', '10.jpg'].map(n => join(directory, n));
  // The fixture never sends a request and only uses native file selection events.
  await Promise.all(images.map(path => writeFile(path, 'fixture')));
});
after(async () => {
  await browser?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function pageWithForm(t, options = {}) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent(`<!doctype html><html><body>
  <button hidden>上传图文</button><button id="tab" role="tab" aria-selected="false" aria-controls="imagepanel">上传图文</button>
  <input type="file" id="video" accept=".mp4,.mov">
  <section id="imagepanel" role="tabpanel" hidden><div id="upload-area">
    <button id="choose">上传图片</button>
  </div><div class="img-preview-area"></div>
    <input id="title-input" placeholder="填写标题"><div class="ql-editor" contenteditable="true" style="min-height:2em"></div>
    <button id="post" disabled>发布</button>
  </section><button>发布笔记</button>
  </body></html>`);
  await page.evaluate(({ chooser, draft, fail, duplicate, flat, publishedButton, indicator }) => {
    const $ = id => document.getElementById(id);
    const panel = $('imagepanel'), area = $('upload-area'), tab = $('tab');
    const previews = document.querySelector('.img-preview-area');
    window.selectedFileNames = [];
    window.submitCount = 0;
    $('post').onclick = () => window.submitCount++;
    $('video').onchange = () => { throw new Error('wrong video input'); };
    if (flat) {
      document.querySelector('button[hidden]').remove();
      tab.removeAttribute('aria-selected');
      tab.removeAttribute('aria-controls');
      tab.removeAttribute('role');
      panel.removeAttribute('role');
    }
    tab.onclick = () => setTimeout(() => {
      if (!flat) tab.setAttribute('aria-selected', 'true');
      $('video').hidden = true;
      panel.hidden = false;
    }, 45);
    function addFiles(input) {
      const file = input.files[0];
      window.selectedFileNames.push(file.name);
      const status = document.createElement('span');
      area.append(status);
      status.textContent = '上传中';
      setTimeout(() => {
        if (fail) { status.textContent = '图片上传失败'; return; }
        status.remove();
        const tile = document.createElement('div');
        tile.className = 'pr';
        tile.textContent = file.name;
        previews.append(tile);
        $('post').disabled = false;
        if (indicator) {
          // The thumbnail and active publish button are visible before the ring.
          // The completion flag belongs to the fixture; the editor cannot use it.
          window.fixtureUploadFinished = false;
          setTimeout(() => {
            const ring = document.createElement('span');
            ring.style.cssText = 'display:inline-block;width:14px;height:14px;border:1px solid red';
            if (indicator === 'animation') {
              ring.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 800, iterations: Infinity });
            } else {
              ring.className = 'image-upload-progress';
            }
            tile.append(ring);
            setTimeout(() => { ring.remove(); window.fixtureUploadFinished = true; }, 700);
          }, 240);
        }
        if (duplicate) previews.append(tile.cloneNode(true));
      }, 30);
    }
    function makeInput() {
      const input = document.createElement('input');
      input.type = 'file';
      input.hidden = true;
      input.accept = '.jpg,.jpeg,.png';
      area.append(input);
      input.onchange = () => addFiles(input);
      return input;
    }
    if (chooser) {
      $('choose').onclick = () => {
        const input = makeInput();
        input.click();
      };
    } else { makeInput(); }
    if (draft === 'images') {
      const tile = document.createElement('div');
      tile.className = 'pr'; tile.textContent = '草稿旧图'; previews.append(tile);
    }
    if (draft === 'text') $('title-input').value = '不能修改的旧标题';
    if (publishedButton) {
      const another = document.createElement('button');
      another.textContent = '发布'; panel.append(another);
    }
  }, options);
  return page;
}

const note = () => ({ title: '中文与🐈', body: '第一段🐈\n\n第二段 #词', images });
test('隐藏扩展名图片输入、多图顺序、段落空行、编辑就绪但提交次数为零', async t => {
  const page = await pageWithForm(t);
  const stages = [];
  const button = await prepareEditor(page, note(), { timeout: 3000, onStage: v => stages.push(v) });
  assert.equal(await button.getAttribute('id'), 'post');
  assert.deepEqual(await page.evaluate(() => window.selectedFileNames), ['01.jpg', '02.jpg', '10.jpg']);
  assert.equal(await page.evaluate(() => window.submitCount), 0);
  assert.ok(stages.includes('text-verified'));
  assert.equal((await editorDiagnostics(page)).fileInputs.some(i => i.accept === '.mp4,.mov'), true);
});
test('无 ARIA 的页面通过图文专属入口打开动态文件选择器', async t => {
  const page = await pageWithForm(t, { chooser: true, flat: true });
  const button = await prepareEditor(page, { ...note(), images: images.slice(0, 1) }, { timeout: 3000 });
  assert.equal(await button.getAttribute('id'), 'post');
});
for (const draft of ['images', 'text']) {
  test('已存在的草稿被保留（' + draft + '）', async t => {
    const page = await pageWithForm(t, { draft });
    await assert.rejects(prepareEditor(page, note(), { timeout: 3000 }), /草稿/);
    assert.deepEqual(await page.evaluate(() => window.selectedFileNames), []);
    assert.equal(await page.evaluate(() => window.submitCount), 0);
  });
}
for (const [type, message] of [['fail', /上传或处理失败/], ['duplicate', /图片比/], ['publishedButton', /多个可匹配的发布按钮/]]) {
  test('页面异常阻止提交（' + type + '）', async t => {
    const page = await pageWithForm(t, { [type]: true });
    await assert.rejects(prepareEditor(page, note(), { timeout: 3000 }), message);
    assert.equal(await page.evaluate(() => window.submitCount), 0);
  });
}
test('普通标签多义时请操作者选择，随后继续机器填稿', async t => {
  const page = await pageWithForm(t, { flat: true });
  await page.evaluate(() => {
    const other = document.createElement('span');
    other.textContent = '上传图文';
    other.onclick = () => { window.wrongTab = true; };
    document.body.append(other);
  });
  const stages = [];
  await prepareEditor(page, { ...note(), images: images.slice(0, 1) }, {
    timeout: 3000,
    onStage: async stage => {
      stages.push(stage);
      if (stage === 'manual-image-tab') {
        assert.equal(await page.locator('#imagepanel').isVisible(), false);
        await page.locator('#tab').click(); // The fixture supplies the operator's action.
      }
    },
  });
  assert.ok(stages.includes('manual-image-tab'));
  assert.equal(await page.evaluate(() => Boolean(window.wrongTab)), false);
});
test('正文保留文件开头、结尾及连续的空行', async t => {
  const page = await pageWithForm(t);
  const body = '\n甲\n\n乙\n\n';
  await prepareEditor(page, { ...note(), body, images: images.slice(0, 1) }, { timeout: 3000 });
});
test('编辑期间遇到明确人工验证，在上传前停止', async t => {
  const page = await pageWithForm(t);
  await assert.rejects(prepareEditor(page, note(), {
    timeout: 3000,
    onStage: async stage => {
      if (stage === 'image-tab-ready') await page.evaluate(() => {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog'); dialog.textContent = '请完成安全验证';
        document.body.append(dialog);
      });
    },
  }), /人工验证/);
  assert.deepEqual(await page.evaluate(() => window.selectedFileNames), []);
  assert.equal(await page.evaluate(() => window.submitCount), 0);
});
test('带话题和末尾换行的稿整段输入，避免回车选中联想词', async t => {
  const page = await pageWithForm(t);
  await page.evaluate(() => {
    window.suggestionConfirmed = false;
    document.querySelector('.ql-editor').addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.currentTarget.innerText.includes('#')) {
        e.preventDefault();
        window.suggestionConfirmed = true;
      }
    });
  });
  await prepareEditor(page, { ...note(), body: '第一段\n#自动化\n', images: images.slice(0, 1) }, { timeout: 3000 });
  assert.equal(await page.evaluate(() => window.suggestionConfirmed), false);
});
for (const requirePublishButton of [false, true]) {
  test('复合发布控件按调用模式处理 ' + (requirePublishButton ? '发布' : '预览'), async t => {
    const page = await pageWithForm(t);
    const stages = [];
    const pending = prepareEditor(page, { ...note(), images: images.slice(0, 1) }, {
      timeout: 3000, requirePublishButton,
      onStage: async stage => {
        stages.push(stage);
        if (stage === 'text-verified') await page.evaluate(() => {
          document.getElementById('post').replaceWith(Object.assign(document.createElement('xhs-publish-btn'), { textContent: '发布或暂存' }));
        });
      },
    });
    if (requirePublishButton) await assert.rejects(pending, /复合发布控件/);
    else {
      assert.equal(await pending, null);
      assert.ok(stages.includes('preview-ready'));
    }
    assert.equal(await page.evaluate(() => window.submitCount), 0);
  });
}
test('文字差异显示字符位置与类型，省略稿件内容', async t => {
  const page = await pageWithForm(t);
  await page.evaluate(() => {
    document.querySelector('.ql-editor').onblur = event => {
      event.currentTarget.append(document.createTextNode('x'));
    };
  });
  await assert.rejects(prepareEditor(page, { ...note(), body: '私密稿', images: images.slice(0, 1) }, { timeout: 1600 }), error => {
    assert.match(error.message, /标题一致，正文原稿 3 字符，页面 4 字符.*第 4 个字符（原稿为文本结束，页面为字母）/);
    assert.doesNotMatch(error.message, /私密稿/);
    return true;
  });
});
for (const indicator of ['animation', 'progress']) {
  test('缩略图已出现时等待延迟挂载的进度圈消失 ' + indicator, async t => {
    const page = await pageWithForm(t, { indicator });
    // Unrelated page animations should not postpone this upload.
    await page.evaluate(() => {
      const decoration = document.createElement('span');
      decoration.textContent = '◎'; decoration.style.display = 'inline-block';
      document.body.append(decoration);
      decoration.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 900, iterations: Infinity });
    });
    await prepareEditor(page, { ...note(), images: images.slice(0, 1) }, {
      timeout: 5000, requirePublishButton: false,
      onStage: async stage => {
        if (stage === 'image-1-ready') assert.equal(await page.evaluate(() => window.fixtureUploadFinished), true);
      },
    });
    assert.equal(await page.evaluate(() => window.submitCount), 0);
  });
}
test('预览收起话题候选后再次核对正文和尾部换行', async t => {
  const page = await pageWithForm(t);
  await page.evaluate(() => {
    const body = document.querySelector('.ql-editor');
    const list = document.createElement('div');
    list.id = 'topics'; list.setAttribute('role', 'listbox'); list.hidden = true; list.textContent = '#候选话题';
    document.body.append(list);
    body.addEventListener('input', () => { list.hidden = false; });
    body.addEventListener('keydown', e => { if (e.key === 'Escape') list.hidden = true; });
  });
  await prepareEditor(page, { ...note(), body: '话题预览\n#自动化\n', images: images.slice(0, 1) }, {
    timeout: 3000, requirePublishButton: false,
    onStage: async stage => {
      if (stage === 'text-verified') assert.equal(await page.locator('#topics').isVisible(), false);
    },
  });
  assert.equal(await page.evaluate(() => window.submitCount), 0);
});

async function openFixtureImagePanel(page, named = false) {
  await page.evaluate(named => {
    document.getElementById('video').hidden = true;
    const panel = document.getElementById('imagepanel');
    panel.hidden = false;
    if (named) panel.setAttribute('aria-label', '上传图文');
    document.getElementById('tab')?.remove();
  }, named);
}

for (const chooser of [false, true]) {
  test('已在图文上传区可直接继续 ' + (chooser ? '活动 ARIA 面板' : '图片专用文件框'), async t => {
    const page = await pageWithForm(t, { chooser });
    await openFixtureImagePanel(page, chooser);
    const stages = [];
    let opened = 0;
    await prepareEditor(page, { ...note(), images: images.slice(0, 1) }, {
      timeout: 3000, requirePublishButton: false, onStage: stage => stages.push(stage),
      openImageEntry: async () => { opened++; return false; },
    });
    assert.equal(opened, 0);
    assert.ok(!stages.includes('manual-image-tab'));
    assert.deepEqual(await page.evaluate(() => window.selectedFileNames), ['01.jpg']);
  });
}
for (const outcome of ['opened', 'unavailable', 'error', 'unconfirmed']) {
  test('正常图文导航回调 ' + outcome, async t => {
    const page = await pageWithForm(t, { flat: true });
    await page.evaluate(() => {
      const label = document.createElement('span');
      label.textContent = '上传图文';
      document.body.append(label);
    });
    let called = 0, manual = 0;
    await prepareEditor(page, { ...note(), images: images.slice(0, 1) }, {
      timeout: 2500, requirePublishButton: false,
      openImageEntry: async () => {
        called++;
        if (outcome === 'error') throw new Error('fixture navigation unavailable');
        if (outcome === 'opened') await openFixtureImagePanel(page);
        return outcome === 'opened' || outcome === 'unconfirmed';
      },
      onStage: async stage => {
        if (stage !== 'manual-image-tab') return;
        manual++;
        assert.deepEqual(await page.evaluate(() => window.selectedFileNames), []);
        await page.locator('#tab').click();
      },
    });
    assert.equal(called, 1);
    assert.equal(manual, outcome === 'opened' ? 0 : 1);
    assert.equal(await page.evaluate(() => window.submitCount), 0);
  });
}
test('图文和视频上传区同时活动时，先确认图文入口', async t => {
  const page = await pageWithForm(t, { flat: true });
  await page.evaluate(() => {
    document.getElementById('imagepanel').hidden = false;
    const label = document.createElement('span');
    label.textContent = '上传图文'; document.body.append(label);
    const videoButton = document.createElement('button');
    videoButton.id = 'video-action'; videoButton.textContent = '选择视频'; document.body.append(videoButton);
  });
  let called = 0;
  await prepareEditor(page, { ...note(), images: images.slice(0, 1) }, {
    timeout: 3000, requirePublishButton: false,
    openImageEntry: async () => {
      called++;
      assert.deepEqual(await page.evaluate(() => window.selectedFileNames), []);
      await page.locator('#video-action').evaluate(el => el.remove());
      await openFixtureImagePanel(page);
      return true;
    },
  });
  assert.equal(called, 1);
});

for (const ambiguous of [false, true]) {
  test('已核对封面后选择内页追加框 ' + (ambiguous ? '多个多选框停止' : '唯一多选框逐图追加'), async t => {
    const page = await pageWithForm(t);
    const run = prepareEditor(page, note(), {
      requirePublishButton: false, timeout: ambiguous ? 1800 : 3500,
      onStage: async stage => {
        if (stage !== 'image-1-ready') return;
        await page.evaluate(ambiguous => {
          const area = document.getElementById('upload-area');
          const append = area.querySelector('input');
          append.multiple = true;
          append.accept = '.jpg,.jpeg,.png,.webp';
          for (const accept of ['.jpg,.jpeg,.png,.webp', '.pdf,.doc']) {
            const other = document.createElement('input');
            other.type = 'file'; other.hidden = true; other.accept = accept;
            other.multiple = ambiguous && accept.startsWith('.jpg');
            other.onchange = () => { window.wrongInput = true; };
            area.prepend(other);
          }
          document.getElementById('choose').remove();
        }, ambiguous);
      },
    });
    if (ambiguous) await assert.rejects(run, /图片输入框或上传按钮/);
    else await run;
    const expected = ambiguous ? ['01.jpg'] : ['01.jpg', '02.jpg', '10.jpg'];
    assert.deepEqual(await page.evaluate(() => window.selectedFileNames), expected);
    assert.deepEqual(await page.locator('.img-preview-area .pr').allTextContents(), expected);
    assert.equal(await page.evaluate(() => Boolean(window.wrongInput)), false);
    assert.equal(await page.evaluate(() => window.submitCount), 0);
  });
}
