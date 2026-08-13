function forEachChatText(body, visit) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return false;
  }
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') continue;
    if (typeof message.content === 'string') {
      if (visit(message, 'content')) return true;
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part && typeof part === 'object' &&
          part.type === 'text' && typeof part.text === 'string') {
        if (visit(part, 'text')) return true;
      }
    }
  }
  return false;
}

module.exports = { forEachChatText };
