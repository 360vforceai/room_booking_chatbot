const logger = require('../utils/logger');

const BASE = 'https://www.libraries.rutgers.edu';
const LIBCAL = 'https://libcal.rutgers.edu';
const TOTAL_PAGES = 10; // 0..9

// ── Caches ────────────────────────────────────────────────────────────────────
const ROOM_LIST_CACHE_MS  = 60 * 60 * 1000; // 1 hour  — list changes rarely
const ROOM_DETAIL_CACHE_MS = 30 * 60 * 1000; // 30 min  — details don't change

let _roomListCache = { data: null, fetchedAt: 0 };
const _roomDetailCache = new Map(); // slug → { data, fetchedAt }

// ── Library detection ─────────────────────────────────────────────────────────
// Maps slug keywords → library value (matches registerCommands choices exactly).
// More specific entries first so 'dana' doesn't accidentally match before 'john-dana'.
const LIBRARY_KEYWORDS = {
  alexander:  ['alexander', '301', '302', '303', '304', '305', '310', '314', '315',
               '318', '319', '320', '335', '336', '342', 'dlc', 'hatchery',
               'daniel-tanner', 'digital-learning'],
  art:        ['art-library', 'art-room'],
  carr:       ['carr'],
  chang:      ['chang'],
  dana:       ['dana'],
  douglass:   ['douglass'],
  lsm:        ['science', 'lsc', 'lsm'],
  rwj:        ['rwj', 'robert-wood', 'health-science'],
  robeson:    ['robeson', 'camden'],
  smith:      ['smith'],
};

// Campus → library mapping (one campus can have multiple libraries)
const CAMPUS_TO_LIBRARIES = {
  busch:         ['lsm'],
  camden:        ['robeson'],
  college_ave:   ['alexander', 'art', 'carr', 'chang'],
  cook_douglass: ['douglass'],
  livingston:    [],
  new_brunswick: ['alexander', 'art', 'carr', 'chang', 'douglass', 'lsm'],
  newark:        ['dana', 'smith'],
};

function detectLibrary(slug) {
  const s = slug.toLowerCase();
  for (const [library, keywords] of Object.entries(LIBRARY_KEYWORDS)) {
    if (keywords.some(k => s.includes(k))) return library;
  }
  return 'alexander'; // default — most rooms are Alexander
}

// Keep detectCampus as a thin wrapper for backward compat
function detectCampus(slug) {
  return detectLibrary(slug);
}

// ── Amenity detection ─────────────────────────────────────────────────────────
// Keys must match the 'value' fields in registerCommands amenity choices exactly.
function detectAmenities(techText, amenityText) {
  const combined = (techText + ' ' + amenityText).toLowerCase();
  return {
    // Technology (from screenshots)
    computer_station:      combined.includes('computer station') || combined.includes('computer workstation'),
    hdmi:                  combined.includes('hdmi'),
    large_display:         combined.includes('large display') || combined.includes('large monitor') || combined.includes('samsung tv') || combined.includes('large screen'),
    power_wifi:            combined.includes('power') || combined.includes('wi-fi') || combined.includes('wifi'),
    recording:             combined.includes('recording') || combined.includes('podcast') || combined.includes('audio booth'),
    usb_charging:          combined.includes('usb charging') || combined.includes('usb hub'),
    webcam:                combined.includes('webcam') || combined.includes('web cam') || combined.includes('zoom') || combined.includes('webex') || combined.includes('teleconferenc'),
    // Amenities (from screenshots)
    configurable_furniture: combined.includes('configurable') || combined.includes('rearrang') || combined.includes('flexible seating'),
    group_table:           combined.includes('group table') || combined.includes('boardroom') || combined.includes('conference table'),
    individual_desks:      combined.includes('individual desk') || combined.includes('individual seat') || combined.includes('carrel'),
    whiteboard:            combined.includes('whiteboard'),
  };
}

