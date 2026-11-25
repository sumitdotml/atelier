import { ICONS, icon, PALETTE, PALETTE_NAMES, el, favicon, initial, loadState, onState, send, tileDataUrl, tint } from './ui.js';

let st = await loadState();
let selectedId = st.activeId;   // the workspace shown on the right, which may not be the current one
let query = '';
let renaming = false;
let addingLink = false;
let renamingLink = null;        // url of the quick link being renamed
let dragging = null;            // { kind: 'tab', from, index } or { kind: 'ws', id }
let blocked = false;            // true while a menu or dialog is open
let pending = false;

const current = () => st.workspaces.find((w) => w.id === st.activeId);
const selected = () => st.workspaces.find((w) => w.id === selectedId) || current() || st.workspaces[0];
const host = (url) => { try { return new URL(url).host || url; } catch { return url; } };
const matchTab = (t) => !query || `${t.title} ${t.url}`.toLowerCase().includes(query);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : word.endsWith('ch') ? 'es' : 's'}`;
const newTabKey = /Mac/.test(navigator.userAgent) ? '⌘T' : 'Ctrl+T';
const J = JSON.stringify;

// showing each position's plain number, with the browser-wide shortcut (if one is set) in the tooltip
const shortcuts = Object.fromEntries((await chrome.commands.getAll()).map((c) => [c.name, c.shortcut]));
const keyHint = (i) => (i < 9 ? String(i + 1) : null);
const keyTitle = (i) => {
  const anywhere = shortcuts[`workspace-${i + 1}`];
  return `Press ${i + 1} on this page` + (anywhere ? `, or ${anywhere} anywhere` : '');
};

const switchTo = (ws, tab) => send({ type: 'switch', id: ws.id, tabId: tab?.id, url: tab?.url });
// switching while keeping this page in front; the tab strip changes behind it
const switchHere = (ws) => { selectedId = ws.id; render(); return send({ type: 'switch', id: ws.id, stay: true }); };
const lastTab = (ws) => ws.tabs.find((t) => t.active) || ws.tabs[0];

function closeLayers() {
  document.querySelectorAll('.menu, .overlay').forEach((n) => n.remove());
  blocked = false;
  flush();
}

function openMenu(anchor, children) {
  // measuring before closeLayers, which may re-render and replace the anchor
  const r = anchor.getBoundingClientRect();
  closeLayers();
  blocked = true;
  const menu = el('div', { className: 'menu', role: 'menu' }, ...children);
  document.body.append(menu);
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + h + 6 > innerHeight ? r.top - h - 6 : r.bottom + 6}px`;
  setTimeout(() => menu.querySelector('.menu-item:not(:disabled)')?.focus(), 0);
}

const menuItem = (label, onSelect, { glyph, danger, disabled, lead } = {}) =>
  el('button', {
    className: 'menu-item' + (danger ? ' danger' : ''),
    disabled,
    onclick: () => { closeLayers(); onSelect(); },
  }, lead || (glyph ? el('span', { html: glyph }) : null), el('span', { textContent: label }));

function swatchRow(chosen, onPick) {
  const row = el('div', { className: 'swatches' });
  PALETTE.forEach((c, i) => row.append(el('button', {
    className: 'swatch' + (i === chosen ? ' on' : ''),
    title: PALETTE_NAMES[i],
    style: { '--c': c },
    onclick: () => {
      row.querySelectorAll('.swatch').forEach((s, j) => s.classList.toggle('on', j === i));
      onPick(i);
    },
  })));
  return row;
}

function openDialog(build) {
  closeLayers();
  blocked = true;
  const dialog = el('div', { className: 'dialog', role: 'dialog' });
  const overlay = el('div', { className: 'overlay', onmousedown: (e) => { if (e.target === overlay) closeLayers(); } }, dialog);
  build(dialog);
  document.body.append(overlay);
  setTimeout(() => dialog.querySelector('input, .btn-primary, .btn-danger')?.focus(), 0);
}

