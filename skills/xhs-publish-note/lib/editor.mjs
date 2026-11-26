import { setTimeout as delay } from 'node:timers/promises';

const tabText = '上传图文';
const uploadLabel = /^(?:上传图片|选择图片|点击上传图片|添加图片|继续添加图片)$/;
const titleSelector = 'input#title-input, input[placeholder*="标题"], textarea[placeholder*="标题"]';
const bodySelector = [
  'textarea[placeholder*="正文"]', '[contenteditable=true].ql-editor',
  '[contenteditable=true].tiptap', '[contenteditable=true].ProseMirror',
  '[contenteditable=true][data-placeholder*="正文"]', '[contenteditable=true][aria-label*="正文"]',
  '[contenteditable=true][role=textbox]',
].join(', ');

async function until(description, timeout, probe) {
  const end = Date.now() + timeout;
  do {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      // A tab change can replace the document between two reads.
      if (!/Execution context was destroyed|Cannot find context with specified id/i.test(error.message)) throw error;
    }
    await delay(160);
  } while (Date.now() < end);
  const error = new Error('等待超时：' + description);
  error.code = 'UI_WAIT_TIMEOUT';
  throw error;
}

const visible = (page, locator) => locator.and(page.locator(':visible'));

async function unique(locator, description) {
  const count = await locator.count();
  if (count > 1) throw new Error('有多个可匹配的' + description + '，请核对页面');
  return count === 1 ? locator : null;
}

async function findTab(page) {
  const byRole = page.getByRole('tab', { name: tabText, exact: true });
  const roleCount = await byRole.count();
  if (roleCount === 1) return { tab: byRole };
  if (roleCount > 1) return { manual: true };
  const byText = page.getByText(tabText, { exact: true });
  const count = await byText.count();
  if (count > 1) return { manual: true };
  return count === 1 && await byText.isVisible() ? { tab: byText } : null;
}

async function modeInfo(tab) {
  return tab.evaluate(el => {
    const target = el.closest('[role=tab], .creator-tab, button, [aria-selected]') || el;
    const selected = target.getAttribute('aria-selected');
    return {
      selected: selected === null
        ? [...target.classList].some(name => /(^|[-_])(active|selected)$/i.test(name)) || null
        : selected === 'true',
      panelId: target.getAttribute('aria-controls'),
    };
  });
}

async function activeScope(page, info) {
  if (info.panelId) {
    const id = await page.evaluate(value => CSS.escape(value), info.panelId);
    const panel = page.locator('#' + id + ':visible');
    if (await panel.count() === 1) return panel;
    return null;
  }
  const panels = page.getByRole('tabpanel');
  const count = await panels.count();
  if (count > 1) throw new Error('有多个可见标签面板，缺少关联的图文面板');
  return count ? panels : page.locator('body');
}

function imageOnly(accept) {
  const tokens = accept.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  return tokens.length > 0 && tokens.every(t => t.startsWith('image/') || /^\.(?:jpe?g|jfif|png|webp|gif|bmp|tiff?|avif|heic|heif)$/i.test(t));
}

async function imageInput(scope, append = false) {
  const candidates = await scope.locator('input[type=file]').elementHandles();
  const matches = [];
  const multiImageInputs = [];
  for (const handle of candidates) {
    const props = await handle.evaluate(el => ({
      accept: el.accept, multiple: el.multiple, enabled: !el.disabled && el.isConnected,
      // The input itself and its wrapper can be hidden; inactive panels are excluded.
      inactive: !!el.closest('[inert], [role=tabpanel][hidden], [role=tabpanel][aria-hidden=true]'),
      inImageUploader: !!el.closest('.img-preview-area,[class*=image-upload],[class*=img-upload],[class*=upload-image]'),
    }));
    const verifiedType = imageOnly(props.accept) || (!props.accept.trim() && props.inImageUploader);
    if (props.enabled && !props.inactive && verifiedType) {
      matches.push(handle);
      if (props.multiple && imageOnly(props.accept)) multiImageInputs.push(handle);
    } else await handle.dispose();
  }
  if (matches.length > 1) {
    // After the cover is verified the editor can show a single-image replacement
    // input next to the multi-image append input. Keep uploading one file per step.
    const target = append && multiImageInputs.length === 1 ? multiImageInputs[0] : null;
    await Promise.all(matches.filter(h => h !== target).map(h => h.dispose()));
    return target; // A visible upload control can still open an unambiguous chooser.
  }
  return matches[0] || null;
}

async function uploadControl(page, scope) {
  return unique(visible(page, scope.getByText(uploadLabel)), '图片上传按钮');
}

