// numeric levels so we can compare severity, higher = more severe
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
// read LOG_LEVEL from .env, default to 'info' if not set
const currentLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
// get the numeric value of the current level, fallback to info if invalid
const levelValue = LOG_LEVELS[currentLevel] ?? LOG_LEVELS.info;

// returns current time in ISO format ex: 2024-01-01T12:00:00.000Z
function formatTimestamp() {
  return new Date().toISOString();
}

// builds the log prefix with timestamp and level label
function formatMessage(level, ...args) {
  const timestamp = formatTimestamp();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  return [prefix, ...args];
}

module.exports = {
    // only logs if current level is debug or lower
  debug(...args) {
    if (levelValue <= LOG_LEVELS.debug) {
      console.log(...formatMessage('debug', ...args));
    }
  },
   // only logs if current level is info or lower
  info(...args) {
    if (levelValue <= LOG_LEVELS.info) {
      console.log(...formatMessage('info', ...args));
    }
  },
  // only logs if current level is warn or lower
  warn(...args) {
    if (levelValue <= LOG_LEVELS.warn) {
      console.warn(...formatMessage('warn', ...args));
    }
  },
  // only logs if current level is error or lower
  error(...args) {
    if (levelValue <= LOG_LEVELS.error) {
      console.error(...formatMessage('error', ...args));
    }
  }
};