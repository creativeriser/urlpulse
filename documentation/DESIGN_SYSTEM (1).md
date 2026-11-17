# URLPulse design system

Part of the URLPulse documentation set. [DOCUMENTATION.md](../../DOCUMENTATION.md) is the master document; if the two ever disagree, the master wins.

This file is enough to rebuild the website's look and feel from scratch, or to add a new screen that feels native. The code that implements it lives in `public/assets/css/`. **`tokens.css` is the only place colour, type, space, radius and motion values are defined**: change a value there and the whole site follows.

Contents: [1 Concept](#1-concept) · [2 Colour](#2-colour) · [3 Typography](#3-typography) · [4 Space, shape and layout](#4-space-shape-and-layout) · [5 Motion](#5-motion) · [6 Components](#6-components) · [7 Data visualisation](#7-data-visualisation) · [8 Dark mode](#8-dark-mode) · [9 Accessibility](#9-accessibility) · [10 Voice and copy](#10-voice-and-copy) · [11 Extending the system](#11-extending-the-system)

---

## 1. Concept

**ECG paper.** URLPulse watches whether links are alive, so the visual language is a heart monitor's printout: rose-tinted graph paper, ink-dark type, and one electric-violet trace.

Three rules keep the idea honest instead of decorative:

1. **The trace is data.** Every heartbeat drawn on the site is a real check result. A beat means a check passed. A flat line with a cross means it failed. On the landing page the hero trace is an illustration, and it is the only one.
2. **Colour has jobs.** Ink is for text. Violet is for data and links. Green, amber and red are reserved for status and never double as chart series colours.
3. **Graph paper appears only where the service reports on itself** (the hero and the status headline). Everywhere else the page is plain paper, so the grid keeps its meaning.

Personality comes from the type and the trace. Everything around them stays quiet: hairlines instead of boxes, no gradients, no decorative shadows.

## 2. Colour

### 2.1 Tokens

All values are CSS custom properties on `:root` in `tokens.css`.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--paper` | `#fcf7f8` | `#0f0c1d` | Page background |
| `--paper-sunk` | `#f6eef0` | `#171329` | Wells, table stripes, meter tracks, tags |
| `--panel` | `#ffffff` | `#1a1631` | Raised surfaces: inputs, tooltips, dialogs, trace panel |
| `--grid` | `#f0d9df` | `#1d1834` | ECG graph-paper lines (hero and status only) |
| `--line` | `#e6dde3` | `#2a2444` | Hairlines and decorative borders |
| `--line-strong` | `#cfc3cc` | `#453d68` | Axis lines, table rules, section rules |
| `--field-border` | `#8a8299` | `#6d6592` | Boundaries of interactive controls (must reach 3:1) |
| `--ink` | `#1a1438` | `#efebfa` | Primary text, primary button fill |
| `--ink-2` | `#544d6b` | `#b6afd0` | Secondary text |
| `--ink-3` | `#6e6784` | `#9a93b6` | Muted text and captions |
| `--on-ink` | `#fcf7f8` | `#0f0c1d` | Text on an `--ink` fill |
| `--pulse` | `#4b34e0` | `#a597ff` | Data series, links, traces, focus ring |
| `--pulse-strong` | `#3a26c4` | `#c1b7ff` | Hover and pressed state of violet |
| `--pulse-wash` | `rgb(75 52 224 / 10%)` | `rgb(165 151 255 / 14%)` | Area fills, meter tracks, selection |
| `--good` / `--good-mark` | `#0a7a0a` / `#0ca30c` | `#4ccf4c` / `#0ca30c` | Status green: text / marks and dots |
| `--warn` / `--warn-mark` | `#8a5a00` / `#b87a00` | `#f0b429` / `#fab219` | Status amber |
| `--bad` / `--bad-mark` | `#c42b2b` / `#d03b3b` | `#ff7b7b` / `#e66767` | Status red |
| `--shadow-pop` | soft, 22% ink | heavy, 60% black | Menus, tooltips, toasts only |

Each status colour comes in two strengths on purpose. The **text** value is darkened (light mode) or lightened (dark mode) until it reads as body text. The **mark** value is the pure hue, used for dots, strokes and borders where 3:1 is enough.

### 2.2 Measured contrast

Computed with the WCAG 2.x relative-luminance formula from the token values above (not estimated). Text needs 4.5:1, non-text indicators and control boundaries need 3:1.

| Pair | Light | Dark |
|---|---|---|
| `--ink` on `--paper` | 16.48 | 16.44 |
| `--ink-2` on `--paper` | 7.47 | 9.20 |
| `--ink-3` on `--paper` | 5.03 | 6.62 |
| `--ink-3` on `--paper-sunk` (tags, wells) | 4.68 | 6.22 |
| `--pulse` on `--paper` (links) | 6.91 | 7.77 |
| `--good` text on `--paper` | 5.21 | 9.48 |
| `--warn` text on `--paper` | 5.59 | 10.33 |
| `--bad` text on `--paper` | 5.31 | 7.68 |
| `--on-ink` on `--ink` (primary button) | 16.48 | 16.44 |
| White on `--pulse` (button hover, light) / dark ink on `--pulse` (dark) | 7.33 | 7.77 |
| `--field-border` vs `--paper` (control edge) | 3.45 | 3.60 |
| `--field-border` vs `--panel` | 3.66 | 3.26 |
| `--field-border` vs `--paper-sunk` | 3.21 | 3.38 |
| `--good-mark` vs `--paper` | 3.16 | 5.74 |
| `--warn-mark` vs `--paper` | 3.40 | 10.50 |
| `--bad-mark` vs `--paper` | 4.53 | 5.96 |

Every pair passes. The weakest are `--ink-3` on `--paper-sunk` in light mode (4.68, so do not make muted text smaller than the 14px step on a well) and `--field-border` on `--paper-sunk` (3.21).

**History worth knowing:** the first light `--warn-mark` was `#fab219` (1.73:1 on paper) and the first `--field-border` did not exist (controls used `--line`, about 1.6:1). Both were caught by running these calculations and fixed. Re-run them whenever a colour changes.

### 2.3 Usage rules

- Text uses `--ink`, `--ink-2` or `--ink-3`. **Never colour body text with a series colour.** A coloured dot or bar beside neutral text carries identity.
- **Never use status colour alone.** Every status shows an icon and a word (see the status pill). This is also why green and red do not need to be distinguishable by colour-blind users.
- `--pulse` is the single data colour. A chart with one series uses it; a chart never needs a second hue because the dashboard shows one measure per chart.
- Borders on decorative containers use `--line` or `--line-strong`. Borders on anything the user can click, type in or toggle use `--field-border`.
- No gradients and no tinted shadows. The only shadow is `--shadow-pop`, and only on things that float.

## 3. Typography

| Role | Family | Why |
|---|---|---|
| Everything (headlines, UI, body) | **Bricolage Grotesque**, variable (weight 200–800, width 75–100%) | A grotesque with a slightly quirky, ink-trap character. The width axis lets one family be both a tight, heavy display face and a calm text face. |
| URLs, codes, hashes, keys | **Martian Mono**, variable | Used only where characters must be told apart (`l`, `1`, `I`, `0`, `O`). Never for decoration or small labels. |

Both are self-hosted as Latin-subset `woff2` in `public/assets/fonts/` under the SIL Open Font License (licence files sit beside them). Self-hosting is required because the Content Security Policy is `default-src 'self'`, and it also means no third-party request leaks visitors' IPs. Bricolage is preloaded on every page; `font-display: swap` keeps text visible while it loads. Fallback stack: `ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`.

### 3.1 Scale

A 1.25 (major third) scale from a 16px base, fluid at the large end.

| Token | Size | Used for |
|---|---|---|
| `--step--1` | 14px | Captions, table cells, status pills, hints, compact buttons |
| `--step-0` | 16px | Body |
| `--step-1` | 20px | Lede, block titles, readout title, metric values |
| `--step-2` | 25px | Defined but currently unused (kept so the scale has no gap) |
| `--step-3` | 28–31px | `.h3`, a link's uptime state |
| `--step-4` | 32–39px | Live numbers on the landing page |
| `--step-5` | 40–49px | `.h2` |
| `--step-6` | 48–76px | `.h1`, status headline |
| `--step-7` | 52–100px | `.display` (landing hero) and the dashboard's large figure |

### 3.2 Treatments

- **Display** (`.display`, hero): `--step-7`, weight 800, width 75%, letter-spacing −0.03em, line-height 0.95. The status headline uses the same recipe at `--step-6` (width 76%). Heavy and condensed is the signature; do not use it below `--step-5`.
- **Headings:** `.h1` (`--step-6`) and `.h2` (`--step-5`) use weight 760, width 80%, letter-spacing −0.02em, line-height about 1.02. `.h3` (`--step-3`) uses weight 700, width 88%, −0.012em, line-height 1.15.
- **Lede** (`.lede`): `--step-1`, line-height 1.5, capped at 52ch. **Prose** (`.prose`) is capped at `--measure` (62ch). Body copy is `--step-0` at weight 400–500.
- **Numbers** in tables and counters use `.num` (tabular figures) so columns align and live-updating values do not jitter.
- Avoid all-caps labels, single-word colour accents inside headlines, and eyebrow labels above every heading. Structure comes from position and rules.

## 4. Space, shape and layout

### 4.1 Space

A 4px base: `--s-1` 4px, `--s-2` 8px, `--s-3` 12px, `--s-4` 16px, `--s-5` 24px, `--s-6` 32px, `--s-7` 48px, `--s-8` 72px, `--s-9` 112px. Gaps inside a component use `s-1`–`s-4`; gaps between page sections use `s-7`–`s-9`. Do not introduce values between steps.

### 4.2 Radius follows hierarchy

| Token | Value | Applied to |
|---|---|---|
| `--r-xs` | 4px | Tags, bar data-ends |
| `--r-sm` | 8px | Inputs, selects, small controls |
| `--r-md` | 14px | Panels, tooltips, dialogs |
| `--r-pill` | 999px | Buttons, segmented control, switch, meter |

One radius everywhere would flatten the hierarchy: the more important and tappable the element, the rounder it is.

### 4.3 Layout

- `.wrap`: centred container, max width `--page` (74rem, 1184px), side padding `--gutter` (`clamp(1rem, 4vw, 2.5rem)`, so 16px on a phone).
- Pages are single column on a phone and use a 7/5 or sidebar/detail grid on desktop. The grid collapses, content-driven, at `62rem`, `56rem` (status), `52rem`, `40rem`, `36rem` and `34rem`.
- No page scrolls horizontally at 390px. Wide data (the recent-clicks table) scrolls inside its own `.table-wrap`.
- `.stack` (vertical rhythm) and `.cluster` (wrapping horizontal group) are the two layout helpers; prefer them over one-off margins.

### 4.4 Elevation

Surfaces are separated with hairlines and the paper / panel / well tones, not shadows. `--shadow-pop` is reserved for the tooltip, toasts and the dialog.

## 5. Motion

| Token | Value | Use |
|---|---|---|
| `--dur-fast` | 120ms | Hover and colour changes |
| `--dur` | 220ms | Toggles, meter fill, toast entrance |
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | Everything |

Principles:

- **One orchestrated moment:** on load the hero trace draws itself once (`trace-draw`, 1.8s) and a travelling beat runs along it (`trace-run`). Nothing else animates on load: no staggered section fades, no hover lifts on cards.
- Motion that answers a user action is welcome: a result readout settling in (`readout-in`, 0.45s), a toast sliding in, the cache meter filling, the switch knob moving.
- `prefers-reduced-motion: reduce` collapses all animation and transition durations to near zero and turns off smooth scrolling.

## 6. Components

Class names are the real ones in `base.css` (shared) and the per-page stylesheets. Every component works with keyboard and screen reader; see [section 9](#9-accessibility).

**Button `.btn`.** Pill, minimum height 44px (`.btn-sm` 36px), ink fill with `--on-ink` text. Hover turns it violet. Modifiers: `.btn-quiet` (transparent, `--field-border` outline), `.btn-danger` (transparent with red outline; fills red on hover), `.btn-sm`, `.btn-lg`, `.btn-link` (text only). Disabled: 50% opacity, `not-allowed`. Press: 1px downward nudge. One primary button per view.

**Text field `.input` / select `.select`.** 8px radius, `--field-border` outline on a `--panel` fill, label above (`.field-label`), optional hint below (`.hint`). Error state sets `aria-invalid="true"` (red outline) and writes the message into a `.field-error` element with `role="alert"`; a success note uses `.field-ok`. The alias field has a prefix affix showing the host (`.affix-text`).

**Switch `.switch`.** A real `<input type="checkbox">` visually hidden behind a 40×24px pill track and a round knob. The track uses `--field-border` when off and `--pulse` when on. Focus ring appears on the track. Disabled when the feature is turned off server-side (`features.monitoring` is false).

**Segmented control `.segmented`.** Pill group of buttons for the 7 / 30 / 90 day range. The selected option has `aria-pressed="true"`. Focus is preserved across re-render (the range change re-fetches without losing the user's place).

**Status pill `.status`.** Icon plus label, coloured by `data-state`: `up` / `UP` green, `degraded` / `DEGRADED` / `pending` amber, `down` / `DOWN` / `DRAINING` red, `off` grey. Created with `statusBadge(state, label)` in `core.js`, which also picks the icon. Default labels (`STATUS_LABEL`): Up, Failing, Down, Waiting for first check, Not monitored for link states; All systems operational, Degraded, Outage, Restarting for service states. A page may pass its own label when it says more (the status page uses "Operational", "Unavailable", "Running", "Disabled").

**Tag `.tag`.** Small `--paper-sunk` chip with a 4px radius, for metadata such as "custom alias".

**Tooltip `.tooltip`.** One shared element positioned by script, `--panel` fill, 14px radius, `--shadow-pop`. Follows the pointer over a chart mark (`pointermove`) and hides on `pointerleave`; value first, label second (`tipRow(value, label)`). It is a convenience for pointer users, never the only way to read a number: keyboard, touch and screen-reader users get the same figures from each chart's `aria-label` summary and its "Show as table" view (see section 7). Content is built from DOM nodes, never HTML strings.

**Toast `.toast`.** Short confirmation in a polite live region (`.toasts`, `role="status"`), with a check icon (info) or a warning icon and red left edge (error). Removed after 3.2 seconds. Used for "Copied", never for errors the user must act on (those stay inline).

**Table `.table`.** Hairline rows, no zebra, 14px text, header cells use `scope="col"`. Always inside `.table-wrap` so it scrolls horizontally rather than the page. Cells do not wrap (`nowrap`).

**Dialog `.dialog`.** Native `<dialog>` opened with `showModal()`: focus trap, Escape to close and the backdrop come from the browser. Destructive confirmation has the safe action first and focused (`autofocus` on "Keep link").

**Readout `.readout`.** The result card after shortening: the short URL in mono at large size, copy / dashboard / QR actions, a management-key box shown **once** with its own copy button and a warning, and a QR image.

**Meter `.meter`.** A `role="meter"` track with a pill fill whose width is set through the `--w` custom property. Used for the cache hit ratio. Has `aria-valuenow` and `aria-valuetext`, and drops `aria-valuenow` when there is no data yet.

**Skip link, nav, footer.** A skip link is the first focusable element. The nav marks the current page with `aria-current="page"`. The theme toggle is an icon button that flips `data-theme` and remembers the choice in `localStorage` (`urlpulse.theme`).

## 7. Data visualisation

(Section referenced from `public/assets/js/charts.js`.)

The charts are dependency-free SVG and HTML in `charts.js`. They follow these rules.

**Form follows the job of the data.**

| Data | Form | Function |
|---|---|---|
| Pass/fail history of checks | Heartbeat trace | `heartbeatTrace` |
| Clicks per day | Column chart | `columnChart` |
| Browser / OS / device / referrer share | Horizontal bar list | `barList` |
| A single ratio | Meter | CSS `.meter` |
| A single headline number | Plain large number | `.num` |

**Marks.**

- One series colour: `--pulse`. A legend appears only when a chart has two or more series (none currently do).
- Columns are at most 24px wide with a 4px rounded top and a square baseline. Lines are 2px. Gridlines are hairlines in `--line`, recessive.
- Direct labels are selective: the peak value is printed above its column, and the date axis labels only the first, middle and last day. Never a number on every mark.
- Failed checks are drawn as a flat line with a red cross in `--bad-mark`; missing data as a dotted gap. Colour is never the only signal: the cross is a shape.
- The heartbeat adapts its density with `slotWidth` (about 20px per check, 16px on the status page) so a narrow chart shows fewer clearer beats instead of a smear. A simpler `BEAT_COMPACT` shape is used when slots are narrow.

**Interaction.**

- Every mark has a value tooltip on pointer hover. Hit areas span the whole slot or row, so they are larger than the visible mark.
- Charts carry a summary `aria-label` (for example "clicks per day, 7 days, 42 total"), and the click timeline and the recent-clicks list have a **"Show as table"** disclosure (`<details>` + `dataTable`), so every number is available without hover, to keyboard users and to screen readers.
- Charts re-render when their container resizes (`ResizeObserver`).
- **Known gap:** chart marks are not individually keyboard-focusable, so tooltips do not appear on focus, and touch devices have no hover. Making marks focusable (roving tabindex across a chart) is on the roadmap in DOCUMENTATION.md; until then the table view is the accessible path.

**Validation.** Chart colours were checked with the same contrast calculations as the rest of the palette (section 2.2). If a second series is ever added, pick its hue from a validated categorical palette (check lightness band, chroma and colour-blind separation), assign hues in fixed order, and never reuse the status colours.

## 8. Dark mode

"Monitor in a dark room": near-black violet paper, soft lavender ink, and a lighter lavender `--pulse` so data stays luminous.

- It is **selected, not inverted.** Each dark token is its own value, checked against the dark surfaces (section 2.2); status text colours move to lighter, more saturated values.
- Resolution order: an explicit `data-theme="light|dark"` on `<html>` (set by the toggle, stored in `localStorage`) wins; otherwise `prefers-color-scheme` applies.
- `theme-init.js` is a tiny classic (non-module) script in `<head>` that sets `data-theme` before first paint, so there is no flash of the wrong theme.
- The dark rules are written twice in `tokens.css` (a media query guarded with `:not([data-theme='light'])`, and an explicit `[data-theme='dark']` block). Edit both together.
- `color-scheme` is set so native controls, scrollbars and the `<dialog>` backdrop match.

## 9. Accessibility

Target: WCAG 2.2 AA.

- **Contrast** measured, section 2.2.
- **Keyboard:** every control, link and form works without a mouse. The one exception is the chart tooltip (section 7), whose figures are available through the table view instead. Focus ring is `--focus` (a 3px paper gap plus a 2px `--pulse` ring), visible on every control.
- **Structure:** one `<h1>` per page, landmarks (`header`, `nav` with `aria-label`, `main`, `footer`), skip link, `aria-current` on the active nav item, `lang="en"`.
- **Live regions:** the shorten result (`aria-live="polite"`, focus moves to it), the status headline (`aria-live="polite"`), toasts. The dashboard detail uses `aria-busy` while refetching.
- **Forms:** every control has a programmatic label; errors use `role="alert"` and `aria-invalid`; hints are tied with `aria-describedby`.
- **Status never relies on colour** (icon + label).
- **Reduced motion** respected. A **print** rule hides the site header, footer, toasts and tooltip.
- **Touch targets:** buttons are at least 44px tall; `.btn-sm` is 36px and is used only for secondary actions beside a larger target.
- **Reflow:** verified at 390px width with no horizontal page scroll on any page. (Not yet formally tested at 320px or at 200% zoom.)

## 10. Voice and copy

Plain, direct, sentence case, in the user's vocabulary (a person creates a *short link* and *watches* it; they do not "provision monitors").

- Buttons say what happens: **Shorten link**, **Copy link**, **Delete link**. The same action keeps the same name through the flow (a "Copy link" button produces a "Link copied" toast).
- Errors say what went wrong and how to fix it, without apologising or blaming: "That does not look like a valid URL. Include http:// or https://".
- Empty states point to the next action: "No links in this browser yet. Shorten a link".
- Numbers are specific and honest: "Answered your browser in 42 ms", "No redirects yet", never invented placeholders.
- Do not claim what the system does not do. The status page says "Development mode: data is lost when the server restarts" in memory mode, and "Turned off on this server" when monitoring is disabled.

## 11. Extending the system

To add a component:

1. Reuse tokens only. If you need a new value, add it to `tokens.css` (both themes) and to the tables above; then recompute contrast.
2. Build it from semantic HTML first (a real `<button>`, `<dialog>`, `<input>`), then style it. Do not add a click handler to a `<div>`.
3. Give every interactive element a visible focus state, a 44px target (36px if it is a secondary action), and a keyboard path.
4. If it conveys state, pair colour with an icon and text.
5. Add it to this file with its class names and states.

To re-skin the product: change the values in `tokens.css`. Because every component reads tokens, nothing else needs editing; then re-run the contrast calculations in section 2.2 and take screenshots in light, dark and at 390px width.
