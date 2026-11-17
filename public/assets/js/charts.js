/* URLPulse charts: dependency-free SVG/HTML renderers.
   Specs follow docs/design/DESIGN_SYSTEM.md > Data visualisation:
   thin marks (<= 24px), 4px rounded data-end with a square baseline, hairline
   recessive grid, one series colour, value-first tooltips, every number also
   reachable without hover (labels or the table view). */

import { h, svg, clear, fmtNum, fmtDateTime, shortDay, tooltip, tipRow } from './core.js';

/** Re-render a chart whenever its container changes width. Returns { redraw, destroy }. */
function responsive(container, render) {
  let width = 0;
  let frame = 0;
  const draw = () => {
    frame = 0;
    const w = Math.floor(container.clientWidth);
    if (w > 0) {
      width = w;
      render(w);
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };
  const observer = new ResizeObserver(() => {
    if (Math.floor(container.clientWidth) !== width) schedule();
  });
  observer.observe(container);
  draw();
  return {
    redraw: draw,
    destroy() {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    },
  };
}

/* ========================================================================
   Heartbeat trace: one slot per uptime check.
   pass -> a beat, fail -> a flatline with a cross, no data yet -> dotted gap.
   ======================================================================== */

const BEAT = [
  [0, 0],
  [0.2, 0],
  [0.28, -0.16],
  [0.36, 0],
  [0.44, 0.12],
  [0.52, -1],
  [0.6, 0.42],
  [0.68, 0],
  [0.8, -0.2],
  [0.9, 0],
  [1, 0],
];

/** Simpler beat for narrow slots: a dip, one clean spike, a recovery. Reads as ECG, not a barcode. */
const BEAT_COMPACT = [
  [0, 0],
  [0.2, 0],
  [0.32, 0.16],
  [0.45, -1],
  [0.58, 0.5],
  [0.7, 0],
  [1, 0],
];

/**
 * slotWidth: target pixel width per check. The number of visible checks adapts to
 * the container, so a narrow chart shows fewer, clearer beats instead of a smear.
 */
export function heartbeatTrace(container, initial = [], { slots, slotWidth = 20, height = 64, label = 'Uptime checks' } = {}) {
  let history = initial;

  const render = (width) => {
    const count = slots ?? Math.max(8, Math.floor(width / slotWidth));
    const data = history.slice(-count);
    const missing = count - data.length;
    const slotW = width / count;
    const shape = slotW < 26 ? BEAT_COMPACT : BEAT;
    const base = height * 0.64;
    const amp = height * (slotW < 26 ? 0.46 : 0.52);

    let ok = '';
    let fail = '';
    let gap = '';
    const crosses = [];
    const hits = [];

    for (let i = 0; i < count; i += 1) {
      const x0 = i * slotW;
      const entry = i < missing ? null : data[i - missing];
      if (!entry) {
        gap += `M${x0.toFixed(1)} ${base}H${(x0 + slotW).toFixed(1)}`;
      } else if (entry.ok) {
        ok += shape.map(([fx, fy], k) => `${k ? 'L' : 'M'}${(x0 + fx * slotW).toFixed(1)} ${(base + fy * amp).toFixed(1)}`).join('');
      } else {
        fail += `M${x0.toFixed(1)} ${base}H${(x0 + slotW).toFixed(1)}`;
        const cx = x0 + slotW / 2;
        crosses.push(`M${(cx - 3).toFixed(1)} ${base - 14}l6 6m0 -6l-6 6`);
      }
      if (entry) hits.push({ x0, entry });
    }

    const passed = data.filter((d) => d.ok).length;
    const root = svg('svg', {
      class: 'trace',
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      role: 'img',
      'aria-label': data.length
        ? `${label}: ${passed} of the last ${data.length} passed, ${data.length - passed} failed`
        : `${label}: no checks yet`,
    });
    if (gap) root.append(svg('path', { class: 'gap', d: gap }));
    if (ok) root.append(svg('path', { class: 'ok', d: ok }));
    if (fail) root.append(svg('path', { class: 'fail', d: fail }));
    crosses.forEach((d) => root.append(svg('path', { class: 'fail', d })));

    hits.forEach(({ x0, entry }) => {
      const rect = svg('rect', { x: x0, y: 0, width: slotW, height, fill: 'transparent' });
      const show = (e) => {
        const box = rect.getBoundingClientRect();
        tooltip.show(
          [
            ...tipRow(entry.ok ? `${entry.ms ?? '?'} ms` : 'Check failed', fmtDateTime(entry.t)),
          ],
          e.clientX ?? box.left + box.width / 2,
          e.clientY ?? box.top,
        );
      };
      rect.addEventListener('pointermove', show);
      rect.addEventListener('pointerleave', tooltip.hide);
      root.append(rect);
    });

    clear(container).append(root);
  };

  const ctl = responsive(container, render);
  return {
    update(next) {
      history = next;
      ctl.redraw();
    },
    destroy: ctl.destroy,
  };
}

/* ========================================================================
   Column chart: clicks per day.
   ======================================================================== */

function niceTicks(max) {
  if (max <= 4) return Array.from({ length: Math.max(max, 1) + 1 }, (_, i) => i);
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough);
  const ticks = [];
  for (let v = 0; v <= max + step - 1e-9; v += step) {
    ticks.push(v);
    if (v >= max) break;
  }
  return ticks;
}

