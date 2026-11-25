// keeping the current workspace's tabs in the main window and moving (not closing) every
// other workspace's tabs into one minimized "parking" window; pinned tabs never move.
// a workspace is "warm" while its tabs exist as real tabs and "cold" when it is only a
// saved URL list, which is the case for all but the current one after a browser restart

importScripts('palette.js');

const PARKING_URL = chrome.runtime.getURL('parking.html');
const HOME_URL = chrome.runtime.getURL('home.html');
const COLORS = PALETTE.length;
const EMPTY = {
  workspaces: [],      // { id, name, color, tabs: [{ id, url, title, active }], links: [{ url, title }] }
  activeId: null,
  lastId: null,
  mainWindowId: null,
  parkWindowId: null,
  parkTabId: null,
  parked: {},          // tabId -> workspace id
  focus: {},           // workspace id -> tab id that was active when parked
  warm: {},            // workspace id -> true
};

async function load() {
  const { state } = await chrome.storage.local.get('state');
  return { ...EMPTY, ...state };
}

function save(st) {
  return chrome.storage.local.set({ state: st });
}

let chain = Promise.resolve();
function queue(fn) {
  const next = chain.then(fn);
  chain = next.catch((e) => console.error('[workspaces]', e));
  return next;
}

async function windowExists(id) {
  if (id == null) return false;
  try {
    await chrome.windows.get(id);
    return true;
  } catch {
    return false;
  }
}

async function getTab(id) {
  if (id == null) return null;
  try {
    return await chrome.tabs.get(id);
  } catch {
    return null;
  }
}

const tabUrl = (t) => t.pendingUrl || t.url || '';
const isBlank = (t) => /^([a-z-]+:\/\/newtab\/?|about:blank)$/.test(tabUrl(t));
const isHome = (t) => tabUrl(t).startsWith(HOME_URL);
const findWs = (st, id) => st.workspaces.find((w) => w.id === id);
const where = (st, wsId) => (wsId === st.activeId ? 'main' : st.warm[wsId] ? 'park' : 'cold');

// extension URLs are not valid match patterns, so filtering by hand
async function findTabs(prefix) {
  return (await chrome.tabs.query({})).filter((t) => tabUrl(t).startsWith(prefix));
}

async function ensurePark(st) {
  if (await windowExists(st.parkWindowId)) {
    if (!(await getTab(st.parkTabId))) {
      const marker = await chrome.tabs.create({ windowId: st.parkWindowId, url: PARKING_URL, index: 0, active: false });
      st.parkTabId = marker.id;
    }
    return;
  }
  const w = await chrome.windows.create({ url: PARKING_URL, focused: false });
  // macOS ignores state: 'minimized' on create, so minimizing after the fact
  await chrome.windows.update(w.id, { state: 'minimized' });
  st.parkWindowId = w.id;
  st.parkTabId = w.tabs[0].id;
  st.parked = {};
}

async function hidePark(st) {
  const w = await chrome.windows.get(st.parkWindowId).catch(() => null);
  if (w && w.state !== 'minimized') await chrome.windows.update(w.id, { state: 'minimized' });
}

// some browsers (Helium, for one) copy pinned tabs into every window and recreate any copy
// that is closed, so managing only the main window's copy and leaving the others alone
async function ensureHome(st) {
  let home = (await findTabs(HOME_URL)).find((t) => t.windowId === st.mainWindowId);
  if (!home) {
    return chrome.tabs.create({ windowId: st.mainWindowId, url: HOME_URL, pinned: true, index: 0, active: false });
  }
  if (!home.pinned) home = await chrome.tabs.update(home.id, { pinned: true });
  if (home.index !== 0) home = await chrome.tabs.move(home.id, { index: 0 });
  return home;
}

async function pickNormalWindow(st) {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const usable = wins.filter((w) => w.id !== st.parkWindowId);
  return usable.find((w) => w.focused) || usable[0] || (await chrome.windows.create({}));
}

