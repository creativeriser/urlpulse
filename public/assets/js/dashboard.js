import {
  h,
  $,
  api,
  ApiError,
  initShell,
  store,
  icon,
  statusBadge,
  STATUS_LABEL,
  copyWithToast,
  toast,
  fmtNum,
  relTime,
  fmtDate,
  fmtDateTime,
  prettyUrl,
  shortDay,
} from './core.js';
import { columnChart, barList, mapToRows, heartbeatTrace, dataTable } from './charts.js';

initShell();

const POLL_MS = 15_000;
const INTERVALS = [
  [60, 'Every minute'],
  [300, 'Every 5 minutes'],
  [900, 'Every 15 minutes'],
  [3600, 'Every hour'],
  [86400, 'Every day'],
];
const CODE_PATTERN = /^[A-Za-z0-9-]{3,30}$/;
const hostOnly = (origin) => origin.replace(/^https?:\/\/(www\.)?/, '');

const els = {
  list: $('#link-list'),
  empty: $('#link-empty'),
  detail: $('#detail'),
  detailEmpty: $('#detail-empty'),
  detailBody: $('#detail-body'),
  lookupForm: $('#lookup-form'),
  lookup: $('#lookup'),
  lookupError: $('#lookup-error'),
  dialog: $('#delete-dialog'),
  dialogText: $('#delete-text'),
};

const state = {
  code: null,
  days: 7,
  link: null,
  analytics: null,
  token: null,
  requestId: 0,
  charts: [],
  openTables: new Set(),
  refocus: null,
};
const listInfo = new Map(); // shortCode -> public link info (or { missing: true })

/* ==========================================================================
   Sidebar
   ========================================================================== */

function itemMeta(code) {
  const info = listInfo.get(code);
  if (!info) return [h('span', { class: 'muted' }, 'Loading…')];
  if (info.missing) return [h('span', { class: 'muted' }, 'Not found. Deleted or expired?')];
  const nodes = [h('span', { class: 'num' }, `${fmtNum(info.clickCount)} ${info.clickCount === 1 ? 'click' : 'clicks'}`)];
  if (info.monitor?.enabled) nodes.push(statusBadge(info.monitor.status));
  if (info.expired) nodes.push(h('span', { class: 'tag' }, 'Expired'));
  return nodes;
}

function renderList() {
  const links = store.list();
  els.list.replaceChildren();
  els.empty.hidden = links.length > 0;
  links.forEach((link) => {
    const selected = link.shortCode === state.code;
    const button = h(
      'button',
      { class: 'link-item', type: 'button', 'aria-current': selected ? 'true' : 'false', dataset: { code: link.shortCode } },
      h('span', { class: 'link-code mono' }, `/${link.shortCode}`),
      h('span', { class: 'link-dest small muted' }, prettyUrl(link.originalUrl, 48)),
      h('span', { class: 'link-meta small' }, ...itemMeta(link.shortCode)),
    );
    button.addEventListener('click', () => go(link.shortCode));
    els.list.append(h('li', {}, button));
  });
}

async function hydrateList() {
  const codes = store.list().slice(0, 30).map((l) => l.shortCode);
  for (let i = 0; i < codes.length; i += 5) {
    await Promise.all(
      codes.slice(i, i + 5).map(async (code) => {
        try {
          listInfo.set(code, await api(`/api/url/${code}`));
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) listInfo.set(code, { missing: true });
        }
      }),
    );
    renderList();
  }
}

/* ==========================================================================
   Navigation (the URL hash is the single source of truth: /dashboard#code)
   ========================================================================== */

function go(code) {
  if (location.hash.slice(1) === code) select(code);
  else location.hash = code; // triggers hashchange -> select
}

window.addEventListener('hashchange', () => select(decodeURIComponent(location.hash.slice(1))));

els.lookupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  els.lookupError.textContent = '';
  let value = els.lookup.value.trim();
  try {
    value = new URL(value).pathname.replace(/^\/+|\/+$/g, ''); // accept a pasted short URL
  } catch {
    /* plain code */
  }
  if (!CODE_PATTERN.test(value)) {
    els.lookupError.textContent = 'Codes are 3 to 30 letters, numbers or hyphens, like capstone-demo.';
    els.lookup.setAttribute('aria-invalid', 'true');
    return;
  }
  els.lookup.removeAttribute('aria-invalid');
  els.lookup.value = '';
  go(value);
});

/* ==========================================================================
   Loading and rendering the selected link
   ========================================================================== */

function select(code) {
  state.code = code || null;
  state.token = code ? store.find(code)?.manageToken ?? null : null;
  state.openTables.clear();
  renderList();
  if (!code) return showEmpty();
  els.detailEmpty.hidden = true;
  els.detailBody.hidden = false;
  return load();
}

