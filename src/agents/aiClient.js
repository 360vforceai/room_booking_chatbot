const OpenAI = require('openai');
const logger = require('../utils/logger');

const DEFAULT_SYSTEM_PROMPT = `You are an AI Room Booking Assistant for a Discord server serving Rutgers University students and organizations.

You help users find, learn about, and reserve rooms at Rutgers libraries and student centers.

## What You Help With

**Library Rooms**: Help students find available study rooms and conference rooms at Rutgers libraries across all campuses. Explain capacity, amenities (monitors, whiteboards, etc.), floor locations, and how to book.

**Student Center Rooms**: Clarify that student center rooms (via centerres.rutgers.edu) are for established Rutgers student organizations and groups — not individual students. Help users understand the difference and direct them appropriately.

**Room Details**: Give specific information about a room when asked — size, capacity, floor, equipment, and booking link.

**Next Available**: Help users find the next available time slot for a specific room or type of room.

**Booking Links**: Always provide the direct booking URL when discussing a specific room.

## General Rules:
- Always be specific: use real room names, real building names, real URLs
- When room or availability data is provided as context, reference it directly
- Student center rooms require an established Rutgers organization — always mention this when relevant
- Library rooms at libcal.rutgers.edu are open to all Rutgers students with a NetID
- Never guess availability — only state what is confirmed in provided context
- When unsure, direct users to libraries.rutgers.edu/book-a-space for library rooms
- Keep responses concise — students want to find a room quickly`;

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
const MODEL = 'gpt-4o-mini';

let client = null;

function getClient() {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    logger.info('OpenAI client init', { keyPrefix: apiKey.slice(0, 12) + '...' });
    client = new OpenAI({ apiKey });
  }
  return client;
}

function sanitizeHistoryMessages(messages) {
  const safeMessages = [];
  let pendingToolCallIds = null;
  let droppedToolMessages = 0;

  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== 'object') continue;

    if (msg.role === 'user') {
      safeMessages.push(msg);
      pendingToolCallIds = null;
      continue;
    }

    if (msg.role === 'assistant') {
      safeMessages.push(msg);
      pendingToolCallIds = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
        ? new Set(msg.tool_calls.map(tc => tc?.id).filter(id => typeof id === 'string'))
        : null;
      continue;
    }

    if (msg.role === 'tool') {
      const id = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
      if (pendingToolCallIds && id && pendingToolCallIds.has(id)) {
        safeMessages.push(msg);
      } else {
        droppedToolMessages++;
      }
      continue;
    }
  }

  if (droppedToolMessages > 0) {
    logger.warn(`Dropped ${droppedToolMessages} orphaned tool message(s)`);
  }
  return safeMessages;
}

// ── Router Agent ─────────────────────────────────────────────────────────────
// Tables: "library_rooms", "student_center_rooms", "room_details", "booking_links"

const ROUTER_SYSTEM_PROMPT = `You are a query router for a Rutgers University Room Booking Discord bot.

Given the user's question, output a JSON object with exactly two fields:

1. "tables": array of data sources to query. Valid values:
   - "library_rooms"       — searching for available library study/conference rooms by campus, seats, or amenities
   - "student_center_rooms" — rooms for established Rutgers student organizations via centerres.rutgers.edu
   - "room_details"        — specific info about a named room (capacity, floor, equipment, booking link)
   - "booking_links"       — just needs the reservation URL for a library or student center room

2. "keywords": a short phrase (3-8 words) for semantic vector search.

## Examples:
"find a room for 4 people on Busch" → tables: ["library_rooms"], keywords: "Busch library room 4 people"
"what's in conference room 342" → tables: ["room_details"], keywords: "conference room 342 details capacity"
"how do I book a student center room" → tables: ["student_center_rooms"], keywords: "student center room booking organization"
"next available room at Alexander Library" → tables: ["library_rooms", "room_details"], keywords: "Alexander Library next available room"
"give me the link to reserve room 342" → tables: ["booking_links"], keywords: "room 342 reservation link"
"what rooms have whiteboards" → tables: ["library_rooms"], keywords: "library room whiteboard amenities"
"hey what's up" → tables: [], keywords: ""

Output ONLY valid JSON, no explanation, no markdown.`;