async function parkedTabs(st, wsId) {
  if (!(await windowExists(st.parkWindowId))) return [];
  const tabs = await chrome.tabs.query({ windowId: st.parkWindowId });
  return tabs.filter((t) => st.parked[t.id] === wsId);
}

async function restoreCold(ws, windowId) {
  const ids = [];
  let activeId = null;
  for (const saved of ws.tabs) {
    const t = await chrome.tabs.create({ windowId, url: saved.url, active: false });
    ids.push(t.id);
    if (saved.active) activeId = t.id;
  }
  return { ids, activeId: activeId ?? ids[0] };
}

async function focusTab(windowId, { url, tabId } = {}) {
  const tab = (await getTab(tabId)) || (url && (await chrome.tabs.query({ windowId })).find((t) => tabUrl(t) === url));
  if (tab && tab.windowId === windowId) await chrome.tabs.update(tab.id, { active: true });
}

async function switchTo(targetId, { url, tabId, stay = false } = {}) {
  const st = await load();
  const target = findWs(st, targetId);
  if (!target) return;
  const mainOk = await windowExists(st.mainWindowId);

  if (mainOk && targetId === st.activeId) {
    if (!stay) await focusTab(st.mainWindowId, { url, tabId });
    await chrome.windows.update(st.mainWindowId, { focused: true });
    return;
  }

  // keeping the saved list of a workspace whose window was closed
  if (!mainOk) delete st.warm[st.activeId];
  const mainId = mainOk ? st.mainWindowId : (await pickNormalWindow(st)).id;
  st.mainWindowId = mainId;
  const current = (await chrome.tabs.query({ windowId: mainId, pinned: false })).filter((t) => !isHome(t));
  const wasActive = current.find((t) => t.active);

  // showing home while tabs swap, so no other page flashes past in between
  const home = await ensureHome(st);
  await chrome.tabs.update(home.id, { active: true });

  if (mainOk && current.length) {
    await ensurePark(st);
    const outgoing = current.map((t) => t.id);
    await chrome.tabs.move(outgoing, { windowId: st.parkWindowId, index: -1 });
    outgoing.forEach((id) => (st.parked[id] = st.activeId));
    st.focus[st.activeId] = (wasActive || current[0]).id;
  } else if (!mainOk && current.length === 1 && isBlank(current[0])) {
    // dropping a fresh window's lone new tab page; any other loose tabs join the target
    await chrome.tabs.remove(current[0].id);
  }

  let focusId = null;
  const live = await parkedTabs(st, targetId);
  if (live.length) {
    const incoming = live.map((t) => t.id);
    await chrome.tabs.move(incoming, { windowId: mainId, index: -1 });
    incoming.forEach((id) => delete st.parked[id]);
    focusId = incoming.includes(st.focus[targetId]) ? st.focus[targetId] : incoming[0];
  } else if (target.tabs.length) {
    ({ activeId: focusId } = await restoreCold(target, mainId));
  }

  if (mainOk) st.lastId = st.activeId;
  st.activeId = targetId;
  st.warm[targetId] = true;
  if (focusId) st.focus[targetId] = focusId;
  await save(st);
  // with "stay", the workspaces page remains in front and the switch happens behind it
  if (!stay) {
    if (focusId) await chrome.tabs.update(focusId, { active: true });
    await focusTab(mainId, { url, tabId });
  }
  if (st.parkWindowId != null) await hidePark(st);
  await chrome.windows.update(mainId, { focused: true });
  await snapshot();
}

const toSaved = (t, activeId) => ({ id: t.id, url: tabUrl(t), title: t.title || tabUrl(t), active: t.id === activeId });