function newWorkspaceDialog() {
  const used = new Set(st.workspaces.map((w) => w.color));
  let color = Math.max(0, PALETTE.findIndex((_, i) => !used.has(i)));
  openDialog((d) => {
    const preview = el('div', { className: 'tile', style: { '--tint': PALETTE[color] }, textContent: '?' });
    const input = el('input', {
      className: 'input',
      placeholder: 'e.g. Research, Reading, Side project',
      spellcheck: false,
      oninput: () => { preview.textContent = input.value.trim() ? initial(input.value) : '?'; },
      onkeydown: (e) => { if (e.key === 'Enter') create(!e.shiftKey); },
    });
    const create = async (switchNow) => {
      const name = input.value.trim();
      if (!name) return input.focus();
      closeLayers();
      selectedId = await send({ type: 'create', name, color, switchNow });
      render();
    };
    d.append(
      el('div', { className: 'dialog-head' },
        preview,
        el('div', {}, el('h2', { textContent: 'New workspace' }), el('p', { textContent: 'A fresh set of tabs you can switch to.' }))),
      input,
      swatchRow(color, (i) => { color = i; preview.style.setProperty('--tint', PALETTE[i]); }),
      el('div', { className: 'dialog-actions' },
        el('button', { className: 'btn btn-ghost', textContent: 'Cancel', onclick: closeLayers }),
        el('button', { className: 'btn btn-outline', textContent: 'Create', onclick: () => create(false) }),
        el('button', { className: 'btn btn-primary', style: { '--tint': 'var(--mauve)' }, textContent: 'Create and switch', onclick: () => create(true) })));
  });
}

function deleteDialog(ws) {
  openDialog((d) => d.append(
    el('h2', { textContent: `Delete “${ws.name}”?` }),
    el('p', { textContent: ws.tabs.length ? `Its ${plural(ws.tabs.length, 'tab')} will be closed. This can't be undone.` : 'It has no tabs.' }),
    el('div', { className: 'dialog-actions' },
      el('button', { className: 'btn btn-outline', textContent: 'Cancel', onclick: closeLayers }),
      el('button', { className: 'btn btn-danger', textContent: 'Delete workspace', onclick: () => { closeLayers(); send({ type: 'delete', id: ws.id }); } }))));
}

function workspaceMenu(anchor, ws) {
  openMenu(anchor, [
    el('div', { className: 'menu-label', textContent: ws.name }),
    menuItem('Rename', () => { renaming = true; render(); }, { glyph: ICONS.edit }),
    el('div', { className: 'menu-sep' }),
    el('div', { className: 'menu-label', textContent: 'Colour' }),
    swatchRow(ws.color ?? 0, (i) => send({ type: 'update', id: ws.id, changes: { color: i } })),
    el('div', { className: 'menu-sep' }),
    menuItem('Delete workspace', () => deleteDialog(ws), { glyph: ICONS.trash, danger: true, disabled: st.workspaces.length < 2 }),
  ]);
}

function moveMenu(anchor, ws, index) {
  const others = st.workspaces.filter((w) => w.id !== ws.id);
  openMenu(anchor, [
    el('div', { className: 'menu-label', textContent: 'Move to' }),
    ...others.map((w) => menuItem(w.name, () => send({ type: 'moveSavedTab', from: ws.id, index, to: w.id }), {
      lead: el('div', { className: 'tile sm', style: { '--tint': tint(w) }, textContent: initial(w.name) }),
    })),
    others.length ? null : el('div', { className: 'menu-label', textContent: 'Create another workspace first' }),
  ]);
}

const indexOf = (id) => st.workspaces.findIndex((w) => w.id === id);
const movingDown = (target) => indexOf(dragging.id) < indexOf(target.id);

