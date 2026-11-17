import { $, api, ApiError, initShell, store, icon, h, copyWithToast, fmtNum, fmtPct, prettyUrl } from './core.js';
import { columnChart, heartbeatTrace } from './charts.js';

initShell();

/* --- Heartbeat: draws once on load (CSS), and beats again when a link is created ----- */

const beat = $('#trace-beat');
function pulseTrace() {
  beat.classList.remove('run');
  void beat.getBoundingClientRect(); // restart the animation
  beat.classList.add('run');
}
setTimeout(pulseTrace, 1500);

/* --- Elements ------------------------------------------------------------------------- */

const form = $('#shorten-form');
const urlInput = $('#url');
const aliasInput = $('#alias');
const expiresSelect = $('#expires');
const watchBox = $('#watch');
const intervalSelect = $('#interval');
const submitBtn = $('#submit-btn');
const errorBox = $('#url-error');
const result = $('#result');

$('#alias-prefix').textContent = `${location.host}/`;

const FIELD_INPUT = {
  originalUrl: urlInput,
  customAlias: aliasInput,
  expiresInDays: expiresSelect,
  monitorIntervalSeconds: intervalSelect,
};

function setError(message, field) {
  errorBox.textContent = message;
  Object.values(FIELD_INPUT).forEach((el) => el.removeAttribute('aria-invalid'));
  const target = FIELD_INPUT[field] || (message ? urlInput : null);
  if (message && target) {
    target.setAttribute('aria-invalid', 'true');
    target.focus();
  }
}

watchBox.addEventListener('change', () => {
  intervalSelect.disabled = !watchBox.checked;
});

urlInput.addEventListener('input', () => errorBox.textContent && setError(''));
aliasInput.addEventListener('input', () => errorBox.textContent && setError(''));

/* --- Server capabilities + live numbers ------------------------------------------------- */

async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('#st-links').textContent = fmtNum(s.links);
    $('#st-clicks').textContent = fmtNum(s.clicks);
    $('#st-cache').textContent = fmtPct(s.cache.hitRatio);
    $('#st-watched').textContent = fmtNum(s.monitoredLinks);

    if (s.features && s.features.monitoring === false) {
      watchBox.disabled = true;
      watchBox.checked = false;
      intervalSelect.disabled = true;
      $('#watch-text').textContent = 'Uptime checks are turned off on this server';
    }
  } catch {
    /* leave the placeholders; the form still works */
  }
}
loadStats();
setInterval(() => document.visibilityState === 'visible' && loadStats(), 20_000);

/* --- Submit ------------------------------------------------------------------------------------ */

function normaliseUrl(raw) {
  const value = raw.trim();
  // Friendly: "example.com/page" -> "https://example.com/page". Anything with a scheme is left for the server to judge.
  return value && !/^[a-z][a-z0-9+.-]*:/i.test(value) ? `https://${value}` : value;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setError('');

  const originalUrl = normaliseUrl(urlInput.value);
  if (!originalUrl) {
    setError('Paste the URL you want to shorten.', 'originalUrl');
    return;
  }

  const body = { originalUrl };
  if (aliasInput.value.trim()) body.customAlias = aliasInput.value.trim();
  if (expiresSelect.value) body.expiresInDays = Number(expiresSelect.value);
  if (watchBox.checked) {
    body.monitor = true;
    body.monitorIntervalSeconds = Number(intervalSelect.value);
  }

  submitBtn.setAttribute('aria-busy', 'true');
  submitBtn.textContent = 'Shortening…';
  try {
    const data = await api('/api/url/shorten', { method: 'POST', body });
    onCreated(data, body);
  } catch (err) {
    if (err instanceof ApiError) setError(err.message, err.details?.field);
    else setError('Something went wrong. Please try again.');
  } finally {
    submitBtn.removeAttribute('aria-busy');
    submitBtn.textContent = 'Shorten link';
  }
});

function onCreated(data, body) {
  const saved = store.save({
    shortCode: data.shortCode,
    shortUrl: data.shortUrl,
    originalUrl: data.originalUrl,
    manageToken: data.manageToken,
    createdAt: new Date().toISOString(),
    expiresAt: data.expiresAt,
    monitor: Boolean(body.monitor),
  });

  const link = $('#result-url');
  link.href = data.shortUrl;
  link.textContent = data.shortUrl;
  $('#result-dest').textContent = prettyUrl(data.originalUrl, 80);
  $('#result-key').textContent = data.manageToken;

  const copyLink = $('#copy-link');
  const copyLabel = () => copyLink.replaceChildren(icon('copy'), 'Copy link');
  copyLabel();
  copyLink.onclick = async () => {
    if (await copyWithToast(data.shortUrl, 'Short link copied')) {
      copyLink.replaceChildren(icon('check'), 'Copied');
      setTimeout(copyLabel, 1800);
    }
  };

  const copyKey = $('#copy-key');
  copyKey.replaceChildren(icon('copy'), 'Copy key');
  copyKey.onclick = () => copyWithToast(data.manageToken, 'Management key copied');

  const dash = $('#open-dashboard');
  dash.href = `/dashboard#${data.shortCode}`;
  dash.replaceChildren(icon('pulse'), 'Open in dashboard');

  const qr = $('#download-qr');
  qr.href = `/api/url/${data.shortCode}/qr?format=png&size=720&download=1`;
  qr.replaceChildren(icon('download'), 'Download QR');
  $('#result-qr').src = `/api/url/${data.shortCode}/qr?size=360`;

  result.hidden = false;
  result.setAttribute('tabindex', '-1');
  result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  result.focus({ preventScroll: true });
  pulseTrace();

  if (!saved) {
    result.querySelector('.key-desc').append(
      h('strong', {}, ' Your browser blocked storage, so copy the key now: it will not be saved for the dashboard.'),
    );
  }

  urlInput.value = '';
  aliasInput.value = '';
}

/* --- Sample specimens (clearly labelled "Sample" in the page) ------------------------------------- */

const SAMPLE_CLICKS = [3, 5, 4, 9, 14, 11, 7, 6, 12, 18, 16, 9, 8, 13];
function sampleDays() {
  const day = 86_400_000;
  const today = Date.now();
  return SAMPLE_CLICKS.map((value, i) => ({
    date: new Date(today - (SAMPLE_CLICKS.length - 1 - i) * day).toISOString().slice(0, 10),
    value,
  }));
}

function sampleHistory() {
  const step = 5 * 60_000;
  const now = Date.now();
  const failures = new Set([30, 31]); // two failed checks in a row
  return Array.from({ length: 36 }, (_, i) => ({
    t: new Date(now - (35 - i) * step).toISOString(),
    ok: !failures.has(i),
    ms: failures.has(i) ? null : 120 + ((i * 37) % 90),
  }));
}

columnChart($('#sample-clicks'), sampleDays(), { height: 170 });
heartbeatTrace($('#sample-trace'), sampleHistory(), { height: 72, label: 'Sample uptime checks' });
