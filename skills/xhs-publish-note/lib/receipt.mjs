import { finishSubmission, reserveSubmission } from './jobs.mjs';

// Runs in the browser. A note's own text or a management-list card can say "发布成功".
function readReceipt() {
  if (location.origin !== 'https://creator.xiaohongshu.com') return '';
  const statusRegions = [
    '[role="status"]', '[role="alert"]', '[role="dialog"]', '[aria-live="polite"]',
    '[aria-live="assertive"]', '[class*="toast"]', '[class*="message-content"]',
    '[class*="publish-success"]', '[class*="success-title"]', '[class*="result-title"]',
  ];
  const userContent = 'article,form,[contenteditable],[role="textbox"],.note-preview,.preview-card,.note-card';
  const positiveStatus = /^(?:(?:图文)?笔记)?(?:发布成功|已提交审核|提交成功[，,]\s*等待审核|发布成功[，,]\s*等待审核)[！!。]?$/u;
  for (const node of document.querySelectorAll(statusRegions.join(','))) {
    if (node.closest(userContent) || node.querySelector(userContent)) continue;
    if (!node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || !node.getClientRects().length) continue;
    const text = node.innerText?.trim();
    if (text && positiveStatus.test(text)) return text;
  }
  return '';
}

export async function existingReceipt(page) {
  return page.evaluate(readReceipt);
}

export async function waitForReceipt(page, timeout = 25000) {
  const result = await page.waitForFunction(readReceipt, undefined, { timeout });
  try {
    return await result.jsonValue();
  } finally {
    await result.dispose();
  }
}

export async function submitOnce({ page, button, stateDir, account, note, runDir, timeout = 25000, onAttempt = () => {} }) {
  if (!button) throw new Error('无法确认唯一且可操作的发布按钮，稿件已停在提交前。');
  if (await existingReceipt(page)) {
    throw new Error('点击前页面已有成功提示，无法区分本次回执，已停止。');
  }
  const reservation = await reserveSubmission(stateDir, account, note);
  let receipt;
  let stage = '记录提交过程';
  try {
    await onAttempt();
    stage = '激活发布按钮';
    await button.click({ timeout: 10000 });
    stage = '等待平台回执';
    receipt = await waitForReceipt(page, timeout);
  } catch (error) {
    const reason = stage + (error.name === 'TimeoutError' ? '超时' : '中断');
    const message = `${reason}，结果待核查。请在同一账号的笔记管理按标题、封面和时间查看，再用 status 和 reconcile 登记核查结果。`;
    try {
      await finishSubmission(reservation, 'unknown', { runDir, reason });
    } catch {
      throw new Error(message + ' 待核查状态写入失败，保留原始提交记录。');
    }
    throw new Error(message + ' 程序已阻止重复提交。');
  }

  try {
    await finishSubmission(reservation, 'submitted', { receipt, runDir });
  } catch {
    throw new Error(`平台已显示「${receipt}」，本地回执写入失败。请查看 status 并核对笔记管理，避免重复提交。`);
  }
  return receipt;
}
