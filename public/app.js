const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

let appConfig = null;
let events = [];
let viewOffset = 0;     // months from the current month (only used when !todayView)
let todayView = true;   // true = rolling "Today" view; false = a full navigated month
const mobileMQ = window.matchMedia('(max-width: 700px)');

// Mobile and desktop remember their view independently: 'month' and 'grid' are
// two different renderings of the same idea and neither is valid on the other's
// width, so one shared preference would keep putting people in a view their
// screen can't show.
function initialViewMode() {
  const mobile = mobileMQ.matches;
  const allowed = mobile ? ['month', 'agenda'] : ['grid', 'agenda'];
  let saved = null;
  try { saved = localStorage.getItem(mobile ? 'kb-view-mobile' : 'kb-view-desktop'); } catch (e) {}
  return allowed.includes(saved) ? saved : (mobile ? 'month' : 'grid');
}

let viewMode = initialViewMode();
let mmOffset = 0;          // months from the current month, mobile month view
let mmSelectedKey = null;  // 'YYYY-MM-DD' of the day expanded under the grid
let weatherData = null;
let dailyWeather = {};
let activeFilter = null;

// Agenda view (mobile) grows on scroll rather than fetching more — the server
// already sends everything up to a year out (see the /api/events window on
// the server), so "load more" just means rendering further into data that's
// already sitting in `events`. Persists across re-renders (not reset inside
// renderAgenda) so the periodic background refresh doesn't snap someone's
// scroll position back down to 60 days while they're mid-read.
let agendaDaysShown = 60;
const AGENDA_PAGE_SIZE = 60;
const AGENDA_MAX_DAYS = 365; // matches the server's fetch window
let editMode = null;
let detailEv = null;
let pendingSaveController = null; // the in-flight add/edit-event request, so Cancel can actually abort it
let aeMoreDates = [];    // extra days for a new event ("Also on"), YYYY-MM-DD
let aePeople = [];       // people currently selected in the add/edit event form's chip row
let detailPeople = [];   // people currently selected in the detail popup's edit-mode chip row
let authed = false; // set from /api/config's `authed` field and by login/logout

// Authenticated API call. The session lives in an httpOnly cookie sent
// automatically with same-origin requests — no bearer token to attach or
// refresh client-side. A 401 means the cookie is missing/expired (or nobody's
// logged in yet); show the password prompt.
async function apiFetch(path, opts = {}) {
  const res = await fetch(path, { ...opts, credentials: 'same-origin' });
  if (res.status === 401) {
    authed = false;
    updateAuthUI();
    showAuthOverlay();
  }
  return res;
}

function updateAuthUI() {
  document.getElementById('add-btn').style.display = authed ? 'flex' : 'none';
  document.getElementById('settings-link').style.display = authed ? 'inline-flex' : 'none';
  const signinBtn = document.getElementById('signin-btn');
  const signoutBtn = document.getElementById('signout-btn');
  signinBtn.style.display = (!authed && appConfig && appConfig.isPublic) ? 'inline-block' : 'none';
  signoutBtn.style.display = authed ? 'inline-block' : 'none';
}

function showAuthOverlay() {
  document.getElementById('auth-overlay').classList.add('open');
  setTimeout(() => document.getElementById('auth-password').focus(), 50);
}

document.getElementById('readonly-signin').addEventListener('click', (e) => {
  e.preventDefault();
  showAuthOverlay();
});

function hideAuthOverlay() {
  document.getElementById('auth-overlay').classList.remove('open');
}

function toDateInputValue(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// The server sends two genuinely different kinds of timestamp, and telling them
// apart is the whole ballgame:
//
//   - Events typed into Kinboard are WALL-CLOCK times with no zone at all
//     ("2026-08-12T17:30"). "Soccer at 5:30" means 5:30 where the family lives.
//   - Events pulled from a subscribed iCal feed are absolute instants, emitted
//     by toISOString() ("2026-08-12T21:30:00.000Z"). Those must be converted
//     into the household's zone to land on the right day at the right time.
//
// Passing a zone-less string through `new Date()` parses it in the VIEWER's
// zone; formatting that with the household's zone then applies the offset a
// SECOND time. At home the two cancel out so it looks fine, which is why this
// survived — but on a phone set to another zone every typed event silently
// shifted, and in the edit form the shifted value got saved back, permanently
// corrupting the time.
function hasExplicitZone(s) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(String(s));
}