function listItem(ws, index) {
  const isCurrent = ws.id === st.activeId;
  const hits = query ? ws.tabs.filter(matchTab).length : 0;
  const shown = ws.tabs.slice(0, 4);
  const item = el('div', {
    className: 'item' + (ws.id === selected()?.id ? ' selected' : '') +
      (query && !hits && !ws.name.toLowerCase().includes(query) ? ' dim' : ''),
    style: { '--tint': tint(ws) },
    title: isCurrent ? `${ws.name}: you are here` : `Switch to ${ws.name}`,
    tabIndex: 0,
    'data-key': `ws:${ws.id}`,
    draggable: true,
    onclick: () => (isCurrent ? ((selectedId = ws.id), render()) : switchHere(ws)),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); } },
    ondblclick: () => switchTo(ws, lastTab(ws)),
    ondragstart: (e) => { dragging = { kind: 'ws', id: ws.id }; e.dataTransfer.effectAllowed = 'move'; item.classList.add('dragging'); },
    ondragend: () => { dragging = null; flush(); },
    ondragover: (e) => {
      if (dragging?.kind === 'tab' && dragging.from !== ws.id) { e.preventDefault(); item.classList.add('drop-target'); }
      if (dragging?.kind === 'ws' && dragging.id !== ws.id) {
        e.preventDefault();
        // landing after the target when dragging downwards, before it when dragging upwards
        item.classList.add(movingDown(ws) ? 'drop-after' : 'drop-before');
      }
    },
    ondragleave: (e) => { if (!item.contains(e.relatedTarget)) item.classList.remove('drop-target', 'drop-before', 'drop-after'); },
    ondrop: (e) => {
      e.preventDefault();
      if (dragging?.kind === 'tab') send({ type: 'moveSavedTab', from: dragging.from, index: dragging.index, to: ws.id });
      if (dragging?.kind === 'ws') {
        const down = movingDown(ws);
        const ids = st.workspaces.map((w) => w.id).filter((id) => id !== dragging.id);
        ids.splice(ids.indexOf(ws.id) + (down ? 1 : 0), 0, dragging.id);
        send({ type: 'reorder', ids });
      }
      dragging = null;
    },
  },
    el('div', { className: 'tile', textContent: initial(ws.name) }),
    el('div', { className: 'item-body' },
      el('div', { className: 'item-row' },
        el('span', { className: 'item-name', textContent: ws.name, title: ws.name }),
        isCurrent ? el('span', { className: 'pill', textContent: 'Current' }) : null,
        keyHint(index) ? el('kbd', { className: 'item-key', textContent: keyHint(index), title: keyTitle(index) }) : null),
      el('div', { className: 'item-meta label' },
        el('span', { textContent: query ? `${plural(hits, 'match')}` : plural(ws.tabs.length, 'tab') }),
        !query && shown.length ? el('span', { className: 'favs' }, shown.map((t) => el('img', { src: favicon(t.url), alt: '' }))) : null)));
  return item;
}

function tabRow(ws, t, index) {
  const saved = (ws.links || []).some((l) => l.url === t.url);
  const row = el('div', {
    className: 'row',
    title: t.url,
    tabIndex: 0,
    'data-key': `tab:${ws.id}:${t.url}`,
    draggable: true,
    onclick: () => switchTo(ws, t),
    onkeydown: (e) => { if (e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); switchTo(ws, t); } },
    ondragstart: (e) => {
      dragging = { kind: 'tab', from: ws.id, index };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/uri-list', t.url);
      row.classList.add('dragging');
    },
    ondragend: () => { dragging = null; row.classList.remove('dragging'); flush(); },
  },
    el('img', { src: favicon(t.url), alt: '' }),
    el('div', { className: 'row-text' },
      el('span', { className: 'row-title', textContent: t.title || t.url }),
      t.active ? el('span', { className: 'dot', style: { '--tint': tint(ws) }, title: 'Last open tab' }) : null,
      el('span', { className: 'row-url label', textContent: host(t.url) })),
    el('div', { className: 'row-actions' },
      el('button', {
        className: 'btn btn-ghost btn-icon' + (saved ? ' on' : ''),
        title: saved ? 'Saved as a quick link (click to remove)' : 'Save as a quick link',
        'data-key': `save:${ws.id}:${t.url}`,
        html: saved ? ICONS.bookmarkSaved : ICONS.bookmarkAdd,
        onclick: (e) => {
          e.stopPropagation();
          send(saved ? { type: 'removeQuickLink', ws: ws.id, url: t.url } : { type: 'addQuickLink', ws: ws.id, url: t.url, title: t.title });
        },
      }),
      el('button', {
        className: 'btn btn-ghost btn-icon',
        title: 'Move to another workspace',
        html: ICONS.move,
        onclick: (e) => { e.stopPropagation(); moveMenu(e.currentTarget, ws, index); },
      }),
      el('button', {
        className: 'btn btn-ghost btn-icon',
        title: 'Close tab',
        html: ICONS.close,
        onclick: (e) => { e.stopPropagation(); send({ type: 'closeSavedTab', ws: ws.id, index }); },
      })));
  return row;
}

