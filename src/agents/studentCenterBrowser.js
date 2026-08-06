const puppeteer = require('puppeteer'); // npm install puppeteer --save
const logger = require('../utils/logger');

// ═══════════════════════════════════════════════════════════════════════════
// centerres.rutgers.edu client — headless-browser approach
//
// Why this instead of raw fetch(): the site pairs a `dea-csrftoken` header
// with an `__AntiXsrfToken` cookie AND an opaque, likely session-bound
// `data=` param on LocationDetails.aspx — reproducing all three by hand is
// fragile and will silently break if the site rotates its token scheme.
// Instead, we let a real (headless) browser load the page, let the page's
// own JS mint tokens and fire its own XHR, and we just intercept the
// response. We reuse the parsing logic already confirmed:
//   response.d (string) → JSON.parse → .JsonData (string) → JSON.parse
//   → { bookings: [ { GmtStart, GmtEnd, Start, End, Title, Position,
//        Height }, ... ] }
//
// IMPORTANT — the selectors below (search form fields, result-row links,
// Next/Prev buttons) are TODO(verify): I don't have the live HTML of
// browseforspace.aspx, so these are best-guess CSS selectors based on
// typical EMS markup conventions. Run with DEBUG=true locally (headless:
// false) to watch it click through and fix any selector that misses —
// see debugRun() at the bottom for a quick way to do that with screenshots.
// ═══════════════════════════════════════════════════════════════════════════

const BASE = 'https://centerres.rutgers.edu';
const BROWSE_URL = `${BASE}/browseforspace.aspx`;
const LOGIN_URL = `${BASE}/AccountManagement.aspx`;
const AVAILABILITY_XHR_PATH = 'AnonymousServersApi.aspx/GetLocationDetailsAvailability';

const AVAIL_CACHE_MS = 5 * 60 * 1000;
const _dayCache = new Map(); // `${roomQuery}_${date}` → { data, fetchedAt }
const _snapshotCache = new Map(); // `${date}` → { data, fetchedAt }

// Known building-id → display-name mapping. Confirmed 2026-08-06 by
// scraping the "Locations" filter modal's checkbox list (aria-label +
// value pairs) — see the "Filter By Area" panel on browseforspace.aspx.
const BUILDING_NAMES = {
  '1':   'College Avenue Student Center',
  '2':   'Busch Student Center',
  '5':   'Cook Student Center',
  '6':   'Douglass Student Center',
  '7':   'Livingston Student Center',
  '9':   'Student Activities Center',
  '328': 'Outdoor Space',
};

function buildingLabel(buildingId) {
  return BUILDING_NAMES[buildingId] || `Building #${buildingId}`;
}

/**
 * Static list of known buildings for Discord autocomplete on the
 * `building` option — { id, name } pairs, e.g. { id: '7', name:
 * 'Livingston Student Center' }. Doesn't require a live scrape since
 * BUILDING_NAMES is a fixed, confirmed mapping.
 */
function listBuildings() {
  return Object.entries(BUILDING_NAMES).map(([id, name]) => ({ id, name }));
}

// ── Browser singleton ─────────────────────────────────────────────────────────
// Launching a full browser per request is slow; keep one instance alive and
// open/close pages (tabs) per request instead.
let _browserPromise = null;

async function getBrowser() {
  if (!_browserPromise) {
    const isDebug = process.env.CENTERRES_DEBUG === 'true';
    if (isDebug) {
      // CENTERRES_DEBUG is meant ONLY for the manual debug/discovery
      // helpers below, run one-off in a terminal. If it's ever true during
      // a normal `npm start` run, a real visible Chrome window opens for
      // every request — including ones triggered by Discord users. This
      // usually happens because `$env:CENTERRES_DEBUG="true"` in
      // PowerShell sets it for the REST of that terminal session, not just
      // the one command — so it silently leaks into a later `npm start`
      // in the same window. Logging loudly here means that leak shows up
      // in the bot's own logs instead of only being visible as a mystery
      // Chrome window.
      logger.warn('⚠️⚠️⚠️  CENTERRES_DEBUG=true — launching a VISIBLE Chrome window for every request. If this is a real bot run (not a one-off debug script), close this terminal and start a fresh one, or run: Remove-Item Env:CENTERRES_DEBUG  ⚠️⚠️⚠️');
    }
    _browserPromise = puppeteer.launch({
      headless: isDebug ? false : 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'] // TODO(verify): may not be needed depending on host
    });
  }
  return _browserPromise;
}