// Express a timestamp as { date, time } wall-clock in the display timezone — used to
// pre-fill the edit form so values round-trip correctly regardless of the device's zone.
function tzParts(iso) {
  // Already wall-clock: read the literal fields. Converting would corrupt them.
  const naive = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(String(iso));
  if (naive && !hasExplicitZone(iso)) {
    return { date: naive[1], time: `${naive[2]}:${naive[3]}` };
  }
  const tz = (appConfig && appConfig.timeZone) || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const p = f.formatToParts(new Date(iso)).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// Per-person emoji (from /api/config). Prefixes names in the UI when set.
function emojiFor(name) {
  return (appConfig && appConfig.emojis && appConfig.emojis[name]) || '';
}
function withEmoji(name) {
  const e = emojiFor(name);
  return e ? `${e} ${name}` : name;
}

// ==== PERSON ASSIGNMENT: shared multi-select chip row + read-only badge row ====

// Toggleable pill per name (same visual language as .filter-chip), builds
// `selected` (an array the caller owns and mutates in place) into `people`
// payloads. `exclude` defaults to hiding only the internal 'default' bucket —
// callers that shouldn't offer category pseudo-people (meals/todos) pass
// NON_PERSON_NAMES instead.
function renderPersonChips(containerId, selected, exclude, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const skip = exclude || new Set(['default']);
  container.innerHTML = '';
  if (!appConfig || !appConfig.colors) return;
  for (const [name, color] of Object.entries(appConfig.colors)) {
    if (skip.has(name)) continue;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'person-chip' + (selected.includes(name) ? ' active' : '');
    chip.dataset.person = name;
    chip.textContent = withEmoji(name);
    chip.style.setProperty('--chip-color', color);
    chip.addEventListener('click', () => {
      const idx = selected.indexOf(name);
      if (idx >= 0) selected.splice(idx, 1); else selected.push(name);
      renderPersonChips(containerId, selected, exclude, onChange);
      if (onChange) onChange([...selected]);
    });
    container.appendChild(chip);
  }
}

// One colored circle carrying that person's emoji (or initial letter) —
// deliberately not a plain color dot, so who's attached is obvious without
// having to memorize a color-to-person mapping.
function personBadge(name, size) {
  const b = document.createElement('div');
  b.className = 'person-badge';
  b.style.width = size + 'px';
  b.style.height = size + 'px';
  b.style.fontSize = Math.max(9, Math.round(size * 0.52)) + 'px';
  const colors = (appConfig && appConfig.colors) || {};
  b.style.background = (name && colors[name]) || '#888';
  b.textContent = name ? (emojiFor(name) || name[0].toUpperCase()) : '';
  if (name) b.title = name;
  return b;
}

// Row of badges for a `people` array, capped at `maxVisible` with a "+N" text
// suffix for the rest (the full name list is always shown as text alongside
// this row wherever it's used, so nobody's actually hidden — just not badged).
function renderPersonBadgeRow(container, people, size, maxVisible) {
  maxVisible = maxVisible || 3;
  container.innerHTML = '';
  container.classList.add('person-badge-row');
  const list = people || [];
  if (!list.length) {
    container.appendChild(personBadge(null, size));
    return;
  }
  for (const name of list.slice(0, maxVisible)) container.appendChild(personBadge(name, size));
  if (list.length > maxVisible) {
    const more = document.createElement('div');
    more.className = 'person-badge-more';
    more.textContent = '+' + (list.length - maxVisible);
    container.appendChild(more);
  }
}

function populatePersonSelect() {
  renderPersonChips('ae-person-chips', aePeople);
}

function populateFeedPersonSelect() {
  const sel = document.getElementById('cf-person');
  sel.innerHTML = '';
  if (!appConfig || !appConfig.colors) return;
  for (const [name] of Object.entries(appConfig.colors)) {
    if (['default', 'Birthday', 'Anniversary', 'Holiday'].includes(name)) continue;
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = withEmoji(name);
    sel.appendChild(opt);
  }
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = 'New person...';
  sel.appendChild(newOpt);
}

function openFeedForm() {
  populateFeedPersonSelect();
  document.getElementById('cf-url').value = '';
  document.getElementById('cf-name').value = '';
  document.getElementById('cf-icon').value = '';
  document.getElementById('cf-new-name').value = '';
  document.getElementById('cf-new-color').value = '#4682B4';
  document.getElementById('cf-new-fields').style.display = 'none';
  document.getElementById('cf-submit').disabled = false;
  document.getElementById('cf-submit').textContent = 'Add Feed';
  document.getElementById('feed-overlay').classList.add('open');
  setTimeout(() => document.getElementById('cf-url').focus(), 50);
}

function closeFeedForm() {
  document.getElementById('feed-overlay').classList.remove('open');
}

function showEventDetail(ev) {
  detailEv = ev;
  document.getElementById('detail-title').textContent = ev.title;

  const allDay = ev.allDay === true || ev.allDay === 'true';
  let meta;
  if (allDay) {
    // Date-only strings parse as UTC; reparse as local to avoid off-by-one in western timezones.
    const localDate = new Date((ev.start || '').slice(0, 10) + 'T00:00:00');
    meta = localDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  } else {
    const start = new Date(ev.start);
    const datePart = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    meta = `${datePart} · ${formatTimeRange(ev.start, ev.end)}`;
  }
  document.getElementById('detail-meta').textContent = meta;
  const canEdit = authed && !ev.feedId;
  document.getElementById('detail-edit').style.display = canEdit ? 'block' : 'none';
  document.getElementById('detail-duplicate').style.display = canEdit ? 'block' : 'none';
  const personSpan = document.getElementById('detail-person');
  const personChips = document.getElementById('detail-person-chips');
  renderPersonBadgeRow(document.getElementById('detail-dot'), ev.people, 24);

  if (canEdit) {
    personSpan.style.display = 'none';
    personChips.style.display = '';
    detailPeople = Array.isArray(ev.people) ? [...ev.people] : [];
    const uid = ev.uid;
    renderPersonChips('detail-person-chips', detailPeople, undefined, async people => {
      try {
        const res = await apiFetch(`/api/events/${encodeURIComponent(uid)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ people }),
        });
        if (!res.ok) throw new Error('failed');
        renderPersonBadgeRow(document.getElementById('detail-dot'), people, 24);
        await loadEvents();
        render();
      } catch (err) {
        alert('Could not update people.');
      }
    });
  } else {
    personSpan.style.display = '';
    personSpan.textContent = (ev.people && ev.people.length) ? ev.people.map(withEmoji).join(', ') : '';
    personChips.style.display = 'none';
  }

  const locationDiv = document.getElementById('detail-location');
  if (ev.location) {
    locationDiv.textContent = '📍 ' + ev.location;
    locationDiv.style.display = '';
  } else {
    locationDiv.style.display = 'none';
  }

  const deleteBtn = document.getElementById('detail-delete');
  const deleteRecurringDiv = document.getElementById('detail-delete-recurring');
  const canDelete = canEdit;

  if (canDelete && ev.hasSeries) {
    deleteBtn.style.display = 'none';
    deleteRecurringDiv.style.display = 'flex';
    const delOne = document.getElementById('detail-delete-one');
    const delAll = document.getElementById('detail-delete-all');
    delOne.dataset.uid = ev.uid || '';
    delOne.dataset.start = ev.start;
    delOne.disabled = false;
    delOne.textContent = 'Delete This Only';
    delAll.dataset.uid = ev.uid || '';
    delAll.disabled = false;
    delAll.textContent = 'Delete All';
  } else {
    deleteBtn.style.display = canDelete ? 'block' : 'none';
    deleteRecurringDiv.style.display = 'none';
    deleteBtn.dataset.uid = ev.uid || '';
    deleteBtn.disabled = false;
    deleteBtn.textContent = 'Delete Event';
  }

  document.getElementById('detail-overlay').classList.add('open');
}

function closeDetailPopup() {
  document.getElementById('detail-overlay').classList.remove('open');
}

// ── Custom recurrence (RRULE builder) ──────────────────────────────────────
// The "Custom…" repeat option builds an RFC5545 RRULE (FREQ/INTERVAL/BYDAY);
// the series end still lives in the separate "Ends on" field, never in the
// rule's UNTIL — the server (expandRruleRecurring) honors both, so keeping the
// end date in one place unifies simple, custom, and imported events.
const RRULE_DAYS = ['SU','MO','TU','WE','TH','FR','SA']; // index = JS getDay()
const RRULE_DAY_LABELS = ['S','M','T','W','T','F','S'];
const RRULE_DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const UNIT_FREQ = { day:'DAILY', week:'WEEKLY', month:'MONTHLY', year:'YEARLY' };
const FREQ_UNIT = { DAILY:'day', WEEKLY:'week', MONTHLY:'month', YEARLY:'year' };
const RRULE_DAY_SHORT = { SU:'Sun', MO:'Mon', TU:'Tue', WE:'Wed', TH:'Thu', FR:'Fri', SA:'Sat' };

// Parse an RRULE value (no "RRULE:" prefix) into the fields the custom builder
// can represent. Returns null when the rule uses anything the checkbox/interval
// UI can't safely round-trip (BYMONTHDAY, BYSETPOS, positional BYDAY like 2MO,
// COUNT, or a non-default WKST on an interval>1 rule) — the caller then shows
// the pattern read-only rather than silently rewriting (and corrupting) it.
function parseSimpleRrule(str) {
  if (!str) return null;
  const parts = {};
  for (const seg of String(str).split(';')) {
    const i = seg.indexOf('=');
    if (i > 0) parts[seg.slice(0, i).toUpperCase()] = seg.slice(i + 1);
  }
  const freq = (parts.FREQ || '').toUpperCase();
  if (!FREQ_UNIT[freq]) return null;
  const allowed = new Set(['FREQ','INTERVAL','BYDAY','UNTIL','WKST']);
  for (const k of Object.keys(parts)) if (!allowed.has(k)) return null;
  const interval = parts.INTERVAL ? parseInt(parts.INTERVAL, 10) : 1;
  if (!(interval >= 1)) return null;
  if (interval > 1 && parts.WKST && parts.WKST.toUpperCase() !== 'MO') return null;
  let byday = [];
  if (parts.BYDAY) {
    byday = parts.BYDAY.split(',').map(d => d.trim().toUpperCase());
    if (byday.some(d => !RRULE_DAYS.includes(d))) return null; // positional (e.g. 2MO)
  }
  let untilDate = null;
  if (parts.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(parts.UNTIL);
    if (m) untilDate = `${m[1]}-${m[2]}-${m[3]}`;
  }
  return { unit: FREQ_UNIT[freq], interval, byday, untilDate };
}

// Best-effort human summary for a pattern we won't let the user edit inline.
function summarizeRrule(str) {
  const parts = {};
  for (const seg of String(str).split(';')) {
    const i = seg.indexOf('=');
    if (i > 0) parts[seg.slice(0, i).toUpperCase()] = seg.slice(i + 1);
  }
  const base = { DAILY:'day', WEEKLY:'week', MONTHLY:'month', YEARLY:'year' }[(parts.FREQ||'').toUpperCase()] || 'period';
  const n = parts.INTERVAL ? parseInt(parts.INTERVAL, 10) : 1;
  let s = n > 1 ? `every ${n} ${base}s` : `every ${base}`;
  if (parts.BYDAY) {
    const names = parts.BYDAY.split(',').map(d => RRULE_DAY_SHORT[d.replace(/^[0-9+-]+/, '').toUpperCase()] || d);
    s += ' on ' + names.join(', ');
  }
  if (parts.BYMONTHDAY) s += ` (day ${parts.BYMONTHDAY} of the month)`;
  return s;
}

// Build an RRULE value from the custom-form fields (end date excluded — it
// lives in ae-ends-on). Weekly with no day checked falls back to the anchor
// date's weekday so the rule is always valid.
function buildSimpleRrule() {
  const unit = document.getElementById('ae-custom-unit').value;
  const freq = UNIT_FREQ[unit] || 'WEEKLY';
  let n = parseInt(document.getElementById('ae-custom-interval').value, 10);
  if (!(n >= 1)) n = 1;
  let rule = `FREQ=${freq}`;
  if (n > 1) rule += `;INTERVAL=${n}`;
  if (unit === 'week') {
    let days = [...document.querySelectorAll('#ae-weekday-chips .ae-weekday-chip.on')].map(b => b.dataset.day);
    if (!days.length) {
      const dv = document.getElementById('ae-date').value;
      const d = dv ? new Date(dv + 'T00:00:00') : null;
      if (d && !isNaN(d.getTime())) days = [RRULE_DAYS[d.getDay()]];
    }
    if (days.length) rule += `;BYDAY=${days.join(',')}`;
  }
  return rule;
}

function renderWeekdayChips(selected) {
  const wrap = document.getElementById('ae-weekday-chips');
  wrap.innerHTML = '';
  const sel = new Set(selected || []);
  for (let i = 0; i < 7; i++) {
    const code = RRULE_DAYS[i];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ae-weekday-chip' + (sel.has(code) ? ' on' : '');
    b.dataset.day = code;
    b.textContent = RRULE_DAY_LABELS[i];
    b.setAttribute('aria-label', RRULE_DAY_NAMES[i]);
    b.addEventListener('click', () => b.classList.toggle('on'));
    wrap.appendChild(b);
  }
}

// Show/hide the custom builder + ends-on based on the repeat dropdown.
function updateRepeatUI() {
  const v = document.getElementById('ae-repeat').value;
  document.getElementById('ae-custom-row').style.display = v === 'custom' ? '' : 'none';
  document.getElementById('ae-ends-row').style.display = v !== 'none' ? '' : 'none';
  document.getElementById('ae-more-row').style.display = (!editMode && v === 'none') ? '' : 'none';
  if (v === 'custom') updateCustomUnitUI();
}

function renderMoreDates() {
  const wrap = document.getElementById('ae-more-chips');
  wrap.textContent = '';
  for (const d of aeMoreDates) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ae-date-chip';
    chip.title = 'Remove this day';
    chip.textContent = new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' ✕';
    chip.addEventListener('click', () => { aeMoreDates = aeMoreDates.filter(x => x !== d); renderMoreDates(); });
    wrap.appendChild(chip);
  }
}

function addMoreDate() {
  const input = document.getElementById('ae-more-date');
  const d = input.value;
  if (!d) return;
  if (d !== document.getElementById('ae-date').value && !aeMoreDates.includes(d)) {
    aeMoreDates = [...aeMoreDates, d].sort();
    renderMoreDates();
  }
  input.value = '';
  input.focus();
}

// The add form, filled in from an existing event: same title, time, people,
// location and sharing, on the same day, not repeating. Change the date (or
// add more under "Also on") and save.
function openDuplicateForm(ev) {
  openAddForm((ev.start || '').slice(0, 10));
  const allDay = ev.allDay === true || ev.allDay === 'true';
  document.getElementById('ae-heading').textContent = 'Duplicate Event';
  document.getElementById('ae-title').value = ev.title || '';
  document.getElementById('ae-allday').checked = allDay;
  document.getElementById('ae-times').style.display = allDay ? 'none' : '';
  if (!allDay) {
    const sp = tzParts(ev.start);
    document.getElementById('ae-date').value = sp.date;
    document.getElementById('ae-start').value = sp.time;
    document.getElementById('ae-end').value = (ev.end && ev.end !== ev.start) ? tzParts(ev.end).time : '';
  }
  refreshDowOption();
  document.getElementById('ae-location').value = ev.location || '';
  aePeople = Array.isArray(ev.people) ? [...ev.people] : [];
  populatePersonSelect();
  document.getElementById('ae-share').value =
    (ev.shareOverride === 'always' || ev.shareOverride === 'never') ? ev.shareOverride : 'auto';
  updateShareHint();
  setTimeout(() => document.getElementById('ae-date').focus(), 60);
}
function updateCustomUnitUI() {
  const unit = document.getElementById('ae-custom-unit').value;
  document.getElementById('ae-weekday-row').style.display = unit === 'week' ? '' : 'none';
}

// Keep the "Monthly on the Nth weekday" option label in sync with the picked date
// (e.g. "Monthly on the 3rd Friday" / "Monthly on the last Friday"). Mirrors the
// server's dowOrdinal logic so the label matches what actually gets generated.
function refreshDowOption() {
  const opt = document.getElementById('ae-repeat-dow');
  const dv = document.getElementById('ae-date').value;
  if (!opt || !dv) return;
  const d = new Date(dv + 'T00:00:00');
  if (isNaN(d.getTime())) return;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const isLast = d.getDate() + 7 > daysInMonth;
  const ord = isLast ? 'last' : ['1st', '2nd', '3rd', '4th'][Math.ceil(d.getDate() / 7) - 1];
  opt.textContent = `Monthly on the ${ord} ${days[d.getDay()]}`;
}

function openAddForm(dateStr) {
  editMode = null;
  document.getElementById('ae-heading').textContent = 'Add Event';
  document.getElementById('ae-repeat-row').style.display = '';
  document.getElementById('ae-submit').style.display = '';
  document.getElementById('ae-save-one').style.display = 'none';
  document.getElementById('ae-save-all').style.display = 'none';
  document.getElementById('ae-title').value = '';
  document.getElementById('ae-date').value = dateStr || toDateInputValue(new Date());
  refreshDowOption();
  document.getElementById('ae-allday').checked = false;
  document.getElementById('ae-start').value = '';
  document.getElementById('ae-end').value = '';
  document.getElementById('ae-times').style.display = '';
  document.getElementById('ae-repeat-row').style.display = '';
  document.getElementById('ae-repeat').value = 'none';
  document.getElementById('ae-ends-on').value = '';
  document.getElementById('ae-custom-interval').value = '1';
  document.getElementById('ae-custom-unit').value = 'week';
  renderWeekdayChips([]);
  aeMoreDates = [];
  renderMoreDates();
  document.getElementById('ae-more-date').value = '';
  updateRepeatUI();
  document.getElementById('ae-repeat-hint').style.display = 'none';
  document.getElementById('ae-repeat-locked').style.display = 'none';
  document.getElementById('ae-location').value = '';
  document.getElementById('ae-share').value = 'auto';
  updateShareHint();
  document.getElementById('ae-submit').disabled = false;
  document.getElementById('ae-submit').textContent = 'Add Event';
  aePeople = (appConfig && appConfig.colors && appConfig.colors.Family) ? ['Family'] : [];
  populatePersonSelect();
  document.getElementById('add-overlay').classList.add('open');
  document.getElementById('add-modal').scrollTop = 0;
  setTimeout(() => document.getElementById('ae-title').focus(), 50);
}

function closeAddForm() {
  // Abort a save still in flight. Without this, "Cancel" only stopped the UI
  // from waiting — the fetch kept running, and on a slow-but-not-dead
  // connection the event still got created moments later with nobody told,
  // since nothing was still awaiting that response. Reproduced: hang the
  // request, click Cancel, let it resolve — the event existed anyway. This is
  // the one choke point closeAddForm() is called from (Cancel, clicking
  // outside the overlay, Escape), so aborting here covers all three.
  if (pendingSaveController) { pendingSaveController.abort(); pendingSaveController = null; }
  document.getElementById('add-overlay').classList.remove('open');
}

function openEditForm(ev) {
  // hasSeries (not the legacy `recurring` string) gates the one/all scope
  // choice — an imported RRULE series has recurring=null but is still a
  // series; checking `recurring` alone here would silently offer only the
  // whole-series edit/delete path for an imported recurring event.
  editMode = { uid: ev.uid, recurring: !!ev.hasSeries, instanceStart: ev.start };
  const allDay = ev.allDay === true || ev.allDay === 'true';

  document.getElementById('ae-heading').textContent = 'Edit Event';
  document.getElementById('ae-title').value = ev.title || '';
  document.getElementById('ae-allday').checked = allDay;
  document.getElementById('ae-times').style.display = allDay ? 'none' : '';
  if (allDay) {
    document.getElementById('ae-date').value = (ev.start || '').slice(0, 10);
    document.getElementById('ae-start').value = '';
    document.getElementById('ae-end').value = '';
  } else {
    const sp = tzParts(ev.start);
    document.getElementById('ae-date').value = sp.date;
    document.getElementById('ae-start').value = sp.time;
    // Start-only events (no original end) come back with end === start; leave End blank.
    document.getElementById('ae-end').value = (ev.end && ev.end !== ev.start) ? tzParts(ev.end).time : '';
  }
  document.getElementById('ae-location').value = ev.location || '';
  aePeople = Array.isArray(ev.people) ? [...ev.people] : [];
  populatePersonSelect();

  // Recurrence: an event carries EITHER a legacy `recurring` string OR an
  // imported/custom `rrule`. Populate whichever applies. A simple RRULE maps
  // back into the custom builder; an RRULE too complex for the builder is shown
  // read-only so a whole-series save can't silently rewrite (and corrupt) it.
  // For an existing series the pattern only takes effect via "All Events"; "This
  // Event" always detaches a single standalone occurrence server-side.
  const repeatSel = document.getElementById('ae-repeat');
  refreshDowOption();
  document.getElementById('ae-repeat-row').style.display = '';
  document.getElementById('ae-repeat-locked').style.display = 'none';
  document.getElementById('ae-custom-interval').value = '1';
  document.getElementById('ae-custom-unit').value = 'week';
  editMode.patternLocked = false;

  const dv = document.getElementById('ae-date').value;
  const anchorD = dv ? new Date(dv + 'T00:00:00') : null;
  const anchorDay = (anchorD && !isNaN(anchorD.getTime())) ? [RRULE_DAYS[anchorD.getDay()]] : [];

  if (ev.rrule) {
    const parsed = parseSimpleRrule(ev.rrule);
    if (parsed) {
      repeatSel.value = 'custom';
      document.getElementById('ae-custom-unit').value = parsed.unit;
      document.getElementById('ae-custom-interval').value = String(parsed.interval || 1);
      renderWeekdayChips(parsed.byday.length ? parsed.byday : (parsed.unit === 'week' ? anchorDay : []));
      // A UNTIL baked into an imported rule surfaces in the unified Ends-on field.
      document.getElementById('ae-ends-on').value = parsed.untilDate || (ev.endsOn ? String(ev.endsOn).slice(0, 10) : '');
      updateRepeatUI();
    } else {
      // Complex imported pattern — lock the editor and preserve it untouched on save.
      editMode.patternLocked = true;
      repeatSel.value = 'none';
      renderWeekdayChips(anchorDay);
      document.getElementById('ae-repeat-row').style.display = 'none';
      document.getElementById('ae-custom-row').style.display = 'none';
      document.getElementById('ae-ends-row').style.display = 'none';
      const note = document.getElementById('ae-repeat-locked');
      note.textContent = `Repeats ${summarizeRrule(ev.rrule)}. Editing this repeat pattern isn't supported yet — you can still change the title, time, person, or location, or delete this event.`;
      note.style.display = '';
    }
  } else {
    repeatSel.value = ev.recurring || 'none';
    renderWeekdayChips(anchorDay);
    document.getElementById('ae-ends-on').value = ev.endsOn ? String(ev.endsOn).slice(0, 10) : '';
    updateRepeatUI();
  }
  document.getElementById('ae-repeat-hint').style.display =
    (editMode.recurring && !editMode.patternLocked) ? '' : 'none';

  document.getElementById('ae-share').value =
    (ev.shareOverride === 'always' || ev.shareOverride === 'never') ? ev.shareOverride : 'auto';
  updateShareHint();

  const submit = document.getElementById('ae-submit');
  const one = document.getElementById('ae-save-one');
  const all = document.getElementById('ae-save-all');
  if (editMode.recurring) {
    submit.style.display = 'none';
    one.style.display = ''; one.disabled = false; one.textContent = 'This Event';
    all.style.display = ''; all.disabled = false; all.textContent = 'All Events';
  } else {
    submit.style.display = ''; submit.disabled = false; submit.textContent = 'Save';
    one.style.display = 'none';
    all.style.display = 'none';
  }

  document.getElementById('add-overlay').classList.add('open');
  document.getElementById('add-modal').scrollTop = 0;
  setTimeout(() => document.getElementById('ae-title').focus(), 50);
}

// Live hint under the Sharing select: for "Auto", say whether the current title
// matches a share word (so you can see it'll be shared before saving).
function updateShareHint() {
  const hint = document.getElementById('ae-share-hint');
  const val = document.getElementById('ae-share').value;
  const kws = (appConfig && appConfig.shareKeywords) || [];
  if (val === 'always') { hint.textContent = 'Shown on your view-only share links.'; return; }
  if (val === 'never')  { hint.textContent = 'Hidden from all share links, even if the title matches a share word.'; return; }
  if (!kws.length) { hint.textContent = 'No share words set yet — nothing is shared. Add words in Settings → Share.'; return; }
  const title = (document.getElementById('ae-title').value || '').toLowerCase();
  const hit = kws.find(k => title.includes(String(k).toLowerCase()));
  hint.textContent = hit
    ? `Will be shared (title matches "${hit}").`
    : `Won't be shared (title matches none of: ${kws.join(', ')}).`;
}

function aeData() {
  const shareVal = document.getElementById('ae-share').value;
  return {
    title: document.getElementById('ae-title').value.trim(),
    date: document.getElementById('ae-date').value,
    allDay: document.getElementById('ae-allday').checked,
    startTime: document.getElementById('ae-start').value,
    endTime: document.getElementById('ae-end').value,
    people: [...aePeople],
    location: document.getElementById('ae-location').value.trim() || null,
    shareOverride: shareVal === 'auto' ? null : shareVal
  };
}

// scope: undefined = create (add) or whole-event save; 'one' = this occurrence; 'all' = series.
async function doSave(scope) {
  const d = aeData();
  if (!d.title || !d.date) { alert('Title and date are required.'); return; }
  const submit = document.getElementById('ae-submit');
  const one = document.getElementById('ae-save-one');
  const all = document.getElementById('ae-save-all');
  const active = !editMode ? submit : (scope === 'one' ? one : scope === 'all' ? all : submit);
  const prevLabel = active.textContent;
  [submit, one, all].forEach(b => b.disabled = true);
  active.textContent = editMode ? 'Saving…' : 'Adding…';
  try {
    let res;
    // Repeat/ends-on apply to the whole series — omitted when detaching a single
    // occurrence (scope 'one'), where the server always forces a standalone,
    // non-recurring copy regardless of what's selected in the form.
    if (scope !== 'one') {
      if (editMode && editMode.patternLocked) {
        // Imported complex recurrence — send no recurrence fields at all so a
        // title/time/person edit can't rewrite (and corrupt) the pattern.
      } else {
        const repeatVal = document.getElementById('ae-repeat').value;
        const endsOn = document.getElementById('ae-ends-on').value;
        // recurring and rrule are mutually exclusive; always send both (one
        // null) so switching between a simple rule, a custom rule, and "none"
        // clears whichever field no longer applies.
        if (repeatVal === 'custom') {
          d.rrule = buildSimpleRrule();
          d.repeat = null;
          d.endsOn = endsOn || null;
        } else if (repeatVal === 'none') {
          d.repeat = null;
          d.rrule = null;
          d.endsOn = null;
        } else {
          d.repeat = repeatVal;
          d.rrule = null;
          d.endsOn = endsOn || null;
        }
      }
    }
    const controller = new AbortController();
    pendingSaveController = controller;
    if (!editMode) {
      // deviceId lets the server skip push-notifying the very device that
      // created this event (see server/notify.js notifyEventAdded).
      // "Also on" days go in one request, so they're added together or not at all.
      const extra = d.repeat == null && d.rrule == null ? aeMoreDates.filter(x => x !== d.date) : [];
      const body = extra.length ? { ...d, dates: [d.date, ...extra] } : d;
      res = await apiFetch('/api/events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, deviceId: kbDeviceId() }), signal: controller.signal
      });
    } else {
      const qs = scope === 'one' ? `?instanceStart=${encodeURIComponent(editMode.instanceStart)}` : '';
      res = await apiFetch(`/api/events/${encodeURIComponent(editMode.uid)}${qs}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d), signal: controller.signal
      });
    }
    pendingSaveController = null;
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `Server error ${res.status}`); }
    await loadEvents();
    render();
    closeAddForm();
  } catch (err) {
    // A deliberate Cancel already closed the form — an "Could not add event"
    // alert popping up right after would just be confusing noise about the
    // user's own action.
    if (err.name !== 'AbortError') {
      alert((editMode ? 'Could not save changes: ' : 'Could not add event: ') + err.message);
    }
  } finally {
    pendingSaveController = null;
    [submit, one, all].forEach(b => b.disabled = false);
    active.textContent = prevLabel;
  }
}

async function loadConfig() {
  const res = await fetch('/api/config', { credentials: 'same-origin' });
  if (res.status === 401 || res.status === 403) return false;
  appConfig = await res.json();
  authed = !!appConfig.authed;
  document.title = appConfig.name || 'Kinboard';
  // Not logged in (only reachable at all when the calendar is public) → hide
  // write controls and show the sign-in banner. The API enforces this
  // server-side too; this just keeps the UI honest.
  document.body.classList.toggle('read-only', !authed);
  // A locally-chosen theme (via the 🎨 button) overrides the household default.
  applyTheme(localStorage.getItem('theme') || appConfig.theme);
  return true;
}

const THEME_ORDER = ['light', 'dark', 'glitter', 'sports', 'beach', 'forest', 'mountains'];
const LIGHT_UI = new Set(['light', 'glitter', 'beach', 'mountains']);
let currentTheme = 'dark';

function applyTheme(name) {
  if (!THEME_ORDER.includes(name)) name = 'dark';
  currentTheme = name;
  document.body.dataset.theme = name;
  document.body.classList.toggle('light-ui', LIGHT_UI.has(name));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const bg = getComputedStyle(document.body).getPropertyValue('--bg').trim();
    if (bg) meta.setAttribute('content', bg);
  }
  // Managed decoration overlay (glitter + sports get extra visual FX)
  const FX_THEMES = new Set(['glitter','sports']);
  let fx = document.getElementById('theme-fx');
  if (FX_THEMES.has(name)) {
    if (!fx) {
      fx = document.createElement('div');
      fx.id = 'theme-fx';
      document.body.prepend(fx);
    }
    fx.className = name;
  } else if (fx) {
    fx.remove();
  }
  localStorage.setItem('theme', name);
}

async function loadEvents() {
  const res = await fetch('/api/events', { credentials: 'same-origin' });
  if (!res.ok) return;
  const data = await res.json();
  const CATEGORY_ICON = { birthday: '🎂', anniversary: '❤️', holiday: '🎉', family: '🏠' };
  events = (data.events || []).map(ev => ({
    ...ev,
    icon: ev.icon || (ev.category && CATEGORY_ICON[ev.category]) || '',
  }));
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0,0,0,0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

// Build a rolling grid: today's week is row 1 (viewOffset=0), or anchor to
// the 1st of the offset month when navigating.
function buildGridDates() {
  const firstDOW = (appConfig && appConfig.firstDayOfWeek) || 0;
  const isMobile = Math.min(window.innerWidth, window.innerHeight) <= 900;
  const configWeeks = isMobile ? 4 : ((appConfig && appConfig.weeksToShow) || 6);

  let anchor, weeks;
  if (todayView) {
    // "Today" view: rolling window of configWeeks starting from today's week.
    anchor = startOfDay(new Date());
    weeks = configWeeks;
  } else {
    // Navigated month: anchor to the 1st and show however many weeks the whole
    // month spans (4–6) so the end of the month is never cut off — the
    // weeks-to-show setting only governs the rolling "Today" view.
    const now = new Date();
    anchor = startOfDay(new Date(now.getFullYear(), now.getMonth() + viewOffset, 1));
    const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
    let lead = anchor.getDay() - firstDOW;
    if (lead < 0) lead += 7;
    weeks = Math.ceil((lead + daysInMonth) / 7);
  }

  const anchorDOW = anchor.getDay();
  let backOffset = anchorDOW - firstDOW;
  if (backOffset < 0) backOffset += 7;

  const gridStart = addDays(anchor, -backOffset);
  const dates = [];
  for (let i = 0; i < weeks * 7; i++) {
    dates.push(addDays(gridStart, i));
  }
  return dates;
}

function eventsForDay(date) {
  const dayStart = startOfDay(date);
  const dayEnd = addDays(dayStart, 1);

  return events.filter(ev => {
    if (activeFilter && !(ev.people || []).includes(activeFilter)) return false;
    // Every event producer (DB rows, iCal feeds, holidays) emits all-day
    // start/end as local-midnight strings with "T00:00:00" already included
    // (no trailing Z) — new Date() parses that as local time directly. Do NOT
    // append another "T00:00:00" here: a source that already includes it
    // (feeds/holidays) would double up into an unparseable string and the
    // event would silently vanish from every day (this happened before).
    const evStart = new Date(ev.start);
    const evEnd   = new Date(ev.end);
    // Event overlaps this day if it starts before dayEnd and ends after dayStart
    return evStart < dayEnd && evEnd > dayStart;
  }).sort((a, b) => {
    // All-day first, then chronological.
    //
    // This used to group by assignee before time — all of Maya's day, then
    // all of Leo's — on the theory that it kept one person's events
    // together. In a household with four or five people it just shuffled the
    // day: 6PM, 8AM, 4PM, 6:30PM, 8:40AM down a single Thursday, because the
    // times were only sorted *within* each person's block. A day cell's whole
    // job is to say what happens when, and the person is already on the badge.
    //
    // The agenda, the phone month view and the share page were all
    // chronological already; the grid was the one that wasn't.
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    const byTime = new Date(a.start) - new Date(b.start);
    if (byTime) return byTime;
    // Same minute: order by title so the run doesn't reshuffle between
    // renders. Array.prototype.sort is stable, but the input isn't — events
    // arrive from the DB, feeds and holiday generation in no fixed order.
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

function formatTime(dateStr) {
  // A zone-less timestamp is already wall-clock in the household's zone — show
  // its literal hour rather than converting it. See hasExplicitZone() above.
  const naive = /T(\d{2}):(\d{2})/.exec(String(dateStr));
  if (naive && !hasExplicitZone(dateStr)) {
    const hh = Number(naive[1]);
    const mm = naive[2];
    const ampm = hh < 12 ? 'AM' : 'PM';
    const h12 = hh % 12 || 12;
    return mm === '00' ? `${h12}${ampm}` : `${h12}:${mm}${ampm}`;
  }
  const d = new Date(dateStr);
  const tz = (appConfig && appConfig.timeZone) || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz
  }).formatToParts(d);
  const h = parts.find(p => p.type === 'hour').value;
  const m = parts.find(p => p.type === 'minute').value;
  const ampm = parts.find(p => p.type === 'dayPeriod').value.toUpperCase();
  return m === '00' ? `${h}${ampm}` : `${h}:${m}${ampm}`;
}

function formatTimeRange(startStr, endStr) {
  const start = formatTime(startStr);
  const end = formatTime(endStr);
  if (startStr === endStr || start === end) return start;
  return `${start}-${end}`;
}

const FILTER_SKIP = new Set(['default']);

function buildFilterBar() {
  const bar = document.getElementById('filter-bar');
  bar.innerHTML = '';
  if (!appConfig || !appConfig.colors) return;
  Object.entries(appConfig.colors).forEach(([person, color]) => {
    if (FILTER_SKIP.has(person)) return;
    const chip = document.createElement('button');
    chip.className = 'filter-chip';
    chip.dataset.person = person;
    chip.textContent = withEmoji(person);
    chip.style.setProperty('--chip-color', color);
    chip.addEventListener('click', () => {
      activeFilter = activeFilter === person ? null : person;
      document.querySelectorAll('.filter-chip').forEach(c =>
        c.classList.toggle('active', c.dataset.person === activeFilter)
      );
      render();
    });
    bar.appendChild(chip);
  });
}

function render() {
  // Set first: the CSS that decides which container has a box (and therefore
  // what agendaScrollEl() measures) keys off this attribute, so a render that
  // reads layout must not run against the previous view's rules.
  document.body.dataset.view = viewMode;
  if (viewMode === 'month') renderMonthMobile();
  else if (viewMode === 'agenda') renderAgenda();
  else renderGrid();
}

function updateViewBtn() {
  const b = document.getElementById('view-btn');
  // The glyph names where the button goes, not where you are.
  const toMonth = viewMode === 'agenda';
  b.textContent = toMonth ? '\u229e' : '\u2630';
  const label = toMonth
    ? (mobileMQ.matches ? 'Month view' : 'Grid view')
    : 'Agenda view';
  b.title = label;
  b.setAttribute('aria-label', label);
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderGrid() {
  document.getElementById('agenda-container').style.display = 'none';
  const grid = document.getElementById('grid');
  grid.style.display = '';
  document.getElementById('prev-month').style.visibility = '';
  document.getElementById('next-month').style.visibility = '';
  document.getElementById('today-btn').style.display = todayView ? 'none' : 'block';

  const today = startOfDay(new Date());
  const dates = buildGridDates();
  grid.innerHTML = '';

  // Month label: today's month when at viewOffset=0, otherwise the navigated month
  const labelDate = todayView
    ? today
    : new Date(today.getFullYear(), today.getMonth() + viewOffset, 1);
  const labelOpts = labelDate.getFullYear() === today.getFullYear()
    ? { month: 'long' }
    : { month: 'long', year: 'numeric' };
  document.getElementById('month-label').textContent =
    labelDate.toLocaleString('en-US', labelOpts);

  // "other-month" dimming relative to the displayed month
  const displayMonth = labelDate.getMonth();
  const displayYear = labelDate.getFullYear();

  // Day-of-week header row
  const firstDOW = (appConfig && appConfig.firstDayOfWeek) || 0;
  for (let i = 0; i < 7; i++) {
    const dow = (firstDOW + i) % 7;
    const el = document.createElement('div');
    el.className = 'day-header';
    el.textContent = DAY_NAMES[dow];
    grid.appendChild(el);
  }

  // Day cells
  for (const date of dates) {
    const dateKey = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;

    const cell = document.createElement('div');
    cell.className = 'day-cell';
    cell.dataset.date = dateKey;
    if (sameDay(date, today)) cell.classList.add('today');
    if (date.getMonth() !== displayMonth || date.getFullYear() !== displayYear) cell.classList.add('other-month');

    const num = document.createElement('div');
    num.className = 'day-number';

    const wxSpan = document.createElement('span');
    wxSpan.className = 'day-weather';
    const dw = dailyWeather[dateKey];
    if (dw) wxSpan.textContent = `${weatherEmoji(dw.code)} ${dw.high}°`;
    num.appendChild(wxSpan);

    const numSpan = document.createElement('span');
    if (date.getDate() === 1) {
      numSpan.textContent = date.toLocaleString('en-US', { month: 'short' }) + ' 1';
    } else {
      numSpan.textContent = String(date.getDate());
    }
    num.appendChild(numSpan);

    cell.appendChild(num);

    const evContainer = document.createElement('div');
    evContainer.className = 'events';

    const dayEvents = eventsForDay(date);
    for (const ev of dayEvents) {
      const evEl = document.createElement('div');
      evEl.className = 'event' + (ev.allDay ? ' allday' : '');
      evEl.dataset.uid = ev.uid || '';
      evEl.dataset.feedId = ev.feedId || '';
      evEl.dataset.start = ev.start || '';
      evEl.title = ev.title;

      const badgeRow = document.createElement('div');
      renderPersonBadgeRow(badgeRow, ev.people, 18, 3);
      evEl.appendChild(badgeRow);

      const textSpan = document.createElement('span');
      textSpan.className = 'event-text';
      if (ev.allDay) {
        textSpan.textContent = ev.icon ? `${ev.icon} ${ev.title}` : ev.title;
      } else if (ev.compact) {
        const timeSpan = document.createElement('span');
        timeSpan.className = 'time';
        timeSpan.textContent = formatTime(ev.start);
        textSpan.appendChild(timeSpan);
        if (ev.icon) textSpan.appendChild(document.createTextNode(' ' + ev.icon));
      } else {
        const timeSpan = document.createElement('span');
        timeSpan.className = 'time';
        // Start time only in the grid — it's the "be there by" signal. The full
        // range shows in the detail popup on click.
        timeSpan.textContent = formatTime(ev.start);
        textSpan.appendChild(timeSpan);
        if (ev.icon) {
          textSpan.appendChild(document.createTextNode(' ' + ev.icon));
        } else {
          textSpan.appendChild(document.createTextNode(ev.title));
        }
      }
      evEl.appendChild(textSpan);
      evContainer.appendChild(evEl);
    }

    cell.appendChild(evContainer);
    grid.appendChild(cell);
  }

  // Row count follows whatever buildGridDates() produced (rolling window for the
  // Today view, full-month span when navigating) so the two never disagree.
  const weeks = dates.length / 7;
  grid.style.gridTemplateRows = `auto repeat(${weeks}, minmax(min-content, 1fr))`;
}

// The box that actually scrolls in agenda view is layout-dependent, not
// always #agenda-container: below 700px, #content-scroll is the one real
// scroller (see its mobile media-query rule — #agenda-container's own
// overflow:auto is inert there because its parent is display:block, not
// flex). Above 700px (only reachable by manually toggling the view — the
// toggle button itself is hidden on mobile), #content-scroll is
// display:contents and generates no box at all, so it reports 0/0 and
// #agenda-container is the real one. Detecting this by measured overflow
// rather than by viewport width tracks the CSS exactly instead of
// duplicating its breakpoint in JS.
function agendaScrollEl() {
  const cs = document.getElementById('content-scroll');
  return cs.scrollHeight > cs.clientHeight ? cs : document.getElementById('agenda-container');
}

// ── Mobile month view ───────────────────────────────────────────────────────
// See the .mm-* CSS block for why this is a separate render path rather than a
// restyled #grid. The short version: a 55px column can hold a number and a few
// dots, and nothing else, so the layout has to be designed around that instead
// of inheriting one designed around 200px columns.

// A whole calendar month, padded out to full weeks. Deliberately NOT
// buildGridDates(): that one has a rolling "today's week first" mode and a
// weeks-to-show setting, both of which exist to fill a wide screen. A phone
// month is just the month.
function buildMonthDates(anchor) {
  const firstDOW = (appConfig && appConfig.firstDayOfWeek) || 0;
  const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
  let lead = anchor.getDay() - firstDOW;
  if (lead < 0) lead += 7;
  const weeks = Math.ceil((lead + daysInMonth) / 7);
  const start = addDays(anchor, -lead);
  const dates = [];
  for (let i = 0; i < weeks * 7; i++) dates.push(addDays(start, i));
  return dates;
}

// One dot per event, colored by its first assignee. Unassigned events (feeds
// without a person, holidays) get a neutral tone rather than being dropped —
// "something is on this day" is the whole job of the dot.
function eventDotColor(ev) {
  const colors = (appConfig && appConfig.colors) || {};
  const who = (ev.people || [])[0];
  // The neutral has to be a theme token, not a fixed value: a pale grey dot is
  // invisible on the light themes and a dark one is invisible on the dark ones.
  return (who && colors[who]) || 'var(--muted)';
}

function renderMonthMobile() {
  document.getElementById('grid').style.display = 'none';
  document.getElementById('agenda-container').style.display = 'none';
  const host = document.getElementById('month-mobile');
  host.innerHTML = '';

  const today = startOfDay(new Date());
  const anchor = startOfDay(new Date(today.getFullYear(), today.getMonth() + mmOffset, 1));

  document.getElementById('prev-month').style.visibility = '';
  document.getElementById('next-month').style.visibility = '';
  document.getElementById('today-btn').style.display = mmOffset === 0 ? 'none' : 'block';
  document.getElementById('month-label').textContent = anchor.toLocaleString(
    'en-US',
    anchor.getFullYear() === today.getFullYear() ? { month: 'long' } : { month: 'long', year: 'numeric' }
  );

  const dates = buildMonthDates(anchor);

  // The list underneath must always describe a day that's visible above it.
  // Navigating away from the selected day's month re-points the selection to
  // today (when today is on screen) or the 1st.
  if (!mmSelectedKey || !dates.some((d) => ymd(d) === mmSelectedKey)) {
    const sameMonth = anchor.getMonth() === today.getMonth() && anchor.getFullYear() === today.getFullYear();
    mmSelectedKey = ymd(sameMonth ? today : anchor);
  }

  const firstDOW = (appConfig && appConfig.firstDayOfWeek) || 0;
  const head = document.createElement('div');
  head.className = 'mm-weekdays';
  for (let i = 0; i < 7; i++) {
    const el = document.createElement('div');
    el.textContent = DAY_NAMES[(firstDOW + i) % 7].slice(0, 3);
    head.appendChild(el);
  }
  host.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'mm-grid';
  const dispMonth = anchor.getMonth();
  const dispYear = anchor.getFullYear();

  // Four marks is what fits across a phone's column without turning into a
  // smear. Past that a count reads "busy" better than more dots would, so the
  // last slot becomes "+N" instead of a fourth dot.
  const MAX_MARKS = 4;

  for (const date of dates) {
    const key = ymd(date);
    const cell = document.createElement('div');
    cell.className = 'mm-day';
    cell.dataset.date = key;
    if (sameDay(date, today)) cell.classList.add('today');
    if (key === mmSelectedKey) cell.classList.add('selected');
    if (date.getMonth() !== dispMonth || date.getFullYear() !== dispYear) cell.classList.add('other-month');

    const num = document.createElement('div');
    num.className = 'mm-num';
    num.textContent = String(date.getDate());
    cell.appendChild(num);

    const dayEvents = eventsForDay(date);
    const dots = document.createElement('div');
    dots.className = 'mm-dots';
    const overflow = dayEvents.length > MAX_MARKS;
    const dotCount = overflow ? MAX_MARKS - 1 : dayEvents.length;
    for (let i = 0; i < dotCount; i++) {
      const dot = document.createElement('span');
      dot.className = 'mm-dot';
      dot.style.background = eventDotColor(dayEvents[i]);
      dots.appendChild(dot);
    }
    if (overflow) {
      const more = document.createElement('span');
      more.className = 'mm-more';
      more.textContent = '+' + (dayEvents.length - dotCount);
      dots.appendChild(more);
    }
    cell.appendChild(dots);

    cell.setAttribute('role', 'button');
    cell.setAttribute('aria-label',
      date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) +
      (dayEvents.length ? `, ${dayEvents.length} event${dayEvents.length === 1 ? '' : 's'}` : ', no events'));
    grid.appendChild(cell);
  }
  host.appendChild(grid);
  host.appendChild(buildMonthDayList(new Date(mmSelectedKey + 'T00:00:00'), today));
}

// The expanded day under the grid. Reuses the agenda's row markup on purpose —
// the two views should be indistinguishable below the fold, and it means one
// set of row styles to keep working rather than two that drift apart.
function buildMonthDayList(date, today) {
  const wrap = document.createElement('div');
  wrap.className = 'mm-daylist';

  const header = document.createElement('div');
  header.className = 'mm-daylist-header';
  const label = document.createElement('span');
  const isToday = sameDay(date, today);
  label.textContent = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  if (isToday) label.className = 'mm-dl-today';
  header.appendChild(label);
  // The grid cells have no room for weather, so it lands here instead of
  // being dropped from the mobile view entirely.
  const wx = dailyWeather[ymd(date)];
  if (wx) {
    const w = document.createElement('span');
    w.className = 'mm-dl-wx';
    w.textContent = `${weatherEmoji(wx.code)} ${wx.high}°`;
    header.appendChild(w);
  }
  wrap.appendChild(header);

  const dayEvents = eventsForDay(date).slice().sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return new Date(a.start) - new Date(b.start);
  });

  if (!dayEvents.length) {
    const empty = document.createElement('div');
    empty.className = 'mm-empty';
    empty.textContent = authed ? 'Nothing scheduled — tap + to add something.' : 'Nothing scheduled.';
    wrap.appendChild(empty);
    return wrap;
  }

  for (const ev of dayEvents) {
    const row = document.createElement('div');
    row.className = 'agenda-event-row';
    row.style.cursor = 'pointer';

    const dot = document.createElement('div');
    dot.className = 'agenda-dot';
    renderPersonBadgeRow(dot, ev.people, 24);

    const timeDiv = document.createElement('div');
    timeDiv.className = 'agenda-time';
    timeDiv.textContent = ev.allDay ? 'All day' : formatTime(ev.start);

    const titleDiv = document.createElement('div');
    titleDiv.className = 'agenda-title';
    titleDiv.textContent = ev.icon ? `${ev.icon} ${ev.title}` : ev.title;

    row.appendChild(dot);
    row.appendChild(timeDiv);
    row.appendChild(titleDiv);

    if (ev.people && ev.people.length) {
      const personDiv = document.createElement('div');
      personDiv.className = 'agenda-person';
      personDiv.textContent = ev.people.map(withEmoji).join(', ');
      row.appendChild(personDiv);
    }

    row.addEventListener('click', () => showEventDetail(ev));
    wrap.appendChild(row);
  }
  return wrap;
}

function renderAgenda() {
  const grid = document.getElementById('grid');
  const container = document.getElementById('agenda-container');
  grid.style.display = 'none';
  container.style.display = 'block';
  // A full rebuild is simplest and matches how this already worked, but it
  // resets scrollTop to 0 — jarring mid-scroll, and would defeat "load more"
  // entirely (every extra page would bounce back to the top). Restore it.
  const scrollEl = agendaScrollEl();
  const prevScrollTop = scrollEl.scrollTop;
  container.innerHTML = '';

  document.getElementById('prev-month').style.visibility = 'hidden';
  document.getElementById('next-month').style.visibility = 'hidden';
  document.getElementById('today-btn').style.display = 'none';
  document.getElementById('month-label').textContent = 'Upcoming';

  const today = startOfDay(new Date());
  let hasAnyEvents = false;

  for (let i = 0; i < agendaDaysShown; i++) {
    const date = addDays(today, i);
    // eventsForDay sorts by person-then-time (grouped) for the grid cells;
    // agenda reads as a chronological timeline, so re-sort to pure time order
    // (all-day still floats to the top of the day).
    const dayEvents = eventsForDay(date).slice().sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return new Date(a.start) - new Date(b.start);
    });
    if (!dayEvents.length) continue;

    hasAnyEvents = true;
    const section = document.createElement('div');
    section.className = 'agenda-day-section';

    const header = document.createElement('div');
    const isToday = sameDay(date, today);
    header.className = 'agenda-date-header' + (isToday ? ' today-header' : '');
    const label = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    header.textContent = isToday ? `Today  ·  ${label}` : label;
    section.appendChild(header);

    for (const ev of dayEvents) {
      const row = document.createElement('div');
      row.className = 'agenda-event-row';
      row.style.cursor = 'pointer';

      const dot = document.createElement('div');
      dot.className = 'agenda-dot';
      renderPersonBadgeRow(dot, ev.people, 24);

      const timeDiv = document.createElement('div');
      timeDiv.className = 'agenda-time';
      timeDiv.textContent = ev.allDay ? 'All day' : formatTime(ev.start);

      const titleDiv = document.createElement('div');
      titleDiv.className = 'agenda-title';
      titleDiv.textContent = ev.icon ? `${ev.icon} ${ev.title}` : ev.title;

      row.appendChild(dot);
      row.appendChild(timeDiv);
      row.appendChild(titleDiv);

      if (ev.people && ev.people.length) {
        const personDiv = document.createElement('div');
        personDiv.className = 'agenda-person';
        personDiv.textContent = ev.people.map(withEmoji).join(', ');
        row.appendChild(personDiv);
      }

      row.addEventListener('click', () => showEventDetail(ev));
      section.appendChild(row);
    }

    container.appendChild(section);
  }

  if (!hasAnyEvents) {
    const empty = document.createElement('div');
    empty.className = 'agenda-empty';
    empty.textContent = `No upcoming events in the next ${agendaDaysShown} days.`;
    container.appendChild(empty);
  } else if (agendaDaysShown >= AGENDA_MAX_DAYS) {
    // Matches the server's own fetch window — there is genuinely nothing
    // further to load, not just an arbitrary place this stopped rendering.
    const end = document.createElement('div');
    end.className = 'agenda-empty';
    end.textContent = "That's everything within a year — nothing further out yet.";
    container.appendChild(end);
  }

  scrollEl.scrollTop = prevScrollTop;
}

function weatherEmoji(code) {
  if (code === 0) return '☀️';
  if (code <= 3) return '⛅️';
  if (code <= 48) return '🌫️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '🌨️';
  if (code <= 86) return '🌦️';
  return '⛈️';
}

async function fetchWeather() {
  if (!appConfig || !appConfig.weather) return;
  const { latitude, longitude, units } = appConfig.weather;
  const tempUnit = (units === 'fahrenheit' || units === 'imperial') ? 'fahrenheit' : 'celsius';
  const tz = encodeURIComponent((appConfig && appConfig.timeZone) || 'America/New_York');
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&current=temperature_2m,weather_code&daily=temperature_2m_max,weather_code` +
      `&temperature_unit=${tempUnit}&timezone=${tz}&forecast_days=14`
    );
    const data = await res.json();
    if (data.current) {
      weatherData = { temp: Math.round(data.current.temperature_2m), code: data.current.weather_code };
    }
    if (data.daily && data.daily.time) {
      dailyWeather = {};
      data.daily.time.forEach((dateStr, i) => {
        dailyWeather[dateStr] = {
          high: Math.round(data.daily.temperature_2m_max[i]),
          code: data.daily.weather_code[i]
        };
      });
    }
    updateClock();
    render();
  } catch (_) {}
}

function updateClock() {
  const now = new Date();
  const opts = { weekday: 'long', hour: 'numeric', minute: '2-digit' };
  let text = now.toLocaleString('en-US', opts);
  if (weatherData) text += `  ·  ${weatherEmoji(weatherData.code)} ${weatherData.temp}°`;
  document.getElementById('clock').textContent = text;
}

// ==== TAB SWITCHING ====
let currentTab = 'calendar';

function showTab(name) {
  currentTab = name;
  document.body.dataset.tab = name;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  if (name === 'meals') {
    mealsWeekStart = startOfDay(new Date()); // always open on today, not wherever it was left
    if (!mealsLoaded) { mealsLoaded = true; loadMeals().then(renderMealsList); }
    else renderMealsList();
  }
  if (name === 'todos') {
    populateTodoPersonSelect();
    buildWhoseSelect();
    syncKindButtons();
    // Earnings are refetched on every visit, not just the first: another device
    // may have completed chores or settled up since this tab was last opened.
    loadChoreEarnings().then(renderChoreEarnings);
    if (!todosLoaded) { todosLoaded = true; loadTodos().then(renderTodos); }
    else renderTodos();
  }
}

// ==== MEAL PLANNER ====
const MEAL_SLOTS = [
  { key: 'breakfast', label: 'Breakfast', icon: '🌅' },
  { key: 'lunch',     label: 'Lunch',     icon: '☀️' },
  { key: 'dinner',    label: 'Dinner',    icon: '🌙' },
  { key: 'snack',     label: 'Snack',     icon: '🍎' },
];
// Categories that are event/feed tags, not real people — never valid meal/todo assignees.
const NON_PERSON_NAMES = new Set(['default', 'Birthday', 'Anniversary', 'Holiday']);

let meals = [];
let mealsLoaded = false;
let editingMealId = null;
let mlPeople = []; // people currently selected in the meal form's chip row

// Rolling 7-day window anchored on today by default (not the calendar week
// start) — showTab() resets this to today every time the Meals tab opens;
// prev/next shift it by a week from wherever the user navigated to.
let mealsWeekStart = null;

async function loadMeals() {
  const res = await apiFetch('/api/meals');
  if (!res.ok) return;
  const data = await res.json();
  meals = data.meals || [];
}

function populateMealPersonSelect() {
  renderPersonChips('ml-person-chips', mlPeople, NON_PERSON_NAMES);
}

function renderMealsList() {
  if (!mealsWeekStart) mealsWeekStart = startOfDay(new Date());
  const list = document.getElementById('meals-list');
  list.innerHTML = '';

  const weekEnd = addDays(mealsWeekStart, 6);
  document.getElementById('meals-week-label').textContent =
    `${mealsWeekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ` +
    `${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  for (let i = 0; i < 7; i++) {
    const d = addDays(mealsWeekStart, i);
    const dateStr = toDateInputValue(d);
    const isToday = sameDay(d, new Date());

    const section = document.createElement('div');
    section.className = 'meal-day-section';

    const header = document.createElement('div');
    header.className = 'meal-day-header' + (isToday ? ' today-header' : '');
    header.textContent = isToday
      ? `Today  ·  ${d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}`
      : d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    section.appendChild(header);

    for (const slot of MEAL_SLOTS) {
      const slotEl = document.createElement('div');
      slotEl.className = 'meal-slot';

      const slotHeader = document.createElement('div');
      slotHeader.className = 'meal-slot-header';
      const label = document.createElement('div');
      label.className = 'meal-slot-label';
      label.textContent = `${slot.icon} ${slot.label}`;
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'meal-slot-add';
      addBtn.textContent = '+ Add';
      addBtn.addEventListener('click', () => openMealForm(dateStr, slot.key));
      slotHeader.appendChild(label);
      slotHeader.appendChild(addBtn);
      slotEl.appendChild(slotHeader);

      for (const m of meals.filter(x => x.date === dateStr && x.meal_type === slot.key)) {
        const row = document.createElement('div');
        row.className = 'meal-item-row';
        const dot = document.createElement('div');
        dot.className = 'meal-item-dot';
        renderPersonBadgeRow(dot, m.people, 24);
        const title = document.createElement('div');
        title.className = 'meal-item-title';
        title.textContent = m.title;
        row.appendChild(dot);
        row.appendChild(title);
        if (m.people && m.people.length) {
          const person = document.createElement('div');
          person.className = 'meal-item-person';
          person.textContent = m.people.map(withEmoji).join(', ');
          row.appendChild(person);
        }
        row.addEventListener('click', () => openMealForm(dateStr, slot.key, m));
        slotEl.appendChild(row);
      }

      section.appendChild(slotEl);
    }

    list.appendChild(section);
  }
}

function openMealForm(dateStr, mealType, meal) {
  editingMealId = meal ? meal.id : null;
  document.getElementById('meal-heading').textContent = meal ? 'Edit Meal' : 'Add Meal';
  document.getElementById('ml-title').value = meal ? meal.title : '';
  document.getElementById('ml-type').value = mealType;
  document.getElementById('ml-date').value = dateStr;
  mlPeople = (meal && Array.isArray(meal.people)) ? [...meal.people] : [];
  populateMealPersonSelect();
  document.getElementById('ml-delete').style.display = meal ? '' : 'none';
  document.getElementById('ml-submit').textContent = meal ? 'Save' : 'Add Meal';
  document.getElementById('meal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('ml-title').focus(), 50);
}

function closeMealForm() {
  document.getElementById('meal-overlay').classList.remove('open');
  editingMealId = null;
}

async function saveMeal() {
  const body = {
    title: document.getElementById('ml-title').value.trim(),
    mealType: document.getElementById('ml-type').value,
    date: document.getElementById('ml-date').value,
    people: [...mlPeople],
  };
  if (!body.title || !body.date) return;

  const submitBtn = document.getElementById('ml-submit');
  submitBtn.disabled = true;
  try {
    const res = editingMealId
      ? await apiFetch(`/api/meals/${editingMealId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      : await apiFetch('/api/meals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { const err = await res.json().catch(() => ({})); alert(err.error || 'Could not save meal'); return; }
    await loadMeals();
    renderMealsList();
    closeMealForm();
  } finally {
    submitBtn.disabled = false;
  }
}

async function deleteMeal() {
  if (!editingMealId) return;
  if (!confirm('Delete this meal?')) return;
  const res = await apiFetch(`/api/meals/${editingMealId}`, { method: 'DELETE' });
  if (!res.ok) { alert('Could not delete meal'); return; }
  await loadMeals();
  renderMealsList();
  closeMealForm();
}

// ==== TO-DO ====
let todos = [];
let todosLoaded = false;
let todoAddPeople = []; // people currently selected in the to-do add-row's chip row
let editingTodoId = null;
let tdPeople = []; // people currently selected in the todo edit form's chip row

function populateTodoPersonSelect() {
  renderPersonChips('todo-add-person-chips', todoAddPeople, NON_PERSON_NAMES);
}

// ── "Who am I?" ─────────────────────────────────────────────────────────────
// Everyone shares one household password, so the server has no idea which
// family member is looking at the screen. Identity is therefore a property of
// the DEVICE, remembered locally — the kitchen tablet stays on "Everyone" while
// a kid's phone can pin itself to just their chores.
const ME_KEY = 'kb_me';
function whoAmI() {
  try { return localStorage.getItem(ME_KEY) || ''; } catch (_) { return ''; }
}
function setWhoAmI(name) {
  try { name ? localStorage.setItem(ME_KEY, name) : localStorage.removeItem(ME_KEY); } catch (_) {}
}

// Chores and to-dos live in ONE list, split by a filter rather than by separate
// tabs. The boundary between them is genuinely fuzzy ("clean your room this
// Saturday" is either, depending on the family), and a tab would force everyone
// to answer that question at the moment they add an item. A filter never asks.
// Also per-device, so a kid's phone can sit on Chores while the kitchen tablet
// shows everything.
const KIND_KEY = 'kb_todo_kind';
function todoKind() {
  try { return localStorage.getItem(KIND_KEY) || 'all'; } catch (_) { return 'all'; }
}
function setTodoKind(kind) {
  try { kind === 'all' ? localStorage.removeItem(KIND_KEY) : localStorage.setItem(KIND_KEY, kind); } catch (_) {}
}

// What makes something a chore: it repeats, or it's worth something. Both are
// already recorded on the item, so nothing new has to be classified by hand.
function isChore(t) {
  return !!t.recurring || (t.points || 0) > 0;
}

let choreEarnings = null;

async function loadTodos() {
  const res = await apiFetch('/api/todos');
  if (!res.ok) return;
  const data = await res.json();
  todos = data.todos || [];
}

async function loadChoreEarnings() {
  try {
    const res = await apiFetch('/api/chores/earnings');
    choreEarnings = res.ok ? await res.json() : null;
  } catch (_) { choreEarnings = null; }
}

// The currency symbol is user-set and this string lands in innerHTML on the
// earnings chips. It's capped at 4 characters server-side so it can't carry a
// working payload, but escaping costs nothing and removes the question entirely.
function money(cents) {
  const sym = escapeHtml((choreEarnings && choreEarnings.currencySymbol) || '$');
  return `${sym}${(cents / 100).toFixed(2)}`;
}

// Populate the whose-chores selector from the member list, preserving the
// device's saved choice even if the roster reloads.
function buildWhoseSelect() {
  const sel = document.getElementById('todo-whose');
  if (!sel) return;
  const me = whoAmI();
  sel.innerHTML = '<option value="">Everyone</option>';
  const names = Object.keys((appConfig && appConfig.colors) || {})
    .filter(n => !NON_PERSON_NAMES.has(n));
  for (const n of names) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = withEmoji(n);
    sel.appendChild(o);
  }
  // A saved name that no longer exists (person renamed/removed) falls back to
  // Everyone rather than silently filtering everything out.
  sel.value = names.includes(me) ? me : '';
  if (sel.value !== me) setWhoAmI(sel.value);
}

// Reflect the saved segment on load, so a device that was left on "Chores"
// comes back to it rather than silently resetting to All.
function syncKindButtons() {
  const kind = todoKind();
  document.querySelectorAll('#todo-kind .kind-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.kind === kind);
    b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
  });
}

function renderChoreEarnings() {
  const wrap = document.getElementById('chore-earnings');
  if (!wrap) return;
  wrap.innerHTML = '';
  // Balances are meaningless next to a list that deliberately excludes every
  // earning item, so the To-dos view drops them entirely.
  if (todoKind() === 'todos') return;
  if (!choreEarnings || !choreEarnings.people || !choreEarnings.people.length) return;

  const me = whoAmI();
  // No rate set means nothing has a cash value yet, so there is no balance worth
  // showing a kid. The parent sets a value in Settings to switch this on.
  if ((choreEarnings.pointValueCents || 0) <= 0) return;

  // When a device has picked a person, show only their chip — a kid checking
  // their own balance doesn't need a leaderboard of their siblings.
  const people = me ? choreEarnings.people.filter(p => p.person === me) : choreEarnings.people;

  for (const p of people) {
    if (!p.pointsOutstanding && !p.points) continue;
    const chip = document.createElement('div');
    chip.className = 'earn-chip';
    chip.innerHTML =
      `<span class="earn-name">${escapeHtml(withEmoji(p.person))}</span>` +
      `<span class="earn-val">${money(p.owedCents)}</span>`;
    if (p.pointsOutstanding > 0) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'paid';
      btn.title = `Settle up with ${p.person} (${p.pointsOutstanding} points)`;
      btn.addEventListener('click', async () => {
        const label = money(p.owedCents);
        if (!confirm(`Mark ${label} as paid to ${p.person}?\n\nTheir history is kept — this only clears what's owed.`)) return;
        await apiFetch('/api/chores/payout', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ person: p.person }),
        });
        await loadChoreEarnings();
        renderChoreEarnings();
      });
      chip.appendChild(btn);
    }
    wrap.appendChild(chip);
  }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : s;
  return d.innerHTML;
}