function renameInput(ws) {
  const input = el('input', { className: 'input', value: ws.name, spellcheck: false });
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    renaming = false;
    const v = input.value.trim();
    if (commit && v && v !== ws.name) send({ type: 'update', id: ws.id, changes: { name: v } });
    flush();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return input;
}

function addBar(ws) {
  const submit = () => {
    if (!input.value.trim()) return input.focus();
    send({ type: 'addLink', ws: ws.id, url: input.value.trim() });
    input.value = '';
  };
  const input = el('input', {
    id: 'add-link',
    placeholder: 'Add a link or search',
    spellcheck: false,
    onkeydown: (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') input.blur();
    },
    onblur: () => setTimeout(() => { if (pending) flush(); }, 0),
  });
  return el('label', { className: 'add' }, el('span', { html: ICONS.plus }), input, el('kbd', { textContent: '↵' }));
}

function renameChip(ws, l) {
  const input = el('input', { className: 'chip-input', value: l.title, spellcheck: false, 'aria-label': 'Quick link name' });
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    renamingLink = null;
    const v = input.value.trim();
    if (commit && v && v !== l.title) send({ type: 'renameQuickLink', ws: ws.id, url: l.url, title: v });
    flush();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return el('div', { className: 'chip editing', title: l.url }, el('img', { src: favicon(l.url), alt: '' }), input);
}

function quickLinkChips(ws) {
  const links = ws.links || [];
  const chips = links.map((l) => l.url === renamingLink ? renameChip(ws, l) : el('div', {
    className: 'chip',
    title: l.url,
    tabIndex: 0,
    'data-key': `link:${ws.id}:${l.url}`,
    onclick: () => send({ type: 'openQuickLink', ws: ws.id, url: l.url }),
    onkeydown: (e) => { if (e.target.classList.contains('chip') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.target.click(); } },
  },
    el('img', { src: favicon(l.url), alt: '' }),
    el('span', { textContent: l.title }),
    el('button', {
      className: 'chip-x',
      title: 'Rename',
      'data-key': `rename-link:${ws.id}:${l.url}`,
      html: icon('edit', 12),
      onclick: (e) => { e.stopPropagation(); renamingLink = l.url; render(); },
    }),
    el('button', {
      className: 'chip-x',
      title: 'Remove quick link',
      html: icon('close', 12),
      onclick: (e) => { e.stopPropagation(); send({ type: 'removeQuickLink', ws: ws.id, url: l.url }); },
    })));

  let adder;
  if (addingLink) {
    const input = el('input', { className: 'chip-input', placeholder: 'Paste a link', spellcheck: false });
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      addingLink = false;
      if (commit && input.value.trim()) send({ type: 'addQuickLink', ws: ws.id, url: input.value.trim() });
      flush();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
    setTimeout(() => input.focus(), 0);
    adder = el('div', { className: 'chip editing' }, el('span', { html: icon('link', 14) }), input);
  } else {
    adder = el('button', {
      className: 'chip add',
      'data-key': `addlink:${ws.id}`,
      onclick: () => { addingLink = true; render(); },
    }, el('span', { html: icon('plus', 14) }), links.length ? 'Add' : 'Add a quick link');
  }
  return el('div', { className: 'chips' }, chips, adder);
}

