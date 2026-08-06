const { isRateLimited, recordRequest, getRemainingSeconds } = require('../utils/rateLimiter');
const { splitMessage } = require('../utils/messageUtils');
const { getResponse, getRouterDecision } = require('../agents/aiClient');
const {
  getShortTermHistory,
  saveMemoryAsync
} = require('../utils/memoryService');
const {
  fetchAllRooms,
  fetchRoomDetail,
  fetchNextAvailable,
  searchRooms,
  autocompleteRoom,
  campusLabel,
} = require('../agents/roomBookingClient');
const {
  fetchRoomDay,
  fetchAllRoomsSummary,
  listBuildings,
  LOGIN_URL,
  BROWSE_URL,
} = require('../agents/studentCenterBrowser');
const logger = require('../utils/logger');

// ── Duplicate interaction guard ───────────────────────────────────────────────
const handledInteractions = new Map();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, ts] of handledInteractions) {
    if (ts < cutoff) handledInteractions.delete(id);
  }
}, 10 * 60 * 1000);

// ── Shared helpers ────────────────────────────────────────────────────────────

async function sendChunks(interaction, content) {
  const chunks = splitMessage(content);
  if (!chunks.length) {
    await interaction.editReply('I could not generate a response. Please try again.').catch(() => {});
    return;
  }
  await interaction.editReply(chunks[0]).catch(err => logger.error('editReply failed:', err.message));
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ content: chunks[i] }).catch(err => logger.error('followUp failed:', err.message));
  }
}

function amenityEmoji(key) {
  const map = {
    whiteboard:           '🖊️',
    hdmi:                 '🔌',
    large_display:        '🖥️',
    power_wifi:           '🔋',
    recording:            '🎙️',
    usb_charging:         '🔌',
    webcam:               '📹',
    computer_station:     '💻',
    configurable_furniture: '🪑',
    group_table:          '🪑',
    individual_desks:     '📖',
  };
  return map[key] || '✅';
}

function amenityLabel(key) {
  const map = {
    whiteboard:           'Whiteboard & Markers',
    hdmi:                 'HDMI Port & Monitor',
    large_display:        'Large Display',
    power_wifi:           'Power & Wi-Fi',
    recording:            'Recording Equipment',
    usb_charging:         'USB Charging Hubs',
    webcam:               'Webcam',
    computer_station:     'Computer Station',
    configurable_furniture: 'Configurable Furniture',
    group_table:          'Group Table & Chairs',
    individual_desks:     'Individual Desks',
  };
  return map[key] || key;
}

// ── Autocomplete ──────────────────────────────────────────────────────────────

async function handleAutocomplete(interaction) {
  const { commandName } = interaction;
  const focused = interaction.options.getFocused(true);

  if (['room-info', 'next-available'].includes(commandName) && focused.name === 'room') {
    try {
      const matches = await autocompleteRoom(focused.value);
      await interaction.respond(
        matches.map(r => ({ name: r.name, value: r.slug }))
      ).catch(() => {});
    } catch (err) {
      logger.error('Autocomplete failed:', err.message);
      await interaction.respond([]).catch(() => {});
    }
    return;
  }

  if (commandName === 'student-center' && focused.name === 'building') {
    const typed = (focused.value || '').toLowerCase();
    const matches = listBuildings()
      .filter(b => b.name.toLowerCase().includes(typed) || b.id === focused.value)
      .slice(0, 25);
    // Value sent back is the building id — handleStudentCenterSummary
    // already matches on exact buildingId OR label substring, so this
    // works whether the option is filled via the dropdown or typed by hand.
    await interaction.respond(
      matches.map(b => ({ name: b.name, value: b.id }))
    ).catch(() => {});
    return;
  }

  await interaction.respond([]).catch(() => {});
}

// ── /library-rooms ────────────────────────────────────────────────────────────
// (unchanged — see roomBookingClient.js)

