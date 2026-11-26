const creatorOrigin = 'https://creator.xiaohongshu.com';

function inspectManagementList({ title, account }) {
  if (location.origin !== 'https://creator.xiaohongshu.com') return { error: '已离开小红书创作者中心。' };
  const visible = el => !!el.getClientRects().length
    && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !el.closest('[hidden], [aria-hidden=true]');
  const nameSelectors = [
    '.d-topbar .user-info .name-box', 'header .user-name', 'header .user-info .nickname',
    '[role=banner] [data-testid="account-name"]',
  ];
  const names = [...new Set([...document.querySelectorAll(nameSelectors.join(','))]
    .filter(visible).map(el => (el.innerText || '').trim().normalize('NFC')).filter(Boolean))];
  if (names.length && (names.length !== 1 || names[0] !== account)) return { error: '管理页的顶栏账号与目标不符。' };

  const inManagement = /(?:manage|manager)/iu.test(location.pathname)
    || [...document.querySelectorAll('main h1, main h2, [role=main] [role=heading], .page-title')]
      .some(el => visible(el) && el.innerText.trim() === '笔记管理');
  if (!inManagement || !names.length) return null;

  const cardSelectors = [
    'article', 'tr', '[role=row]', '.note-item', '.note-card', '.note', '.note-wrapper',
    '.note-manage-item', '.note-manager-item', '.content-card', '.list-item', 'li',
    '[data-testid="note-card"]',
  ].join(',');
  const titleSelectors = [
    'h2', 'h3', 'h4', '[role=heading]', '[class*="title" i]', '[data-testid="note-title"]',
    'a[href*="/explore/"]', 'a[href*="/discovery/item/"]',
  ].join(',');
  const excluded = 'header,nav,aside,[role=navigation],.d-topbar,form,[role=dialog],[role=menu],textarea,[contenteditable]';
  const cards = new Set();
  let unscopedTitles = 0;
  const all = [...document.querySelectorAll(titleSelectors)].filter(el =>
    visible(el) && !el.closest(excluded) && (el.innerText || '').trim().normalize('NFC') === title);
  for (const el of all) {
    if (all.some(other => other !== el && el.contains(other))) continue;
    const card = el.closest(cardSelectors);
    if (card) cards.add(card);
    else unscopedTitles++;
  }
  const matches = [];
  for (const card of cards) {
    // Only collect values from the matched card. Status controls, menus and tab labels
    // can describe a possible action instead of the note's current status.
    const labels = [...card.querySelectorAll('time, span, div, p, small, label, td, em, strong')].filter(el =>
      visible(el) && !el.closest('button,[role=button],[role=tab],[role=menuitem],[role=menu],.dropdown')
      && ![...el.children].some(child => visible(child) && child.innerText?.trim()));
    const lines = [...new Set(labels.map(el => el.innerText.trim()).filter(value => value && value !== title))];
    const statuses = lines.filter(value => /^(?:(?:笔记状态|可见范围|可见性)\s*[：:]\s*)?(?:审核中|审核通过|审核未通过|审核不通过|待审核|已发布|已公开|公开|公开可见|所有人可见|仅自己可见|仅我可见|私密|已隐藏|已下架|已定时|定时发布中|已发布仅自己可见)$/u.test(value));
    const times = lines.filter(value => /^(?:(?:发布|更新|创建)(?:于|时间)?\s*[：:]?\s*)?(?:\d{4}[-./年]\d{1,2}[-./月]\d{1,2}日?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}[-./月]\d{1,2}日?(?:\s+\d{1,2}:\d{2})?|(?:刚刚|今天|昨天)(?:\s*\d{1,2}:\d{2})?|\d+\s*(?:分钟|小时|天)前)$/u.test(value));
    const links = new Map();
    for (const el of card.querySelectorAll('a[href]')) {
      if (!visible(el)) continue;
      const url = new URL(el.href);
      if (!['https://www.xiaohongshu.com', 'https://xiaohongshu.com'].includes(url.origin) || url.username || url.password) continue;
      const match = url.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f\d]{24})\/?$/iu);
      if (match) links.set(match[1], url.href);
    }
    const ids = new Set(links.keys());
    for (const line of lines) {
      const idLabel = line.match(/^笔记\s*ID\s*[：:]\s*([a-f\d]{24})$/iu);
      if (idLabel) ids.add(idLabel[1]);
    }
    const noteId = ids.size === 1 ? [...ids][0] : null;
    const publicUrl = links.get(noteId) ?? null;
    matches.push({ title, statuses, times, publicUrl, noteId });
  }
  const loading = [...document.querySelectorAll('[aria-busy=true], [role=progressbar], main .loading, .list-loading')]
    .some(visible);
  return { matches, unscopedTitles, loading };
}