async function closeBrowser() {
  if (_browserPromise) {
    const browser = await _browserPromise;
    await browser.close().catch(() => {});
    _browserPromise = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Parsing — unchanged from the confirmed shape
// ═══════════════════════════════════════════════════════════════════════════

function parseAvailabilityResponse(bodyText) {
  const outer = JSON.parse(bodyText); // { d: "<json string>" }
  if (!outer || typeof outer.d !== 'string') {
    throw new Error('Unexpected response shape: missing string "d" property');
  }
  const inner = JSON.parse(outer.d);
  if (!inner || typeof inner.JsonData !== 'string') {
    throw new Error('Unexpected response shape: missing string "JsonData" property');
  }
  const data = JSON.parse(inner.JsonData);
  const bookings = Array.isArray(data.bookings) ? data.bookings : [];

  return bookings.map(b => ({
    title: b.Title || 'Reserved',
    start: b.Start,
    end: b.End,
    gmtStart: b.GmtStart,
    gmtEnd: b.GmtEnd,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Navigation — search for a room, scrape booking presence directly out of
// the results grid's DOM.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Searches for a room and scrapes booking presence directly from the
 * results grid's DOM — no need to click into LocationDetails.aspx or deal
 * with the CSRF/session complexity that page's XHR requires.
 *
 * Tradeoff: this gives busy/open status and booking count, NOT exact
 * start/end times (those are pixel positions on the calendar, not present
 * as text in the DOM — see the block comment above KNOWN_ROOMS for the
 * confirmed structure). Good enough to answer "is this room free" without
 * more reverse-engineering; exact time ranges are a future upgrade if
 * wanted later — either the underlying XHR or pixel-to-time calibration
 * against the header row, both still unconfirmed.
 *
 * @param {string} roomName - e.g. "BSC 115" (matches the site's own search)
 * @returns {Promise<{ events: Array<{title: string, bookingId: string}>, authRequired: boolean }>}
 */
async function fetchRoomAvailabilityViaBrowser(roomName) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.goto(BROWSE_URL, { waitUntil: 'networkidle2' });

    if (/AccountManagement\.aspx/i.test(page.url())) {
      return { events: [], authRequired: true };
    }

    const searchSelector = '#find-a-room-filter';
    await page.waitForSelector(searchSelector, { timeout: 10000 });
    await page.click(searchSelector, { clickCount: 3 }); // select any existing text first
    await page.type(searchSelector, roomName, { delay: 20 });
    await page.keyboard.press('Enter');

    // Wait for the AJAX search to actually finish rather than a fixed sleep.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {});

    // The site keeps every room in the DOM at all times and just toggles
    // display:none on non-matches (confirmed via DevTools) — so after
    // searching, find whichever .room-row is actually visible.
    const events = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.room-row.grid-row[data-room-id]'));
      const visibleRow = rows.find(r => r.style.display !== 'none');
      if (!visibleRow) return null; // no match for this search

      const containers = Array.from(visibleRow.querySelectorAll('.event-container'));
      return containers.map(c => ({
        title: c.getAttribute('title') || 'Reserved',
        bookingId: c.getAttribute('data-booking-id') || null,
      }));
    });

    if (events === null) {
      logger.warn('No matching room-row found for search', { roomName });
      return { events: [], authRequired: false, matched: false };
    }

    return { events, authRequired: false, matched: true };

  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Bulk snapshot of EVERY room currently loaded in the DOM, in a single page
 * load — no per-room search needed. This is the "check every student
 * center at once" path used by /student-center when no room is specified.
 *
 * Same trick as discoverRooms(): the site keeps every room-row in the DOM
 * regardless of search filter, so loading the page unfiltered and reading
 * .room-row.grid-row[data-room-id] gives the full set (confirmed 166 rooms
 * across 7 buildings: 1, 2, 328, 5, 6, 7, 9).
 *
 * Same caveat as fetchRoomAvailabilityViaBrowser: this reads busy/open +
 * booking count from event-containers in the DOM, not exact times, and
 * always reflects whatever day the site currently defaults to (today) —
 * date navigation still isn't wired up.
 *
 * TODO(verify): room display-name scraping is best-effort. There's no
 * confirmed ".room-name"-style label element yet, so this first tries a
 * few likely selectors, then falls back to "whatever text is in the row
 * minus the event containers." If names come back ugly/wrong, inspect a
 * .room-row in DevTools and swap in the real label selector.
 *
 * @returns {Promise<{ authRequired: boolean, rooms: Array<{roomId, buildingId, name, events}> }>}
 */
/**
 * Bulk snapshot of EVERY room currently loaded in the DOM, in a single page
 * load — no per-room search needed. This is the "check every student
 * center at once" path used by /student-center when no room is specified.
 *
 * Same trick as discoverRooms(): the site keeps every room-row in the DOM
 * regardless of search filter, so loading the page unfiltered and reading
 * .room-row.grid-row[data-room-id] gives the full set (confirmed 166 rooms
 * across 7 buildings: 1, 2, 328, 5, 6, 7, 9).
 *
 * Same caveat as fetchRoomAvailabilityViaBrowser: this reads busy/open +
 * booking count from event-containers in the DOM, not exact times, and
 * always reflects whatever day the site currently defaults to (today) —
 * date navigation still isn't wired up.
 *
 * CONFIRMED (via live DevTools dump, 2026-08-06): the room's display name
 * and capacity are NOT inside .room-row at all (that element is pure
 * timeline/grid content — just "Closed" markers and event-containers).
 * They live in a separate, structurally-sibling "row labels" column:
 *   .room-column.column[data-room-id="158"][data-building-id="7"][title="LSC 109"]
 *     .column-text > a.location  → "LSC 109" (same text as the title attr)
 *     .column-label               → "12 " (capacity, as text)
 * Both elements share the same data-room-id/data-building-id, so they're
 * joined by that key below rather than by DOM position.
 *
 * @returns {Promise<{ authRequired: boolean, rooms: Array<{roomId, buildingId, name, capacity, events}> }>}
 */
async function fetchAllRoomsSnapshot() {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.goto(BROWSE_URL, { waitUntil: 'networkidle2' });

    if (/AccountManagement\.aspx/i.test(page.url())) {
      return { authRequired: true, rooms: [] };
    }

    await page.waitForSelector('.room-row.grid-row[data-room-id]', { timeout: 10000 }).catch(() => {});

    const rooms = await page.evaluate(() => {
      // Name + capacity live in the separate label column, keyed by
      // data-room-id — build a lookup first.
      const nameMap = {};
      document.querySelectorAll('.room-column.column[data-room-id]').forEach(col => {
        const roomId = col.getAttribute('data-room-id');
        const linkEl = col.querySelector('a.location');
        const name = col.getAttribute('title') || (linkEl ? linkEl.textContent.trim() : null);
        const capacityText = col.querySelector('.column-label')
          ? col.querySelector('.column-label').textContent.trim()
          : '';
        const capacity = capacityText && /^\d+$/.test(capacityText) ? parseInt(capacityText, 10) : null;
        nameMap[roomId] = { name, capacity };
      });

      const rows = Array.from(document.querySelectorAll('.room-row.grid-row[data-room-id]'));
      return rows.map(r => {
        const roomId = r.getAttribute('data-room-id');
        const events = Array.from(r.querySelectorAll('.event-container')).map(c => ({
          title: c.getAttribute('title') || 'Reserved',
          bookingId: c.getAttribute('data-booking-id') || null,
        }));
        const info = nameMap[roomId] || {};

        return {
          roomId,
          buildingId: r.getAttribute('data-building-id'),
          name: info.name || `Room ${roomId}`,
          capacity: info.capacity ?? null,
          events,
        };
      });
    });

    return { authRequired: false, rooms };

  } catch (err) {
    logger.error('fetchAllRoomsSnapshot failed:', err.message);
    return { authRequired: false, rooms: [], error: true };
  } finally {
    await page.close().catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — same shape as the previous fetch-based client, so
// interactionHandler.js doesn't need to change for the single-room path.
// ═══════════════════════════════════════════════════════════════════════════

async function fetchRoomDay(roomQuery, date) {
  const cacheKey = `${roomQuery}_${date}`;
  const cached = _dayCache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < AVAIL_CACHE_MS) {
    return cached.data;
  }

  let result;
  try {
    const { events, authRequired, matched } = await fetchRoomAvailabilityViaBrowser(roomQuery);
    if (authRequired) {
      result = { status: 'auth_required', events: [] };
    } else if (!matched) {
      result = { status: 'not_found', events: [] };
    } else if (events.length === 0) {
      result = { status: 'open', events: [] };
    } else {
      // TODO(verify): date navigation isn't wired up yet — this always
      // reads whatever day the site currently defaults to (today), not
      // the requested `date` param. Clicking #nextDayBtn/#previousDayBtn
      // the right number of times, or finding a URL/query-param way to
      // jump straight to a date, would fix this — worth doing once the
      // busy/open MVP is confirmed working end-to-end.
      result = { status: 'busy', events: events.map(e => ({ title: e.title, bookingId: e.bookingId })) };
    }
  } catch (err) {
    logger.error('fetchRoomDay (browser) failed:', { roomQuery, date, error: err.message });
    result = { status: 'error', events: [] };
  }

  _dayCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
  return result;
}

/**
 * Cached wrapper around fetchAllRoomsSnapshot(), grouped-by-building
 * summary already computed so interactionHandler.js doesn't need to
 * duplicate that logic.
 */
async function fetchAllRoomsSummary(date) {
  const cached = _snapshotCache.get(date);
  if (cached && (Date.now() - cached.fetchedAt) < AVAIL_CACHE_MS) {
    return cached.data;
  }

  let result;
  try {
    const { authRequired, rooms, error } = await fetchAllRoomsSnapshot();
    if (authRequired) {
      result = { authRequired: true, total: 0, open: 0, busy: 0, buildings: [] };
    } else {
      const byBuilding = new Map();
      let openCount = 0;
      let busyCount = 0;

      for (const r of rooms) {
        const isBusy = r.events.length > 0;
        if (isBusy) busyCount++; else openCount++;

        const label = buildingLabel(r.buildingId);
        if (!byBuilding.has(label)) byBuilding.set(label, { label, total: 0, open: 0, busy: 0 });
        const b = byBuilding.get(label);
        b.total++;
        if (isBusy) b.busy++; else b.open++;
      }

      result = {
        authRequired: false,
        error: !!error,
        total: rooms.length,
        open: openCount,
        busy: busyCount,
        buildings: Array.from(byBuilding.values()).sort((a, b) => b.total - a.total),
        // Annotated per-room list, kept alongside the building grouping so
        // callers can filter to one building and list its individual rooms
        // without a second fetch.
        rooms: rooms.map(r => ({
          roomId: r.roomId,
          buildingId: r.buildingId,
          buildingLabel: buildingLabel(r.buildingId),
          name: r.name,
          capacity: r.capacity,
          busy: r.events.length > 0,
          bookingCount: r.events.length,
        })),
      };
    }
  } catch (err) {
    logger.error('fetchAllRoomsSummary failed:', err.message);
    result = { authRequired: false, error: true, total: 0, open: 0, busy: 0, buildings: [] };
  }

  _snapshotCache.set(date, { data: result, fetchedAt: Date.now() });
  return result;
}

// CONFIRMED (via live DevTools inspection, 2026-08-05):
//   - Searching "BSC 115" in #find-a-room-filter shows exactly one visible
//     .room-row.grid-row[data-room-id] div — its internal id is 113, NOT
//     115. The room code shown to users ("BSC 115") is NOT the same value
//     used internally — don't assume they match for any other room either.
//   - data-building-id="2" = Busch Student Center.
//   - Bookings render directly in the DOM as nested elements:
//       .room-row.grid-row[data-room-id="113"]
//         .event-container[data-booking-id][data-private="true"][title]
//           .event  (title attribute holds "Unavailable" for private
//                     bookings — position/width are pixel offsets on the
//                     calendar, not explicit start/end timestamps)
//   - Bulk (unfiltered) page load surfaces 166 room-rows across 7
//     buildingIds: 1, 2, 328, 5, 6, 7, 9 — all labeled now, see
//     BUILDING_NAMES above (confirmed via the "Locations" filter modal's
//     checkbox list, 2026-08-06).
const KNOWN_ROOMS = [
  { key: 'BSC 115', name: 'BSC 115', building: 'Busch Student Center', buildingId: '2', internalRoomId: '113' },
];

function listKnownRooms() {
  return KNOWN_ROOMS;
}

// ── Debug helper ─────────────────────────────────────────────────────────────
// Run with: CENTERRES_DEBUG=true node -e "require('./studentCenterBrowser').debugRun('BSC 115')"
async function debugRun(roomQuery = 'BSC 115') {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.goto(BROWSE_URL, { waitUntil: 'networkidle2' });
  await page.screenshot({ path: './debug-1-browse.png' });
  logger.info('Screenshot saved: ./debug-1-browse.png — inspect this to find the real search input selector');
  logger.info('Leaving the browser open for manual inspection — right-click the search box → Inspect.');
  logger.info('Press ENTER in this terminal when you are done to close the browser and exit.');

  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });

  await closeBrowser();
}

// Run with: CENTERRES_DEBUG=true node -e "require('./studentCenterBrowser').discoverRooms()"
async function discoverRooms() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.goto(BROWSE_URL, { waitUntil: 'networkidle2' });

  const rooms = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.room-row.grid-row[data-room-id]'));
    return rows.map(r => ({
      roomId: r.getAttribute('data-room-id'),
      buildingId: r.getAttribute('data-building-id'),
      visible: r.style.display !== 'none',
      textHint: r.textContent.trim().slice(0, 80) || null,
    }));
  });

  let locationsHtml = null;
  try {
    const clicked = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('a, button'))
        .find(e => /add\/remove locations/i.test(e.textContent || ''));
      if (el) { el.click(); return true; }
      return false;
    });
    if (clicked) {
      await new Promise(r => setTimeout(r, 1000));
      locationsHtml = await page.evaluate(() => {
        const modal = document.querySelector('.modal, [role="dialog"], .locations-panel');
        return modal ? modal.outerHTML.slice(0, 5000) : null;
      });
    }
  } catch (err) {
    logger.warn('Locations panel scrape failed (non-fatal):', err.message);
  }

  await page.screenshot({ path: './debug-2-discover.png', fullPage: true });

  const output = { scrapedAt: new Date().toISOString(), rooms, locationsHtml };
  require('fs').writeFileSync('./room-discovery.json', JSON.stringify(output, null, 2));

  logger.info(`Discovery complete: ${rooms.length} room-row(s) found (${rooms.filter(r => r.visible).length} visible by default).`);
  logger.info('Saved: ./room-discovery.json and ./debug-2-discover.png');
  logger.info('Press ENTER when done reviewing to close the browser.');

  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });
  await closeBrowser();
}

