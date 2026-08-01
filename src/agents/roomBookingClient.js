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

    // ── LibCal booking URL ──
    const libcalMatch = html.match(/href="(https:\/\/libcal\.rutgers\.edu\/(?:space|reserve)\/[^"]+)"/);
    const libcalUrl = libcalMatch ? libcalMatch[1] : `${LIBCAL}/spaces`;

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

// ═══════════════════════════════════════════════════════════════════════════
// SEARCH / FILTER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Filters the room list by campus, library, minimum seats, and amenity.
 * campus = campus value from registerCommands (e.g. 'college_ave')
 * library = specific library value (e.g. 'alexander') — takes priority over campus
 * seats = minimum number (integer)
 * amenity = amenity key string (e.g. 'whiteboard')
 */
async function searchRooms({ campus = null, library = null, seats = null, amenity = null } = {}) {
  const allRooms = await fetchAllRooms();

  // Step 1: filter by library or campus (cheap, no extra fetch)
  let filtered = allRooms;

  if (library) {
    // Direct library filter — match rooms whose detected library equals the value
    filtered = allRooms.filter(r => detectLibrary(r.slug) === library);
  } else if (campus && campus !== 'all') {
    // Campus filter — expand to all libraries on that campus
    const libs = CAMPUS_TO_LIBRARIES[campus] || [];
    if (libs.length > 0) {
      filtered = allRooms.filter(r => libs.includes(detectLibrary(r.slug)));
    }
    // 'new_brunswick' covers most libraries so filtered may still be large — that's fine
  }

  // Step 2: if seats or amenity filter needed, fetch details in parallel (max 20 at a time)
  if (seats || amenity) {
    const BATCH = 20;
    const detailed = [];

    for (let i = 0; i < filtered.length; i += BATCH) {
      const batch = filtered.slice(i, i + BATCH);
      const details = await Promise.all(
        batch.map(r => fetchRoomDetail(r.slug).catch(() => null))
      );
      for (const d of details) {
        if (!d) continue;
        if (seats && (!d.capacity || d.capacity < seats)) continue;
        if (amenity && !d.amenityFlags[amenity]) continue;
        detailed.push(d);
      }
    }
    return detailed;
  }

  return filtered;
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

module.exports = {
  fetchAllRooms,
  fetchRoomDetail,
  searchRooms,
  autocompleteRoom,
  campusLabel,
  detectLibrary,
  CAMPUS_LABELS,
  LIBRARY_LABELS,
  CAMPUS_TO_LIBRARIES,
};