export async function findManagedNote(page, { account, title, timeout = 30000, statusFilter } = {}) {
  if (!account?.trim() || !title?.trim()) throw new Error('管理页核查需要指定账号和完整标题。');
  if (new URL(page.url()).origin !== creatorOrigin) throw new Error('请从已核对账号的小红书创作者中心进入笔记管理。');
  const expected = { account: account.trim().normalize('NFC'), title: title.trim().normalize('NFC') };
  if (statusFilter && !['已发布', '审核中'].includes(statusFilter)) throw new Error('仅支持已发布或审核中分栏。');
  if (!/manage/iu.test(new URL(page.url()).pathname)) {
    const nav = page.getByText('笔记管理', { exact: true }).filter({ visible: true });
    await nav.first().waitFor({ state: 'visible', timeout });
    if (await nav.count() !== 1) throw new Error('无法唯一定位「笔记管理」入口，已停止核查。');
    await nav.click({ timeout });
  }

  // The site keeps its filter tabs outside the individual note cards. Switch only through
  // a visible tab in that strip and confirm its selected state before inspecting records.
  let filter, priorTitle;
  if (statusFilter) {
    const filterByName = name => page.locator('.tab-list .tab-item, [role=tablist] [role=tab]')
      .filter({ hasText: new RegExp('^\\s*' + name + '\\s*(?:[（(]\\d+[)）])?\\s*$'), visible: true });
    filter = filterByName(statusFilter);
    await filter.first().waitFor({ state: 'visible', timeout });
    if (await filter.count() !== 1) throw new Error('管理页筛选分栏不唯一。');
    // The live list can finish its initial load after the tab strip appears and reset
    // the selection to “全部”. Wait until a card or the site's empty state is visible.
    const siteList = page.locator('.notes-container').filter({ visible: true });
    if (await siteList.count() === 1) {
      const ready = siteList.locator('.note-card, [class*="empty"], [class*="no-data"]')
        .filter({ visible: true }).first();
      await ready.waitFor({ state: 'visible', timeout });
    }
    if (!await filterSelected(filter)) {
      const visibleTitle = page.getByText(expected.title, { exact: true }).filter({ visible: true });
      if (await visibleTitle.count() === 1) {
        priorTitle = await visibleTitle.elementHandle();
        // A framework can reuse an identical DOM node from the “全部” list. When the
        // opposite official filter exists, let the old title disappear before testing
        // the requested tab, just as a creator can cross-check the two lists.
        const opposite = filterByName(statusFilter === '已发布' ? '审核中' : '已发布');
        if (await opposite.count() === 1) {
          if (!await filterSelected(opposite)) await opposite.click({ timeout });
          try {
            await visibleTitle.waitFor({ state: 'hidden', timeout: Math.min(timeout, 5000) });
            if (await filterSelected(opposite)) {
              await priorTitle.dispose();
              priorTitle = null;
            }
          } catch (error) {
            if (error.name !== 'TimeoutError') throw error;
          }
        }
      }
    }
    await filter.click({ timeout });
  }

  const deadline = Date.now() + timeout;
  let latest, signature, unchangedSince;
  do {
    try {
      latest = await page.evaluate(inspectManagementList, expected);
    } catch (error) {
      if (page.isClosed() || !/Execution context was destroyed|Cannot find context/iu.test(error.message)) throw error;
    }
    if (latest?.error) throw new Error(latest.error);
    if (filter && !await filterSelected(filter)) latest = null;
    if (priorTitle && latest) {
      const remains = await priorTitle.evaluate(el => el.isConnected && el.getClientRects().length > 0);
      if (!remains || !(latest.matches.length || latest.unscopedTitles)) {
        await priorTitle.dispose();
        priorTitle = null;
      }
    }
    if (latest && !priorTitle && !latest.loading && (latest.matches.length || latest.unscopedTitles)) {
      const current = JSON.stringify(latest);
      if (current !== signature) {
        signature = current;
        unchangedSince = Date.now();
      } else if (Date.now() - unchangedSince >= 700) break;
    } else {
      signature = null;
    }
    if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(300, deadline - Date.now())));
  } while (Date.now() < deadline);
  const reusedPriorTitle = Boolean(priorTitle);
  await priorTitle?.dispose();
  if (!latest || latest.loading) throw new Error('未能在目标账号的笔记管理页核对顶栏与已加载的列表。');
  const { matches, unscopedTitles } = latest;
  const matchCount = matches.length + unscopedTitles;
  let outcome = 'not-found';
  if (matchCount > 1) outcome = 'ambiguous';
  else if (unscopedTitles || (matchCount && reusedPriorTitle)) outcome = 'unverified';
  else if (matches.length === 1) outcome = 'found';
  return { outcome, matchCount, matches, unscopedTitles, scope: 'visible-management-list', ...(statusFilter ? { statusFilter } : {}) };
}

async function filterSelected(filter) {
  return filter.evaluateAll(nodes => nodes.length === 1 && (
    nodes[0].getAttribute('aria-selected') === 'true' ||
    [...nodes[0].classList].some(token => /^(?:active|selected|(?:tab-item|is)(?:--?)(?:active|selected))$/u.test(token))
  ));
}

// Creator Center displays Beijing time to the minute. A date-only label or
// an unrelated update time cannot identify this submission.
export function matchSubmission(lookup, note, receipt) {
  if (!['已发布','审核中'].includes(lookup?.statusFilter) || lookup.outcome!=='found' ||
      lookup.matchCount!==1 || lookup.matches?.length!==1 || lookup.matches[0].title!==note.title ||
      !['pending','unknown','submitted'].includes(receipt?.status) || receipt.title!==note.title ||
      receipt.fingerprint!==note.fingerprint) return false;
  const statuses=lookup.matches[0].statuses??[];
  if(statuses.some(s=>/审核(?:未通过|不通过)|已隐藏|已下架|已定时|定时发布中|私密|仅(?:自己|我)可见/u.test(s)) ||
     lookup.statusFilter==='已发布' && statuses.some(s=>/审核中|待审核/u.test(s))) return false;
  const start=Date.parse(receipt.createdAt);
  const finish=Date.parse(receipt.updatedAt);
  const end=!receipt.reconciled && finish>=start && finish-start<=120000 ? finish : start;
  return lookup.matches[0].times.some(label=>{
    const fields=label.match(/^(?:发布(?:于|时间)?\s*[:：]?\s*)?(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::\d{2})?$/u);
    if(!fields)return false;
    const [,year,month,day,hour,minute]=fields;
    const observed=Date.parse(`${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}T${hour.padStart(2,'0')}:${minute}:00+08:00`);
    return observed>=Math.floor(start/60000)*60000 && observed<=end;
  });
}