function showEmpty() {
  destroyCharts();
  els.detailBody.hidden = true;
  els.detailBody.replaceChildren();
  els.detailEmpty.hidden = false;
}

function destroyCharts() {
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
}

/** silent = keep the current render on screen (dimmed) while refetching: no skeleton, no layout jump. */
async function load({ silent = false } = {}) {
  const code = state.code;
  if (!code) return;
  const id = ++state.requestId;
  els.detail.setAttribute('aria-busy', 'true');
  try {
    const [link, analytics] = await Promise.all([
      api(`/api/url/${code}`),
      api(`/api/analytics/${code}?days=${state.days}`),
    ]);
    if (id !== state.requestId) return; // a newer request superseded this one
    state.link = link;
    state.analytics = analytics;
    listInfo.set(code, link);
    renderDetail();
    renderList();
  } catch (err) {
    if (id !== state.requestId) return;
    if (!silent || !state.link) renderProblem(code, err);
  } finally {
    if (id === state.requestId) els.detail.setAttribute('aria-busy', 'false');
  }
}

function renderProblem(code, err) {
  destroyCharts();
  state.link = null;
  const notFound = err instanceof ApiError && err.status === 404;
  const stored = store.find(code);
  const actions = [];
  if (notFound && stored) {
    actions.push(
      h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => {
        store.remove(code);
        listInfo.delete(code);
        history.replaceState(null, '', location.pathname);
        select(null);
      } }, icon('trash'), 'Remove from this list'),
    );
  } else if (!notFound) {
    actions.push(h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => load() }, 'Try again'));
  }
  els.detailBody.replaceChildren(
    h(
      'div',
      { class: 'stack' },
      h('h2', { class: 'h3' }, notFound ? `No link with the code “${code}”` : 'Could not load this link'),
      h(
        'p',
        { class: 'prose' },
        notFound
          ? 'It may have been deleted or may have expired. Check the code and try again.'
          : err.message || 'Something went wrong. Please try again.',
      ),
      h('div', { class: 'cluster' }, ...actions),
    ),
  );
}

/* ==========================================================================
   Detail view
   ========================================================================== */

function renderDetail() {
  const { link, analytics } = state;
  destroyCharts();
  els.detailBody.replaceChildren(
    h(
      'div',
      { class: 'detail-stack' },
      renderHead(link),
      renderClicks(link, analytics),
      renderBreakdowns(analytics),
      renderRecent(analytics),
      renderUptime(link),
    ),
  );
  if (state.refocus) {
    $(state.refocus)?.focus();
    state.refocus = null;
  }
}

function renderHead(link) {
  const owner = Boolean(state.token);
  const expiry = link.expiresAt
    ? link.expired
      ? h('dd', {}, `Expired ${relTime(link.expiresAt)}`)
      : h('dd', {}, `${fmtDate(link.expiresAt)} (${relTime(link.expiresAt)})`)
    : h('dd', {}, 'Never');

  const actions = [
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyWithToast(link.shortUrl, 'Short link copied') }, icon('copy'), 'Copy link'),
    h('a', { class: 'btn btn-quiet btn-sm', href: link.shortUrl, target: '_blank', rel: 'noopener' }, icon('external'), 'Open link'),
    h('a', { class: 'btn btn-quiet btn-sm', href: `/api/url/${link.shortCode}/qr?format=png&size=720&download=1`, download: '' }, icon('qr'), 'Download QR'),
  ];
  if (owner) {
    actions.push(h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: confirmDelete }, icon('trash'), 'Delete'));
  }

  return h(
    'header',
    { class: 'detail-head' },
    h('h2', { class: 'detail-url' }, link.shortUrl),
    h(
      'p',
      { class: 'detail-dest muted' },
      'Points to ',
      h('a', { href: link.originalUrl, target: '_blank', rel: 'noopener noreferrer' }, prettyUrl(link.originalUrl, 90)),
    ),
    h('div', { class: 'cluster' }, ...actions),
    h(
      'dl',
      { class: 'detail-meta' },
      h('div', {}, h('dt', {}, 'Created'), h('dd', {}, fmtDate(link.createdAt))),
      h('div', {}, h('dt', {}, 'Expires'), expiry),
      h('div', {}, h('dt', {}, 'Type'), h('dd', {}, link.customAlias ? 'Custom alias' : 'Random code')),
    ),
    owner
      ? null
      : h(
          'p',
          { class: 'notice' },
          icon('off'),
          'You are viewing public analytics. This browser does not hold the management key, so you cannot change or delete this link.',
        ),
  );
}

