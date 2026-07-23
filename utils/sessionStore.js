// src/utils/sessionStore.js
const activeSessions = new Map(); // userId → { startedAt, topic }

function startSession(userId, topic) {
  activeSessions.set(userId, {
    startedAt: new Date().toISOString(),
    topic: topic || 'general advising'
  });
}

function getSession(userId) {
  return activeSessions.get(userId) || null;
}

function endSession(userId) {
  const session = activeSessions.get(userId);
  activeSessions.delete(userId);
  return session;
}

function hasSession(userId) {
  return activeSessions.has(userId);
}

module.exports = { startSession, getSession, endSession, hasSession };