// ── Capacity extraction ───────────────────────────────────────────────────────
function extractCapacity(text) {
  // "seats 10", "seating capacity to 18", "accommodate up to 30", "up to 4 people"
  const patterns = [
    /seating capacity(?:\s+to)?\s+(\d+)/i,
    /seats?\s+(\d+)/i,
    /accommodate(?:\s+up\s+to)?\s+(\d+)/i,
    /up\s+to\s+(\d+)\s+(?:people|person|students)/i,
    /(\d+)\s+(?:people|person|students|seats?)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ── Strip HTML tags ───────────────────────────────────────────────────────────
function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ').trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// ROOM LIST — scrape all pages and build catalog
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetches all room slugs from all 10 pages of /book-a-space.
 * Returns array of { slug, name, libcalUrl } objects.
 * Results cached for 1 hour.
 */
async function fetchAllRooms() {
  const now = Date.now();
  if (_roomListCache.data && (now - _roomListCache.fetchedAt) < ROOM_LIST_CACHE_MS) {
    return _roomListCache.data;
  }

  logger.info('Fetching full room list from libraries.rutgers.edu...');
  const rooms = [];
  const seen = new Set();

  await Promise.all(
    Array.from({ length: TOTAL_PAGES }, (_, i) =>
      fetchHtml(`${BASE}/book-a-space?page=${i}`)
        .then(html => {
          // Extract /book-a-space/SLUG links
          const slugMatches = [...html.matchAll(/href="(\/book-a-space\/[a-z][^"]+)"/g)];
          // Extract paired libcal URLs
          const libcalMatches = [...html.matchAll(/href="(https:\/\/libcal\.rutgers\.edu\/(?:space|reserve)\/[^"]+)"/g)];

          // Build a map of slug → libcalUrl from the page
          // They appear in pairs on the page: detail link then libcal link
          const libcalMap = {};
          for (const m of libcalMatches) {
            libcalMap[i + '_' + libcalMatches.indexOf(m)] = m[1];
          }

          slugMatches.forEach((m, idx) => {
            const slug = m[1].replace('/book-a-space/', '');
            if (seen.has(slug)) return;
            seen.add(slug);

            const name = slug
              .replace(/-/g, ' ')
              .replace(/\b\w/g, c => c.toUpperCase());

            // Match libcal URL by position (every slug has a paired libcal link)
            const libcalUrl = libcalMatches[idx]
              ? libcalMatches[idx][1]
              : `${LIBCAL}/spaces`;

            rooms.push({
              slug,
              name,
              campus: null,
              libcalUrl,
              detailUrl: `${BASE}/book-a-space/${slug}`
            });
          });
        })
        .catch(err => logger.warn(`Failed to fetch page ${i}:`, err.message))
    )
  );

  logger.info(`Room list fetched: ${rooms.length} rooms`);
  _roomListCache = { data: rooms, fetchedAt: now };
  return rooms;
}

// ═══════════════════════════════════════════════════════════════════════════
// ROOM DETAIL — scrape individual room page
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Scrapes a single room detail page and returns structured data.
 * @param {string} slug  e.g. "conference-room-342"
 */
async function fetchRoomDetail(slug) {
  const cached = _roomDetailCache.get(slug);
  if (cached && (Date.now() - cached.fetchedAt) < ROOM_DETAIL_CACHE_MS) {
    return cached.data;
  }

  const url = `${BASE}/book-a-space/${slug}`;
  try {
    const html = await fetchHtml(url);

    // ── Title ──
    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const name = titleMatch ? stripTags(titleMatch[1]) : slug.replace(/-/g, ' ');

    // ── LibCal booking URL + eid ──
    const libcalMatch = html.match(/href="(https:\/\/libcal\.rutgers\.edu\/(?:space|reserve)\/[^"]+)"/);
    const libcalUrl = libcalMatch ? libcalMatch[1] : `${LIBCAL}/spaces`;
    const eidMatch  = libcalUrl.match(/\/space\/(\d+)/) || libcalUrl.match(/\/(\d+)$/);
    const eid       = eidMatch ? eidMatch[1] : null;
    logger.info('fetchRoomDetail eid', { slug, eid, libcalUrl });

    // ── Extract top-level sections by h2/h3 headings ──
    const sectionRegex = /<(?:h2|h3)[^>]*>([\s\S]*?)<\/(?:h2|h3)>([\s\S]*?)(?=<(?:h2|h3)|$)/gi;
    const sections = {};
    for (const m of html.matchAll(sectionRegex)) {
      const heading = stripTags(m[1]).toLowerCase().trim();
      const content = m[2];
      const items = [];
      for (const li of content.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
        const text = stripTags(li[1]);
        if (text.length > 3) items.push(text);
      }
      for (const p of content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
        const text = stripTags(p[1]);
        if (text.length > 10) items.push(text);
      }
      sections[heading] = items;
    }

    // ── Parse Space Details by <strong> sub-labels ──
    // The site uses <strong>Label:</strong> followed by text in the same or next <p>.
    // We extract each sub-field individually instead of grabbing the whole blob.
    const spaceDetailsSection = (() => {
      const m = html.match(/<h2[^>]*>\s*Space Details\s*<\/h2>([\s\S]*?)(?=<h2|<h3|$)/i);
      return m ? m[1] : '';
    })();

    function extractSubField(sectionHtml, labelPattern) {
      // Site structure: <strong>Label:&nbsp;</strong>&nbsp;<br>\nValue text here
      // Strategy: find the <strong> label, then grab text after the following <br>
      const pattern = new RegExp(
        '<strong[^>]*>' + labelPattern + '[\\s\\S]*?<\/strong>[\\s\\S]*?<br\\s*\/?>([\\s\\S]*?)(?=<strong|<p|<\/div|<\/p)',
        'i'
      );
      const m = sectionHtml.match(pattern);
      if (!m) return null;
      // Strip tags and &nbsp; entities, collapse whitespace
      return m[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s{2,}/g, ' ')
        .trim() || null;
    }

    // Extract each Space Details sub-field cleanly
    const location  = extractSubField(spaceDetailsSection, 'Location')           || '';
    const accessRaw = extractSubField(spaceDetailsSection, 'How to access')      || '';
    const maxRaw    = extractSubField(spaceDetailsSection, 'Maximum reservation') || '';

    // ── Parse other sections ──
    const description = (sections['description'] || []).join(' ');
    const technology  =  sections['technology']  || [];
    const amenities   =  sections['amenities']   || [];

    // Capacity: from description text or seat count patterns
    const capacity = extractCapacity(description) || extractCapacity(maxRaw);

    // Amenity flags
    const amenityFlags = detectAmenities(technology.join(' '), amenities.join(' '));

    const data = {
      slug,
      name,
      eid,
      detailUrl: url,
      libcalUrl,
      description,
      location,
      access: accessRaw,
      maxReservation: maxRaw,
      technology,
      amenities,
      capacity,
      amenityFlags
    };

    _roomDetailCache.set(slug, { data, fetchedAt: Date.now() });
    logger.info('Fetched room detail', { slug, capacity, campus: data.campus });
    return data;

  } catch (err) {
    logger.error('fetchRoomDetail failed:', { slug, error: err.message });
    return null;
  }
}

// ── Real filter IDs from the site's <select> elements ────────────────────────
const CAMPUS_FILTER_IDS = {
  all:           'All',
  busch:         '1393',
  camden:        '1391',
  college_ave:   '1394',
  cook_douglass: '1395',
  livingston:    '1396',
  new_brunswick: '1392',
  newark:        '1397',
};
const LIBRARY_FILTER_IDS = {
  alexander: '1401', art: '1402', carr: '1403', chang: '1404',
  dana: '1405', douglass: '1406', lsm: '1407', rwj: '1408',
  robeson: '1409', smith: '1410',
};
const AMENITY_FILTER_IDS = {
  computer_station: '1419', hdmi: '1420', large_display: '1421',
  power_wifi: '1422', recording: '1423', usb_charging: '1424',
  webcam: '1425', configurable_furniture: '1386', group_table: '1387',
  individual_desks: '1388', whiteboard: '1389',
};

function buildFilterUrl({ campus=null, library=null, seats=null, amenity=null, page=0 }={}) {
  const p = new URLSearchParams();
  if (campus && campus !== 'all' && CAMPUS_FILTER_IDS[campus]) p.set('campus', CAMPUS_FILTER_IDS[campus]);
  if (library && LIBRARY_FILTER_IDS[library])                   p.set('library', LIBRARY_FILTER_IDS[library]);
  if (seats)                                                     p.set('number_of_seats_value', seats);
  if (amenity && AMENITY_FILTER_IDS[amenity])                   p.append('amenities[]', AMENITY_FILTER_IDS[amenity]);
  if (page > 0)                                                  p.set('page', page);
  return `${BASE}/book-a-space?${p.toString()}`;
}

function countPages(html) {
  const m = [...html.matchAll(/[?&]page=(\d+)/g)];
  return m.length ? Math.max(...m.map(x => parseInt(x[1], 10))) + 1 : 1;
}

function parseRoomsFromHtml(html, libraryKey) {
  const rooms = [], seen = new Set();
  const slugs   = [...html.matchAll(/href="(\/book-a-space\/[a-z][^"]+)"/g)];
  const libcals = [...html.matchAll(/href="(https:\/\/libcal\.rutgers\.edu\/(?:space|reserve)\/[^"]+)"/g)];
  slugs.forEach((m, i) => {
    const slug = m[1].replace('/book-a-space/', '');
    if (seen.has(slug)) return;
    seen.add(slug);
    const name = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const libcalUrl = libcals[i] ? libcals[i][1] : `${LIBCAL}/spaces`;
    rooms.push({ slug, name, library: libraryKey||null, libcalUrl, detailUrl: `${BASE}/book-a-space/${slug}` });
  });
  return rooms;
}

// ═══════════════════════════════════════════════════════════════════════════
// SEARCH — server-side filtering via the site's own form URL
// ═══════════════════════════════════════════════════════════════════════════
async function searchRooms({ campus=null, library=null, seats=null, amenity=null }={}) {
  const campusVal = (campus && campus !== 'all') ? campus : null;
  const firstUrl  = buildFilterUrl({ campus: campusVal, library, seats, amenity, page: 0 });
  logger.info('searchRooms URL:', firstUrl);
  try {
    const firstHtml  = await fetchHtml(firstUrl);
    const totalPages = countPages(firstHtml);
    const rooms      = parseRoomsFromHtml(firstHtml, library||null);
    if (totalPages > 1) {
      const rest = await Promise.all(
        Array.from({ length: totalPages-1 }, (_,i) =>
          fetchHtml(buildFilterUrl({ campus: campusVal, library, seats, amenity, page: i+1 }))
            .then(h => parseRoomsFromHtml(h, library||null))
            .catch(() => [])
        )
      );
      for (const b of rest) rooms.push(...b);
    }
    const seen = new Set();
    const unique = rooms.filter(r => { if (seen.has(r.slug)) return false; seen.add(r.slug); return true; });
    logger.info(`searchRooms found ${unique.length} rooms`);
    return unique;
  } catch (err) {
    logger.error('searchRooms failed:', err.message);
    return [];
  }
}


/**
 * Autocomplete: fuzzy-match room name or slug against a query string.
 */
async function autocompleteRoom(query) {
  const allRooms = await fetchAllRooms();
  const q = query.toLowerCase().trim();
  if (!q) return allRooms.slice(0, 25);

  return allRooms
    .filter(r => r.name.toLowerCase().includes(q) || r.slug.includes(q))
    .slice(0, 25);
}

// ── Display name maps ─────────────────────────────────────────────────────────
// Library values → human-readable names (matches registerCommands choices)
const LIBRARY_LABELS = {
  alexander: 'Alexander Library',
  art:       'Art Library',
  carr:      'Carr Library',
  chang:     'Chang Library',
  dana:      'Dana Library',
  douglass:  'Douglass Library',
  lsm:       'Library of Science & Medicine (LSM)',
  rwj:       'Robert Wood Johnson Library',
  robeson:   'Robeson Library',
  smith:     'Smith Library - Health Sciences',
};

// Campus values → human-readable names (matches registerCommands choices)
const CAMPUS_LABELS = {
  busch:         'Busch Campus',
  camden:        'Camden Campus',
  college_ave:   'College Avenue Campus',
  cook_douglass: 'Cook/Douglass Campus',
  livingston:    'Livingston Campus',
  new_brunswick: 'New Brunswick Campus',
  newark:        'Newark Campus',
};

function campusLabel(value) {
  return LIBRARY_LABELS[value] || CAMPUS_LABELS[value] || value;
}

// ═══════════════════════════════════════════════════════════════════════════
// AVAILABILITY — LibCal internal API
// ═══════════════════════════════════════════════════════════════════════════
// Two-step process:
//   1. GET nextdate endpoint → returns next date with availability
//   2. POST spaces/availability/grid → returns time slots for that date
//
// lid and gid are per-location/group IDs embedded in the LibCal space page.
// We scrape them from the page JS when needed.

const AVAIL_CACHE_MS = 5 * 60 * 1000; // 5 min cache
const _availCache = new Map(); // eid → { data, fetchedAt }

/**
 * Scrapes lid and gid from a LibCal space page (needed for availability calls).
 */
async function fetchLibCalIds(eid) {
  try {
    const res = await fetch(`${LIBCAL}/space/${eid}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    // lid and gid are in the springyPage JS object on the page
    const lidMatch = html.match(/locationId[:\s]+(\d+)/);
    const gidMatch = html.match(/groupId[:\s]+(\d+)/);
    const lid = lidMatch ? lidMatch[1] : null;
    const gid = gidMatch ? gidMatch[1] : null;

    logger.info('fetchLibCalIds', { eid, lid, gid });
    return { lid, gid };
  } catch (err) {
    logger.error('fetchLibCalIds failed:', { eid, error: err.message });
    return { lid: null, gid: null };
  }
}

/**
 * Formats a slot time range into a readable string.
 * e.g. "2026-08-03 08:00:00" → "8:00 AM"
 */
function formatSlotTime(dateStr) {
  const d = new Date(dateStr.replace(' ', 'T') + '-04:00'); // Eastern time
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
}

function formatSlotDate(dateStr) {
  const d = new Date(dateStr.replace(' ', 'T') + '-04:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

/**
 * Gets the next available date and time slots for a room.
 * @param {string} eid  - LibCal item/space ID (e.g. "16936")
 * @param {string} date - YYYY-MM-DD date to start from (defaults to today)
 */
async function fetchNextAvailable(eid, date = null) {
  if (!eid) return null;

  const cacheKey = `${eid}_${date || 'today'}`;
  const cached = _availCache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < AVAIL_CACHE_MS) return cached.data;

  try {
    // Step 1: get lid and gid
    const { lid, gid } = await fetchLibCalIds(eid);
    if (!lid || !gid) throw new Error(`Could not get lid/gid for eid=${eid}`);

    // Step 2: GET nextdate — returns { date: "YYYY-MM-DD", page: N }
    const nextDateUrl = `${LIBCAL}/equipment/availability/nextdate?lid=${lid}&gid=${gid}&eid=${eid}&seatId=0&zone=0&capacity=0&isEquipment=false&isSeatBooking=0&pageIndex=0&pageSize=18`;
    const nextDateRes = await fetch(nextDateUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${LIBCAL}/space/${eid}`
      }
    });
    if (!nextDateRes.ok) throw new Error(`nextdate HTTP ${nextDateRes.status}`);
    const nextDateData = await nextDateRes.json();
    logger.info('fetchNextAvailable nextdate', nextDateData);

    const availDate = nextDateData.date;
    if (!availDate) throw new Error('nextdate returned no date');

    // Step 3: POST grid for that date using the page number from nextdate response
    const endDateObj = new Date(availDate + 'T12:00:00');
    endDateObj.setDate(endDateObj.getDate() + 1);
    const endDateStr = endDateObj.toISOString().slice(0, 10);

    const body = new URLSearchParams({
      lid, gid, eid,
      seat: '0', seatId: '0', zone: '0',
      start: availDate,
      end: endDateStr,
      pageIndex: String(nextDateData.page || 0),
      pageSize: '18'
    });

    logger.info('fetchNextAvailable grid POST', { availDate, endDateStr, page: nextDateData.page || 0 });

    const gridRes = await fetch(`${LIBCAL}/spaces/availability/grid`, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${LIBCAL}/space/${eid}`,
        'Origin': LIBCAL
      },
      body: body.toString()
    });
    if (!gridRes.ok) throw new Error(`grid HTTP ${gridRes.status}`);
    const gridData = await gridRes.json();

    const allSlots = gridData.slots || [];
    logger.info('Grid slots count:', allSlots.length, 'sample:', JSON.stringify(allSlots[0] || {}));

    // Filter to only slots for THIS room (grid returns all rooms in the group)
    // and exclude unavailable slots
    const eidInt = parseInt(eid, 10);
    const slots = allSlots.filter(s => {
      if (s.itemId !== eidInt) return false; // wrong room
      const cls   = (s.className || s.class || s.status || '').toLowerCase();
      const title = (s.title || '').toLowerCase();
      if (cls.includes('unavailable') || cls.includes('checkout') ||
          cls.includes('pending')     || cls.includes('booked'))    return false;
      if (title.includes('unavailable') || title.includes('booked')) return false;
      return true;
    });
    logger.info('Grid filtered slots:', slots.length);

    // Merge consecutive 1-hour slots into blocks
    const blocks = [];
    let blockStart = null;
    let blockEnd   = null;
    for (const slot of slots) {
      if (!blockStart) {
        blockStart = slot.start;
        blockEnd   = slot.end;
      } else if (slot.start === blockEnd) {
        blockEnd = slot.end;
      } else {
        blocks.push({ start: blockStart, end: blockEnd });
        blockStart = slot.start;
        blockEnd   = slot.end;
      }
    }
    if (blockStart) blocks.push({ start: blockStart, end: blockEnd });

    function formatSlotDate(dateStr) {
      const d = new Date(dateStr + 'T12:00:00');
      return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
    }

    const result = {
      date: availDate,
      dateLabel: formatSlotDate(availDate),
      slots,
      blocks,
      bookingUrl: `${LIBCAL}/space/${eid}`
    };

    _availCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
    logger.info('fetchNextAvailable result', { eid, date: availDate, slots: slots.length, blocks: blocks.length });
    return result;
  } catch (err) {
    logger.error('fetchNextAvailable failed:', { eid, error: err.message });
    return null;
  }
}

module.exports = {
  fetchAllRooms,
  fetchRoomDetail,
  searchRooms,
  autocompleteRoom,
  campusLabel,
  fetchNextAvailable,
  fetchLibCalIds,
  detectLibrary,
  CAMPUS_LABELS,
  LIBRARY_LABELS,
  CAMPUS_TO_LIBRARIES,
};