function renderTodos() {
  const list = document.getElementById('todos-list');
  list.innerHTML = '';

  const me = whoAmI();
  const kind = todoKind();

  // Unassigned items stay visible to everyone — "empty the dishwasher" with
  // nobody's name on it is still the household's job, and hiding it would let
  // shared work quietly disappear from every filtered view.
  let visible = me
    ? todos.filter(t => !t.people || !t.people.length || t.people.includes(me))
    : todos;
  if (kind === 'chores') visible = visible.filter(isChore);
  else if (kind === 'todos') visible = visible.filter(t => !isChore(t));

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.id = 'todos-empty';
    const who = me ? ` for ${me}` : '';
    empty.textContent =
      kind === 'chores' ? `No chores${who} right now.` :
      kind === 'todos'  ? `No to-dos${who} right now.` :
      me ? `Nothing for ${me} right now.` : 'No to-dos yet — add one above.';
    list.appendChild(empty);
    return;
  }
  for (const t of visible) {
    const row = document.createElement('div');
    row.className = 'todo-row' + (t.done ? ' done' : '');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = t.done;
    checkbox.addEventListener('change', () => toggleTodo(t.id, checkbox.checked, t.due_date));
    row.appendChild(checkbox);

    if (t.people && t.people.length) {
      const dot = document.createElement('div');
      dot.className = 'todo-person-dot';
      renderPersonBadgeRow(dot, t.people, 24);
      row.appendChild(dot);
    }

    // Title sits directly after the badges, and the name list goes to its
    // right — same order the agenda and meal rows use.
    const title = document.createElement('div');
    title.className = 'todo-title';
    title.textContent = t.recurring ? `🔁 ${t.title}` : t.title;
    title.title = t.recurring ? `Repeats ${t.recurring}` : '';
    title.addEventListener('click', () => openTodoEditForm(t));
    row.appendChild(title);

    if (t.people && t.people.length) {
      const name = document.createElement('div');
      name.className = 'todo-person-name';
      name.textContent = t.people.map(withEmoji).join(', ');
      name.title = t.people.join(', ');   // full list on hover when truncated
      row.appendChild(name);
    }

    // Kids see money, never points. Points are the parent's dial for setting
    // relative worth; "$0.75" is the thing that actually motivates a nine year
    // old. With no rate set there is no money yet, so the badge stays off
    // entirely rather than showing a meaningless $0.00.
    const rateCents = (appConfig && appConfig.pointValueCents) || 0;
    if (t.points > 0 && rateCents > 0) {
      const val = document.createElement('div');
      val.className = 'todo-points';
      const sym = (appConfig && appConfig.currencySymbol) || '$';
      val.textContent = `${sym}${((t.points * rateCents) / 100).toFixed(2)}`;
      // The underlying points stay discoverable to a parent on hover.
      val.title = `${t.points} point${t.points === 1 ? '' : 's'}`;
      row.appendChild(val);
    }

    if (t.due_date) {
      const due = document.createElement('div');
      due.className = 'todo-due';
      due.textContent = new Date(t.due_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      row.appendChild(due);
    }

    // Only a repeating chore has a "next occurrence" to skip to — a one-off
    // to-do that gets missed is just late, not skippable.
    if (t.recurring) {
      const skip = document.createElement('button');
      skip.type = 'button';
      skip.className = 'todo-skip';
      skip.setAttribute('aria-label', 'Skip to next occurrence');
      skip.title = 'Missed it — skip to the next occurrence, no credit';
      skip.textContent = 'Skip';
      skip.addEventListener('click', (e) => { e.stopPropagation(); skipTodo(t.id); });
      row.appendChild(skip);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'todo-delete';
    del.setAttribute('aria-label', 'Delete to-do');
    del.textContent = '×';
    del.addEventListener('click', () => deleteTodo(t.id));
    row.appendChild(del);

    list.appendChild(row);
  }
}

async function toggleTodo(id, done, occurrenceDate) {
  // Send the due date this row was showing. The server uses it to tell a
  // deliberate catch-up click (new date, allowed) from a double-tap or a
  // retry (stale date, refused) — without that, checking off a chore that's
  // several weeks overdue only ever credits one of the missed weeks.
  await apiFetch(`/api/todos/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(occurrenceDate ? { done, occurrenceDate } : { done }),
  });
  await loadTodos();
  renderTodos();
  // Checking a chore off is what mints points, so the balance has to move in
  // the same beat — that immediate feedback is the whole motivation loop.
  if (done) { await loadChoreEarnings(); renderChoreEarnings(); }
}

async function skipTodo(id) {
  const res = await apiFetch(`/api/todos/${id}/skip`, { method: 'POST' });
  if (!res.ok) { const err = await res.json().catch(() => ({})); alert(err.error || 'Could not skip this chore'); return; }
  await loadTodos();
  renderTodos();
}

async function deleteTodo(id) {
  if (!confirm('Delete this to-do?')) return;
  const res = await apiFetch(`/api/todos/${id}`, { method: 'DELETE' });
  if (!res.ok) return;
  await loadTodos();
  renderTodos();
}

function openTodoEditForm(todo) {
  editingTodoId = todo.id;
  document.getElementById('td-title').value = todo.title || '';
  document.getElementById('td-due').value = todo.due_date || '';
  document.getElementById('td-repeat').value = todo.recurring || '';
  const ptsEl = document.getElementById('td-points');
  ptsEl.value = todo.points ? String(todo.points) : '';
  // Points are the parent's dial; the family only ever sees the money. Show the
  // live conversion right here so setting a value doesn't require mental
  // arithmetic against a rate buried in Settings.
  const cents = (appConfig && appConfig.pointValueCents) || 0;
  const sym = (appConfig && appConfig.currencySymbol) || '$';
  const hint = document.getElementById('td-points-hint');
  const updateHint = () => {
    const n = Math.max(0, parseInt(ptsEl.value, 10) || 0);
    hint.textContent = cents <= 0
      ? '(set a point value in Settings to pay for chores)'
      : n > 0
        ? `= ${sym}${((n * cents) / 100).toFixed(2)}`
        : `(${sym}${(cents / 100).toFixed(2)} per point)`;
  };
  ptsEl.oninput = updateHint;
  updateHint();
  tdPeople = Array.isArray(todo.people) ? [...todo.people] : [];
  renderPersonChips('td-person-chips', tdPeople, NON_PERSON_NAMES);
  document.getElementById('todo-overlay').classList.add('open');
  setTimeout(() => document.getElementById('td-title').focus(), 50);
}

function closeTodoEditForm() {
  document.getElementById('todo-overlay').classList.remove('open');
  editingTodoId = null;
}

async function saveTodoEdit() {
  const title = document.getElementById('td-title').value.trim();
  if (!title) return;
  const recurring = document.getElementById('td-repeat').value || null;
  // A repeat pattern needs an anchor date to advance from — default to today
  // rather than block saving, since picking a repeat is the clearer signal.
  const dueDate = document.getElementById('td-due').value || (recurring ? toDateInputValue(new Date()) : null);
  const body = {
    title,
    people: [...tdPeople],
    dueDate,
    recurring,
    points: Math.max(0, parseInt(document.getElementById('td-points').value, 10) || 0),
  };
  const submitBtn = document.getElementById('td-submit');
  submitBtn.disabled = true;
  try {
    const res = await apiFetch(`/api/todos/${editingTodoId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); alert(err.error || 'Could not save to-do'); return; }
    await loadTodos();
    renderTodos();
    closeTodoEditForm();
  } finally {
    submitBtn.disabled = false;
  }
}