async function handleLibraryRooms(interaction, userId) {
  const campus   = interaction.options.getString('campus');
  const library  = interaction.options.getString('library');
  const seatsStr = interaction.options.getString('seats');
  const amenity  = interaction.options.getString('amenity');

  const campusFilter = (campus && campus !== 'all') ? campus : null;
  const seatsFilter  = (seatsStr && seatsStr !== 'any') ? seatsStr : null;

  const results = await searchRooms({
    campus:  campusFilter || null,
    library: library      || null,
    seats:   seatsFilter,
    amenity: amenity      || null
  });

  if (results.length === 0) {
    const filters = [
      library      ? `library: **${campusLabel(library)}**`         : null,
      campusFilter ? `campus: **${campusLabel(campusFilter)}**`     : null,
      seatsFilter  ? `seats: **${seatsFilter}**`                    : null,
      amenity      ? `amenity: **${amenityLabel(amenity)}**`        : null,
    ].filter(Boolean);

    await interaction.editReply({
      embeds: [{
        color: 0xCC0033,
        title: '🔍 No Rooms Found',
        description: `No rooms matched your filters${filters.length ? ` (${filters.join(', ')})` : ''}.\n\nTry fewer filters or browse all rooms at [libraries.rutgers.edu/book-a-space](https://www.libraries.rutgers.edu/book-a-space).`,
        footer: { text: 'Rutgers University Libraries' }
      }]
    }).catch(() => {});
    return;
  }

  const hasDetail = results[0].amenityFlags !== undefined;
  const shown = results.slice(0, 10);

  const fields = shown.map(r => {
    const detail = hasDetail ? r : null;
    const capacityStr = detail?.capacity ? `👥 Up to ${detail.capacity} people` : '';
    const amenityStr  = detail
      ? Object.entries(detail.amenityFlags)
          .filter(([, v]) => v)
          .map(([k]) => `${amenityEmoji(k)} ${amenityLabel(k)}`)
          .join(' · ')
      : '';
    const locationStr = detail?.location ? `📍 ${detail.location}` : '';
    const lines = [capacityStr, locationStr, amenityStr, `[Book this room](${r.libcalUrl || detail?.libcalUrl})`]
      .filter(Boolean);

    return {
      name: r.name || detail?.name,
      value: lines.join('\n') || 'See detail page for more info',
      inline: false
    };
  });

  const filterSummary = [
    library      ? campusLabel(library)                              : null,
    campusFilter ? campusLabel(campusFilter)                        : (!library ? 'All campuses' : null),
    seatsFilter  ? `${seatsFilter} seats`                           : null,
    amenity      ? amenityLabel(amenity)                            : null,
  ].filter(Boolean).join(' · ');

  const embed = {
    color: 0xCC0033,
    title: `📚 Library Rooms — ${filterSummary}`,
    description: `Found **${results.length}** room${results.length !== 1 ? 's' : ''}${results.length > 10 ? `, showing first 10` : ''}. Use \`/room-info\` for full details on any room.\n\nAll bookings require a **Rutgers NetID**.`,
    fields,
    footer: { text: 'Rutgers University Libraries · libraries.rutgers.edu/book-a-space' }
  };

  await interaction.editReply({ embeds: [embed] }).catch(() => {});
  logger.info('Handled /library-rooms', { userId, campus, library, seatsStr, amenity, found: results.length });
}

// ── /room-info ────────────────────────────────────────────────────────────────
// (unchanged — see roomBookingClient.js)