async function snapshot() {
  const { ready } = await chrome.storage.session.get('ready');
  if (!ready) return;
  const st = await load();
  const before = JSON.stringify(st);
  const mainOk = await windowExists(st.mainWindowId);
  const parkOk = await windowExists(st.parkWindowId);
  const parkTabs = parkOk ? await chrome.tabs.query({ windowId: st.parkWindowId }) : [];
  const alive = new Set(parkTabs.map((t) => t.id));
  for (const id of Object.keys(st.parked)) if (!alive.has(+id)) delete st.parked[id];

  for (const ws of st.workspaces) {
    if (ws.id === st.activeId) {
      if (!mainOk) continue;
      const tabs = (await chrome.tabs.query({ windowId: st.mainWindowId, pinned: false })).filter((t) => !isHome(t));
      const active = tabs.find((t) => t.active);
      ws.tabs = tabs.map((t) => toSaved(t, active?.id ?? st.focus[ws.id]));
      if (active) st.focus[ws.id] = active.id;
    } else if (st.warm[ws.id] && parkOk) {
      const tabs = parkTabs.filter((t) => st.parked[t.id] === ws.id);
      ws.tabs = tabs.map((t) => toSaved(t, st.focus[ws.id]));
    }
  }
  if (JSON.stringify(st) !== before) await save(st);
}

let snapshotTimer;
function scheduleSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => queue(snapshot), 250);
}

async function createWorkspace(name, { switchNow = false, color } = {}) {
  const st = await load();
  const used = new Set(st.workspaces.map((w) => w.color));
  const fallback = [...Array(COLORS).keys()].find((c) => !used.has(c)) ?? st.workspaces.length % COLORS;
  const ws = {
    id: crypto.randomUUID(),
    name: name.trim() || `Workspace ${st.workspaces.length + 1}`,
    color: Number.isInteger(color) ? color : fallback,
    tabs: [],
    links: [],
  };
  st.workspaces.push(ws);
  await save(st);
  if (switchNow) await switchTo(ws.id);
  return ws.id;
}

async function deleteWorkspace(id) {
  let st = await load();
  if (st.workspaces.length < 2) return;
  if (id === st.activeId) {
    const fallback = findWs(st, st.lastId && st.lastId !== id ? st.lastId : null) || st.workspaces.find((w) => w.id !== id);
    await switchTo(fallback.id);
    st = await load();
  }
  const doomed = (await parkedTabs(st, id)).map((t) => t.id);
  if (doomed.length) await chrome.tabs.remove(doomed);
  doomed.forEach((t) => delete st.parked[t]);
  st.workspaces = st.workspaces.filter((w) => w.id !== id);
  delete st.focus[id];
  delete st.warm[id];
  if (st.lastId === id) st.lastId = null;
  await save(st);
}

async function updateWorkspace(id, changes) {
  const st = await load();
  const ws = findWs(st, id);
  if (!ws) return;
  if (typeof changes.name === 'string' && changes.name.trim()) ws.name = changes.name.trim();
  if (Number.isInteger(changes.color)) ws.color = ((changes.color % COLORS) + COLORS) % COLORS;
  await save(st);
}

async function reorder(ids) {
  const st = await load();
  const byId = new Map(st.workspaces.map((w) => [w.id, w]));
  st.workspaces = ids.map((id) => byId.get(id)).filter(Boolean);
  await save(st);
}

// moving an open tab into workspace `to`, wherever that workspace's tabs currently are
async function placeLive(st, tab, to) {
  const dest = where(st, to);
  if (dest === 'main') {
    await chrome.tabs.move(tab.id, { windowId: st.mainWindowId, index: -1 });
    delete st.parked[tab.id];
  } else if (dest === 'park') {
    await ensurePark(st);
    await chrome.tabs.move(tab.id, { windowId: st.parkWindowId, index: -1 });
    st.parked[tab.id] = to;
    await hidePark(st);
  } else {
    findWs(st, to).tabs.push({ url: tabUrl(tab), title: tab.title || tabUrl(tab), active: false });
    delete st.parked[tab.id];
    await chrome.tabs.remove(tab.id);
  }
}

