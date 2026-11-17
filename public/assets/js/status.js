import { h, $, api, initShell, icon, statusBadge, fmtNum, fmtPct, fmtDuration } from './core.js';
import { heartbeatTrace } from './charts.js';

initShell();

const HEALTH_MS = 5_000;
const STATS_MS = 15_000;
const MAX_SAMPLES = 120;

const samples = [];
const trace = heartbeatTrace($('#health-trace'), samples, { height: 72, slotWidth: 16, label: 'Health checks' });

const view = {
  title: $('#state-title'),
  icon: $('#state-icon'),
  text: $('#state-text'),
  note: $('#state-note'),
  components: $('#components'),
};

let health = null; // { data?, ms?, error?, at }
let stats = null;

/* ==========================================================================
   Data
   ========================================================================== */

async function checkHealth() {
  const started = performance.now();
  try {
    // /health answers 503 with a JSON body when the database is down: that is data, not a network error
    const res = await fetch('/health', { cache: 'no-store', headers: { Accept: 'application/json' } });
    const ms = Math.round(performance.now() - started);
    const data = await res.json();
    samples.push({ t: new Date().toISOString(), ok: res.ok, ms });
    health = { data, ms, at: new Date() };
  } catch {
    samples.push({ t: new Date().toISOString(), ok: false, ms: null });
    health = { error: true, at: new Date() };
  }
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  trace.update(samples);
  render();
}

async function loadStats() {
  try {
    stats = await api('/api/stats');
    renderFacts();
    renderComponents();
  } catch {
    /* keep the previous numbers */
  }
}

/* ==========================================================================
   Headline state
   ========================================================================== */

const HEADLINE = {
  UP: {
    icon: 'up',
    text: 'All systems operational',
    note: 'The web app, database and cache are all responding.',
  },
  DEGRADED: {
    icon: 'degraded',
    text: 'Running with reduced performance',
    note: 'The cache is unavailable. Redirects still work, served from the database, but more slowly.',
  },
  DOWN: {
    icon: 'down',
    text: 'Service outage',
    note: 'The database is unreachable, so links cannot be created or opened until it is back.',
  },
  DRAINING: {
    icon: 'pending',
    text: 'Restarting',
    note: 'The server is shutting down for a restart. This page keeps checking.',
  },
  UNREACHABLE: {
    icon: 'down',
    text: 'Cannot reach the server',
    note: 'Your browser did not get a response. It will keep trying every 5 seconds.',
  },
};

function render() {
  const key = health.error ? 'UNREACHABLE' : health.data.status;
  const headline = HEADLINE[key] ?? { icon: 'pending', text: String(key), note: '' };

  view.title.dataset.state = key;
  view.icon.replaceChildren(icon(headline.icon));
  view.text.textContent = headline.text;
  view.note.textContent = `${headline.note} Last checked at ${health.at.toLocaleTimeString('en')}.`;
  document.title = `${headline.text} | URLPulse status`;

  renderComponents();
}

/* ==========================================================================
   Components
   ========================================================================== */

function row(name, detail, state, label) {
  return h(
    'li',
    { class: 'component' },
    h('span', { class: 'component-name' }, name),
    h('span', { class: 'component-detail' }, detail),
    statusBadge(state, label),
  );
}

const ms = (value) => (value === null || value === undefined ? '' : `${value} ms`);

function renderComponents() {
  if (!health) return;
  const rows = [];

  if (health.error) {
    rows.push(row('Web application', 'No response from the server', 'down', 'Unreachable'));
  } else {
    const d = health.data;
    const draining = d.status === 'DRAINING';
    rows.push(
      row(
        'Web application',
        `Answered your browser in ${health.ms} ms`,
        draining ? 'degraded' : 'up',
        draining ? 'Restarting' : 'Operational',
      ),
    );

    const dbMemory = d.mongo === 'memory';
    rows.push(
      row(
        dbMemory ? 'In-memory store' : 'MongoDB',
        d.checks.mongo.up
          ? dbMemory
            ? 'Development mode: data is lost when the server restarts'
            : `Database round trip ${ms(d.checks.mongo.latencyMs)}`
          : 'The database did not answer its ping',
        d.checks.mongo.up ? 'up' : 'down',
        d.checks.mongo.up ? 'Operational' : 'Down',
      ),
    );

    if (d.redis === 'disabled') {
      rows.push(row('Cache', 'Caching is turned off, so every redirect reads the database', 'off', 'Disabled'));
    } else if (d.redis === 'memory') {
      rows.push(row('In-memory cache', 'Development mode: one cache per server process', 'up', 'Operational'));
    } else {
      rows.push(
        row(
          'Redis cache',
          d.checks.redis.up ? `Round trip ${ms(d.checks.redis.latencyMs)}` : 'Redirects fall back to the database until it returns',
          d.checks.redis.up ? 'up' : 'degraded',
          d.checks.redis.up ? 'Operational' : 'Unavailable',
        ),
      );
    }
  }

  // Stats come from the same server: when it is unreachable they are stale, so do not present them as current
  if (stats && !health.error) {
    if (stats.features?.monitoring) {
      const down = stats.monitoredLinksDown;
      rows.push(
        row(
          'Uptime monitor',
          `Watching ${fmtNum(stats.monitoredLinks)} ${stats.monitoredLinks === 1 ? 'link' : 'links'}, ${fmtNum(down)} currently down`,
          'up',
          'Running',
        ),
      );
    } else {
      rows.push(row('Uptime monitor', 'Turned off on this server', 'off', 'Disabled'));
    }
  }

  view.components.replaceChildren(...rows);
}

/* ==========================================================================
   Deployment facts + cache meter
   ========================================================================== */

function renderFacts() {
  if (!stats) return;
  $('#f-version').textContent = stats.version;
  const hasCommit = Boolean(stats.commit) && stats.commit !== 'dev';
  const commit = $('#f-commit');
  commit.textContent = hasCommit ? stats.commit.slice(0, 12) : 'Development build';
  commit.classList.toggle('mono', hasCommit); // the monospace face is for hashes only
  $('#f-uptime').textContent = fmtDuration(stats.uptimeSeconds);
  $('#f-links').textContent = fmtNum(stats.links);
  $('#f-clicks').textContent = fmtNum(stats.clicks);

  const { hits, misses, hitRatio } = stats.cache;
  const meter = $('#cache-meter');
  const note = $('#cache-note');
  if (hitRatio === null) {
    meter.removeAttribute('aria-valuenow');
    meter.setAttribute('aria-valuetext', 'No redirects yet');
    $('#cache-fill').style.setProperty('--w', '0%');
    note.textContent = 'No redirects yet. Open a short link to see the cache fill.';
  } else {
    const pct = Math.round(hitRatio * 100);
    meter.setAttribute('aria-valuenow', String(pct));
    meter.setAttribute('aria-valuetext', `${pct} percent`);
    $('#cache-fill').style.setProperty('--w', `${pct}%`);
    note.textContent = `${fmtPct(hitRatio)} of redirect lookups were answered from the cache: ${fmtNum(hits)} hits and ${fmtNum(misses)} misses since the server started.`;
  }
}

/* ==========================================================================
   Polling (paused while the tab is hidden)
   ========================================================================== */

checkHealth();
loadStats();
setInterval(() => document.visibilityState === 'visible' && checkHealth(), HEALTH_MS);
setInterval(() => document.visibilityState === 'visible' && loadStats(), STATS_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    checkHealth();
    loadStats();
  }
});
