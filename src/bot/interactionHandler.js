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

  await interaction.respond([]).catch(() => {});
}

// ── /library-rooms ────────────────────────────────────────────────────────────
// Filter rooms by campus, minimum seats, and amenity.
// Shows a list embed — up to 10 results with name, capacity, key amenities, book link.

async function handleLibraryRooms(interaction, userId) {
  const campus   = interaction.options.getString('campus');
  const library  = interaction.options.getString('library');
  const seatsStr = interaction.options.getString('seats'); // '1-3', '4-6', '7+', 'any', or null
  const amenity  = interaction.options.getString('amenity');

  // campus 'all' means no filter; seats 'any' means no filter
  const campusFilter = (campus && campus !== 'all') ? campus : null;
  const seatsFilter  = (seatsStr && seatsStr !== 'any') ? seatsStr : null;

  const results = await searchRooms({
    campus:  campusFilter || null,
    library: library      || null,
    seats:   seatsFilter,           // pass string directly e.g. '4-6' — site handles it
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
// Full details for a specific room scraped from its detail page.

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

  // Capacity: parsed value or fall back to seat count in description text
  const capacityNum = room.capacity
    || (room.description && room.description.match(/(\d+)\s*seats?/i)
        ? parseInt(room.description.match(/(\d+)\s*seats?/i)[1])
        : null);

  // Strip bold labels the site puts in Space Details
  const locationText     = room.location      ? room.location.replace(/^location:\s*/i, '').trim()                         : null;
  const accessText       = room.access        ? room.access.replace(/^how to access this space:\s*/i, '').trim()           : null;
  const maxText          = room.maxReservation? room.maxReservation.replace(/^maximum reservation length:\s*/i, '').trim() : null;

  // All field values must be non-empty strings — Discord errors silently on empty values
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
// Two-step LibCal API: GET nextdate → POST grid for time slots

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

  // ── No availability data ──────────────────────────────────────────────────
  const todayLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });

  if (!avail || !avail.slots || avail.slots.length === 0) {
    const embed = {
      color: 0xED4245, // red
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

  // ── Format available blocks ───────────────────────────────────────────────
  function fmt(dateStr) {
    const d = new Date(dateStr.replace(' ', 'T') + '-04:00');
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
  }

  const blockLines = avail.blocks.map(b => `🟢 **${fmt(b.start)} – ${fmt(b.end)}**`).join('\n')
    || avail.slots.slice(0, 10).map(s => `🟢 **${fmt(s.start)} – ${fmt(s.end)}**`).join('\n');

  const embed = {
    color: 0x57F287, // green
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
    '`/student-center [date]` — Learn about student center rooms (for established Rutgers organizations only).',
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
    // /student-center handler to be added
  } catch (err) {
    logger.error('Handler error:', { command: commandName, error: err.message });
    await interaction.editReply('Sorry, something went wrong. Please try again later.').catch(() => {});
  }
}

module.exports = { handleInteraction };