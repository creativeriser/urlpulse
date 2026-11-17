/* URLPulse web client: shared helpers.
   Rules: untrusted strings only ever go through textContent (never innerHTML);
   storage access is always wrapped in try/catch; no inline styles (CSP). */

/* --- DOM ------------------------------------------------------------------- */

/** Tiny hyperscript: h('a', { href, class }, 'text', childNode, ...) */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function clear(node) {
  node.replaceChildren();
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/* --- Icons (24px grid, 2px round stroke, currentColor) ---------------------------- */

const ICONS = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2M14 18h2v2M18 18h2v2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  /* status: circle-check, triangle-alert, circle-x, clock, circle-minus */
  up: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  degraded: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.2v.1"/>',
  down: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  pending: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  off: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  pulse: '<path d="M2 12h5l2.2-6.5L13 18.5l2.6-6.5H22"/>',
};

export function icon(name) {
  const node = svg('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  node.innerHTML = ICONS[name] || ''; // constant strings from the table above, never user data
  return node;
}

export const STATUS_LABEL = {
  up: 'Up',
  degraded: 'Failing',
  down: 'Down',
  pending: 'Waiting for first check',
  off: 'Not monitored',
  UP: 'All systems operational',
  DEGRADED: 'Degraded',
  DOWN: 'Outage',
  DRAINING: 'Restarting',
};

/** Status indicator: icon + label, so state is never conveyed by colour alone. */
export function statusBadge(state, label = STATUS_LABEL[state] ?? state) {
  const iconName = { UP: 'up', DEGRADED: 'degraded', DOWN: 'down', DRAINING: 'pending' }[state] || state;
  return h('span', { class: 'status', 'data-state': state }, icon(iconName), label);
}

/* --- API ------------------------------------------------------------------------------ */

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body, token, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Manage-Token'] = token;

  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
  }
  if (res.status === 204) return null;

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(res.status, err?.code || 'ERROR', err?.message || `Request failed (${res.status})`, err?.details);
  }
  return data;
}

/* --- Local storage (links created in this browser + their management keys) ------------- */

const LINKS_KEY = 'urlpulse.links.v1';

function readLinks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LINKS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLinks(links) {
  try {
    localStorage.setItem(LINKS_KEY, JSON.stringify(links.slice(0, 200)));
    return true;
  } catch {
    return false;
  }
}

export const store = {
  list: readLinks,
  find: (code) => readLinks().find((l) => l.shortCode === code) || null,
  save(link) {
    const rest = readLinks().filter((l) => l.shortCode !== link.shortCode);
    return writeLinks([link, ...rest]);
  },
  remove: (code) => writeLinks(readLinks().filter((l) => l.shortCode !== code)),
};

/* --- Formatting ------------------------------------------------------------------------ */

const nf = new Intl.NumberFormat('en');
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export const fmtNum = (n) => (n === null || n === undefined ? 'n/a' : n >= 100000 ? compact.format(n) : nf.format(n));
export const fmtPct = (ratio, digits = 0) => (ratio === null || ratio === undefined ? 'n/a' : `${(ratio * 100).toFixed(digits)}%`);

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function relTime(input, now = Date.now()) {
  if (!input) return 'never';
  const diff = (new Date(input).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(input).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

export const fmtDate = (input) =>
  new Date(input).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
export const fmtDateTime = (input) =>
  new Date(input).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const shortDay = (isoDay) =>
  new Date(`${isoDay}T00:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function fmtDuration(seconds) {
  const d = Math.floor(seconds / 86400);
  const hr = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}m`;
  if (m) return `${m}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** "https://example.com/a/very/long/path" -> "example.com/a/very/…" */
export function prettyUrl(url, max = 56) {
  try {
    const u = new URL(url);
    const text = `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  } catch {
    return url.length > max ? `${url.slice(0, max - 1)}…` : url;
  }
}

export const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/* --- Clipboard & toasts ------------------------------------------------------------------ */

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h('textarea', { 'aria-hidden': 'true', tabindex: '-1' });
    area.value = text;
    area.className = 'visually-hidden';
    document.body.append(area);
    area.select();
    let copied;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }
}

let toastRegion;
export function toast(message, kind = 'info', ms = 3200) {
  if (!toastRegion) {
    toastRegion = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRegion);
  }
  const node = h('div', { class: 'toast', 'data-kind': kind }, kind === 'error' ? icon('degraded') : icon('check'), message);
  toastRegion.append(node);
  setTimeout(() => node.remove(), ms);
}

export async function copyWithToast(text, what = 'Copied') {
  const ok = await copyText(text);
  toast(ok ? `${what} to clipboard` : 'Could not copy. Select the text and copy it manually.', ok ? 'info' : 'error');
  return ok;
}

/* --- Tooltip: one shared element, used by every chart ------------------------------------- */

let tipEl;
function tipNode() {
  if (!tipEl) {
    tipEl = h('div', { class: 'tooltip', role: 'tooltip', 'data-open': 'false' });
    document.body.append(tipEl);
  }
  return tipEl;
}

export const tooltip = {
  /** nodes: Node[] built with h() (never HTML strings). x/y are viewport coordinates. */
  show(nodes, x, y) {
    const el = tipNode();
    el.replaceChildren(...nodes);
    el.dataset.open = 'true';
    const pad = 12;
    const { width, height } = el.getBoundingClientRect();
    let left = x + 14;
    let top = y - height - 14;
    if (left + width > window.innerWidth - pad) left = x - width - 14;
    if (left < pad) left = pad;
    if (top < pad) top = y + 18;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  },
  hide() {
    if (tipEl) tipEl.dataset.open = 'false';
  },
};

/** Value-first tooltip body: big value, quiet label. */
export const tipRow = (value, label) => [h('span', { class: 'tt-value' }, value), h('span', { class: 'tt-label' }, label)];

/* --- Page shell: theme toggle + build info ------------------------------------------------ */

function effectiveTheme() {
  return (
    document.documentElement.getAttribute('data-theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );
}

export function initShell({ buildInfo = true } = {}) {
  const toggle = $('.theme-toggle');
  toggle?.addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('urlpulse.theme', next);
    } catch {
      /* storage unavailable: theme still applies for this visit */
    }
    toggle.setAttribute('aria-label', next === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    document.dispatchEvent(new CustomEvent('themechange', { detail: next }));
  });
  toggle?.setAttribute(
    'aria-label',
    effectiveTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
  );

  const target = $('.build-info');
  if (buildInfo && target) {
    api('/api/stats')
      .then((s) => {
        target.textContent =
          s.commit && s.commit !== 'dev' ? `Version ${s.version}, build ${s.commit.slice(0, 7)}` : `Version ${s.version}, development build`;
      })
      .catch(() => {
        target.textContent = '';
      });
  }
}

/** Debounce for input handlers. */
export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