async function handleRoomInfo(interaction, userId) {
  const slug = interaction.options.getString('room');
  if (!slug) {
    await interaction.editReply('Please select a room from the dropdown.').catch(() => {});
    return;
  }

  const room = await fetchRoomDetail(slug);
  if (!room) {
    await interaction.editReply(
      `⚠️ Couldn't load details for that room right now.\n\nView it directly: https://www.libraries.rutgers.edu/book-a-space/${slug}`
    ).catch(() => {});
    return;
  }

  const amenityList = Object.entries(room.amenityFlags)
    .filter(([, v]) => v)
    .map(([k]) => `${amenityEmoji(k)} ${amenityLabel(k)}`)
    .join('\n') || 'See room page for details';

  const techList = room.technology.length > 0
    ? room.technology.map(t => `• ${t}`).join('\n')
    : 'See room page for details';

  const capacityNum = room.capacity
    || (room.description && room.description.match(/(\d+)\s*seats?/i)
        ? parseInt(room.description.match(/(\d+)\s*seats?/i)[1])
        : null);

  const locationText     = room.location      ? room.location.replace(/^location:\s*/i, '').trim()                         : null;
  const accessText       = room.access        ? room.access.replace(/^how to access this space:\s*/i, '').trim()           : null;
  const maxText          = room.maxReservation? room.maxReservation.replace(/^maximum reservation length:\s*/i, '').trim() : null;

  const fields = [
    locationText && { name: '📍 Location',          value: locationText,                                                    inline: false },
    capacityNum  && { name: '👥 Capacity',           value: `Up to **${capacityNum}** people`,                              inline: true  },
    accessText   && { name: '🔑 Access',             value: accessText,                                                     inline: true  },
                    { name: '🖥️ Technology',         value: techList,                                                       inline: false },
                    { name: '✅ Amenities',           value: amenityList,                                                    inline: true  },
    maxText      && { name: '⏱️ Reservation Limit',  value: maxText,                                                        inline: false },
                    { name: '📅 Book This Room',      value: `[Reserve on LibCal](${room.libcalUrl}) · [Room details](${room.detailUrl})`, inline: false },
  ].filter(Boolean);

  const embed = {
    color: 0xCC0033,
    title: `🚪 ${room.name}`,
    description: room.description || undefined,
    fields,
    footer: { text: 'Rutgers University Libraries · libraries.rutgers.edu/book-a-space' }
  };

  await interaction.editReply({ embeds: [embed] }).catch(() => {});
  logger.info('Handled /room-info', { userId, slug });
}

// ── /next-available ──────────────────────────────────────────────────────────
// (unchanged — see roomBookingClient.js)

async function handleNextAvailable(interaction, userId) {
  const slug = interaction.options.getString('room');

  if (!slug) {
    await interaction.editReply('Please select a room from the dropdown.').catch(() => {});
    return;
  }

  const room = await fetchRoomDetail(slug);
  if (!room) {
    await interaction.editReply(
      `⚠️ Couldn't load that room. Browse all rooms at: https://www.libraries.rutgers.edu/book-a-space`
    ).catch(() => {});
    return;
  }

  const avail = await fetchNextAvailable(room.eid, 'today');

  const todayLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });

  if (!avail || !avail.slots || avail.slots.length === 0) {
    const embed = {
      color: 0xED4245,
      title: `📅 ${room.name} — No Availability Found`,
      description: [
        `No available slots found starting from **${todayLabel}**.`,
        '',
        'Try checking the LibCal page directly for a wider date range:',
      ].join('\n'),
      fields: [{ name: '🔗 Book on LibCal', value: room.libcalUrl, inline: false }],
      footer: { text: 'Rutgers University Libraries · libcal.rutgers.edu' }
    };
    await interaction.editReply({ embeds: [embed] }).catch(() => {});
    return;
  }

  function fmt(dateStr) {
    const d = new Date(dateStr.replace(' ', 'T') + '-04:00');
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
  }

  const blockLines = avail.blocks.map(b => `🟢 **${fmt(b.start)} – ${fmt(b.end)}**`).join('\n')
    || avail.slots.slice(0, 10).map(s => `🟢 **${fmt(s.start)} – ${fmt(s.end)}**`).join('\n');

  const embed = {
    color: 0x57F287,
    title: `📅 Next Available — ${room.name}`,
    description: `Available slots on **${avail.dateLabel}**:`,
    fields: [
      {
        name: '🕐 Available Times',
        value: blockLines,
        inline: false
      },
      room.location && {
        name: '📍 Location',
        value: room.location.replace(/^location:\s*/i, '').trim(),
        inline: false
      },
      room.capacity && {
        name: '👥 Capacity',
        value: `Up to ${room.capacity} people`,
        inline: true
      },
      room.maxReservation && {
        name: '⏱️ Max Booking',
        value: room.maxReservation.replace(/^maximum reservation length:\s*/i, '').trim(),
        inline: true
      },
      {
        name: '🔗 Book This Room',
        value: `[Reserve on LibCal](${avail.bookingUrl})`,
        inline: false
      }
    ].filter(Boolean),
    footer: { text: `Live availability · Rutgers University Libraries` }
  };

  await interaction.editReply({ embeds: [embed] }).catch(() => {});
  logger.info('Handled /next-available', { userId, slug, date: avail.date, blocks: avail.blocks.length });
}

