const { execSync } = require('child_process');

function sendIMessage(message) {
  try {
    // Escape for AppleScript string (inside double quotes) and for the outer single-quoted shell arg.
    // Single quotes are the dangerous case: they terminate the shell's outer '...' wrapping.
    const escaped = message
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/'/g, "'\\''");   // end single-quote, escaped single-quote, restart single-quote
    execSync(`osascript -e 'tell application "Messages" to send "${escaped}" to buddy "self"'`, {
      timeout: 10000,
      stdio: 'ignore',
    });
  } catch {
    // iMessage sending is best-effort — don't crash on failure
  }
}

function notifySuccess(code, savings) {
  // Platform-neutral: the detail already carries "· UberEats" when the win
  // came from the fallback, so a hardcoded "Postmates" would be wrong there.
  const msg = `✅ Promo code applied: ${code}${savings ? ` — ${savings}` : ''}`;
  sendIMessage(msg);
}

function notifyError(message) {
  const msg = `⚠️ Postmates promo: ${message}`;
  sendIMessage(msg);
}

module.exports = { sendIMessage, notifySuccess, notifyError };