async function hasVideoUpload(page) {
  // A tab label can remain visible while another editor is active. Check the
  // upload surface itself and ordinary selected-tab semantics.
  const videoTab = page.getByRole('tab', { name: '上传视频', exact: true, selected: true });
  const videoAction = page.getByRole('button', { name: /^(?:上传视频|选择视频|点击上传视频|上传视频文件)$/ });
  const videoPrompt = visible(page, page.getByText(/^(?:点击上传视频|选择视频|拖拽视频到此处)$/));
  if (await videoTab.count() || await videoAction.count() || await videoPrompt.count()) return true;
  if (await page.getByRole('tabpanel', { name: '上传视频', exact: true }).count()) return true;
  const fileTypes = await page.locator('input[type=file]:visible:enabled').evaluateAll(inputs => inputs.map(el => el.accept));
  return fileTypes.some(accept => /(?:video\/|\.(?:mp4|mov|avi|mkv|m4v|webm|flv)\b)/i.test(accept));
}

async function existingImageScope(page) {
  const panels = page.getByRole('tabpanel');
  const named = page.getByRole('tabpanel', { name: tabText, exact: true });
  const namedCount = await named.count();
  const panelCount = await panels.count();
  if (namedCount > 1 || (panelCount > 1 && namedCount !== 1)) return null;
  const scope = namedCount ? named : panelCount ? panels : page.locator('body');
  const imageButton = scope.getByRole('button', { name: uploadLabel });
  const imageActions = await imageButton.count() ? imageButton : visible(page, scope.getByText(uploadLabel));
  if (await imageActions.count() !== 1 || !await imageActions.isEnabled() || await hasVideoUpload(page)) return null;
  const input = await imageInput(scope);
  if (input) {
    try {
      if (imageOnly((await input.getAttribute('accept')) || '')) return scope;
    } finally {
      await input.dispose();
    }
  }
  // A semantic image panel can use a file chooser created only after a click.
  if (namedCount === 1) return scope;
  if (panelCount !== 1) return null;
  const selectedTab = page.getByRole('tab', { name: tabText, exact: true, selected: true });
  if (await selectedTab.count() !== 1) return null;
  const panelId = await scope.getAttribute('id');
  return panelId && panelId === await selectedTab.getAttribute('aria-controls') ? scope : null;
}