// Run with: CENTERRES_DEBUG=true node -e "require('./studentCenterBrowser').discoverBuildingNames()"
//
// Tries two heuristics to map buildingId → real name (BUILDING_NAMES above
// only has "2" confirmed so far):
//   1. For each unique buildingId, walk up from its first room-row looking
//      for a nearby heading/label element (h1-h4, .header, .title,
//      .location-name) — TODO(verify): guessed selector list, EMS grids
//      often group rooms under a building header but the exact markup is
//      unconfirmed.
//   2. Open the "Add/Remove Locations" panel (same guessed click target as
//      discoverRooms) and read every checkbox's `value` + its label text —
//      if the site uses the building id as the checkbox value, this gives
//      a direct id → name mapping, which is more reliable than #1 if it
//      works.
// Writes both results to ./building-discovery.json so you can eyeball
// which heuristic actually produced real names, then hand-fill
// BUILDING_NAMES above with whichever is correct.
async function discoverBuildingNames() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.goto(BROWSE_URL, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.room-row.grid-row[data-room-id]', { timeout: 10000 }).catch(() => {});

  // Heuristic 1: nearby heading walk
  const headingGuesses = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.room-row.grid-row[data-room-id]'));
    const seen = {};
    for (const row of rows) {
      const bId = row.getAttribute('data-building-id');
      if (seen[bId] !== undefined) continue;
      let el = row;
      let found = null;
      for (let i = 0; i < 6 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        const heading = el.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > .header, :scope > .title, :scope > .location-name, :scope > .building-name');
        if (heading && heading.textContent.trim()) { found = heading.textContent.trim(); break; }
      }
      seen[bId] = found;
    }
    return seen;
  });

  // Heuristic 2: "Add/Remove Locations" panel checkbox list
  let panelItems = null;
  try {
    const clicked = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('a, button'))
        .find(e => /add\/remove locations/i.test(e.textContent || ''));
      if (el) { el.click(); return true; }
      return false;
    });
    if (clicked) {
      await new Promise(r => setTimeout(r, 1000));
      panelItems = await page.evaluate(() => {
        const modal = document.querySelector('.modal, [role="dialog"], .locations-panel');
        if (!modal) return null;
        const checkboxes = Array.from(modal.querySelectorAll('input[type=checkbox]'));
        return checkboxes.map(cb => {
          const label = cb.closest('label') || (cb.id ? document.querySelector(`label[for="${cb.id}"]`) : null);
          const text = (label ? label.textContent : (cb.parentElement ? cb.parentElement.textContent : '')) || '';
          return { value: cb.value || cb.id || null, text: text.trim() };
        });
      });
    }
  } catch (err) {
    logger.warn('Locations panel checkbox scrape failed (non-fatal):', err.message);
  }

  const output = { scrapedAt: new Date().toISOString(), headingGuesses, panelItems };
  require('fs').writeFileSync('./building-discovery.json', JSON.stringify(output, null, 2));

  logger.info('Building name discovery complete. Saved: ./building-discovery.json');
  logger.info(`Heading-walk guesses: ${JSON.stringify(headingGuesses)}`);
  logger.info(panelItems ? `Locations panel found ${panelItems.length} item(s) — check building-discovery.json` : 'Locations panel scrape did not find a match (non-fatal).');
  logger.info('Press ENTER when done reviewing to close the browser.');

  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });
  await closeBrowser();
}