// Sign-in / sign-out wiring. MUST be attached before init()'s early return
// below: when nobody is logged in, loadConfig() fails and init() bails out
// immediately, so anything wired after that point never gets attached. Leaving
// the login form unwired made "Sign in" fall through to a native form submit,
// which reloaded the page straight back to the password prompt — the request
// never reached /api/login at all.
function wireAuthUi() {
  document.getElementById('auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    const password = document.getElementById('auth-password').value;
    const btn = document.getElementById('auth-submit');
    const errEl = document.getElementById('auth-error');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    errEl.style.display = 'none';
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Incorrect password.');
      }
      document.getElementById('auth-password').value = '';
      hideAuthOverlay();
      authed = true;
      // A fresh login lands mid-boot when init() had bailed out, so run the
      // full start-up path rather than assuming the rest of init() already ran.
      await init();
    } catch (err) {
      errEl.textContent = err.message || 'Could not sign in. Try again.';
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  document.getElementById('signin-btn').addEventListener('click', showAuthOverlay);

  document.getElementById('signout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    authed = false;
    const stillOk = await loadConfig();
    if (!stillOk) { showAuthOverlay(); return; }
    buildFilterBar();
    await loadEvents();
    render();
    updateAuthUI();
  });
}

// Guard against init() running its one-time setup twice — it now re-runs after
// a successful sign-in (see wireAuthUi above).
let initialized = false;

