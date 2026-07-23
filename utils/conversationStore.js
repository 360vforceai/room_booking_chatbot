// max messages to keep per user in memory
const MAX_MESSAGES = 20;

// in-memory store, maps userId to their message history
const store = new Map();

// returns a copy of the users message history, empty array if none exists
function getHistory(userId) {
  const history = store.get(userId);
  return history ? [...history] : [];
}

// saves updated history for a user, trimming to last 20 messages
function saveHistory(userId, messages) {
  const trimmed = messages.slice(-MAX_MESSAGES);
  store.set(userId, trimmed);
}

module.exports = {
  getHistory,
  saveHistory
};