// Run with: CENTERRES_DEBUG=true node -e "require('./studentCenterBrowser').dumpRoomRowContext('158')"
//
// dumpRoomRowSample (previous version) proved the .room-row element itself
// carries NO name — it's pure grid/timeline content (just "Closed" markers
// and event-containers). The real label almost certainly lives in a
// separate "row labels" column elsewhere in the DOM, aligned to the
// timeline rows by position/order rather than nested inside them — common
// in this kind of scrolling grid widget.
//
// This casts a wider net for a given roomId:
//   1. Every element ANYWHERE with data-room-id="<roomId>" (not just
//      .room-row) — a label element may share the same data attribute.
//   2. The .room-row's position (index) among all .room-row siblings under
//      its parent, plus that parent's outerHTML truncated — so a sibling
//      "labels" container at the same index can be spotted by eye.
//   3. A broad scan for any element whose text content is short (<40
//      chars, so it's plausibly a room label, not a paragraph) and whose
//      DOM position is inside the same broad grid container as the rows —
//      cast wide on purpose since we don't know the real container class.
// Writes everything to ./room-row-context.html.
async function dumpRoomRowContext(roomId) {
  if (!roomId) throw new Error('dumpRoomRowContext requires a roomId, e.g. dumpRoomRowContext("158")');

  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.goto(BROWSE_URL, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.room-row.grid-row[data-room-id]', { timeout: 10000 }).catch(() => {});

  const result = await page.evaluate((rid) => {
    const out = {};

    // 1. Every element anywhere with this data-room-id
    const withAttr = Array.from(document.querySelectorAll(`[data-room-id="${rid}"]`));
    out.elementsWithDataRoomId = withAttr.map(el => ({
      tag: el.tagName,
      className: el.className,
      outerHTML: el.outerHTML.length > 1500 ? el.outerHTML.slice(0, 1500) + '...[truncated]' : el.outerHTML,
    }));

    // 2. Index among siblings + parent context
    const row = document.querySelector(`.room-row.grid-row[data-room-id="${rid}"]`);
    if (row && row.parentElement) {
      const siblings = Array.from(row.parentElement.children);
      out.rowIndexAmongSiblings = siblings.indexOf(row);
      out.siblingCount = siblings.length;
      out.parentTag = row.parentElement.tagName;
      out.parentClassName = row.parentElement.className;
      // Grandparent's full structure (one level up from the rows
      // container), truncated — likely to contain a sibling "labels"
      // column next to the "rows" column.
      const grandparent = row.parentElement.parentElement;
      out.grandparentOuterHTML = grandparent
        ? (grandparent.outerHTML.length > 4000 ? grandparent.outerHTML.slice(0, 4000) + '...[truncated]' : grandparent.outerHTML)
        : null;
    }

    return out;
  }, roomId);

  const output = JSON.stringify(result, null, 2);
  require('fs').writeFileSync('./room-row-context.html', output);

  logger.info('Saved context to ./room-row-context.html');
  logger.info('Paste its contents back so the real room-name element can be identified.');
  logger.info('Press ENTER when done reviewing to close the browser.');

  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });
  await closeBrowser();
}

module.exports = {
  fetchRoomDay,
  fetchAllRoomsSnapshot,
  fetchAllRoomsSummary,
  listKnownRooms,
  listBuildings,
  closeBrowser,
  debugRun,
  discoverRooms,
  discoverBuildingNames,
  dumpRoomRowContext,
  LOGIN_URL,
  BROWSE_URL,
};