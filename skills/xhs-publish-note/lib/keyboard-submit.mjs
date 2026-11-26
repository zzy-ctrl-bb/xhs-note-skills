// Browser accessibility may expose buttons inside a native/custom control even
// when a DOM locator cannot address the individual button. Use normal Tab/Enter
// only when Chrome exposes exactly one enabled, labelled publishing action.
export async function keyboardSubmitAction(page) {
  const session = await page.context().newCDPSession(page);
  async function target() {
    const { nodes } = await session.send('Accessibility.getFullAXTree');
    const matches = nodes.filter(node => !node.ignored && node.role?.value === 'button'
      && node.name?.value?.trim() === '发布'
      && !node.properties?.some(p => p.name === 'disabled' && p.value?.value === true));
    return matches.length === 1 ? matches[0] : null;
  }
  try {
    await session.send('Accessibility.enable');
    if (!await target()) { await session.detach(); return null; }
    return {
      async click() {
        try {
          for (let i = 0; i < 65; i++) {
            const url = new URL(page.url());
            if (url.origin !== 'https://creator.xiaohongshu.com' || url.pathname !== '/publish/publish') break;
            const button = await target();
            if (!button) break;
            if (button.properties?.some(p => p.name === 'focused' && p.value?.value === true)) {
              await page.keyboard.press('Enter');
              return;
            }
            await page.keyboard.press('Tab');
          }
          throw new Error('键盘导航未聚焦唯一的「发布」按钮。');
        } finally {
          await session.detach().catch(() => {});
        }
      },
    };
  } catch (error) {
    await session.detach().catch(() => {});
    throw error;
  }
}