function headBlock(ws, index, isCurrent, last) {
  return el('header', { className: 'head' },
    el('div', { className: 'tile xl', textContent: initial(ws.name) }),
    el('div', { className: 'head-text' },
      renaming
        ? renameInput(ws)
        : el('h1', { textContent: ws.name, title: 'Double-click to rename', ondblclick: () => { renaming = true; render(); } }),
      el('div', { className: 'head-meta label' },
        isCurrent ? el('span', { className: 'pill', textContent: 'Current' }) : null,
        el('span', { textContent: plural(ws.tabs.length, 'tab') }),
        keyHint(index) ? el('kbd', { textContent: keyHint(index), title: keyTitle(index) }) : null)),
    el('div', { className: 'head-actions' },
      isCurrent
        ? (last ? el('button', { className: 'btn btn-outline', 'data-key': 'back', title: 'Go to the tab you had open last', onclick: () => switchTo(ws, lastTab(current())) }, 'Back to tabs', el('kbd', { textContent: '↵' })) : null)
        : el('button', { className: 'btn btn-primary', 'data-key': 'switch', onclick: () => switchHere(ws) }, 'Switch'),
      el('button', { className: 'btn btn-ghost btn-icon', 'data-key': 'more', title: 'Rename, colour, delete', html: ICONS.more, onclick: (e) => workspaceMenu(e.currentTarget, ws) })));
}

// rebuilding only the blocks whose signature changed, so a tab that keeps updating its
// title cannot disturb the buttons around it
function detailBlocks(ws) {
  const index = st.workspaces.indexOf(ws);
  const isCurrent = ws.id === st.activeId;
  const last = lastTab(ws);
  const saved = new Set((ws.links || []).map((l) => l.url));
  return [
    { key: 'head', sig: J([ws.id, ws.name, ws.color, index, isCurrent, !!last, ws.tabs.length, renaming]), build: () => headBlock(ws, index, isCurrent, last) },
    { key: 'links-label', sig: '', build: () => el('div', {
        className: 'label section-title',
        title: 'Saved with the workspace, even when its tabs are closed',
        textContent: 'Quick links' }) },
    { key: 'links', sig: J([ws.id, ws.links, addingLink, renamingLink]), build: () => quickLinkChips(ws) },
    { key: 'tabs-label', sig: '', build: () => el('div', {
        className: 'label section-title',
        title: 'Drag a tab onto a workspace in the sidebar to move it',
        textContent: 'Tabs' }) },
    { key: `add:${ws.id}`, sig: '', build: () => addBar(ws) },
    ...(ws.tabs.length
      ? ws.tabs.map((t, i) => ({
          key: `tab:${t.id ?? t.url}:${i}`,
          sig: J([ws.id, t.title, t.url, t.active, saved.has(t.url), i]),
          build: () => tabRow(ws, t, i),
        }))
      : [{ key: 'empty', sig: J([isCurrent]), build: () => el('div', { className: 'empty label', textContent: isCurrent
            ? `No open tabs. Press ${newTabKey}, or add a link above.`
            : 'No open tabs. Add a link above, or drag tabs onto this workspace.' }) }]),
  ];
}

function reconcile(container, blocks) {
  const existing = new Map([...container.children].map((n) => [n.dataset.rk, n]));
  blocks.forEach((b, i) => {
    let node = existing.get(b.key);
    existing.delete(b.key);
    if (!node || node.dataset.sig !== b.sig) {
      const fresh = b.build();
      fresh.dataset.rk = b.key;
      fresh.dataset.sig = b.sig;
      if (node) node.replaceWith(fresh);
      node = fresh;
    }
    if (container.children[i] !== node) container.insertBefore(node, container.children[i] || null);
  });
  existing.forEach((n) => n.remove());
}