// Reads only upload UI, never cookies, media URLs or other form values.
function readUploadState(root) {
  const shown = el => el.checkVisibility({ visibilityProperty: true }) && el.getClientRects().length > 0;
  const textNodes = [...root.querySelectorAll('span,div,p,label,button,strong,[role=alert]')].filter(el =>
    !el.closest('[contenteditable=true], [hidden], [aria-hidden=true]') && !el.querySelector('[contenteditable=true]') &&
    el.childElementCount < 2 && el.textContent.length < 90 && shown(el));
  const texts = textNodes.map(el => el.innerText?.trim() || '');
  const error = texts.find(t => /^(?:图片|文件)?上传失败|^图片处理失败|^文件格式不支持|^不支持的图片格式|^图片大小超出/.test(t));
  const uploadMessage = texts.some(t => /^(?:图片)?(?:上传中|处理中|正在上传|正在处理)(?:[.。…\s\d%]*)$/.test(t));

  // A count in the heading can appear before upload starts. Wait for a second,
  // consistent count when the UI renders thumbnail tiles as well.
  const countMatch = texts.map(t => t.match(/^(?:图片编辑|编辑图片|图片管理|已上传图片)\s*[（(]?\s*(\d+)\s*\/\s*\d+/)).find(Boolean);
  const headingCount = countMatch ? Number(countMatch[1]) : null;
  const groups = [
    '.img-preview-area .pr', '.img-preview-area .img-item', '.img-preview-area img',
    '.upload-preview-item', '.image-preview-item', '.image-list .image-item',
    '.preview-list .preview-item', '[data-testid=image-preview-item]',
  ];
  let tiles = [];
  for (const selector of groups) {
    tiles = [...root.querySelectorAll(selector)].filter(shown);
    if (tiles.length) break;
  }
  // A local thumbnail can be visible while the site is still uploading it.
  // Inspect only the site's thumbnail areas, since the rest of the page can
  // have unrelated spinners or continuously animated decorations.
  const areas = new Set([...root.querySelectorAll('.img-preview-area'), ...tiles]);
  const busy = uploadMessage || [...areas].filter(shown).some(area => {
    const indicatorShown = el => shown(el) && el.checkVisibility({ opacityProperty: true });
    const indicators = area.querySelectorAll([
      'progress', '[role=progressbar]', '[aria-busy=true]', '[data-status=uploading]',
      '[data-status=processing]', '[class*=loading i]', '[class*=spinner i]',
      '[class*=uploading i]', '[class*=progress i]',
    ].join(','));
    for (const el of [area, ...indicators]) {
      if (!indicatorShown(el)) continue;
      const meter = el.closest('progress,[role=progressbar]');
      if (meter?.matches('progress')) {
        if (meter.position < 1) return true;
        continue;
      }
      if (meter) {
        const now = meter.getAttribute('aria-valuenow');
        if (now === null || Number(now) < Number(meter.getAttribute('aria-valuemax') || 100)) return true;
        continue;
      }
      if (el.matches('[aria-busy=true], [data-status=uploading], [data-status=processing]')) return true;
      if (/(?:loading|spinner|uploading|progress)/i.test(el.getAttribute('class') || '')) return true;
    }
    return area.getAnimations({ subtree: true }).some(animation => {
      const effect = animation.effect;
      const target = effect?.target;
      if (animation.playState !== 'running' || !(target instanceof Element) || !indicatorShown(target)) return false;
      if (/spin|rotat|loading|processing|progress|dash/i.test(animation.animationName || '')) return true;
      return effect.getTiming().iterations > 1 && effect.getKeyframes().some(frame =>
        String(frame.transform || '').includes('rotate') || Boolean(frame.rotate));
    });
  });
  return {
    count: tiles.length || headingCount || 0, headingCount, busy, failed: !!error,
    inconsistent: tiles.length > 0 && headingCount !== null && tiles.length !== headingCount,
  };
}

function readField(el) {
  if ('value' in el) return el.value;
  // Blank Quill paragraphs contain a placeholder <br>. Chrome also represents
  // an unwrapped first line followed by sibling <div> blocks. innerText alone
  // counts the placeholder and the boundary and adds spurious blank lines.
  function lineText(nodes) {
    if (nodes.length === 1 && nodes[0].nodeName === 'BR') return '';
    return nodes.map(node => {
      if (node.nodeName === 'BR') return node.classList.contains('ProseMirror-trailingBreak') ? '' : '\n';
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (node.matches?.('.ql-cursor,.ProseMirror-separator,.ProseMirror-widget')) return '';
      return node.nodeType === Node.ELEMENT_NODE ? lineText([...node.childNodes]) : '';
    }).join('');
  }
  const lines = [];
  let inline = [];
  for (const node of el.childNodes) {
    if (node.nodeName === 'P' || node.nodeName === 'DIV') {
      if (inline.length) lines.push(lineText(inline));
      inline = [];
      lines.push(lineText([...node.childNodes]));
    } else {
      inline.push(node);
    }
  }
  if (inline.length) lines.push(lineText(inline));
  return lines.join('\n');
}

async function emptyFields(page, scope) {
  for (const selector of [titleSelector, bodySelector]) {
    const fields = visible(page, scope.locator(selector));
    const field = await unique(fields, '编辑框');
    if (field && (await field.evaluate(readField)).trim()) {
      throw new Error('页面已有草稿文字，请先从空白发布页开始');
    }
  }
}

async function checkPage(page, origin) {
  const url = new URL(page.url());
  if (url.origin !== origin || /(?:^|\/)(?:login|signin)(?:\/|$)/i.test(url.pathname)) {
    throw new Error('编辑期间页面已离开原站或跳转登录，请重新核对账号');
  }
  const blocker = visible(page, page.locator('[role=dialog],dialog,.login-modal,.captcha-container,[role=alert]')
    .filter({ hasText: /扫码登录|验证码登录|安全验证|请完成验证|请完成.{0,4}验证/ }));
  if (await blocker.count()) throw new Error('页面要求登录或人工验证，请处理后重试');
}

async function sendImage(page, scope, path, timeout, origin, append) {
  const result = await until('图文面板的图片输入框或上传按钮', timeout, async () => {
    await checkPage(page, origin);
    const input = await imageInput(scope, append);
    if (input) return { input };
    const button = await uploadControl(page, scope);
    return button ? { button } : null;
  });
  if (result.input) {
    try {
      await result.input.setInputFiles(path, { timeout });
    } finally {
      await result.input.dispose();
    }
    return;
  }
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout }),
    result.button.click({ timeout }),
  ]);
  const accept = (await chooser.element().getAttribute('accept'))?.trim();
  if (accept && !imageOnly(accept)) throw new Error('图片上传按钮打开了其他类型的文件选择器');
  await chooser.setFiles(path, { timeout });
}

