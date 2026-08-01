// 5 second cooldown between requests per user to prevent API spam
const COOLDOWN_MS = 5000;

// tracks each users last request time, key = userId, value = timestamp
const userCooldowns = new Map();

// checks if a user is still in their cooldown period
// returns true if they sent a request less than 5 seconds ago
function isRateLimited(userId) {
  const lastRequest = userCooldowns.get(userId);
  // if no record of this user, they are not rate limited
  if (!lastRequest) return false;
  // compare how long ago their last request was against the cooldown
  return Date.now() - lastRequest < COOLDOWN_MS;
}

// saves the current timestamp for a user when they make a request
// this is what gets checked in isRateLimited next time they send a command
function recordRequest(userId) {
  userCooldowns.set(userId, Date.now());
}

// calculates how many seconds a user still has to wait
// used to tell the user "please wait X more seconds"
function getRemainingSeconds(userId) {
  const lastRequest = userCooldowns.get(userId);
  // if no record, no wait time needed
  if (!lastRequest) return 0;
  const elapsed = Date.now() - lastRequest;
  const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
  // Math.max ensures we never return a negative number
  return Math.max(0, remaining);
}

module.exports = {
  isRateLimited,
  recordRequest,
  getRemainingSeconds,
  COOLDOWN_MS
};
//bung