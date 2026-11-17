# URLPulse website specification

Part of the URLPulse documentation set. [DOCUMENTATION.md](../../DOCUMENTATION.md) is the master document; if the two ever disagree, the master wins.

What the website is, how it is built, and exactly how every page behaves: enough to rebuild it or extend it. Visual rules (colour, type, components) are in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md); the API it calls is in [BACKEND_DESIGN.md](BACKEND_DESIGN.md#5-api-reference).

Contents: [1 Brief](#1-brief) · [2 Site map](#2-site-map) · [3 Architecture](#3-front-end-architecture) · [4 Home](#4-home-) · [5 Dashboard](#5-dashboard-dashboardcode) · [6 Status](#6-status-status) · [7 Error pages](#7-error-pages) · [8 Cross-cutting behaviour](#8-cross-cutting-behaviour) · [9 Responsive design](#9-responsive-design) · [10 Performance](#10-performance) · [11 Front-end security](#11-front-end-security) · [12 QA checklist](#12-qa-checklist) · [13 Extending](#13-extending-the-site) · [14 Screenshots](#14-screenshots)

---

## 1. Brief

**Audience.** A person with a long URL who wants a short one and, optionally, to know when the page behind it stops working: students, small-site owners, anyone sharing links in a README, a slide or a QR code. For this project the site is also a showcase, so it has to look and feel finished.

**Jobs of the site, in priority order**

1. Make a short link in under ten seconds, with no sign-up.
2. Show what happened to that link (clicks, devices, sources) and whether its destination is alive.
3. Show, honestly and live, whether the service itself is healthy.
4. Demonstrate the DevOps story (cache, pipeline, health) without lecturing.

**Principles.** The primary action is the first thing on the first screen. State is always visible and never colour-only. Real data beats placeholder data: the only illustrations are clearly labelled "Sample". Nothing is hidden behind an account.

**Non-goals.** No sign-in, no editing a link's destination, no marketing pages, no cookie banner (the site sets no cookies).

## 2. Site map

| URL | File | Purpose |
|---|---|---|
| `/` | `index.html` | Create a link; what every link gets; how a redirect works; the delivery pipeline |
| `/dashboard` or `/dashboard#<code>` | `dashboard.html` | Your links, analytics and uptime for one link |
| `/status` | `status.html` | Live service health |
| `/<code>` | (server) | 302 redirect to the destination |
| unknown path | `404.html` | "Nothing here" |
| expired link | `expired.html` | "This link has expired" (HTTP 410) |

The server maps `/dashboard` to `dashboard.html` through `express.static({ extensions: ['html'] })`. Anything with a dot, or a reserved word, is never treated as a short code, so `/dashboard`, `/status`, `/assets/...` can never be shadowed by a link. 404 and 410 pages are sent by the same code path as redirect failures; clients that ask for JSON get a JSON error instead.

Global navigation (header, every page): **Shorten**, **Dashboard**, **Status**, plus the theme toggle. Footer: the name, "A DevOps and Automation capstone project.", build information (`version · commit`), and links to Dashboard, Status and Health JSON.

## 3. Front-end architecture

A deliberately small, dependency-free site: **plain HTML, hand-written CSS, native ES modules, no framework, no bundler, no build step.** What is in `public/` is what ships.

Why: the content is three screens, the interactivity is forms and charts, the Content Security Policy forbids inline script and style anyway, and zero build tooling means nothing to maintain or to flag in a vulnerability scan. (All the JavaScript on the site is about 57 KB raw, 18 KB gzip, measured as one stream.)

```
public/
├── index.html  dashboard.html  status.html  404.html  expired.html
└── assets/
    ├── css/    tokens.css  base.css  charts.css  home.css  dashboard.css  status.css  error.css
    ├── js/     theme-init.js  core.js  charts.js  home.js  dashboard.js  status.js  shell.js
    ├── img/    favicon.svg
    └── fonts/  bricolage-grotesque-…woff2  martian-mono-…woff2  (+ OFL licence files)
```

**Stylesheets** load in this order on every page: `tokens.css` (all design values), `base.css` (reset, typography, layout helpers, every shared component), `charts.css` when charts appear, then one page file (`home.css`, `dashboard.css`, `status.css` or `error.css`) that only lays out and adds page-specific pieces. Page files never redefine tokens.

**Scripts**

| File | Role |
|---|---|
| `theme-init.js` | Classic script in `<head>`: sets `data-theme` from `localStorage` before first paint (no flash of the wrong theme) |
| `core.js` | Shared toolkit: `h()` and `svg()` DOM builders, `icon()`, `statusBadge()`, `api()` / `ApiError`, the link `store`, formatters, clipboard and toasts, tooltip, `initShell()` (theme toggle, build info), `debounce` |
| `charts.js` | `heartbeatTrace`, `columnChart`, `barList`, `mapToRows`, `dataTable` (SVG and HTML, no library) |
| `home.js`, `dashboard.js`, `status.js` | One module per page |
| `shell.js` | `initShell()` only, for the static error pages |

**Rules of the code**

- **DOM is built with `h(tag, attrs, ...children)`; server data is never parsed as markup.** All server data is inserted as text nodes, so there is no HTML-injection path. The single `innerHTML` use in the code base is `icon()` in `core.js`, which assigns strings from a constant table of SVG icons. (`eslint.config.js` has a separate block that lints `public/assets/js` as ES modules with browser globals.)
- `api(path, { method, body, token, signal })` wraps `fetch` (`token` becomes the `X-Manage-Token` header): JSON in and out, throws `ApiError { status, code, message, details }` for any non-2xx, and surfaces the API's error `message` directly so it can be shown to the user.
- Charts are objects with `update(data)` and `destroy()`; they redraw on container resize.
- Polling skips its tick while the tab is hidden (`document.visibilityState`), and the dashboard and status pages refresh at once when the tab becomes visible again.

**Browser storage** (the only state the site keeps; no cookies, no server session)

| Key | Content | Notes |
|---|---|---|
| `urlpulse.links.v1` | JSON array of up to 200 links created in this browser, newest first: `{ shortCode, shortUrl, originalUrl, manageToken, createdAt, expiresAt, monitor }` | Powers the dashboard list and holds the management keys. Clearing site data forgets them, and with them the ability to manage those links. |
| `urlpulse.theme` | `light` or `dark` | Absent = follow the operating system |

Every storage access is wrapped in `try/catch`: if storage is blocked (private modes), the site still works, and the create flow tells the user to copy the key now.

## 4. Home (`/`)

### 4.1 Hero: the shortener

- **Headline** (`.display`, h1): "Shorten a link. Then know if it's still alive." Lede below: what the user gets.
- **Hero trace:** a full-width ECG line behind the form. It draws once on load (1.8 s, CSS only) and a violet beat runs along it once after 1.5 s and again every time a link is created. It is decorative (`aria-hidden`) and the single illustration of the heartbeat idea. On a flat-line graph-paper background (`.grid-paper`).
- **Form** (`#shorten-form`, `novalidate`; JavaScript validates):

| Control | Behaviour |
|---|---|
| Long URL (`#url`, large) | Visually hidden label "Long URL", visible placeholder. Accepts input without a scheme: `example.com/page` becomes `https://example.com/page` before sending. Anything with a scheme is left for the server to judge. |
| Shorten link (`#submit-btn`) | While waiting: `aria-busy` and the label "Shortening…". Restored afterwards. |
| Custom alias (`#alias`) | Prefix shows the real host (`localhost:8080/`). Hint: "3 to 30 letters, numbers or hyphens. Leave empty for a random code." |
| Link expires (`#expires`) | Never (default), 1, 7, 30, 90 days, 1 year. Hint: "Visitors see an expired page afterwards." |
| Uptime check (`#watch` switch) | Label "Watch the destination". Enabling reveals the interval select (`#interval`: every minute, 5 minutes (default), 15 minutes, hour, day). If the server reports `features.monitoring === false`, the switch is disabled and its label reads "Uptime checks are turned off on this server". |

- **Validation and errors.** One error region (`#url-error`, `role="alert"`) under the main row. Empty submit: "Paste the URL you want to shorten." Server errors show the API's message, and `details.field` decides which control gets `aria-invalid="true"` and focus (URL, alias, expiry or interval). Typing clears the error. Other failure: "Something went wrong. Please try again."
- **Success:** the readout appears (4.2), the link is saved to the browser store, the URL and alias fields clear (expiry and uptime settings stay), focus moves to the readout, and the hero trace beats.

### 4.2 Result readout (`#result`, hidden until a link exists)

`aria-live="polite"`. Contains:

1. Title "Your short link is ready", then the short URL as a large mono link (opens in a new tab) and "Points to <destination>" (shortened with an ellipsis if long).
2. Actions: **Copy link** (becomes "Copied" for 1.8 s, plus a "Short link copied" toast), **Open in dashboard** (`/dashboard#<code>`), **Download QR** (PNG, 720 px).
3. **Management key box:** the key in mono with **Copy key** (toast "Management key copied"), and the text "This is the only time it is shown. You need it to delete the link or change its uptime check. It is already saved in this browser for your dashboard." If browser storage was blocked, a bold sentence is appended telling the user to copy the key now.
4. A QR code shown at 180 px (the image is requested at 360 px so it stays sharp on high-density screens, `alt="QR code for the short link"`) with the caption "Scan to open".

### 4.3 Section "What every link gets"

A two-column split (heading left, three feature rows right), each row a short paragraph beside a *specimen* labelled "Sample" or "Sample data":

| Feature | Specimen |
|---|---|
| Short links you control (random 7-character code or alias, expiry, QR, delete with key) | Three alias checks: available (green), taken (red), reserved word (red), each with icon + text |
| Analytics without tracking people (browser, OS, device, referrer; IPs salted and hashed, never stored; logs delete after 90 days) | A 14-day sample column chart |
| A heartbeat on the destination (passing check = beat, failing = flatline, two in a row = down) | A 36-check sample trace with two failed checks |

### 4.4 Section "How a redirect works"

Explains cache-then-database and batched click writes in prose, with an inline SVG diagram (`viewBox 960×300`, `role="img"`, a `<title>` and a long `<desc>` for screen readers): Browser → Nginx → URLPulse → Redis (hit, fast path in violet) and → MongoDB (miss, then cache fill), plus a dashed "Clicks: written in batches" path. Below it, **live numbers** from `/api/stats` (refreshed every 20 s): links created, redirects counted, cache hit ratio, links being watched. Placeholder "n/a" until loaded or if the request fails.

### 4.5 Section "Every change ships through a pipeline"

An ordered list (a real sequence, so numbered is correct) of seven stages: Push, Lint and test, Build, Scan ("Trivy fails the build on any critical vulnerability that has a fix"), Publish, Deploy, Observe. Each is one sentence of plain language. The smoke test that follows a deploy is in the workflow but is not a stage on the page. Source of truth: [DOCUMENTATION.md, CI/CD](../../DOCUMENTATION.md#cicd).

## 5. Dashboard (`/dashboard#<code>`)

A two-pane workspace. The **URL hash is the single source of truth** for which link is open, so a link's dashboard can be bookmarked and shared (`hashchange` drives selection).

### 5.1 Layout

| Desktop | Phone |
|---|---|
| Sidebar (lookup form + list of links) on the left, detail pane on the right | Stacked: lookup and list first, detail below |

### 5.2 Sidebar

- **Lookup form** (label "Look up any link by its code", placeholder "Code or short URL", button **View**): paste a code **or a whole short URL** (the pathname is extracted). Invalid input: "Codes are 3 to 30 letters, numbers or hyphens, like capstone-demo." with `aria-invalid`. Valid: clears and opens the link, which works for any link whether or not it was created in this browser.
- **"Your links"** (`#link-list`), the links created in this browser: each item shows the code, destination host, and a status badge when monitored (after enrichment fetches each link's current info, one request per link; a 404 marks it as missing). The selected item has `aria-current`. Empty state: "No links in this browser yet."
- On first load with no hash and a non-empty list, the newest link is selected automatically and the hash is set with `replaceState`.

### 5.3 Detail pane states

| State | What shows |
|---|---|
| No link selected | `#detail-empty`: a flat trace, "Pick a link to see its pulse" and an instruction to choose from the list or look up any link by its code |
| Loading | `aria-busy` is set on the pane and the previous content stays until the new data arrives, so a refresh never flashes empty (there is no skeleton) |
| Loaded | Header, clicks, breakdowns, recent clicks, uptime |
| Not found (404) | "No link with the code “abc”" and, if it was in the local list, a **Remove from this list** button |
| Other error | "Could not load this link" with the message and **Try again** |

Data is fetched together (`GET /api/url/:code` and `GET /api/analytics/:code?days=N`), reloaded every **15 s** while the tab is visible and the moment it becomes visible again. A request counter discards stale responses. A background refresh that fails keeps what is on screen instead of replacing it with an error. Switching theme re-renders so SVG colours follow.

### 5.4 Header

The short URL as the pane's heading, then "Points to <destination>" (a link, shortened with an ellipsis past 90 characters). Actions: **Copy link**, **Open link**, **Download QR** (PNG, 720 px) and, for the owner only, **Delete** (opens the native confirmation dialog, 5.8). A three-item list gives **Created** (date), **Expires** ("Never", "date (in 5 days)" or "Expired 2 days ago") and **Type** ("Custom alias" or "Random code"). Without the management key, a notice reads "You are viewing public analytics. This browser does not hold the management key, so you cannot change or delete this link."

### 5.5 Clicks

- Segmented range control: **7 / 30 / 90 days** (`aria-pressed`). Changing it re-fetches and re-renders, and **keeps keyboard focus on the same button** (`state.refocus`).
- Headline: the lifetime total ("N clicks in total"), followed by ", M in the last D days" when the period differs.
- **Column chart** under the heading "Clicks per day" (zero-filled by the API), tooltip on hover.
- **Show as table** disclosure (`<details>`): Day / Clicks. Open state survives re-render.

### 5.6 Breakdowns and recent clicks

Four horizontal bar lists: **Browsers**, **Operating systems**, **Devices**, **Referring sites**. Each row: label, count, share of the period; an empty list shows "No clicks in this period yet". Referrers show the **host only** (scheme and `www.` removed); the API reports visits with no referrer as "Direct". **Recent clicks** is a table of the latest ten clicks (columns When, Browser, System, Device, From; empty state "No clicks yet. Open the short link to record the first one.") inside a horizontally scrolling wrapper so the page itself never scrolls sideways.

#### Who can see this data

Reading a link's info and analytics needs only its code, not the key. Anyone who knows a code can view the aggregate statistics (never IP addresses or personal data), which is why that is stated as a known limitation in [DOCUMENTATION.md](../../DOCUMENTATION.md#known-limitations).

### 5.7 Destination uptime

| Monitor state | Presentation |
|---|---|
| `off` | Label "Not monitored" and the note "Turn on the uptime check and URLPulse will visit the destination on a schedule." The owner gets the controls below; a non-owner sees "Only the link’s owner can turn the uptime check on." |
| `pending` | Label "Waiting for first check", note "The first check will run shortly." |
| `up` | Note "The destination answered the last check." |
| `degraded` | Note "The last check failed. One more failure marks this link as down." |
| `down` | Note "The last N checks failed: <reason>." |

Every state shows an icon and a text label (never colour alone). Once at least one check has run, the section also shows four figures (**Uptime** %, **Last response** in ms or "No response", **Last checked** as relative time, **Checks run**), the **heartbeat trace** of the stored history (the last 48 checks, newest on the right) with the caption "Each beat is one check, newest on the right. A flatline with a cross is a failed check.", and a "Show check history as table" disclosure (columns Checked, Result as Passed or Failed, Response).

Owner controls: a switch (`#monitor-switch`, "Watch the destination") and an interval select (`#monitor-interval`). Turning the switch on or off, or changing the interval, calls `PATCH /api/url/:code/monitor` with the management key; success toast "Uptime check is on" or "Uptime check is off"; failure toast with the server's message and the controls revert; focus returns to the switch after the re-render.

### 5.8 Owner versus read-only

"Owner" means the browser holds this link's management key in its store. Without it the dashboard works in **read-only mode**: analytics and uptime are visible, but Delete and the uptime controls are not rendered. This matches the API, where those actions need `X-Manage-Token`.

**Delete dialog** (`<dialog id="delete-dialog">`): "Delete this link?" with the code and the consequence (the short link stops working and its click history is removed). Buttons: **Keep link** (default focus) and **Delete link** (danger). On success: remove from the list, "Link deleted" toast, return to the empty detail state. On failure: error toast.

## 6. Status (`/status`)

The service's own health, rendered live in the product's visual language.

### 6.1 Headline

An `h1` (`aria-live="polite"`) with a status icon and one of:

| `/health` status | Headline | Note |
|---|---|---|
| `UP` | All systems operational | The web app, database and cache are all responding. |
| `DEGRADED` | Running with reduced performance | The cache is unavailable. Redirects still work, served from the database, but more slowly. |
| `DOWN` | Service outage | The database is unreachable, so links cannot be created or opened until it is back. |
| `DRAINING` | Restarting | The server is shutting down for a restart. This page keeps checking. |
| fetch failed | Cannot reach the server | Your browser did not get a response. It will keep trying every 5 seconds. |
| before the first reply | Checking the service… | Asking the server how it is doing. |

The note ends with "Last checked at HH:MM:SS". The document title also changes (`<headline> | URLPulse status`) so a background tab shows the state. 503 responses are parsed as data, not treated as network errors.

### 6.2 Trace panel

A heartbeat chart of your browser's own `/health` checks every 5 seconds since the page opened (up to 120 kept): a beat per success, a flatline with a cross per failure (HTTP error or no answer). Caption explains this in plain words. This is the only chart on the site made from the viewer's own live measurements.

### 6.3 Components

A ledger of rows (name, detail, status badge): **Web application** ("Answered your browser in N ms"; "Restarting" while draining), **MongoDB** ("Database round trip N ms"; "The database did not answer its ping" when down; in development it is named **In-memory store** with "Development mode: data is lost when the server restarts"), **Redis cache** ("Round trip N ms"; badge "Unavailable" with "Redirects fall back to the database until it returns"; in development **In-memory cache**; when caching is off, **Cache** with "Caching is turned off, so every redirect reads the database" and badge "Disabled"), **Uptime monitor** ("Watching N links, M currently down" or "Turned off on this server"). The monitor row only shows when stats are fresh: if the server is unreachable, stale numbers are hidden rather than presented as current.

### 6.4 This deployment

Version, build (first 12 characters of the commit, mono; "Development build" when unset), running for (human duration), links stored, redirects counted. A **cache hit ratio meter** (`role="meter"`, 0–100) with the sentence "N% of redirect lookups were answered from the cache: X hits and Y misses since the server started", or "No redirects yet. Open a short link to see the cache fill." `/api/stats` is polled every 15 s.

### 6.5 For operators

A table (columns Endpoint, What it answers, Used by) of `/livez`, `/health`, `/metrics` and `/api/stats`. `/metrics` is named but **not** linked, with the note "Reachable only inside the deployment, not from the public internet."

## 7. Error pages

`404.html` ("Nothing here") shows a heartbeat that stops in a flatline ending in a red cross; its actions are **Shorten a link** and **Open dashboard**. `expired.html` ("This link has expired") shows a heartbeat that fades into a dotted line; its actions are **Shorten a link** and **Check service status**. Both use `shell.js` for the theme toggle and build info, and the server sends them with `Cache-Control: no-store` and the correct status code (404 and 410) so search engines and monitors see the truth.

## 8. Cross-cutting behaviour

- **Theme:** toggle in the header; remembered; follows the OS when no choice was made; applied before paint. Charts re-render on `themechange`.
- **Copy to clipboard:** uses the async Clipboard API with a fallback to a temporary hidden `<textarea>` and `execCommand('copy')`; always confirms with a toast ("… to clipboard", or "Could not copy. Select the text and copy it manually.").
- **Toasts:** polite live region, 3.2 s.
- **Dates and numbers:** formatted for display with `Intl` and `toLocaleDateString` in English; the API's UTC values are never altered. Counters use tabular figures.
- **Build info:** the footer shows `version · commit` from `/api/stats`, so a screenshot of any page identifies the deployed build.
- **Offline or API failure:** every fetch has a failure path with text; pages never sit on a spinner forever.
- **Keyboard:** full tab order, visible focus, skip link, native `<dialog>` and `<details>`.

## 9. Responsive design

Layout is fluid, and the breakpoints in use are `62rem`, `56rem`, `52rem`, `40rem`, `36rem` and `34rem`. Wide tables scroll inside their own `.table-wrap` so the page itself never scrolls sideways (checked in a headless browser at 390 px, see section 12).

| Breakpoint | What changes |
|---|---|
| ≤ 62rem | Home: heading/feature split becomes one column and the pipeline turns from a horizontal row into a vertical timeline. Dashboard: sidebar stacks above the detail and the link list becomes a multi-column grid of bordered items. |
| ≤ 56rem | Status: the two-column grid becomes one column. |
| ≤ 52rem | Home: shorten options become one column; each feature stacks its specimen under its text; the readout stacks the QR code under the key. |
| ≤ 40rem | Dashboard: breakdowns become one column and bar-row label column narrows. |
| ≤ 36rem | Home: the form button drops under the URL field at full width, the hero trace shortens. Status: each component row stacks with its badge on top. |
| ≤ 34rem | Header: tighter gaps and smaller nav text; the brand name is hidden and only the mark remains. |

## 10. Performance

Measured from the files in `public/` (gzip level 9; the font is already compressed):

| Page | HTML + CSS + JS (gzip) | Plus font |
|---|---|---|
| Home | about 26 KB | Bricolage 78 KB; Martian Mono 38 KB where mono text is shown |
| Dashboard | about 25 KB | same |
| Status | about 21 KB | same |

- No framework, no third-party requests, no images other than the favicon and the QR code.
- Only Bricolage Grotesque is preloaded; fonts are cached for a year (`immutable`), HTML is `no-cache` so a deploy is visible immediately, and all other assets cache for an hour. Martian Mono is fetched by the browser only when text set in it is first rendered.
- Responses are compressed by the app (`compression` middleware).
- API polling is light and skips ticks in hidden tabs: status page `/health` every 5 s and `/api/stats` every 15 s, dashboard 15 s, home-page numbers 20 s. `/api/stats` answers with `Cache-Control: public, max-age=5` and its database counts are cached on the server for 10 s.

Reference budget for future changes: keep each page under about 40 KB gzip of HTML, CSS and JS excluding fonts.

## 11. Front-end security

- **CSP** `default-src 'self'` with no `unsafe-inline`: all script and style are external files; there are no inline handlers or `style=""` attributes. Dynamic widths are applied with the CSSOM (`style.setProperty('--w', …)`), which CSP allows.
- **Server data never becomes markup**: all dynamic content goes through text nodes (section 3); the only `innerHTML` is the constant icon table.
- `target="_blank"` links carry `rel="noopener"`.
- **Management keys in `localStorage`:** readable by any script on the origin, so the CSP and the rule that server data never becomes markup are what protect them. The keys only manage links, never an account. Trade-off accepted and documented; see DOCUMENTATION.md, Known limitations.
- QR images and downloads come from same-origin API URLs.

## 12. QA checklist

**Automated:** `scripts/ui-check.js` (`make ui-check`) drives the real pages in headless Chromium at 390 px, in light and dark, and checks the items marked ✔ below. It needs a running app and Playwright (its header comment says how to install it); it is not part of `npm test`, so CI does not run it. 60 of 60 checks passed on the shipped version.

Run through the list after any UI change:

1. Home ✔ empty submit shows the error and focuses the URL field; a reserved alias (`dashboard`) is rejected with `aria-invalid`; a bare domain is accepted; success moves focus to the readout, saves the link with its key, and the QR loads; the short link redirects with a 302 and `no-store`.
2. Dashboard ✔ the newest link is selected automatically; changing the range keeps keyboard focus; the table views exist; an invalid lookup shows its message; an unknown code shows the not-found state; a link whose key is not stored is read-only (no Delete button, explanatory notice). By hand: tooltip on a chart column, a down link's red flatline, the uptime switch, the delete dialog.
3. Status ✔ all five headlines (UP, DEGRADED, DOWN, DRAINING, unreachable), simulated by intercepting `/health`.
4. Both themes ✔. By hand: toggle the theme while a chart is on screen.
5. 390 px ✔ no horizontal scroll on home (also after a result appears), dashboard (also with a table open), status and the 404 page. By hand: every control is at least 44 px tall (36 px for small buttons).
6. By hand, keyboard only: reach and operate every control; Escape closes the dialog; focus is always visible.
7. By hand, reduced motion: no animation.
8. By hand, contrast: re-run the calculations in DESIGN_SYSTEM.md if any colour changed.
9. ✔ No JavaScript errors, and no failed requests other than the ones the script provokes on purpose.

## 13. Extending the site

**Add a page:** copy `status.html` as a starting point (it has the complete head, header, skip link and footer), add `<page>.css` that only does layout, add `<page>.js` that starts with `initShell()`, link it in the nav on every page, and add the route to the table in section 2 (and, if the URL is a plain word, to `RESERVED_ALIASES` in `src/lib/validators.js` so no short link can shadow it).

**Add a chart:** write it in `charts.js` following the rules in DESIGN_SYSTEM.md section 7: one series colour, tooltip, summary `aria-label`, table view, `update` and `destroy`.

**Change the look:** edit `tokens.css` only (DESIGN_SYSTEM.md, section 11).

## 14. Screenshots

Reference renders of the shipped design at 1440 px wide, in both themes, are in `docs/screenshots/`: `home-<theme>.png` (hero and form), `home-result-<theme>.png` (the result readout with management key and QR), `dashboard-<theme>.png` (a link with 46 sample clicks and a passing uptime check) and `status-<theme>.png`. They were produced by driving the real pages in headless Chromium against a development server, so they show real rendering, not a mock-up. They were captured with Playwright at 1440 × 900 (the dashboard at 1440 × 1500) with sample clicks recorded through the redirect. Regenerate them after any visual change.
