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

// Dates and times live here rather than in one route file because every table
// that stores a date needs the same rule. Events validated theirs and meals and
// to-dos did not, which let a meal be saved onto a day that doesn't exist — it
// then rendered nowhere and couldn't be deleted from the grid it never appeared
// on. A stored date is read on every page load, so it has to be right going in.
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const HMS_RE = /^\d{2}:\d{2}(:\d{2})?$/;

function isValidDate(s) {
  if (typeof s !== 'string' || !YMD_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  // Rejects both unparseable strings and impossible dates that Date happily
  // rolls over (2026-02-30 becoming March 2nd).
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isValidTime(s) {
  if (typeof s !== 'string' || !HMS_RE.test(s)) return false;
  const [h, m, sec] = s.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59 && (sec === undefined || (sec >= 0 && sec <= 59));
}

module.exports = { THEMES, HEX_RE, cleanEmoji, isValidDate, isValidTime };