async function init() {
  const ok = await loadConfig();
  if (!ok) { showAuthOverlay(); return; }
  if (initialized) {
    // Already booted once (e.g. signed out then back in) — just refresh data.
    buildFilterBar();
    await loadEvents();
    render();
    updateAuthUI();
    return;
  }
  initialized = true;

  buildFilterBar();
  await loadEvents();
  updateViewBtn();
  render();
  updateAuthUI();
  updateClock();

  const themeBtn = document.getElementById('theme-btn');
  themeBtn.addEventListener('click', () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(currentTheme) + 1) % THEME_ORDER.length];
    applyTheme(next);
  });

  const todayBtn = document.getElementById('today-btn');

  document.getElementById('view-btn').addEventListener('click', () => {
    // Each width toggles between its own two views: month/agenda on a phone,
    // grid/agenda on a desktop.
    const mobile = mobileMQ.matches;
    if (viewMode === 'agenda') viewMode = mobile ? 'month' : 'grid';
    else viewMode = 'agenda';
    try { localStorage.setItem(mobile ? 'kb-view-mobile' : 'kb-view-desktop', viewMode); } catch (e) {}
    updateViewBtn();
    render();
  });

  // Crossing the breakpoint (rotating a tablet, resizing a window) re-reads the
  // preference for the width we just landed on, because the view we were in may
  // not exist over there.
  mobileMQ.addEventListener('change', () => {
    viewMode = initialViewMode();
    updateViewBtn();
    render();
  });

  document.getElementById('prev-month').addEventListener('click', () => {
    // The mobile month is a plain paged month with no rolling-window mode, so
    // it steps by one every time — none of the todayView dance below applies.
    if (viewMode === 'month') { mmOffset--; render(); return; }
    // First step back from the Today view lands on the current month in full
    // (offset 0), not the previous month.
    if (todayView) { todayView = false; viewOffset = 0; }
    else viewOffset--;
    render();
  });
  document.getElementById('next-month').addEventListener('click', () => {
    if (viewMode === 'month') { mmOffset++; render(); return; }
    // First step forward from the Today view advances to next month.
    if (todayView) { todayView = false; viewOffset = 1; }
    else viewOffset++;
    render();
  });
  todayBtn.addEventListener('click', () => {
    if (viewMode === 'month') { mmOffset = 0; mmSelectedKey = null; render(); return; }
    todayView = true; viewOffset = 0;
    render();
  });

  // ---- Mobile month: pick a day, swipe to page ----
  const monthHost = document.getElementById('month-mobile');
  // A swipe usually ends in a click on whatever cell the finger lifted over, and
  // paging the month AND moving the selection off one gesture is wrong. Timestamp
  // rather than a "swallow the next click" flag: a swipe doesn't always produce a
  // click (it can end outside the grid, or the browser can suppress it), and a
  // flag left armed by one of those silently eats a real tap minutes later. A
  // timestamp expires on its own.
  let mmSwipeAt = 0;
  const MM_SWIPE_CLICK_MS = 500;

  monthHost.addEventListener('click', e => {
    if (Date.now() - mmSwipeAt < MM_SWIPE_CLICK_MS) return;
    const cell = e.target.closest('.mm-day');
    if (!cell || !cell.dataset.date) return;
    mmSelectedKey = cell.dataset.date;
    // Tapping a leading/trailing day moves to the month it belongs to, the way
    // every phone calendar does — otherwise the selection ring sits on a dimmed
    // cell while the header names a different month.
    if (cell.classList.contains('other-month')) {
      const t = startOfDay(new Date());
      const d = new Date(mmSelectedKey + 'T00:00:00');
      mmOffset = (d.getFullYear() - t.getFullYear()) * 12 + (d.getMonth() - t.getMonth());
    }
    render();
  });

  let mmTouchX = null, mmTouchY = null;
  monthHost.addEventListener('touchstart', e => {
    // Only drags that start on the grid page the month; the day list under it
    // is an ordinary vertical scroller and must keep its own gestures.
    mmTouchX = e.target.closest('.mm-grid') ? e.touches[0].clientX : null;
    mmTouchY = e.touches[0].clientY;
  }, { passive: true });

  monthHost.addEventListener('touchend', e => {
    if (mmTouchX === null) return;
    const dx = e.changedTouches[0].clientX - mmTouchX;
    const dy = e.changedTouches[0].clientY - mmTouchY;
    mmTouchX = null;
    // Decisively horizontal only: 50px of travel, and clearly more sideways
    // than down, so a slightly-slanted scroll doesn't jump a month.
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    mmSwipeAt = Date.now();
    mmOffset += dx < 0 ? 1 : -1;
    render();
  }, { passive: true });

  // ---- Event detail popup ----
  document.getElementById('grid').addEventListener('click', e => {
    const evEl = e.target.closest('.event');
    if (evEl) {
      e.stopPropagation();
      const uid = evEl.dataset.uid;
      const start = evEl.dataset.start;
      const ev = events.find(x => x.uid === uid && x.start === start) ||
                 events.find(x => x.uid === uid) ||
                 { uid, feedId: evEl.dataset.feedId, title: evEl.title,
                   start: '', end: '', allDay: false, people: [] };
      showEventDetail(ev);
      return;
    }
    if (authed) {
      const cell = e.target.closest('.day-cell');
      if (cell && cell.dataset.date) openAddForm(cell.dataset.date);
    }
  });

  document.getElementById('detail-close').addEventListener('click', closeDetailPopup);

  document.getElementById('detail-overlay').addEventListener('click', e => {
    if (e.target.id === 'detail-overlay') closeDetailPopup();
  });


  document.getElementById('detail-delete').addEventListener('click', async e => {
    if (!confirm('Delete this event?')) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      const res = await apiFetch(`/api/events/${encodeURIComponent(btn.dataset.uid)}`, {
        method: 'DELETE'
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server error ${res.status}`);
      }
      await loadEvents();
      render();
      closeDetailPopup();
    } catch (err) {
      alert('Could not delete event: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Delete Event';
    }
  });

  document.getElementById('detail-delete-one').addEventListener('click', async e => {
    if (!confirm('Delete just this occurrence? All other dates of this recurring event will remain.')) return;
    const btn = e.currentTarget;
    const allBtn = document.getElementById('detail-delete-all');
    btn.disabled = true;
    allBtn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      const uid = btn.dataset.uid;
      const start = btn.dataset.start;
      const res = await apiFetch(
        `/api/events/${encodeURIComponent(uid)}?instanceStart=${encodeURIComponent(start)}`,
        { method: 'DELETE' }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server error ${res.status}`);
      }
      await loadEvents();
      render();
      closeDetailPopup();
    } catch (err) {
      alert('Could not delete occurrence: ' + err.message);
      btn.disabled = false;
      allBtn.disabled = false;
      btn.textContent = 'Delete This Only';
    }
  });

  document.getElementById('detail-delete-all').addEventListener('click', async e => {
    if (!confirm('Delete ALL occurrences of this recurring event? This cannot be undone.')) return;
    const btn = e.currentTarget;
    const oneBtn = document.getElementById('detail-delete-one');
    btn.disabled = true;
    oneBtn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      const uid = btn.dataset.uid;
      const res = await apiFetch(`/api/events/${encodeURIComponent(uid)}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server error ${res.status}`);
      }
      await loadEvents();
      render();
      closeDetailPopup();
    } catch (err) {
      alert('Could not delete event: ' + err.message);
      btn.disabled = false;
      oneBtn.disabled = false;
      btn.textContent = 'Delete All';
    }
  });

  // ---- Add event form ----
  populatePersonSelect();

  document.getElementById('add-btn').addEventListener('click', () => {
    // In month view the selected day is the subject of the whole screen, so
    // that's the date the form should open on — not today.
    openAddForm(viewMode === 'month' ? mmSelectedKey : null);
  });

  document.getElementById('ae-cancel').addEventListener('click', closeAddForm);

  document.getElementById('add-overlay').addEventListener('click', e => {
    if (e.target.id === 'add-overlay') closeAddForm();
  });

  document.getElementById('ae-allday').addEventListener('change', e => {
    document.getElementById('ae-times').style.display = e.target.checked ? 'none' : '';
  });

  document.getElementById('ae-repeat').addEventListener('change', updateRepeatUI);
  document.getElementById('ae-custom-unit').addEventListener('change', updateCustomUnitUI);
  document.getElementById('ae-share').addEventListener('change', updateShareHint);
  document.getElementById('ae-title').addEventListener('input', updateShareHint);

  // Keep the "Monthly on the Nth weekday" label current as the date changes.
  document.getElementById('ae-date').addEventListener('change', refreshDowOption);


  document.getElementById('add-form').addEventListener('submit', e => {
    e.preventDefault();
    // For recurring edits the user must choose This/All explicitly; Enter does nothing.
    if (editMode && editMode.recurring) return;
    doSave();
  });
  document.getElementById('ae-save-one').addEventListener('click', () => doSave('one'));
  document.getElementById('ae-save-all').addEventListener('click', () => doSave('all'));
  document.getElementById('detail-edit').addEventListener('click', () => {
    const ev = detailEv;
    closeDetailPopup();
    if (ev) openEditForm(ev);
  });
  document.getElementById('detail-duplicate').addEventListener('click', () => {
    const ev = detailEv;
    closeDetailPopup();
    if (ev) openDuplicateForm(ev);
  });
  document.getElementById('ae-more-add').addEventListener('click', addMoreDate);
  document.getElementById('ae-more-date').addEventListener('keydown', e => {
    // Enter adds the day rather than submitting the whole form.
    if (e.key === 'Enter') { e.preventDefault(); addMoreDate(); }
  });

  // ---- Feed management ----
  document.getElementById('feed-btn').addEventListener('click', openFeedForm);
  document.getElementById('cf-cancel').addEventListener('click', closeFeedForm);
  document.getElementById('feed-overlay').addEventListener('click', e => {
    if (e.target.id === 'feed-overlay') closeFeedForm();
  });

  document.getElementById('cf-person').addEventListener('change', e => {
    document.getElementById('cf-new-fields').style.display =
      e.target.value === '__new__' ? '' : 'none';
  });

  document.getElementById('feed-form').addEventListener('submit', async e => {
    e.preventDefault();
    const url    = document.getElementById('cf-url').value.trim();
    const name   = document.getElementById('cf-name').value.trim();
    const icon   = document.getElementById('cf-icon').value.trim();
    const personSel = document.getElementById('cf-person').value;

    let person, color;
    if (personSel === '__new__') {
      person = document.getElementById('cf-new-name').value.trim();
      color  = document.getElementById('cf-new-color').value;
      if (!person) { alert('Please enter a name for the new person.'); return; }
    } else {
      person = personSel;
      color  = null;
    }

    const btn = document.getElementById('cf-submit');
    btn.disabled = true;
    btn.textContent = 'Adding…';

    try {
      const res = await apiFetch('/api/feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, name, person, color, icon: icon || null })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server error ${res.status}`);
      }
      await loadConfig();
      populatePersonSelect();
      await loadEvents();
      render();
      closeFeedForm();
    } catch (err) {
      alert('Could not add feed: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Add Feed';
    }
  });


  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeAddForm(); closeDetailPopup(); hideAuthOverlay(); closeMealForm(); closeTodoEditForm(); }
  });

  window.addEventListener('resize', () => render());

  // ---- Tab bar ----
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  // ---- Meal planner ----
  document.getElementById('meals-prev').addEventListener('click', () => {
    mealsWeekStart = addDays(mealsWeekStart, -7);
    renderMealsList();
  });
  document.getElementById('meals-next').addEventListener('click', () => {
    mealsWeekStart = addDays(mealsWeekStart, 7);
    renderMealsList();
  });
  document.getElementById('ml-cancel').addEventListener('click', closeMealForm);
  document.getElementById('ml-delete').addEventListener('click', deleteMeal);
  document.getElementById('meal-overlay').addEventListener('click', e => {
    if (e.target.id === 'meal-overlay') closeMealForm();
  });
  document.getElementById('meal-form').addEventListener('submit', e => {
    e.preventDefault();
    saveMeal();
  });

  // ---- To-do ----
  document.getElementById('todo-add-form').addEventListener('submit', async e => {
    e.preventDefault();
    const titleEl = document.getElementById('todo-add-title');
    const title = titleEl.value.trim();
    if (!title) return;
    const people = [...todoAddPeople];
    const dueEl = document.getElementById('todo-add-due');
    const repeatEl = document.getElementById('todo-add-repeat');
    const recurring = repeatEl.value || null;
    const dueDate = dueEl.value || (recurring ? toDateInputValue(new Date()) : null);
    const pointsEl = document.getElementById('todo-add-points');
    const points = Math.max(0, parseInt(pointsEl.value, 10) || 0);
    const submitBtn = e.target.querySelector('button[type=submit]');
    submitBtn.disabled = true;
    try {
      const res = await apiFetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, people, dueDate, recurring, points }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); alert(err.error || 'Could not add to-do'); return; }
      titleEl.value = '';
      dueEl.value = '';
      repeatEl.value = '';
      pointsEl.value = '';
      todoAddPeople = [];
      populateTodoPersonSelect();
      await loadTodos();
      renderTodos();
    } finally {
      submitBtn.disabled = false;
    }
  });

  // Whose chores this device shows. Persisted locally, so each phone/tablet
  // keeps its own answer without any server-side notion of "current user".
  document.getElementById('todo-whose').addEventListener('change', e => {
    setWhoAmI(e.target.value);
    renderTodos();
    renderChoreEarnings();
  });

  document.getElementById('todo-kind').addEventListener('click', e => {
    const btn = e.target.closest('.kind-btn');
    if (!btn) return;
    setTodoKind(btn.dataset.kind);
    syncKindButtons();
    renderTodos();
    renderChoreEarnings();
  });

  document.getElementById('td-cancel').addEventListener('click', closeTodoEditForm);
  document.getElementById('td-delete').addEventListener('click', async () => {
    if (!editingTodoId) return;
    if (!confirm('Delete this to-do?')) return;
    const res = await apiFetch(`/api/todos/${editingTodoId}`, { method: 'DELETE' });
    if (!res.ok) return;
    await loadTodos();
    renderTodos();
    closeTodoEditForm();
  });
  document.getElementById('todo-overlay').addEventListener('click', e => {
    if (e.target.id === 'todo-overlay') closeTodoEditForm();
  });
  document.getElementById('todo-edit-form').addEventListener('submit', e => {
    e.preventDefault();
    saveTodoEdit();
  });

  fetchWeather();
  setInterval(fetchWeather, 1000 * 60 * 30);
  setInterval(updateClock, 1000 * 30);
  // Refresh events every 5 minutes from cache, re-render
  setInterval(async () => {
    await loadEvents();
    render();
  }, 1000 * 60 * 5);
  // Re-render at midnight rollover by checking every minute for date change
  let lastDate = new Date().getDate();
  setInterval(() => {
    const d = new Date().getDate();
    if (d !== lastDate) {
      lastDate = d;
      render();
    }
  }, 1000 * 60);

  // Mobile browsers throttle setInterval in a backgrounded tab — installed as
  // a Home Screen PWA and left open for hours, the 5-minute refresh above
  // simply doesn't fire, so the calendar quietly goes stale until something
  // else forces a reload. Catching the moment the tab becomes visible again
  // fixes that for free: this fires once, does nothing while backgrounded,
  // and replaces a background timer rather than adding one.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    await loadEvents();
    render();
  });

  // Agenda "load more": grow the rendered window as the user nears the
  // bottom. No fetch involved — the data's already in `events` out to a
  // year, this just renders further into it — so it's a synchronous
  // re-render, not a network round trip.
  //
  // Attached to both candidate scroll boxes (see agendaScrollEl() above) —
  // which one actually fires depends on viewport width, and only the one
  // that's genuinely overflowing will ever cross the threshold below, so
  // having both listeners present is harmless.
  let agendaLoadingMore = false;
  function handleAgendaScroll(e) {
    const el = e.target;
    if (viewMode !== 'agenda' || agendaLoadingMore || agendaDaysShown >= AGENDA_MAX_DAYS) return;
    if (el.scrollHeight <= el.clientHeight) return; // not the active scroller right now
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 600) return;
    agendaLoadingMore = true;
    // A page of days can render nothing at all — a sparse stretch with zero
    // events — in which case scrollHeight doesn't grow, and a browser never
    // fires another 'scroll' event for a scrollTop assignment that didn't
    // actually move anything. Without this loop, "load more" would silently
    // wedge itself the first time it crossed an empty run, even with real
    // events sitting much further out. Keep pulling pages in-place until
    // either real content pushes the edge away or the cap is hit.
    while (agendaDaysShown < AGENDA_MAX_DAYS) {
      agendaDaysShown = Math.min(AGENDA_MAX_DAYS, agendaDaysShown + AGENDA_PAGE_SIZE);
      renderAgenda();
      if (el.scrollTop + el.clientHeight < el.scrollHeight - 600) break;
    }
    agendaLoadingMore = false;
  }
  document.getElementById('agenda-container').addEventListener('scroll', handleAgendaScroll);
  document.getElementById('content-scroll').addEventListener('scroll', handleAgendaScroll);
}

(function() {
  // Dev2 (Glass) is a single-mode theme — no light/dark variant, so no class is applied.
})();

wireAuthUi();   // must run before init() — init() bails early when logged out
init();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