async function assertPreviews(scope, expected, timeout) {
  let readySince = null;
  return until('图文预览显示 ' + expected + ' 张且处理完毕', timeout, async () => {
    if (await scope.count() !== 1) {
      readySince = null;
      return false;
    }
    const state = await scope.evaluate(readUploadState);
    if (state.failed) throw new Error('页面提示图片上传或处理失败');
    if (state.count > expected || state.headingCount > expected) throw new Error('预览图片比本次选入的更多，请核对该页是否有其他素材');
    if (state.busy || state.inconsistent || state.count !== expected) {
      readySince = null;
      return false;
    }
    // The progress overlay may mount just after the thumbnail. Require stable
    // readiness across multiple polls before reporting this upload as ready.
    readySince ??= Date.now();
    return Date.now() - readySince >= 400;
  });
}

function normalized(value) {
  return value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
}

async function writeBody(page, body, value, timeout) {
  // Send all lines as one ordinary text insertion. Keydown(Enter) while a topic
  // suggestion is open can select a different topic and consume a line break.
  await body.fill(value, { timeout });
  await body.blur({ timeout });
  if (normalized(await body.evaluate(readField)) === normalized(value)) return;
  if (await body.evaluate(el => el instanceof HTMLTextAreaElement)) return;

  // Some rich-text engines need native paragraph insertion. Start from an empty
  // field and close topic suggestions before issuing paragraph keys.
  await body.fill('', { timeout });
  await body.focus({ timeout });
  const lines = value.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      if (lines[i - 1].includes('#')) await body.press('Escape', { timeout });
      await body.press('Enter', { timeout });
    }
    if (lines[i]) await page.keyboard.insertText(lines[i]);
  }
  await body.blur({ timeout });
}

function characterKind(char) {
  if (char === undefined) return '文本结束';
  if (char === '\n') return '换行';
  if (char === '\t') return '制表';
  if (/\s/u.test(char)) return '空白';
  if (/\p{Cf}/u.test(char)) return '不可见格式字符';
  if (/\p{Script=Han}/u.test(char)) return '汉字';
  if (/\p{Letter}/u.test(char)) return '字母';
  if (/\p{Number}/u.test(char)) return '数字';
  return '符号';
}

async function verifyText(title, body, note, timeout) {
  const expected = [...normalized(note.body)];
  const end = Date.now() + Math.min(timeout, 3500);
  let actual, sameTitle, first;
  do {
    sameTitle = (await title.inputValue()) === note.title;
    actual = [...normalized(await body.evaluate(readField))];
    first = expected.findIndex((ch, i) => actual[i] !== ch);
    if (first === -1 && actual.length !== expected.length) first = expected.length;
    if (sameTitle && first === -1) return;
    await delay(120);
  } while (Date.now() < end);
  const difference = first === -1 ? '正文一致' : '正文首差在第 ' + (first + 1) +
    ' 个字符（原稿为' + characterKind(expected[first]) + '，页面为' + characterKind(actual[first]) + '）';
  throw new Error('文字回读未通过：标题' + (sameTitle ? '一致' : '不一致') + '，正文原稿 ' +
    expected.length + ' 字符，页面 ' + actual.length + ' 字符；' + difference);
}

export async function editorDiagnostics(page) {
  const result = await page.evaluate(() => {
    const inputTypes = [...document.querySelectorAll('input[type=file]')].map(el => ({
      accept: el.accept.slice(0, 180), multiple: el.multiple, disabled: el.disabled,
      hidden: !el.getClientRects().length, panel: el.closest('[role=tabpanel]')?.tagName || null,
    }));
    return {
      imageTabLabels: [...document.querySelectorAll('[role=tab], .creator-tab, button, span')].filter(el =>
        el.textContent.trim() === '上传图文' && el.childElementCount < 2).map(el => ({
        tag: el.tagName, selected: el.getAttribute('aria-selected'), visible: !!el.getClientRects().length,
      })).slice(0, 8),
      fileInputs: inputTypes, documentReady: document.readyState,
      contentEditors: document.querySelectorAll('[contenteditable=true]').length,
      customPublishControls: document.querySelectorAll('xhs-publish-btn').length,
    };
  });
  const actionBar = page.locator('xhs-publish-btn:visible');
  if (await actionBar.count() === 1) {
    result.publishActions = (await actionBar.ariaSnapshot({ timeout: 2000 }).catch(() => '')).slice(0, 400);
  }
  result.namedPublishButtons = await page.getByRole('button', {name:'发布', exact:true}).count();
  return result;
}