// ── /student-center ───────────────────────────────────────────────────────────
// Rooms for established Rutgers organizations, via centerres.rutgers.edu.
//
// Two branches:
//  - `room:` given  → single-room search via fetchRoomDay() (typed straight
//    into the site's own search box, so works for anything the site itself
//    can find).
//  - no `room:`     → bulk summary across EVERY room currently loaded in the
//    DOM (166 rooms / 7 buildings as of the last discovery run), via
//    fetchAllRoomsSummary(), grouped by building.

function parseRequestedDate(dateStr) {
  const today = new Date();
  if (!dateStr || /^today$/i.test(dateStr)) return today.toISOString().slice(0, 10);
  if (/^tomorrow$/i.test(dateStr)) {
    const t = new Date(today);
    t.setDate(t.getDate() + 1);
    return t.toISOString().slice(0, 10);
  }
  // Accept YYYY-MM-DD directly; otherwise fall back to today.
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  return today.toISOString().slice(0, 10);
}

function loginRequiredEmbed() {
  return {
    color: 0xED4245,
    title: '🔒 Login Required',
    description: [
      "The bot doesn't currently have a valid session for Student Center rooms.",
      '',
      `Browsing this system requires an approved organization account: [Create/manage an account](${LOGIN_URL})`,
    ].join('\n'),
    footer: { text: 'centerres.rutgers.edu' }
  };
}

async function handleStudentCenterSingleRoom(interaction, userId, roomInput, date, dateLabel) {
  const day = await fetchRoomDay(roomInput, date);

  if (day.status === 'auth_required') {
    await interaction.editReply({ embeds: [loginRequiredEmbed()] }).catch(() => {});
    return;
  }

  let value;
  if (day.status === 'not_found') {
    value = `❓ No room matched "${roomInput}" — check the spelling, or [browse directly](${BROWSE_URL})`;
  } else if (day.status === 'error') {
    value = `⚠️ Could not load this room's schedule right now — [check directly](${BROWSE_URL})`;
  } else if (day.status === 'busy') {
    const count = day.events.length;
    value = `🔴 Busy — ${count} booking${count !== 1 ? 's' : ''} today (times not yet shown — [check directly](${BROWSE_URL}))`;
  } else {
    value = '🟢 No bookings found — appears open';
  }

  const isToday = date === new Date().toISOString().slice(0, 10);

  const embed = {
    color: 0xCC0033,
    title: `🏢 Student Center Rooms — ${dateLabel}`,
    description: [
      'Rooms for **established Rutgers student organizations** only — not individual students.',
      `Searched for: **${roomInput}**`,
      !isToday ? "⚠️ Date selection isn't wired up yet — showing **today's** status regardless of the date requested." : null,
      `[Browse & book on centerres.rutgers.edu](${BROWSE_URL})`,
    ].filter(Boolean).join('\n'),
    fields: [{ name: roomInput, value, inline: false }],
    footer: { text: 'centerres.rutgers.edu' }
  };

  await interaction.editReply({ embeds: [embed] }).catch(() => {});
  logger.info('Handled /student-center (single room)', { userId, date, room: roomInput });
}