export function columnChart(container, data, { height = 232, unit = 'clicks' } = {}) {
  const margin = { top: 22, right: 6, bottom: 26, left: 38 };

  const render = (width) => {
    const n = data.length;
    const max = Math.max(0, ...data.map((d) => d.value));
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1];
    const iw = width - margin.left - margin.right;
    const ih = height - margin.top - margin.bottom;
    const y = (v) => margin.top + ih - (v / top) * ih;
    const band = iw / n;
    const bw = Math.max(2, Math.min(24, band - 2));

    const root = svg('svg', {
      class: 'chart',
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      role: 'img',
      'aria-label': `${unit} per day, ${n} days, ${fmtNum(data.reduce((s, d) => s + d.value, 0))} total`,
    });

    ticks.forEach((t) => {
      root.append(svg('line', { class: t === 0 ? 'axis' : 'grid', x1: margin.left, x2: width - margin.right, y1: y(t), y2: y(t) }));
      root.append(svg('text', { class: 'tick', x: margin.left - 8, y: y(t) + 4, 'text-anchor': 'end' }, fmtNum(t)));
    });

    const labelIdx = [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
    labelIdx.forEach((i) => {
      const x = margin.left + band * i + band / 2;
      const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      const ax = i === 0 ? margin.left + band / 2 - bw / 2 : i === n - 1 ? margin.left + band * i + band / 2 + bw / 2 : x;
      root.append(svg('text', { class: 'tick', x: ax, y: height - 6, 'text-anchor': anchor }, shortDay(data[i].date)));
    });

    const peak = data.findIndex((d) => d.value === max);
    data.forEach((d, i) => {
      const x = margin.left + band * i + (band - bw) / 2;
      const g = svg('g', { class: 'col' });
      if (d.value > 0) {
        const bh = Math.max(2, (d.value / top) * ih);
        const r = Math.min(4, bw / 2, bh);
        const yTop = margin.top + ih - bh;
        // rounded data-end (top), square at the baseline
        g.append(
          svg('path', {
            class: 'bar',
            d: `M${x} ${margin.top + ih}V${yTop + r}Q${x} ${yTop} ${x + r} ${yTop}H${x + bw - r}Q${x + bw} ${yTop} ${x + bw} ${yTop + r}V${margin.top + ih}Z`,
          }),
        );
      }
      g.append(svg('rect', { class: 'hit', x: margin.left + band * i, y: margin.top, width: band, height: ih }));
      const show = (e) =>
        tooltip.show(tipRow(`${fmtNum(d.value)} ${d.value === 1 ? unit.replace(/s$/, '') : unit}`, shortDay(d.date)), e.clientX, e.clientY);
      g.addEventListener('pointermove', show);
      g.addEventListener('pointerleave', tooltip.hide);
      root.append(g);
    });

    if (max > 0 && peak >= 0) {
      const px = margin.left + band * peak + band / 2;
      const anchor = px < 40 ? 'start' : px > width - 40 ? 'end' : 'middle';
      root.append(svg('text', { class: 'peak', x: px, y: y(max) - 7, 'text-anchor': anchor }, fmtNum(max)));
    }
    if (max === 0) {
      root.append(svg('text', { class: 'empty', x: width / 2, y: margin.top + ih / 2, 'text-anchor': 'middle' }, `No ${unit} in this period yet`));
    }
    clear(container).append(root);
  };

  const ctl = responsive(container, render);
  return { destroy: ctl.destroy };
}

/* ========================================================================
   Horizontal bar list (browsers, OS, devices, referrers).
   ======================================================================== */

export function barList(container, rows, { total, emptyText = 'No data yet', unit = 'clicks' } = {}) {
  clear(container);
  if (!rows.length) {
    container.append(h('p', { class: 'muted small' }, emptyText));
    return;
  }
  const max = Math.max(...rows.map((r) => r.count));
  const sum = total ?? rows.reduce((s, r) => s + r.count, 0);

  const list = h('ul', { class: 'bars' });
  rows.forEach((r) => {
    const pct = sum ? (r.count / sum) * 100 : 0;
    const fill = h('span', { class: 'bar-fill' });
    fill.style.setProperty('--w', `${(r.count / max) * 100}%`);
    const row = h(
      'li',
      { class: 'bar-row' },
      h('span', { class: 'bar-name', title: r.label }, r.label),
      h('span', { class: 'bar-track' }, fill),
      h('span', { class: 'bar-val num' }, fmtNum(r.count)),
    );
    row.addEventListener('pointermove', (e) =>
      tooltip.show(tipRow(`${fmtNum(r.count)} ${unit}`, `${r.label}, ${pct < 1 ? '<1' : Math.round(pct)}% of total`), e.clientX, e.clientY),
    );
    row.addEventListener('pointerleave', tooltip.hide);
    list.append(row);
  });
  container.append(list);
}

/** Convert { Chrome: 3, Safari: 1 } into sorted [{label, count}] rows. */
export const mapToRows = (obj = {}) =>
  Object.entries(obj)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

/* ========================================================================
   Accessible table alternative for any series.
   ======================================================================== */

export function dataTable(columns, rows) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'table' },
      h('thead', {}, h('tr', {}, columns.map((c, i) => h('th', { scope: 'col', class: i ? 'r' : '' }, c)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, r.map((cell, i) => h('td', { class: i ? 'r' : '' }, cell))))),
    ),
  );
}