function searchView() {
  const groups = st.workspaces
    .map((ws) => ({ ws, hits: ws.tabs.map((t, i) => [t, i]).filter(([t]) => matchTab(t)) }))
    .filter((g) => g.hits.length);
  const total = groups.reduce((n, g) => n + g.hits.length, 0);
  return el('div', { className: 'wrap' },
    el('header', { className: 'head' },
      el('div', { className: 'head-text' },
        el('h1', { textContent: `“${query}”` }),
        el('div', { className: 'head-meta label', textContent: `${plural(total, 'tab')} in ${plural(groups.length, 'workspace')}` }))),
    groups.length
      ? groups.flatMap(({ ws, hits }) => [
          el('div', { className: 'group-head label', style: { '--tint': tint(ws) } },
            el('div', { className: 'tile sm', textContent: initial(ws.name) }),
            el('span', { textContent: ws.name }),
            ws.id === st.activeId ? el('span', { className: 'pill', textContent: 'Current' }) : null),
          ...hits.map(([t, i]) => tabRow(ws, t, i)),
        ])
      : el('div', { className: 'empty label', textContent: 'No tabs match.' }));
}

const items = el('div', { className: 'items' });
const main = el('main', { className: 'main' });
const searchInput = el('input', {
  placeholder: 'Search all tabs',
  spellcheck: false,
  oninput: (e) => { query = e.target.value.trim().toLowerCase(); render(); },
  onkeydown: (e) => {
    if (e.key === 'Escape') { e.target.value = ''; query = ''; render(); e.target.blur(); }
    if (e.key === 'Enter') {
      for (const ws of st.workspaces) {
        const t = ws.tabs.find(matchTab);
        if (t) return switchTo(ws, t);
      }
    }
  },
});

let shownIdentity = '';
let shownSearch = '';
const wrap = el('div', { className: 'wrap' });

function render() {
  const cur = current();
  const identity = cur ? `${cur.name}|${cur.color}` : '';
  if (cur && identity !== shownIdentity) {
    shownIdentity = identity;
    document.title = cur.name;
    document.getElementById('favicon').href = tileDataUrl(cur);
  }
  const focusKey = document.activeElement?.dataset?.key;
  const sel = selected();
  reconcile(items, st.workspaces.map((ws, i) => {
    const hits = query ? ws.tabs.filter(matchTab).length : 0;
    return {
      key: ws.id,
      sig: J([ws.name, ws.color, i, ws.id === st.activeId, ws.id === sel?.id, ws.tabs.length, ws.tabs.slice(0, 4).map((t) => t.url), query, hits]),
      build: () => listItem(ws, i),
    };
  }));

  if (query) {
    const sig = J([query, st.activeId, st.workspaces]);
    if (sig !== shownSearch) {
      shownSearch = sig;
      main.replaceChildren(searchView());
    }
  } else {
    shownSearch = '';
    if (main.firstChild !== wrap) main.replaceChildren(wrap);
    if (sel) {
      wrap.style.setProperty('--tint', tint(sel));
      reconcile(wrap, detailBlocks(sel));
    } else {
      wrap.replaceChildren();
    }
  }
  if (focusKey && document.activeElement?.dataset?.key !== focusKey) {
    document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }
}

// holding back redraws while the user is renaming, typing a link, dragging or in a menu
function flush() {
  if (renaming || addingLink || renamingLink || dragging || blocked || document.activeElement?.id === 'add-link') { pending = true; return; }
  pending = false;
  render();
}

function moveSelection(step) {
  const i = st.workspaces.indexOf(selected());
  const next = st.workspaces[(i + step + st.workspaces.length) % st.workspaces.length];
  if (!next) return;
  selectedId = next.id;
  render();
  items.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
}