// Chunk a building's room list into embed fields (Discord caps a field's
// value length and an embed's total field count, and some buildings have
// 30-40 rooms — one field per room isn't safe).
const ROOMS_PER_FIELD = 15;

function chunkRoomFields(rooms) {
  const fields = [];
  for (let i = 0; i < rooms.length; i += ROOMS_PER_FIELD) {
    const chunk = rooms.slice(i, i + ROOMS_PER_FIELD);
    const value = chunk
      .map(r => `${r.busy ? '🔴' : '🟢'} ${r.name}${r.capacity ? ` (${r.capacity} cap)` : ''}${r.busy ? ` — ${r.bookingCount} booking${r.bookingCount !== 1 ? 's' : ''}` : ''}`)
      .join('\n');
    fields.push({
      name: fields.length === 0 ? 'Rooms' : `Rooms (cont.)`,
      value,
      inline: false
    });
  }
  return fields;
}

async function handleStudentCenterSummary(interaction, userId, date, dateLabel, buildingFilter) {
  const summary = await fetchAllRoomsSummary(date);

  if (summary.authRequired) {
    await interaction.editReply({ embeds: [loginRequiredEmbed()] }).catch(() => {});
    return;
  }

  if (summary.error || summary.total === 0) {
    const embed = {
      color: 0xED4245,
      title: '⚠️ Could Not Load Student Center Rooms',
      description: `Something went wrong scraping the room list — [check directly](${BROWSE_URL}).\n\nTry \`/student-center room: <name>\` to search a specific room instead.`,
      footer: { text: 'centerres.rutgers.edu' }
    };
    await interaction.editReply({ embeds: [embed] }).catch(() => {});
    logger.info('Handled /student-center (summary)', { userId, date, total: 0, open: 0 });
    return;
  }

  const isToday = date === new Date().toISOString().slice(0, 10);

  // ── Filtered to one building: list its individual rooms ──────────────────
  if (buildingFilter) {
    const filterLower = buildingFilter.trim().toLowerCase();
    const matched = summary.rooms.filter(r =>
      r.buildingId === buildingFilter.trim() ||
      r.buildingLabel.toLowerCase().includes(filterLower)
    );

    if (matched.length === 0) {
      const available = summary.buildings.map(b => b.label).join(', ');
      const embed = {
        color: 0xED4245,
        title: '🔍 No Matching Building',
        description: `Nothing matched **"${buildingFilter}"**.\n\nAvailable buildings today: ${available}`,
        footer: { text: 'centerres.rutgers.edu' }
      };
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
      logger.info('Handled /student-center (summary, building not found)', { userId, date, buildingFilter });
      return;
    }

    const openCount = matched.filter(r => !r.busy).length;
    const busyCount = matched.length - openCount;
    const label = matched[0].buildingLabel;
    const openRooms = matched.filter(r => !r.busy);

    const embed = {
      color: 0xCC0033,
      title: `🏢 ${label} — ${dateLabel}`,
      description: [
        'Rooms for **established Rutgers student organizations** only — not individual students.',
        `**${openCount} open**, ${busyCount} busy (hidden below), out of ${matched.length} rooms.`,
        !isToday ? "⚠️ Date selection isn't wired up yet — showing **today's** status regardless of the date requested." : null,
        `[Browse & book on centerres.rutgers.edu](${BROWSE_URL})`,
      ].filter(Boolean).join('\n'),
      fields: openRooms.length
        ? chunkRoomFields(openRooms)
        : [{ name: 'No open rooms', value: `Every room in ${label} is currently busy — [check directly](${BROWSE_URL})`, inline: false }],
      footer: { text: 'centerres.rutgers.edu' }
    };

    await interaction.editReply({ embeds: [embed] }).catch(() => {});
    logger.info('Handled /student-center (summary, building filtered)', { userId, date, buildingFilter: label, total: matched.length, open: openCount });
    return;
  }

  // ── No filter: all-buildings overview ─────────────────────────────────────
  const fields = summary.buildings.map(b => ({
    name: b.label,
    value: `🟢 ${b.open} open · 🔴 ${b.busy} busy (of ${b.total})`,
    inline: true
  }));

  const embed = {
    color: 0xCC0033,
    title: `🏢 Student Center Rooms — ${dateLabel}`,
    description: [
      'Rooms for **established Rutgers student organizations** only — not individual students.',
      `**${summary.open} open, ${summary.busy} busy**, out of ${summary.total} rooms found.`,
      !isToday ? "⚠️ Date selection isn't wired up yet — showing **today's** status regardless of the date requested." : null,
      `Search a room with \`/student-center room: <name>\`, filter to one building with \`/student-center building: <name>\`, or [browse directly](${BROWSE_URL}).`,
    ].filter(Boolean).join('\n'),
    fields,
    footer: { text: 'centerres.rutgers.edu' }
  };

  await interaction.editReply({ embeds: [embed] }).catch(() => {});
  logger.info('Handled /student-center (summary)', { userId, date, total: summary.total, open: summary.open });
}