// adding a page that has no open tab yet (a saved entry or a new link)
async function placeNew(st, entry, to) {
  const dest = where(st, to);
  if (dest === 'main') {
    await chrome.tabs.create({ windowId: st.mainWindowId, url: entry.url, active: false });
  } else if (dest === 'park') {
    await ensurePark(st);
    const t = await chrome.tabs.create({ windowId: st.parkWindowId, url: entry.url, active: false });
    st.parked[t.id] = to;
    await hidePark(st);
  } else {
    findWs(st, to).tabs.push({ url: entry.url, title: entry.title || entry.url, active: false });
  }
}

async function liveTabOf(st, entry) {
  const tab = await getTab(entry?.id);
  return tab && (tab.windowId === st.mainWindowId || st.parked[tab.id]) ? tab : null;
}

async function moveTab(tabId, to) {
  const st = await load();
  const tab = await getTab(tabId);
  if (!tab || tab.pinned || !findWs(st, to) || to === st.activeId || tab.windowId !== st.mainWindowId) return;
  await placeLive(st, tab, to);
  await save(st);
  await snapshot();
}

async function moveSavedTab(from, index, to) {
  const st = await load();
  const src = findWs(st, from);
  const entry = src?.tabs[index];
  if (!entry || !findWs(st, to) || from === to) return;
  const tab = await liveTabOf(st, entry);
  if (tab) {
    await placeLive(st, tab, to);
  } else {
    src.tabs.splice(index, 1);
    await placeNew(st, entry, to);
  }
  await save(st);
  await snapshot();
}

async function closeSavedTab(wsId, index) {
  const st = await load();
  const ws = findWs(st, wsId);
  const entry = ws?.tabs[index];
  if (!entry) return;
  const tab = await liveTabOf(st, entry);
  if (tab) {
    delete st.parked[tab.id];
    await chrome.tabs.remove(tab.id);
  } else {
    ws.tabs.splice(index, 1);
  }
  await save(st);
  await snapshot();
}

function normalizeUrl(input) {
  const s = input.trim();
  let url = `https://kagi.com/search?q=${encodeURIComponent(s)}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) url = s;
  else if (/^[^\s]+\.[^\s]+$/.test(s)) url = `https://${s}`;
  // matching the browser's own form (e.g. a trailing slash) so open tabs can be recognised
  try { return new URL(url).href; } catch { return url; }
}

async function addLink(wsId, input) {
  const st = await load();
  if (!findWs(st, wsId) || !input.trim()) return;
  const url = normalizeUrl(input);
  await placeNew(st, { url, title: url }, wsId);
  await save(st);
  await snapshot();
}

async function addQuickLink(wsId, input, title) {
  const st = await load();
  const ws = findWs(st, wsId);
  if (!ws || !input?.trim()) return;
  const url = normalizeUrl(input);
  ws.links = ws.links || [];
  if (ws.links.some((l) => l.url === url)) return;
  let name = title;
  if (!name) { try { name = new URL(url).host.replace(/^www\./, ''); } catch { name = url; } }
  ws.links.push({ url, title: name });
  await save(st);
}

async function removeQuickLink(wsId, url) {
  const st = await load();
  const ws = findWs(st, wsId);
  if (!ws?.links) return;
  ws.links = ws.links.filter((l) => l.url !== url);
  await save(st);
}

async function renameQuickLink(wsId, url, title) {
  const st = await load();
  const link = findWs(st, wsId)?.links?.find((l) => l.url === url);
  if (!link || !title?.trim()) return;
  link.title = title.trim();
  await save(st);
}

