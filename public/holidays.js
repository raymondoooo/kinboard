// ── Master holiday list — single source of truth ────────────────────────────
// Loaded by BOTH the browser (onboard.html / settings.html, via <script>) and the
// Node server (server/index.js + server/routes/onboard.js, via require). The UMD
// wrapper below exports to module.exports under Node and to window under a browser.
//
// `rule` describes WHICH day the holiday falls on as plain data. The server reads
// it to compute the date (the algorithms live in server/index.js); the browser
// ignores `rule` and only uses `name`/`emoji` for the checklist. Add a holiday here
// and both sides pick it up — no other file to edit.
//
//   rule kinds:
//     { kind: 'fixed',  month, day }          — same calendar date every year (month 1-based)
//     { kind: 'nth',    month, weekday, n }    — nth weekday of month (weekday 0=Sun…6=Sat)
//     { kind: 'last',   month, weekday }       — last weekday of month
//     { kind: 'easter' }                       — Anonymous Gregorian algorithm
//     { kind: 'hanukkah' }                     — table lookup (Hebrew calendar)
(function (root, factory) {
  const defs = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = defs;
  else root.HOLIDAY_DEFS = defs;
})(typeof self !== 'undefined' ? self : this, function () {
  return [
    { key: 'new-years',     name: "New Year's Day",    emoji: '🎆', rule: { kind: 'fixed', month: 1,  day: 1  } },
    { key: 'valentines',    name: "Valentine's Day",   emoji: '💝', rule: { kind: 'fixed', month: 2,  day: 14 } },
    { key: 'st-patricks',   name: "St. Patrick's Day", emoji: '🍀', rule: { kind: 'fixed', month: 3,  day: 17 } },
    { key: 'easter',        name: 'Easter',            emoji: '🐣', rule: { kind: 'easter' } },
    { key: 'mothers-day',   name: "Mother's Day",      emoji: '💐', rule: { kind: 'nth',  month: 5,  weekday: 0, n: 2 } },
    { key: 'memorial-day',  name: 'Memorial Day',      emoji: '🇺🇸', rule: { kind: 'last', month: 5,  weekday: 1 } },
    { key: 'juneteenth',    name: 'Juneteenth',        emoji: '✊', rule: { kind: 'fixed', month: 6,  day: 19 } },
    { key: 'fathers-day',   name: "Father's Day",      emoji: '👔', rule: { kind: 'nth',  month: 6,  weekday: 0, n: 3 } },
    { key: 'independence',  name: 'Independence Day',  emoji: '🎇', rule: { kind: 'fixed', month: 7,  day: 4  } },
    { key: 'labor-day',     name: 'Labor Day',         emoji: '👷', rule: { kind: 'nth',  month: 9,  weekday: 1, n: 1 } },
    { key: 'halloween',     name: 'Halloween',         emoji: '🎃', rule: { kind: 'fixed', month: 10, day: 31 } },
    { key: 'veterans',      name: 'Veterans Day',      emoji: '🎖️', rule: { kind: 'fixed', month: 11, day: 11 } },
    { key: 'thanksgiving',  name: 'Thanksgiving',      emoji: '🦃', rule: { kind: 'nth',  month: 11, weekday: 4, n: 4 } },
    { key: 'hanukkah',      name: 'Hanukkah',          emoji: '🕎', rule: { kind: 'hanukkah' } },
    { key: 'christmas',     name: 'Christmas',         emoji: '🎄', rule: { kind: 'fixed', month: 12, day: 25 } },
    { key: 'new-years-eve', name: "New Year's Eve",    emoji: '🥂', rule: { kind: 'fixed', month: 12, day: 31 } },
  ];
});