async function handleStudentCenter(interaction, userId) {
  const dateInput = interaction.options.getString('date');
  const roomInput = interaction.options.getString('room');
  const buildingInput = interaction.options.getString('building');
  const date = parseRequestedDate(dateInput);
  const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York'
  });

  if (roomInput) {
    // `room:` takes priority over `building:` if both are somehow given —
    // a specific room search is more precise than a building filter.
    await handleStudentCenterSingleRoom(interaction, userId, roomInput, date, dateLabel);
  } else {
    await handleStudentCenterSummary(interaction, userId, date, dateLabel, buildingInput);
  }
}

// ── /ask ──────────────────────────────────────────────────────────────────────

async function handleAsk(interaction, userId, username) {
  const question = interaction.options.getString('question');
  if (!question) {
    await interaction.reply({ content: 'Please provide a question.', ephemeral: true }).catch(() => {});
    return;
  }

  const shortTermHistory = await getShortTermHistory(userId);
  const { keywords } = await getRouterDecision(shortTermHistory, question);
  const messages = [...shortTermHistory, { role: 'user', content: question }];
  const { content } = await getResponse(messages, { keywords });

  saveMemoryAsync(userId, username, question, content, null);
  await sendChunks(interaction, content);
  logger.info('Handled /ask', { userId, username });
}

// ── /booking-links ────────────────────────────────────────────────────────────

async function handleBookingLinks(interaction) {
  const type = interaction.options.getString('type');

  const LINKS = {
    library: {
      title: '📚 Library Room Booking',
      links: [
        { name: 'Browse All Library Rooms', url: 'https://www.libraries.rutgers.edu/book-a-space' },
        { name: 'LibCal — All Spaces',       url: 'https://libcal.rutgers.edu/spaces' },
      ],
      note: 'All library rooms require a valid Rutgers NetID.'
    },
    alex_342: {
      title: '🚪 Conference Room 342 — Alexander Library',
      links: [
        { name: 'Reserve Room 342 on LibCal', url: 'https://libcal.rutgers.edu/reserve/alex_342/342' },
        { name: 'Room 342 Details',            url: 'https://www.libraries.rutgers.edu/book-a-space/conference-room-342' },
      ],
      note: 'Large conference room, up to 18 people. Bookings mediated by library staff. Pick up key at Circulation Desk.'
    },
    student_center: {
      title: '🏢 Student Center Room Booking',
      links: [
        { name: 'Create an Account',  url: 'https://centerres.rutgers.edu/AccountManagement.aspx' },
        { name: 'Browse Spaces',      url: 'https://centerres.rutgers.edu/browseforspace.aspx' },
      ],
      note: '⚠️ Student center rooms are for **established Rutgers student organizations** only — not individual students. You must have an approved organization account to book.'
    }
  };

  const entry = LINKS[type];
  if (!entry) {
    await interaction.editReply('Unknown booking type.').catch(() => {});
    return;
  }

  const embed = {
    color: 0xCC0033,
    title: entry.title,
    description: entry.note,
    fields: entry.links.map(l => ({
      name: l.name,
      value: l.url,
      inline: false
    })),
    footer: { text: 'Rutgers University Libraries' }
  };

  await interaction.editReply({ embeds: [embed] }).catch(() => {});
  logger.info('Handled /booking-links', { type });
}

