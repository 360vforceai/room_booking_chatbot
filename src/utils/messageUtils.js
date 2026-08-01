// discord has a 2000 char limit per message, 1900 gives a safety buffer
const MAX_CHUNK_SIZE = 1900;

// splits a long AI response into multiple discord-compatible chunks
function splitMessage(text) {
  // if text is empty or not a string, return empty chunk to avoid errors
  if (!text || typeof text !== 'string') {
    return [''];
  }

  const trimmed = text.trim();

  // if the message is already short enough, no splitting needed
  if (trimmed.length <= MAX_CHUNK_SIZE) {
    return [trimmed];
  }

  const chunks = [];
  let remaining = trimmed;
  while (remaining.length > 0) {

    // if whats left fits in one chunk, add it and stop
    if (remaining.length <= MAX_CHUNK_SIZE) {
      chunks.push(remaining);
      break;
    }

    // try to split at a newline first so we dont cut mid paragraph
    let splitIndex = remaining.lastIndexOf('\n', MAX_CHUNK_SIZE);

    // no newline found, try splitting at a space so we dont cut mid word
    if (splitIndex === -1) {
      splitIndex = remaining.lastIndexOf(' ', MAX_CHUNK_SIZE);
    }
    // no space or newline found at all, hard cut at 1900 as last resort
    if (splitIndex === -1 || splitIndex === 0) {
      splitIndex = MAX_CHUNK_SIZE;
    }
    // add the chunk and continue with the rest of the text
    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }
    
  // filter out any empty chunks that may have slipped through
  return chunks.filter((chunk) => chunk.length > 0);
}

module.exports = {
  splitMessage,
  MAX_CHUNK_SIZE
};
//bung