async function getRouterDecision(shortTermHistory, question) {
  const fallback = { tables: ['library_rooms'], keywords: question };

  try {
    const openai = getClient();
    const historyText = shortTermHistory.length > 0
      ? shortTermHistory.slice(-6).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')
      : '(no prior conversation)';

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: ROUTER_SYSTEM_PROMPT },
        { role: 'user', content: `Conversation:\n${historyText}\n\nQuestion: ${question}` }
      ],
      max_tokens: 80,
      temperature: 0,
      response_format: { type: 'json_object' }
    });

    const parsed = JSON.parse(response.choices[0]?.message?.content?.trim() || '{}');
    const validTables = ['library_rooms', 'student_center_rooms', 'room_details', 'booking_links'];
    const tables = Array.isArray(parsed.tables)
      ? parsed.tables.filter(t => validTables.includes(t))
      : fallback.tables;
    const keywords = typeof parsed.keywords === 'string' && parsed.keywords.trim()
      ? parsed.keywords.trim()
      : question;

    logger.info('Router decision', { tables, keywords });
    return { tables, keywords };
  } catch (err) {
    logger.warn('getRouterDecision failed, using fallback:', err.message);
    return fallback;
  }
}

// ── Main Response Function ────────────────────────────────────────────────────

/**
 * @param {Array}  messages
 * @param {Object} options
 * @param {string|null} options.libraryRoomsContext
 * @param {string|null} options.studentCenterContext
 * @param {string|null} options.roomDetailsContext
 * @param {string|null} options.bookingLinksContext
 * @param {string|null} options.availabilityContext  — live availability data from LibCal API
 * @param {string|null} options.keywords
 */
async function getResponse(messages, {
  libraryRoomsContext   = null,
  studentCenterContext  = null,
  roomDetailsContext    = null,
  bookingLinksContext   = null,
  availabilityContext   = null,
  keywords              = null
} = {}) {
  logger.info('getResponse called', {
    msgCount: messages.length,
    hasLibrary:      !!libraryRoomsContext,
    hasStudentCenter:!!studentCenterContext,
    hasRoomDetails:  !!roomDetailsContext,
    hasAvailability: !!availabilityContext,
  });

  const systemMessage = { role: 'system', content: SYSTEM_PROMPT };
  const sanitizedHistory = sanitizeHistoryMessages(messages);
  const keywordsLine = keywords ? `Search keywords: "${keywords}"\n\n` : '';

  const contextParts = [];

  // Availability always goes first — most time-sensitive
  if (availabilityContext) {
    contextParts.push(`## Live Room Availability\n${keywordsLine}${availabilityContext}\n\n→ Always state the date/time range for the availability shown.\n→ Include the direct booking link with every available slot.`);
  }

  if (libraryRoomsContext) {
    contextParts.push(`## Library Rooms\n${keywordsLine}${libraryRoomsContext}\n\n→ Mention campus, capacity, amenities, and the booking link for each room.\n→ Remind users they need a Rutgers NetID to book.`);
  }

  if (roomDetailsContext) {
    contextParts.push(`## Room Details\n${keywordsLine}${roomDetailsContext}\n\n→ Include floor, capacity, all equipment/amenities, and the direct booking URL.`);
  }

  if (studentCenterContext) {
    contextParts.push(`## Student Center Rooms\n${keywordsLine}${studentCenterContext}\n\n→ Always clarify these rooms are for established Rutgers student organizations only.\n→ Direct individuals to library rooms instead.`);
  }

  if (bookingLinksContext) {
    contextParts.push(`## Booking Links\n${keywordsLine}${bookingLinksContext}`);
  }

  let apiMessages;
  if (contextParts.length > 0) {
    const contextMessage = { role: 'system', content: contextParts.join('\n\n---\n\n') };
    const historyWithoutLast = sanitizedHistory.slice(0, -1);
    const lastMessage = sanitizedHistory[sanitizedHistory.length - 1];
    apiMessages = [systemMessage, ...historyWithoutLast, contextMessage, lastMessage];
  } else {
    apiMessages = [systemMessage, ...sanitizedHistory];
  }

  try {
    const openai = getClient();
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: apiMessages,
      max_tokens: 1024
    });

    const msg = response.choices[0]?.message;
    const content = msg?.content?.trim() || '';

    if (content) {
      apiMessages.push(msg);
      return { content, messages: apiMessages };
    }

    return { content: 'I could not generate a response. Please try again.', messages: apiMessages };
  } catch (err) {
    logger.error('OpenAI API error', { status: err.status, message: err.message });
    if (err.status === 429) return { content: 'Rate limit exceeded. Please try again in a moment.', messages: apiMessages };
    if (err.status === 401) return { content: 'API configuration error. Please contact the bot administrator.', messages: apiMessages };
    return { content: 'Sorry, I encountered an error. Please try again later.', messages: apiMessages };
  }
}

module.exports = { getResponse, getRouterDecision, getClient };