// ── /help ─────────────────────────────────────────────────────────────────────

async function handleHelp(interaction) {
  const helpText = [
    '**🏛️ Rutgers Room Booking Bot — Commands**',
    '',
    '`/library-rooms [campus] [seats] [amenity]` — Find available library study and conference rooms. Filter by campus, minimum seats, or required amenity.',
    '',
    '`/room-info <room>` — Full details on a specific room: capacity, floor, technology, amenities, and booking link.',
    '',
    '`/next-available <room> [date]` — Get the direct LibCal link to check and book the next available slot for a room.',
    '',
    '`/student-center [room] [building] [date]` — Browse Student Center rooms for established Rutgers organizations. Leave both blank for a summary across all buildings, filter to one building, or specify a room to search it directly.',
    '',
    '`/booking-links <type>` — Quick links to reservation pages for library rooms or student center rooms.',
    '',
    '`/ask <question>` — Ask anything about room booking at Rutgers.',
    '',
    '`/help` — Show this message.',
    '',
    '📋 **All library bookings require a Rutgers NetID.**',
    '🏢 **Student center rooms are for registered Rutgers organizations only.**',
  ].join('\n');

  await interaction.editReply(helpText).catch(() => {});
  logger.info('Handled /help');
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

async function handleInteraction(interaction) {
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const validCommands = ['library-rooms', 'student-center', 'room-info', 'next-available', 'booking-links', 'ask', 'help'];
  if (!validCommands.includes(commandName)) return;

  const userId   = interaction.user.id;
  const username = interaction.user.username;

  logger.info('Interaction received', { userId, command: commandName, id: interaction.id });

  if (handledInteractions.has(interaction.id)) {
    logger.warn('Duplicate interaction skipped', { id: interaction.id });
    return;
  }
  handledInteractions.set(interaction.id, Date.now());

  if (isRateLimited(userId)) {
    const remaining = getRemainingSeconds(userId);
    await interaction.reply({
      content: `Please wait ${remaining} second(s) before using another command.`,
      ephemeral: true
    }).catch(() => {});
    return;
  }
  recordRequest(userId);

  try {
    await interaction.deferReply();
  } catch (err) {
    logger.error('Defer failed:', err.message);
    return;
  }

  try {
    if (commandName === 'library-rooms')  await handleLibraryRooms(interaction, userId);
    if (commandName === 'room-info')      await handleRoomInfo(interaction, userId);
    if (commandName === 'next-available') await handleNextAvailable(interaction, userId);
    if (commandName === 'booking-links')  await handleBookingLinks(interaction);
    if (commandName === 'ask')            await handleAsk(interaction, userId, username);
    if (commandName === 'help')           await handleHelp(interaction);
    if (commandName === 'student-center') await handleStudentCenter(interaction, userId);
  } catch (err) {
    logger.error('Handler error:', { command: commandName, error: err.message });
    await interaction.editReply('Sorry, something went wrong. Please try again later.').catch(() => {});
  }
}

module.exports = { handleInteraction };