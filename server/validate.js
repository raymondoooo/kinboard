// Shared validation constants/helpers used by both the onboarding routes and
// the authenticated management API.

const THEMES = new Set(['light', 'dark', 'glitter', 'sports', 'beach', 'forest', 'mountains']);
const HEX_RE = /^#[0-9a-f]{6}$/i;

// Trim to a single emoji-ish string (a few codepoints). We don't strictly
// verify it's an emoji — just cap the length so it can't carry a payload.
function cleanEmoji(e) {
  if (typeof e !== 'string') return null;
  const t = e.trim();
  if (!t) return null;
  return Array.from(t).slice(0, 4).join('');
}

module.exports = { THEMES, HEX_RE, cleanEmoji };