const SIDEBAR_DEFAULT = 320;
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 560;

function setSidebarWidth(px, remember = true) {
  const w = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)));
  document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
  resizer.setAttribute('aria-valuenow', w);
  if (remember) localStorage.setItem('sidebarWidth', String(w));
}

const resizer = el('div', {
  className: 'resizer',
  role: 'separator',
  'aria-orientation': 'vertical',
  'aria-label': 'Resize the workspace list',
  'aria-valuemin': SIDEBAR_MIN,
  'aria-valuemax': SIDEBAR_MAX,
  title: 'Drag to resize, double-click to reset',
  tabIndex: 0,
  onpointerdown: (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add('active');
    document.body.classList.add('resizing');
  },
  onpointermove: (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    setSidebarWidth(e.clientX - resizer.parentElement.getBoundingClientRect().left, false);
  },
  onpointerup: (e) => {
    resizer.releasePointerCapture(e.pointerId);
    resizer.classList.remove('active');
    document.body.classList.remove('resizing');
    setSidebarWidth(resizer.parentElement.getBoundingClientRect().width);
  },
  ondblclick: () => setSidebarWidth(SIDEBAR_DEFAULT),
  onkeydown: (e) => {
    const step = { ArrowLeft: -16, ArrowRight: 16 }[e.key];
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    setSidebarWidth(resizer.parentElement.getBoundingClientRect().width + step);
  },
});
setSidebarWidth(Number(localStorage.getItem('sidebarWidth')) || SIDEBAR_DEFAULT, false);

const hint = (keys, label) => el('span', {}, keys.map((k) => el('kbd', { textContent: k })), label);

document.body.append(
  el('div', { className: 'app' },
    el('aside', { className: 'sidebar' },
      resizer,
      el('div', { className: 'brand' },
        el('div', { className: 'logo' }, PALETTE.slice(0, 4).map((c) => el('i', { style: { background: c } }))),
        el('span', { textContent: 'Atelier' })),
      el('label', { className: 'search' }, el('span', { html: ICONS.search }), searchInput, el('kbd', { textContent: '/' })),
      el('div', { className: 'section' },
        el('span', { className: 'label', textContent: 'Workspaces' }),
        el('button', { className: 'btn btn-ghost btn-icon', title: 'New workspace (N)', html: ICONS.plus, onclick: newWorkspaceDialog })),
      items,
      el('div', { className: 'hints label' },
        hint(['↑↓'], 'browse'),
        hint(['↵'], 'open'),
        hint(['1–9'], 'switch'))),
    main));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && blocked) return closeLayers();
  if (e.target.closest?.('input') || blocked || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); moveSelection(1); }
  else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); moveSelection(-1); }
  else if (e.key === 'Enter' && e.target === document.body && selected()) { e.preventDefault(); switchTo(selected(), lastTab(selected())); }
  else if (e.key === '/') { e.preventDefault(); searchInput.focus(); }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); newWorkspaceDialog(); }
  else if (/^[1-9]$/.test(e.key)) {
    const ws = st.workspaces[+e.key - 1];
    if (ws) switchHere(ws);
  }
});
document.addEventListener('mousedown', (e) => {
  if (blocked && !e.target.closest('.menu, .overlay')) closeLayers();
});
window.addEventListener('blur', () => { if (document.querySelector('.menu')) closeLayers(); });

chrome.runtime.onMessage.addListener((msg) => {
  // freeing the keyboard for 1-9, arrows and Enter when opened by the shortcut or toolbar icon
  if (msg?.type === 'home-opened' && !renaming && !addingLink && !renamingLink) document.activeElement?.blur();
});

const visible = (s) => J([s.activeId, s.workspaces]);

onState((next) => {
  if (visible(next) === visible(st)) return;
  // following a switch made elsewhere (shortcut, context menu) so the shown workspace matches
  if (next.activeId !== st.activeId) selectedId = next.activeId;
  st = next;
  flush();
});
render();