function renderClicks(link, a) {
  const range = h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': 'Time range' },
    [7, 30, 90].map((d) =>
      h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(state.days === d),
          'data-days': d,
          onclick: () => {
            if (state.days === d) return;
            state.days = d;
            state.refocus = `[data-days="${d}"]`;
            load({ silent: true });
          },
        },
        `${d} days`,
      ),
    ),
  );

  const chartBox = h('div', { class: 'chart-box' });
  const series = a.timeline.map((d) => ({ date: d.date, value: d.clicks }));

  const table = h(
    'details',
    {
      class: 'table-view',
      ...(state.openTables.has('clicks') ? { open: true } : {}),
      ontoggle: (e) => (e.target.open ? state.openTables.add('clicks') : state.openTables.delete('clicks')),
    },
    h('summary', {}, 'Show as table'),
    h(
      'div',
      { class: 'table-scroll' },
      dataTable(['Day', 'Clicks'], [...a.timeline].reverse().map((d) => [shortDay(d.date), fmtNum(d.clicks)])),
    ),
  );

  const section = h(
    'section',
    { class: 'block', 'aria-labelledby': 'clicks-title' },
    h(
      'div',
      { class: 'filter-row' },
      h(
        'div',
        {},
        h('p', { class: 'figure-value' }, fmtNum(link.clickCount)),
        h(
          'p',
          { class: 'figure-caption' },
          link.clickCount === 1 ? 'click in total' : 'clicks in total',
          a.clicksInPeriod !== link.clickCount ? `, ${fmtNum(a.clicksInPeriod)} in the last ${a.periodDays} days` : '',
        ),
      ),
      range,
    ),
    h('h3', { class: 'block-title', id: 'clicks-title' }, 'Clicks per day'),
    chartBox,
    table,
  );

  // charts measure their container, so they must be created after it is in the DOM
  queueMicrotask(() => {
    state.charts.push(columnChart(chartBox, series, { height: 240 }));
  });
  return section;
}

function renderBreakdowns(a) {
  const make = (title, rows, empty) => {
    const box = h('div', {});
    barList(box, rows, { total: a.clicksInPeriod, emptyText: empty });
    return h('section', { class: 'block' }, h('h3', { class: 'block-title' }, title), box);
  };
  return h(
    'div',
    { class: 'breakdowns' },
    make('Browsers', mapToRows(a.clicksByBrowser), 'No clicks in this period yet'),
    make('Operating systems', mapToRows(a.clicksByOS), 'No clicks in this period yet'),
    make('Devices', mapToRows(a.clicksByDevice), 'No clicks in this period yet'),
    make('Referring sites', a.topReferrers.map((r) => ({ label: hostOnly(r.referrer), count: r.count })), 'No clicks in this period yet'),
  );
}

function renderRecent(a) {
  const body = a.recentClicks.length
    ? dataTable(
        ['When', 'Browser', 'System', 'Device', 'From'],
        a.recentClicks.map((c) => [relTime(c.timestamp), c.browser, c.os, c.device, hostOnly(c.referrer)]),
      )
    : h(
        'p',
        { class: 'muted' },
        'No clicks yet. Open the short link to record the first one.',
      );
  // columns after the first are left-aligned text, not numbers
  body.querySelectorAll?.('.r').forEach((cell) => cell.classList.remove('r'));
  return h('section', { class: 'block' }, h('h3', { class: 'block-title' }, 'Recent clicks'), body);
}

/* ---- Uptime ------------------------------------------------------------------------------ */

const STATE_NOTE = (m) =>
  ({
    up: 'The destination answered the last check.',
    degraded: 'The last check failed. One more failure marks this link as down.',
    down: `The last ${m.consecutiveFailures} checks failed${m.lastError ? `: ${m.lastError}` : ''}.`,
    pending: 'The first check will run shortly.',
    off: 'Turn on the uptime check and URLPulse will visit the destination on a schedule.',
  })[m.status];

