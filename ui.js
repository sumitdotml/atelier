import { LUCIDE } from './lucide.js';

export const PALETTE = self.PALETTE;
export const PALETTE_NAMES = self.PALETTE_NAMES;
export const INK = self.INK;
export const initial = self.initial;
export const tint = (ws) => PALETTE[ws?.color ?? 0];

export function favicon(url) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', '32');
  return u.toString();
}

export async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (res && !res.ok) console.error('[workspaces]', res.error);
  return res?.value;
}

export async function loadState() {
  const { state } = await chrome.storage.local.get('state');
  return state || { workspaces: [] };
}

export function onState(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.state) cb(changes.state.newValue);
  });
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'style') for (const [prop, val] of Object.entries(v)) node.style.setProperty(prop, val);
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

const svg = (body, size = 15) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = Object.fromEntries(Object.entries(LUCIDE).map(([k, body]) => [k, svg(body)]));
export const icon = (name, size) => svg(LUCIDE[name], size);

export function tileDataUrl(ws, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = tint(ws);
  g.beginPath();
  g.roundRect(0, 0, size, size, size * 0.28);
  g.fill();
  g.fillStyle = INK;
  g.font = `600 ${Math.round(size * 0.62)}px -apple-system, system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(initial(ws.name), size / 2, size / 2 + size * 0.05);
  return c.toDataURL('image/png');
}
