// The creator center's sidebar offers a separate, user-facing menu of post types.
export async function openImageEntry(page) {
  const current = new URL(page.url());
  if (current.origin !== 'https://creator.xiaohongshu.com' || current.pathname !== '/publish/publish') return false;
  const menu = page.locator('.publish-video').getByText('发布笔记', { exact: true }).filter({ visible: true });
  if (await menu.count() !== 1) return false;
  const popup = page.locator('.publish-video-popover').filter({ visible: true });
  if (await popup.count() === 0) {
    await menu.hover({ timeout: 4000 });
    try {
      await popup.waitFor({ state: 'visible', timeout: 1200 });
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      await menu.click({ timeout: 4000 });
      await popup.waitFor({ state: 'visible', timeout: 4000 });
    }
  }
  const entry = popup.getByText('上传图文', { exact: true }).filter({ visible: true });
  if (await popup.count() !== 1 || await entry.count() !== 1) return false;
  await entry.click({ timeout: 5000 });
  return true;
}