export async function prepareEditor(page, note, { timeout = 90000, manualTabTimeout = timeout, onStage = async () => {}, requirePublishButton = true, openImageEntry } = {}) {
  if (!note.images?.length) throw new Error('缺少待上传的图片');
  const origin = new URL(page.url()).origin;
  const readyImageScope = async () => {
    await checkPage(page, origin);
    return existingImageScope(page);
  };
  const choice = await until('图文上传区或「上传图文」标签', timeout, async () => {
    const scope = await readyImageScope();
    return scope ? { scope } : findTab(page);
  });
  let scope = choice.scope;
  if (!scope && choice.manual && openImageEntry) {
    // The caller can navigate via the site's own visible image publishing entry.
    // Recheck the destination; a click alone does not establish image mode.
    const initial = page.locator('body');
    if ((await initial.evaluate(readUploadState)).count) throw new Error('页面已有图片草稿，请先从空白发布页开始');
    await emptyFields(page, initial);
    let opened;
    try {
      opened = await openImageEntry();
    } catch {
      await checkPage(page, origin);
    }
    if (opened) {
      try {
        scope = await until('官网图文入口的上传区', timeout, readyImageScope);
      } catch (error) {
        if (error.code !== 'UI_WAIT_TIMEOUT') throw error;
      }
    }
  }
  if (!scope && choice.manual) {
    await onStage('manual-image-tab');
    scope = await until('请在浏览器手动选择「上传图文」，等待图文上传区出现', manualTabTimeout, async () => {
      await checkPage(page, origin);
      const scope = await activeScope(page, {});
      if (!scope || await hasVideoUpload(page)) return null;
      return await uploadControl(page, scope) ? scope : null;
    });
  } else if (!scope) {
    const tab = choice.tab;
    if (!(await modeInfo(tab)).selected) await tab.click({ timeout });
    scope = await until('确认「上传图文」标签已激活', timeout, async () => {
      await checkPage(page, origin);
      if (await tab.count() !== 1) return null;
      const info = await modeInfo(tab);
      if (info.selected === false) return null;
      const root = await activeScope(page, info);
      if (!root) return null;
      if (!info.selected && !info.panelId && !await uploadControl(page, root)) return null;
      return root;
    });
  }
  await onStage('image-tab-ready');
  if ((await scope.evaluate(readUploadState)).count) throw new Error('页面已有图片草稿，请先从空白发布页开始');
  await emptyFields(page, scope);

  // One image at a time keeps the cover first even when multiple uploads finish out of order.
  // Some versions replace the upload tab with a full-page editor after the first image.
  const pageRoot = page.locator('body');
  for (const [index, path] of note.images.entries()) {
    const editorRoot = await scope.isVisible() ? scope : pageRoot;
    await sendImage(page, editorRoot, path, timeout, origin, index > 0);
    await assertPreviews(pageRoot, index + 1, timeout);
    await onStage('image-' + (index + 1) + '-ready');
  }

  const title = await until('唯一可见标题框', timeout, () => unique(visible(page, page.locator(titleSelector)), '标题框'));
  const body = await until('唯一可见正文框', timeout, () => unique(visible(page, page.locator(bodySelector)), '正文框'));
  await checkPage(page, origin);
  await emptyFields(page, pageRoot);
  await title.fill(note.title, { timeout });
  await writeBody(page, body, note.body, timeout);
  await verifyText(title, body, note, timeout);
  if (note.body.includes('#')) {
    await checkPage(page, origin);
    await body.press('Escape', { timeout });
    await body.blur({ timeout });
    await verifyText(title, body, note, timeout);
  }
  await assertPreviews(pageRoot, note.images.length, timeout);
  await onStage('text-verified');
  const publishButtons = visible(page, page.getByRole('button', { name: '发布', exact: true }));
  if (!requirePublishButton) {
    await checkPage(page, origin);
    if (await publishButtons.count() === 1 && await publishButtons.isEnabled()) {
      try {
        await publishButtons.click({ trial: true, timeout: Math.min(timeout, 1000) });
        await onStage('ready-to-publish');
        return publishButtons;
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
      }
    }
    await onStage('preview-ready');
    return null;
  }
  const button = await until('唯一可见的「发布」按钮', timeout, async () => {
    await checkPage(page, origin);
    const btn = await unique(publishButtons, '发布按钮');
    if (btn) return btn;
    if (await page.locator('xhs-publish-btn:visible').count()) {
      throw new Error('当前页面使用复合发布控件，无法唯一定位可点击的「发布」按钮');
    }
    return null;
  });
  await button.click({ trial: true, timeout });
  await onStage('ready-to-publish');
  return button;
}