function renderUptime(link) {
  const m = link.monitor;
  const owner = Boolean(state.token);
  const head = h(
    'div',
    { class: 'uptime-top' },
    h('h3', { class: 'block-title' }, 'Destination uptime'),
  );

  const stateLine = h(
    'div',
    {},
    h('p', { class: 'uptime-state', 'data-state': m.status }, icon(m.status), STATUS_LABEL[m.status]),
    h('p', { class: 'muted', id: 'uptime-note' }, STATE_NOTE(m)),
  );

  const parts = [head, stateLine];

  if (m.enabled && m.checks > 0) {
    parts.push(
      h(
        'dl',
        { class: 'metrics' },
        h('div', {}, h('dt', {}, 'Uptime'), h('dd', { class: 'num' }, m.uptimePercent === null ? 'n/a' : `${m.uptimePercent}%`)),
        h('div', {}, h('dt', {}, 'Last response'), h('dd', { class: 'num' }, m.lastLatencyMs === null ? 'No response' : `${fmtNum(m.lastLatencyMs)} ms`)),
        h('div', {}, h('dt', {}, 'Last checked'), h('dd', {}, relTime(m.lastCheckedAt))),
        h('div', {}, h('dt', {}, 'Checks run'), h('dd', { class: 'num' }, fmtNum(m.checks))),
      ),
    );

    const traceBox = h('div', { class: 'chart-box' });
    parts.push(
      h(
        'div',
        { class: 'trace-box' },
        traceBox,
        h('p', { class: 'trace-caption small muted' }, `Each beat is one check, newest on the right. A flatline with a cross is a failed check.`),
      ),
    );
    queueMicrotask(() => state.charts.push(heartbeatTrace(traceBox, m.history, { height: 72 })));

    parts.push(
      h(
        'details',
        {
          class: 'table-view',
          ...(state.openTables.has('checks') ? { open: true } : {}),
          ontoggle: (e) => (e.target.open ? state.openTables.add('checks') : state.openTables.delete('checks')),
        },
        h('summary', {}, 'Show check history as table'),
        h(
          'div',
          { class: 'table-scroll' },
          dataTable(
            ['Checked', 'Result', 'Response'],
            [...m.history].reverse().map((c) => [fmtDateTime(c.t), c.ok ? 'Passed' : 'Failed', c.ms === null ? 'No response' : `${c.ms} ms`]),
          ),
        ),
      ),
    );
  }

  if (owner) parts.push(renderUptimeControls(link));
  else if (!m.enabled) parts.push(h('p', { class: 'muted small' }, 'Only the link’s owner can turn the uptime check on.'));

  return h('section', { class: 'uptime', 'aria-label': 'Destination uptime' }, ...parts);
}

function renderUptimeControls(link) {
  const m = link.monitor;
  const interval = m.intervalSeconds ?? 300;
  const options = INTERVALS.some(([s]) => s === interval) ? INTERVALS : [...INTERVALS, [interval, `Every ${interval} seconds`]].sort((a, b) => a[0] - b[0]);

  const select = h(
    'select',
    { class: 'select', id: 'monitor-interval', 'aria-label': 'How often to check', ...(m.enabled ? {} : { disabled: true }) },
    options.map(([s, label]) => h('option', { value: s, ...(s === interval ? { selected: true } : {}) }, label)),
  );
  const input = h('input', { type: 'checkbox', id: 'monitor-switch', ...(m.enabled ? { checked: true } : {}) });
  const toggle = h('label', { class: 'switch' }, input, h('span', { class: 'track', 'aria-hidden': 'true' }), h('span', {}, 'Watch the destination'));

  const apply = async (enabled) => {
    input.disabled = select.disabled = true;
    try {
      await api(`/api/url/${link.shortCode}/monitor`, {
        method: 'PATCH',
        token: state.token,
        body: { enabled, intervalSeconds: Number(select.value) },
      });
      toast(enabled ? 'Uptime check is on' : 'Uptime check is off');
      state.refocus = '#monitor-switch';
      await load({ silent: true });
    } catch (err) {
      toast(err.message || 'Could not change the uptime check', 'error');
      input.checked = m.enabled;
      input.disabled = false;
      select.disabled = !m.enabled;
    }
  };
  input.addEventListener('change', () => apply(input.checked));
  select.addEventListener('change', () => apply(true));

  return h('div', { class: 'uptime-controls' }, toggle, select);
}

/* ---- Delete ------------------------------------------------------------------------------ */

function confirmDelete() {
  const link = state.link;
  els.dialogText.textContent = `${link.shortUrl} will stop redirecting immediately, and its click history will be removed. This cannot be undone.`;
  els.dialog.returnValue = '';
  els.dialog.addEventListener(
    'close',
    async () => {
      if (els.dialog.returnValue !== 'confirm') return;
      try {
        await api(`/api/url/${link.shortCode}`, { method: 'DELETE', token: state.token });
        store.remove(link.shortCode);
        listInfo.delete(link.shortCode);
        toast('Link deleted');
        history.replaceState(null, '', location.pathname);
        select(null);
      } catch (err) {
        toast(err.message || 'Could not delete the link', 'error');
      }
    },
    { once: true },
  );
  els.dialog.showModal();
}

/* ==========================================================================
   Boot + live refresh
   ========================================================================== */

renderList();
hydrateList();

const initial = decodeURIComponent(location.hash.slice(1));
if (initial) {
  select(initial);
} else if (store.list().length) {
  history.replaceState(null, '', `#${store.list()[0].shortCode}`);
  select(store.list()[0].shortCode);
}

setInterval(() => {
  if (document.visibilityState === 'visible' && state.code) load({ silent: true });
}, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.code) load({ silent: true });
});
document.addEventListener('themechange', () => state.link && renderDetail());