async function openQuickLink(wsId, url) {
  await switchTo(wsId, { stay: true });
  const st = await load();
  const same = (await chrome.tabs.query({ windowId: st.mainWindowId })).find((t) => tabUrl(t) === url);
  if (same) await chrome.tabs.update(same.id, { active: true });
  else await chrome.tabs.create({ windowId: st.mainWindowId, url, active: true });
  await chrome.windows.update(st.mainWindowId, { focused: true });
}

async function openHome() {
  let st = await load();
  if (!(await windowExists(st.mainWindowId))) {
    await switchTo(st.activeId || st.workspaces[0]?.id);
    st = await load();
  }
  const home = await ensureHome(st);
  await chrome.tabs.update(home.id, { active: true });
  await chrome.windows.update(st.mainWindowId, { focused: true });
  // letting the page drop focus from its fields so number keys work right away
  chrome.runtime.sendMessage({ type: 'home-opened' }).catch(() => {});
}

async function waitForNormalWindow() {
  for (let i = 0; i < 20; i++) {
    if ((await chrome.windows.getAll({ windowTypes: ['normal'] })).length) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function init() {
  if ((await chrome.storage.session.get('ready')).ready) return;
  await waitForNormalWindow();
  const st = await load();
  if (!st.workspaces.length) return firstRun();
  // window ids are never reused, so if a remembered window still exists this is
  // the same browser session (the extension was just reloaded or updated)
  const sameSession = (await windowExists(st.mainWindowId)) || (await windowExists(st.parkWindowId));
  return sameSession ? resume(st) : onBrowserStart(st);
}

async function onBrowserStart(st) {
  Object.assign(st, { mainWindowId: null, parkWindowId: null, parkTabId: null, parked: {}, focus: {}, warm: {} });
  st.workspaces.forEach((ws) => ws.tabs.forEach((t) => delete t.id));

  // closing the old parking window the browser restores with "continue where you left off"
  const oldMarkers = await findTabs(PARKING_URL);
  for (const wid of new Set(oldMarkers.map((t) => t.windowId))) await chrome.windows.remove(wid);

  await save(st);
  await chrome.storage.session.set({ ready: true });
  if (oldMarkers.length) {
    st.mainWindowId = (await pickNormalWindow(st)).id;
    st.warm[st.activeId] = true;
    await ensureHome(st);
    await save(st);
    await snapshot();
  } else {
    await switchTo(st.activeId || st.workspaces[0].id);
  }
}

async function firstRun() {
  await chrome.storage.session.set({ ready: true });
  const st = await load();
  const w = await pickNormalWindow(st);
  const id = await createWorkspace('Main');
  const fresh = await load();
  Object.assign(fresh, { activeId: id, mainWindowId: w.id, warm: { [id]: true } });
  await ensureHome(fresh);
  await save(fresh);
  await snapshot();
}

async function resume(st) {
  await chrome.storage.session.set({ ready: true });
  if (await windowExists(st.parkWindowId)) await ensurePark(st);
  if (await windowExists(st.mainWindowId)) await ensureHome(st);
  await save(st);
  await snapshot();
}

async function switchToIndex(i) {
  const st = await load();
  if (st.workspaces[i]) await switchTo(st.workspaces[i].id);
}

async function previous() {
  const st = await load();
  if (st.lastId) await switchTo(st.lastId);
}

function drawTile(ws, size) {
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = PALETTE[ws.color ?? 0];
  g.beginPath();
  g.roundRect(0, 0, size, size, size * 0.28);
  g.fill();
  g.fillStyle = INK;
  g.font = `600 ${Math.round(size * 0.62)}px -apple-system, system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(initial(ws.name), size / 2, size / 2 + size * 0.05);
  return g.getImageData(0, 0, size, size);
}

async function updateIcon() {
  const st = await load();
  const ws = findWs(st, st.activeId);
  if (!ws) return;
  await chrome.action.setIcon({ imageData: { 16: drawTile(ws, 16), 32: drawTile(ws, 32) } });
  await chrome.action.setTitle({ title: `Workspace: ${ws.name}` });
}

async function rebuildMenus() {
  const st = await load();
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'move', title: 'Move tab to workspace', contexts: ['page'] });
  for (const ws of st.workspaces) {
    if (ws.id === st.activeId) continue;
    chrome.contextMenus.create({ id: `move:${ws.id}`, parentId: 'move', title: ws.name, contexts: ['page'] });
  }
}

const handlers = {
  switch: (m) => switchTo(m.id, { url: m.url, tabId: m.tabId, stay: !!m.stay }),
  create: (m) => createWorkspace(m.name || '', { color: m.color, switchNow: !!m.switchNow }),
  delete: (m) => deleteWorkspace(m.id),
  update: (m) => updateWorkspace(m.id, m.changes),
  reorder: (m) => reorder(m.ids),
  moveSavedTab: (m) => moveSavedTab(m.from, m.index, m.to),
  closeSavedTab: (m) => closeSavedTab(m.ws, m.index),
  addLink: (m) => addLink(m.ws, m.url),
  addQuickLink: (m) => addQuickLink(m.ws, m.url, m.title),
  removeQuickLink: (m) => removeQuickLink(m.ws, m.url),
  renameQuickLink: (m) => renameQuickLink(m.ws, m.url, m.title),
  openQuickLink: (m) => openQuickLink(m.ws, m.url),
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  queue(() => handler(msg)).then((value) => reply({ ok: true, value }), (e) => reply({ ok: false, error: String(e) }));
  return true;
});

chrome.action.onClicked.addListener(() => queue(openHome));

chrome.commands.onCommand.addListener((command) => {
  if (command === 'previous-workspace') return queue(previous);
  const m = /^workspace-(\d)$/.exec(command);
  if (m) queue(() => switchToIndex(+m[1] - 1));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId.startsWith('move:') && tab) queue(() => moveTab(tab.id, info.menuItemId.slice(5)));
});

// running init on every service worker wake-up, before any queued event
queue(init);
queue(updateIcon);
chrome.runtime.onInstalled.addListener(() => queue(rebuildMenus));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.state) return;
  const key = (s) => JSON.stringify([s?.activeId, s?.workspaces?.map((w) => [w.id, w.name, w.color])]);
  if (key(changes.state.oldValue) !== key(changes.state.newValue)) {
    queue(rebuildMenus);
    queue(updateIcon);
  }
});

chrome.tabs.onCreated.addListener(scheduleSnapshot);
chrome.tabs.onMoved.addListener(scheduleSnapshot);
chrome.tabs.onAttached.addListener(scheduleSnapshot);
chrome.tabs.onDetached.addListener(scheduleSnapshot);
chrome.tabs.onActivated.addListener(scheduleSnapshot);
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  // ignoring the workspaces page's own title and icon updates
  if (isHome(tab)) return;
  if (change.url || change.title || change.favIconUrl || change.pinned !== undefined) scheduleSnapshot();
});
chrome.tabs.onRemoved.addListener((_id, info) => {
  // skipping window closes, so quitting the browser never wipes saved workspaces
  if (!info.isWindowClosing) scheduleSnapshot();
});
chrome.tabs.onReplaced.addListener((added, removed) =>
  queue(async () => {
    const st = await load();
    if (st.parked[removed]) {
      st.parked[added] = st.parked[removed];
      delete st.parked[removed];
    }
    for (const [ws, id] of Object.entries(st.focus)) if (id === removed) st.focus[ws] = added;
    await save(st);
  })
);
chrome.windows.onRemoved.addListener((windowId) =>
  queue(async () => {
    const st = await load();
    if (windowId !== st.parkWindowId) return;
    // falling back to the saved URL lists of the workspaces that were parked
    for (const wsId of Object.values(st.parked)) delete st.warm[wsId];
    Object.assign(st, { parkWindowId: null, parkTabId: null, parked: {} });
    await save(st);
  })
);
