    const COLORS = ['#dc2626','#2563eb','#16a34a','#f97316','#9333ea','#db2777','#0d9488','#ca8a04','#0891b2','#64748b'];

    // HOLIDAY_DEFS is loaded from /holidays.js.
    const THEMES = [
      { id:'light',     name:'Light',     chip:'linear-gradient(135deg,#ffffff,#e0e7ff)' },
      { id:'dark',      name:'Dark',      chip:'linear-gradient(135deg,#1a1a1d,#3dd6e0)' },
      { id:'glitter',   name:'Glitter',   chip:'linear-gradient(135deg,#ff9ec7,#c084fc,#a78bfa)' },
      { id:'sports',    name:'Sports',    chip:'linear-gradient(135deg,#16a34a,#22c55e,#facc15)' },
      { id:'beach',     name:'Beach',     chip:'linear-gradient(135deg,#fde68a,#2dd4bf,#fb7185)' },
      { id:'forest',    name:'Forest',    chip:'linear-gradient(135deg,#14532d,#15803d,#84cc16)' },
      { id:'mountains', name:'Mountains', chip:'linear-gradient(135deg,#64748b,#94a3b8,#e2e8f0)' },
    ];
    const TZS = [
      ['America/New_York','Eastern (New York)'], ['America/Chicago','Central (Chicago)'],
      ['America/Denver','Mountain (Denver)'], ['America/Phoenix','Arizona (Phoenix)'],
      ['America/Los_Angeles','Pacific (Los Angeles)'], ['America/Anchorage','Alaska (Anchorage)'],
      ['Pacific/Honolulu','Hawaii (Honolulu)'], ['America/Toronto','Toronto'],
      ['America/Vancouver','Vancouver'], ['Europe/London','London'],
      ['Europe/Paris','Central Europe (Paris)'], ['Australia/Sydney','Sydney'],
    ];

    let selectedTheme = 'dark';
    let members = [];   // {id, display_name, color, emoji, member_type}
    let feeds = [];     // {id, url, name, fixed_person, emoji}

    function show(state) {
      ['loading','main'].forEach(s =>
        document.getElementById('state-' + s).classList.toggle('hidden', s !== state));
    }

    let toastTimer = null;
    function toast(msg, kind) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = 'toast show' + (kind ? ' ' + kind : '');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { t.className = 'toast' + (kind ? ' ' + kind : ''); }, 2400);
    }

    // The session lives in an httpOnly cookie sent automatically with
    // same-origin requests — no bearer token to attach.
    async function api(method, path, body) {
      const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 || res.status === 503) {
        // Not signed in (or setup isn't done yet) — the calendar page owns the
        // sign-in overlay, so send them there instead of duplicating it here.
        location.href = '/';
        throw new Error('redirecting');
      }
      let data = {};
      try { data = await res.json(); } catch { /* no body */ }
      if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
      return data;
    }

    // ── Share links + ICS feed ──
    function renderShare(data) {
      const on = document.getElementById('share-on');
      const off = document.getElementById('share-off');
      if (data && data.token) {
        document.getElementById('share-url').value = data.shareUrl;
        document.getElementById('ics-url').value = data.icsUrl;
        on.style.display = '';
        off.style.display = 'none';
      } else {
        on.style.display = 'none';
        off.style.display = '';
      }
      const fullOn = !!(data && data.fullIcsUrl);
      document.getElementById('full-ics-url').value = fullOn ? data.fullIcsUrl : '';
      document.getElementById('full-on').style.display = fullOn ? '' : 'none';
      document.getElementById('full-off').style.display = fullOn ? 'none' : '';
    }
    async function loadShareState() {
      try { renderShare(await api('GET', '/api/share/status')); } catch { /* leave default (off) */ }
    }
    async function generateShare() {
      try { renderShare(await api('POST', '/api/share/generate')); toast('Share links created', 'ok'); }
      catch (e) { toast('Could not create links: ' + e.message, 'err'); }
    }
    async function revokeShare() {
      if (!confirm('Turn off sharing? Existing links will stop working immediately.')) return;
      try { await api('POST', '/api/share/revoke'); await loadShareState(); toast('Sharing turned off', 'ok'); }
      catch (e) { toast('Could not turn off sharing: ' + e.message, 'err'); }
    }
    async function generateFull() {
      try { renderShare(await api('POST', '/api/share/full/generate')); toast('Full feed link created', 'ok'); }
      catch (e) { toast('Could not create link: ' + e.message, 'err'); }
    }
    async function revokeFull() {
      if (!confirm('Turn off the full feed? Apps subscribed to it will stop updating.')) return;
      try { await api('POST', '/api/share/full/revoke'); await loadShareState(); toast('Full feed turned off', 'ok'); }
      catch (e) { toast('Could not turn off the full feed: ' + e.message, 'err'); }
    }
    function copyShare(id) {
      const el = document.getElementById(id);
      el.select();
      navigator.clipboard?.writeText(el.value).then(() => toast('Copied'), () => toast('Copy failed', 'error'));
    }
    // Each Copy button names the field it copies in data-copy.
    document.querySelectorAll('[data-copy]').forEach((btn) =>
      btn.addEventListener('click', () => copyShare(btn.dataset.copy)));
    document.getElementById('share-generate-btn')?.addEventListener('click', generateShare);
    document.getElementById('share-revoke-btn')?.addEventListener('click', revokeShare);
    document.getElementById('full-generate-btn')?.addEventListener('click', generateFull);
    document.getElementById('full-revoke-btn')?.addEventListener('click', revokeFull);

    // ── API keys ──
    function whenLabel(iso) {
      if (!iso) return 'never';
      const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z');
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }
    async function loadApiKeys() {
      const wrap = document.getElementById('api-keys-list');
      let keys = [];
      try { keys = await api('GET', '/api/keys'); } catch { return; }
      wrap.textContent = '';
      if (!keys.length) {
        const p = document.createElement('p');
        p.className = 'hint'; p.style.marginTop = '0';
        p.textContent = 'No API keys yet.';
        wrap.appendChild(p);
        return;
      }
      for (const k of keys) {
        const row = document.createElement('div');
        row.className = 'cat-item';
        const name = document.createElement('div');
        name.className = 'cat-item-name';
        name.textContent = k.name;
        const meta = document.createElement('div');
        meta.className = 'hint'; meta.style.marginTop = '2px';
        meta.textContent = `${k.prefix}… · created ${whenLabel(k.created_at)} · last used ${whenLabel(k.last_used_at)}`;
        name.appendChild(meta);
        const del = document.createElement('button');
        del.className = 'btn btn-sm btn-danger';
        del.textContent = 'Revoke';
        del.addEventListener('click', async () => {
          if (!confirm(`Revoke "${k.name}"? Anything using it stops working immediately.`)) return;
          try { await api('DELETE', '/api/keys/' + encodeURIComponent(k.id)); toast('Key revoked', 'ok'); loadApiKeys(); }
          catch (e) { toast('Could not revoke: ' + e.message, 'err'); }
        });
        row.appendChild(name);
        row.appendChild(del);
        wrap.appendChild(row);
      }
    }
    document.getElementById('api-key-create')?.addEventListener('click', async () => {
      const input = document.getElementById('api-key-name');
      try {
        const created = await api('POST', '/api/keys', { name: input.value.trim() });
        input.value = '';
        document.getElementById('api-key-value').value = created.key;
        document.getElementById('api-key-new').style.display = '';
        toast('Key created — copy it now', 'ok');
        loadApiKeys();
      } catch (e) { toast(e.message, 'err'); }
    });

    // ── Share keywords (auto-share by title) ──
    let shareKeywords = [];
    const KW_SUGGESTIONS = ['Game', 'Birthday', 'Graduation', 'Recital', 'Concert', 'Championship', 'Tournament', 'Ceremony'];

    function renderKeywords() {
      const wrap = document.getElementById('kw-chips');
      wrap.innerHTML = '';
      shareKeywords.forEach(w => {
        const chip = document.createElement('span');
        chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:4px 10px;font-size:0.85rem;';
        chip.textContent = w;
        const x = document.createElement('button');
        x.type = 'button'; x.textContent = '×';
        x.style.cssText = 'background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.1rem;line-height:1;padding:0;';
        x.setAttribute('aria-label', 'Remove ' + w);
        x.addEventListener('click', () => { shareKeywords = shareKeywords.filter(k => k !== w); renderKeywords(); });
        chip.appendChild(x);
        wrap.appendChild(chip);
      });
      const remaining = KW_SUGGESTIONS.filter(s => !shareKeywords.some(k => k.toLowerCase() === s.toLowerCase()));
      const sug = document.getElementById('kw-suggest');
      sug.innerHTML = remaining.length ? 'Suggestions: ' : '';
      remaining.forEach(s => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = '+ ' + s;
        b.style.cssText = 'background:none;border:1px dashed var(--border);border-radius:999px;color:var(--muted);cursor:pointer;font-size:0.78rem;padding:2px 8px;margin:0 4px 4px 0;';
        b.addEventListener('click', () => addKeyword(s));
        sug.appendChild(b);
      });
    }
    function addKeyword(raw) {
      const w = (raw || '').trim().slice(0, 40);
      if (!w) return;
      if (!shareKeywords.some(k => k.toLowerCase() === w.toLowerCase())) shareKeywords.push(w);
      document.getElementById('kw-input').value = '';
      renderKeywords();
    }
    document.getElementById('kw-add')?.addEventListener('click', () => addKeyword(document.getElementById('kw-input').value));
    document.getElementById('kw-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(e.target.value); } });

    // ── Swatches ──
    function buildSwatches(container, color) {
      container.innerHTML = '';
      const valid = typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color);
      const palette = (valid && !COLORS.includes(color)) ? [color, ...COLORS] : COLORS;
      palette.forEach(c => {
        const s = document.createElement('button');
        s.type = 'button';
        s.className = 'swatch' + (c === color ? ' selected' : '');
        s.style.background = c;
        s.dataset.color = c;
        s.addEventListener('click', () => {
          container.querySelectorAll('.swatch').forEach(x => x.classList.remove('selected'));
          s.classList.add('selected');
        });
        container.appendChild(s);
      });
    }
    function selectedColor(container) {
      const el = container.querySelector('.swatch.selected') || container.querySelector('.swatch');
      return el ? el.dataset.color : '#6366f1';
    }

    // ── Members ──
    function renderMembers() {
      const list = document.getElementById('members-list');
      list.innerHTML = '';
      members.filter(m => m.member_type !== 'category').forEach(m => list.appendChild(memberRow(m)));
    }

    function renderCategories() {
      const list = document.getElementById('categories-list');
      list.innerHTML = '';
      members.filter(m => m.member_type === 'category').forEach(m => list.appendChild(categoryRow(m)));
    }

    function categoryRow(m) {
      const item = document.createElement('div');
      item.className = 'cat-item';
      item.dataset.id = m.id || '';

      const dot = document.createElement('div');
      dot.className = 'cat-dot';
      dot.style.background = m.color || '#6366f1';

      const name = document.createElement('div');
      name.className = 'cat-item-name';
      name.textContent = m.display_name;

      const swatches = document.createElement('div');
      swatches.className = 'color-swatches';
      buildSwatches(swatches, m.color || COLORS[0]);
      swatches.addEventListener('click', () => {
        dot.style.background = selectedColor(swatches);
      });

      item.appendChild(dot);
      item.appendChild(name);
      item.appendChild(swatches);
      return item;
    }

    function memberRow(m) {
      const item = document.createElement('div');
      item.className = 'item';
      item.dataset.id = m.id || '';

      const line = document.createElement('div');
      line.className = 'item-line';
      const name = document.createElement('input');
      name.type = 'text'; name.className = 'm-name'; name.maxLength = 30;
      name.placeholder = 'Name'; name.value = m.display_name || '';
      const emoji = document.createElement('input');
      emoji.type = 'text'; emoji.className = 'emoji-input m-emoji'; emoji.maxLength = 8;
      emoji.placeholder = '🙂'; emoji.value = m.emoji || '';
      line.appendChild(name); line.appendChild(emoji);
      item.appendChild(line);

      const swatches = document.createElement('div');
      swatches.className = 'color-swatches';
      buildSwatches(swatches, m.color || COLORS[0]);

      const actions = document.createElement('div');
      actions.className = 'item-actions';
      const del = document.createElement('button');
      del.className = 'btn btn-sm btn-danger'; del.textContent = 'Delete';
      del.addEventListener('click', () => deleteMember(item, m));
      actions.appendChild(del);

      item.appendChild(swatches);
      item.appendChild(actions);
      return item;
    }

    async function saveMember(item) {
      const body = {
        display_name: item.querySelector('.m-name').value.trim(),
        emoji: item.querySelector('.m-emoji').value.trim(),
        color: selectedColor(item.querySelector('.color-swatches')),
      };
      if (!body.display_name) throw new Error('Name is required');
      const id = item.dataset.id;
      const res = id ? await api('PATCH', '/api/members/' + id, body)
                     : await api('POST', '/api/members', body);
      if (res.member && res.member.id) item.dataset.id = res.member.id;
      return res;
    }

    // Tracks the saved state of the public toggle, so the confirmation fires on
    // the transition to public rather than on every save while it's already on.
    let wasPublic = false;
    function syncPublicWarning() {
      const on = document.getElementById('set-public').checked;
      document.getElementById('public-warn').classList.toggle('on', on);
    }
    document.addEventListener('change', (e) => {
      if (e.target && e.target.id === 'set-public') syncPublicWarning();
    });

    async function saveAll() {
      // Confirm before anything else runs: bailing out after the button is
      // disabled would leave it stuck on "Saving…".
      const publicBox = document.getElementById('set-public');
      if (publicBox.checked && !wasPublic) {
        const ok = confirm(
          'Turn off the password for this calendar?\n\n' +
          'Anyone who can reach this address will be able to read every event, ' +
          'time, person and location — with no password.\n\n' +
          'To share only some events, cancel and use the Share link section instead.'
        );
        if (!ok) { publicBox.checked = false; syncPublicWarning(); return; }
      }

      const btn = document.getElementById('save-all');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      const errors = [];

      for (const item of document.querySelectorAll('#members-list .item')) {
        try { await saveMember(item); }
        catch (e) { errors.push((item.querySelector('.m-name')?.value || 'Member') + ': ' + e.message); }
      }

      for (const item of document.querySelectorAll('#categories-list .cat-item')) {
        try {
          const color = selectedColor(item.querySelector('.color-swatches'));
          await api('PATCH', '/api/members/' + item.dataset.id, { color });
          item.querySelector('.cat-dot').style.background = color;
        } catch (e) {
          errors.push((item.querySelector('.cat-item-name')?.textContent || 'Category') + ': ' + e.message);
        }
      }

      for (const item of document.querySelectorAll('#feeds-list .item')) {
        try { await saveFeedItem(item); }
        catch (e) { errors.push('Feed: ' + e.message); }
      }

      try {
        const holidays = Array.from(document.querySelectorAll('#holiday-grid input[type=checkbox]:checked'))
          .map(cb => cb.value);
        const body = {
          name: document.getElementById('set-name').value.trim(),
          zip: document.getElementById('set-zip').value.trim(),
          weather_units: document.getElementById('set-units').value,
          time_zone: document.getElementById('set-tz').value,
          first_day_of_week: parseInt(document.getElementById('set-firstday').value, 10),
          weeks_to_show: parseInt(document.getElementById('set-weeks').value, 10),
          theme: selectedTheme,
          is_public: document.getElementById('set-public').checked,
          holidays,
          share_keywords: shareKeywords,
          // Stored as integer cents so a point is never worth 0.30000000000000004.
          point_value_cents: Math.round((parseFloat(document.getElementById('set-point-value').value) || 0) * 100),
          currency_symbol: document.getElementById('set-currency').value.trim() || '$',
          default_event_minutes: parseInt(document.getElementById('set-default-len').value, 10),
        };
        const res = await api('PATCH', '/api/settings', body);
        wasPublic = body.is_public;
        localStorage.setItem('theme', body.theme);
        if (body.zip && !res.geocoded) errors.push('ZIP code could not be located');
      } catch (e) {
        errors.push('Settings: ' + e.message);
      }

      btn.disabled = false;
      btn.textContent = 'Save';
      toast(errors.length ? errors.join(' · ') : 'All saved', errors.length ? 'err' : 'ok');
    }

    async function deleteMember(item, m) {
      if (!confirm('Delete ' + (m.display_name || 'this person') + '?')) return;
      try {
        if (item.dataset.id) await api('DELETE', '/api/members/' + item.dataset.id);
        item.remove();
        members = members.filter(x => x.id !== m.id);
        toast('Deleted', 'ok');
        await reloadFeedPeople();
        buildImportPersonOptions();
      } catch (e) { toast(e.message, 'err'); }
    }

    // ── Feeds ──
    function peopleNames() {
      const fromList = Array.from(document.querySelectorAll('#members-list .m-name'))
        .map(i => i.value.trim()).filter(Boolean);
      const fromCategories = members
        .filter(m => m.member_type === 'category' && m.display_name)
        .map(m => m.display_name);
      const defaults = ['Family', 'Birthday', 'Anniversary', 'Holiday'];
      return [...new Set([...fromList, ...fromCategories, ...defaults])];
    }

    function renderFeeds() {
      const list = document.getElementById('feeds-list');
      list.innerHTML = '';
      feeds.forEach(f => list.appendChild(feedRow(f)));
    }

    function feedRow(f) {
      const item = document.createElement('div');
      item.className = 'item';
      item.dataset.id = f.id || '';

      const line = document.createElement('div');
      line.className = 'item-line';
      const url = document.createElement('input');
      url.type = 'text'; url.className = 'f-url'; url.placeholder = 'iCal URL (https://…)';
      url.value = f.url || '';
      const emoji = document.createElement('input');
      emoji.type = 'text'; emoji.className = 'emoji-input f-emoji'; emoji.maxLength = 8;
      emoji.placeholder = '📅'; emoji.value = f.emoji || '';
      line.appendChild(url); line.appendChild(emoji);

      const line2 = document.createElement('div');
      line2.className = 'item-line';
      const sel = document.createElement('select');
      sel.className = 'f-member';
      sel.style.flex = '1';
      buildPeopleOptions(sel, f.fixed_person || '');
      line2.appendChild(sel);

      const line3 = document.createElement('div');
      line3.className = 'item-line';
      const label = document.createElement('input');
      label.type = 'text'; label.className = 'f-label'; label.maxLength = 60;
      label.placeholder = 'Calendar name (optional)';
      label.value = (f.display_name || f.name || '');
      line3.appendChild(label);

      const line4 = document.createElement('label');
      line4.className = 'item-line';
      line4.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;font-size:0.85rem;color:var(--muted);';
      const ns = document.createElement('input');
      ns.type = 'checkbox'; ns.className = 'f-never-share';
      ns.style.cssText = 'width:auto;flex:0 0 auto;';
      ns.checked = !!f.never_share;
      const nsText = document.createElement('span');
      nsText.textContent = 'Never share this calendar (hide from view-only links, even if titles match share words)';
      line4.appendChild(ns); line4.appendChild(nsText);

      const actions = document.createElement('div');
      actions.className = 'item-actions';
      const del = document.createElement('button');
      del.className = 'btn btn-sm btn-danger'; del.textContent = 'Delete';
      del.addEventListener('click', () => deleteFeed(item, f));
      actions.appendChild(del);

      item.appendChild(line);
      item.appendChild(line2);
      item.appendChild(line3);
      item.appendChild(line4);
      item.appendChild(actions);
      return item;
    }

    function buildPeopleOptions(sel, current) {
      sel.innerHTML = '<option value="">— Whose calendar? —</option>';
      peopleNames().forEach(n => {
        const o = document.createElement('option');
        o.value = n; o.textContent = n;
        sel.appendChild(o);
      });
      if (current) sel.value = current;
    }

    function reloadFeedPeople() {
      document.querySelectorAll('#feeds-list .f-member').forEach(sel =>
        buildPeopleOptions(sel, sel.value));
    }

    function buildImportPersonOptions() {
      const sel = document.getElementById('import-person');
      if (!sel) return;
      const current = sel.value;
      sel.innerHTML = '<option value="">— Leave unmatched events unassigned —</option>';
      peopleNames().forEach(n => {
        const o = document.createElement('option');
        o.value = n; o.textContent = n;
        sel.appendChild(o);
      });
      if (current) sel.value = current;
    }

    async function saveFeedItem(item) {
      const body = {
        url: item.querySelector('.f-url').value.trim(),
        label: item.querySelector('.f-label').value.trim(),
        member: item.querySelector('.f-member').value,
        emoji: item.querySelector('.f-emoji').value.trim(),
        never_share: item.querySelector('.f-never-share').checked,
      };
      if (!/^https?:\/\//i.test(body.url)) throw new Error('valid URL required');
      const id = item.dataset.id;
      const res = id ? await api('PATCH', '/api/feeds/' + id, body)
                     : await api('POST', '/api/feeds', body);
      if (res.feed && res.feed.id) item.dataset.id = res.feed.id;
      return res;
    }

    async function deleteFeed(item, f) {
      if (!confirm('Delete this calendar feed?')) return;
      try {
        if (item.dataset.id) await api('DELETE', '/api/feeds/' + item.dataset.id);
        item.remove();
        feeds = feeds.filter(x => x.id !== f.id);
        toast('Deleted', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }

    // ── Import a calendar (one-time migration) ──
    let lastImportPreview = null;

    function todayStr() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function importRangeDates() {
      const preset = document.getElementById('import-range').value;
      if (preset === 'future') return { rangeStart: todayStr(), rangeEnd: null };
      if (preset === 'year')   return { rangeStart: `${new Date().getFullYear()}-01-01`, rangeEnd: null };
      if (preset === 'all')    return { rangeStart: null, rangeEnd: null };
      return {
        rangeStart: document.getElementById('import-start').value || null,
        rangeEnd:   document.getElementById('import-end').value || null,
      };
    }

    // Holds the uploaded file's text once read — kept separate from the URL
    // field so a large .ics never round-trips through a visible input value.
    let importFileText = null;

    function importRequestBody(dryRun) {
      const person = document.getElementById('import-person').value;
      const { rangeStart, rangeEnd } = importRangeDates();
      // A chosen file always wins over a leftover URL — they're mutually
      // exclusive in the UI (picking one clears the other), so this is just
      // the last line of defense.
      if (importFileText) return { icsText: importFileText, person, rangeStart, rangeEnd, dryRun };
      const url = document.getElementById('import-url').value.trim();
      return { url, person, rangeStart, rangeEnd, dryRun };
    }

    function clearImportFile() {
      importFileText = null;
      document.getElementById('import-file').value = '';
      document.getElementById('import-file-name').style.display = 'none';
    }

    document.getElementById('import-file').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      const nameEl = document.getElementById('import-file-name');
      lastImportPreview = null; // source changed — the last Preview no longer applies
      document.getElementById('import-run-btn').style.display = 'none';
      if (!file) { importFileText = null; nameEl.style.display = 'none'; return; }
      try {
        importFileText = await file.text();
      } catch {
        toast('Could not read that file', 'err');
        clearImportFile();
        return;
      }
      document.getElementById('import-url').value = '';
      nameEl.textContent = `Using ${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB) — clears the URL field above.`;
      nameEl.style.display = '';
    });

    document.getElementById('import-url').addEventListener('input', () => {
      // Typing a URL after picking a file means the file should be dropped —
      // otherwise the file would silently keep winning per importRequestBody().
      if (importFileText) clearImportFile();
    });

    document.getElementById('import-range').addEventListener('change', e => {
      document.getElementById('import-custom-range').style.display = e.target.value === 'custom' ? '' : 'none';
    });

    document.getElementById('import-preview-btn').addEventListener('click', async () => {
      const url = document.getElementById('import-url').value.trim();
      if (!importFileText && !/^https?:\/\//i.test(url)) {
        toast('Enter a valid iCal URL or choose a .ics file', 'err'); return;
      }
      const resultEl = document.getElementById('import-result');
      const runBtn = document.getElementById('import-run-btn');
      runBtn.style.display = 'none';
      resultEl.style.display = '';
      resultEl.textContent = 'Fetching and parsing…';
      try {
        const body = importRequestBody(true);
        const res = await api('POST', '/api/feeds/import', body);
        lastImportPreview = body;
        const parts = [];
        if (res.singleCount) parts.push(`${res.singleCount} one-off event${res.singleCount === 1 ? '' : 's'}`);
        if (res.seriesCount) parts.push(`${res.seriesCount} recurring series`);
        if (res.overrideCount) parts.push(`${res.overrideCount} edited instance${res.overrideCount === 1 ? '' : 's'}`);
        if (!parts.length) {
          resultEl.textContent = 'No matching events found in this range.';
        } else {
          const sampleTxt = res.sample && res.sample.length ? ` Examples: ${res.sample.slice(0,4).join(', ')}${res.sample.length > 4 ? '…' : ''}.` : '';
          resultEl.textContent = `Found ${parts.join(' and ')}.${sampleTxt} Nothing has been imported yet — review, then click Import.`;
          runBtn.style.display = '';
        }
      } catch (e) {
        resultEl.textContent = '';
        resultEl.style.display = 'none';
        toast(e.message, 'err');
      }
    });

    document.getElementById('import-run-btn').addEventListener('click', async () => {
      const resultEl = document.getElementById('import-result');
      const runBtn = document.getElementById('import-run-btn');
      const currentBody = importRequestBody(false);
      if (!lastImportPreview || JSON.stringify({ ...lastImportPreview, dryRun: false }) !== JSON.stringify(currentBody)) {
        toast('Settings changed — click Preview again first', 'err');
        return;
      }
      if (!confirm('Import these events into your calendar now? This writes real events and cannot be undone automatically.')) return;
      runBtn.disabled = true;
      resultEl.textContent = 'Importing…';
      try {
        const res = await api('POST', '/api/feeds/import', currentBody);
        const parts = [];
        if (res.insertedSingles) parts.push(`${res.insertedSingles} event${res.insertedSingles === 1 ? '' : 's'}`);
        if (res.insertedSeries) parts.push(`${res.insertedSeries} recurring series`);
        if (res.insertedOverrides) parts.push(`${res.insertedOverrides} edited instance${res.insertedOverrides === 1 ? '' : 's'}`);
        resultEl.textContent = `Imported ${parts.join(' and ') || 'nothing new'}.` +
          (res.removedFeed ? ' The matching live feed subscription was removed — these events are now yours to edit.' : '');
        runBtn.style.display = 'none';
        lastImportPreview = null;
        if (res.removedFeed) {
          feeds = feeds.filter(f => f.url !== currentBody.url);
          renderFeeds();
        }
        document.getElementById('import-url').value = '';
        clearImportFile();
        toast('Import complete', 'ok');
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        runBtn.disabled = false;
      }
    });

    // ── Holidays ──
    function buildHolidayGrid(selected = []) {
      const selectedSet = new Set(selected);
      const grid = document.getElementById('holiday-grid');
      grid.innerHTML = '';
      HOLIDAY_DEFS.forEach(h => {
        const label = document.createElement('label');
        label.className = 'holiday-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = h.key;
        cb.checked = selectedSet.has(h.key);
        label.appendChild(cb);
        label.appendChild(document.createTextNode(' ' + h.emoji + ' ' + h.name));
        grid.appendChild(label);
      });
    }

    // ── Calendar settings ──
    function buildThemeGrid() {
      const grid = document.getElementById('theme-grid');
      grid.innerHTML = '';
      THEMES.forEach(t => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'theme-opt' + (t.id === selectedTheme ? ' selected' : '');
        b.dataset.theme = t.id;
        b.innerHTML = '<div class="theme-chip" style="background:' + t.chip + '"></div>' +
                      '<div class="theme-name">' + t.name + '</div>';
        b.addEventListener('click', () => {
          selectedTheme = t.id;
          grid.querySelectorAll('.theme-opt').forEach(x => x.classList.remove('selected'));
          b.classList.add('selected');
        });
        grid.appendChild(b);
      });
    }

    function buildTzSelect(current) {
      const sel = document.getElementById('set-tz');
      const list = TZS.slice();
      if (current && !list.some(([z]) => z === current)) list.unshift([current, current]);
      sel.innerHTML = '';
      list.forEach(([z, label]) => {
        const o = document.createElement('option');
        o.value = z; o.textContent = label;
        sel.appendChild(o);
      });
      sel.value = current || 'America/New_York';
    }

    // ── Notifications (Web Push) ──
    // Progressive enhancement: everything here stays hidden unless the browser
    // actually supports Web Push in a secure context. A self-hoster on
    // http://192.168.x.x sees an explanation and the webhook hint instead of a
    // toggle that could never work.
    let pushSubs = [];          // every registered device (for the list)
    let myEndpoint = null;      // this browser's endpoint, if subscribed
    let pushWatch = [];         // this device's watched people (local edit buffer)

    function urlBase64ToUint8Array(base64String) {
      const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
      const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(base64);
      return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
    }

    // Does an existing browser subscription already use this server's VAPID key?
    // The browser exposes it as an ArrayBuffer, ours is a base64url string, so
    // normalise both to compare. If the browser won't tell us (older engines
    // leave options undefined), assume it differs — resubscribing is harmless,
    // being stuck unable to enable notifications is not.
    function sameServerKey(subscription, publicKey) {
      const raw = subscription.options && subscription.options.applicationServerKey;
      if (!raw) return false;
      const bytes = new Uint8Array(raw);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      const b64url = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return b64url === String(publicKey).replace(/=+$/, '');
    }

    function renderPushPeople() {
      const wrap = document.getElementById('push-people');
      wrap.innerHTML = '';
      const names = members.filter(m => m.display_name).map(m => m.display_name);
      if (!names.length) {
        wrap.innerHTML = '<span class="hint">Add people under Family first.</span>';
        return;
      }
      names.forEach(n => {
        const on = pushWatch.some(w => w.toLowerCase() === n.toLowerCase());
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = n;
        b.style.cssText = 'border-radius:999px;padding:5px 12px;font-size:0.85rem;cursor:pointer;border:1px solid ' +
          (on ? 'var(--accent)' : 'var(--border)') + ';background:' + (on ? 'var(--accent)' : 'none') +
          ';color:' + (on ? '#fff' : 'var(--muted)') + ';';
        b.addEventListener('click', () => {
          pushWatch = on ? pushWatch.filter(w => w.toLowerCase() !== n.toLowerCase()) : [...pushWatch, n];
          renderPushPeople();
          savePushPrefs();
        });
        wrap.appendChild(b);
      });
    }

    function renderPushDevices() {
      const wrap = document.getElementById('push-devices');
      wrap.innerHTML = '';
      if (!pushSubs.length) {
        wrap.innerHTML = '<p class="hint" style="margin-top:0;">No devices registered yet.</p>';
        return;
      }
      pushSubs.forEach(s => {
        const row = document.createElement('div');
        row.className = 'cat-item';
        const name = document.createElement('div');
        name.className = 'cat-item-name';
        const isThis = s.device_id && s.device_id === kbDeviceId();
        const watching = (s.notify_people && s.notify_people.length) ? s.notify_people.join(', ') : 'everything';
        name.innerHTML = `${esc(s.label || 'Device')}${isThis ? ' <span style="color:var(--accent);font-size:0.78rem;">· this device</span>' : ''}` +
          `<div class="hint" style="margin-top:2px;">Watching ${esc(watching)}</div>`;
        const del = document.createElement('button');
        del.className = 'btn btn-sm btn-danger';
        del.textContent = 'Remove';
        del.addEventListener('click', async () => {
          if (!confirm('Stop sending notifications to ' + (s.label || 'this device') + '?')) return;
          try {
            await api('DELETE', '/api/push/subscriptions/' + s.id);
            toast('Device removed', 'ok');
            await loadPushState();
          } catch (e) { toast(e.message, 'err'); }
        });
        row.appendChild(name);
        row.appendChild(del);
        wrap.appendChild(row);
      });
    }

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s == null ? '' : s;
      return d.innerHTML;
    }

    // Reflect whether THIS browser is currently subscribed. "Subscribed" means
    // both halves agree: the browser still holds a PushSubscription, AND the
    // server still has a row for this device. If either is missing (permission
    // revoked, data cleared, row pruned as expired) we fall back to the off
    // state so the user can simply re-enable.
    async function refreshMyState() {
      myEndpoint = null;
      if (!kbPushSupported()) return;
      try {
        const reg = await kbServiceWorker();
        const sub = await reg.pushManager.getSubscription();
        myEndpoint = sub ? sub.endpoint : null;
      } catch (_) { myEndpoint = null; }

      // Matched by device_id — the list endpoint deliberately doesn't return
      // endpoints (long, and effectively a capability URL).
      const mine = myRow();
      const on = !!myEndpoint && !!mine;

      document.getElementById('push-on').style.display = on ? '' : 'none';
      document.getElementById('push-off').style.display = on ? 'none' : '';

      if (on && mine) {
        document.getElementById('push-label').value = mine.label || '';
        document.getElementById('push-lead').value = String(mine.reminder_minutes ?? 60);
        document.getElementById('push-digest').checked = !!mine.digest_enabled;
        document.getElementById('push-reminders').checked = !!mine.reminders_enabled;
        document.getElementById('push-onadd').checked = !!mine.on_add_enabled;
        pushWatch = Array.isArray(mine.notify_people) ? mine.notify_people.slice() : [];
        renderPushPeople();
      }
    }

    async function loadPushState() {
      if (!kbPushSupported()) return;
      try {
        const res = await api('GET', '/api/push/subscriptions');
        pushSubs = res.subscriptions || [];
      } catch { pushSubs = []; }
      renderPushDevices();
      await refreshMyState();
    }

    // The subscription list endpoint omits `endpoint` (it's long and secret-ish),
    // so `mine` is matched by device_id. Fetch it once here for the test button.
    function myRow() {
      return pushSubs.find(s => s.device_id && s.device_id === kbDeviceId()) || null;
    }

    async function savePushPrefs() {
      const mine = myRow();
      if (!mine) return;
      try {
        await api('PATCH', '/api/push/subscriptions/' + mine.id, {
          label: document.getElementById('push-label').value.trim() || 'This device',
          notifyPeople: pushWatch,
          reminderMinutes: +document.getElementById('push-lead').value,
          digestEnabled: document.getElementById('push-digest').checked,
          remindersEnabled: document.getElementById('push-reminders').checked,
          onAddEnabled: document.getElementById('push-onadd').checked,
        });
        await loadPushState();
      } catch (e) { toast(e.message, 'err'); }
    }

    async function enablePush() {
      const btn = document.getElementById('push-enable-btn');
      btn.disabled = true;
      try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          const msg = document.getElementById('push-denied-msg');
          msg.style.display = '';
          msg.textContent = permission === 'denied'
            ? "Your browser is blocking notifications for this site. You'll need to re-allow them in the browser's site settings."
            : 'Notification permission was dismissed.';
          return;
        }

        const reg = await kbServiceWorker();
        const { publicKey } = await api('GET', '/api/push/key');

        // A browser refuses to subscribe when it already holds a subscription
        // for this origin under a different VAPID key — "A subscription with a
        // different applicationServerKey already exists". That's not an edge
        // case here: every Kinboard generates its own keypair on first use, so
        // moving host, restoring a backup, or migrating onto a fresh data
        // volume all land exactly here. The browser's own advice is to
        // unsubscribe and resubscribe, so do that instead of showing the user
        // a wall of jargon they can't act on.
        const existing = await reg.pushManager.getSubscription();
        if (existing && !sameServerKey(existing, publicKey)) {
          await existing.unsubscribe();
          // Drop the stale row as well. That endpoint is dead now, and the
          // server would otherwise keep trying it until a push service
          // eventually answers 410.
          try {
            await api('POST', '/api/push/unsubscribe', { endpoint: existing.endpoint });
          } catch { /* it may not be registered on this instance at all */ }
        }

        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });

        await api('POST', '/api/push/subscribe', {
          subscription: sub.toJSON(),
          deviceId: kbDeviceId(),
          label: document.getElementById('push-label').value.trim() ||
                 (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'My phone' : 'My computer'),
          notifyPeople: pushWatch,
          reminderMinutes: +document.getElementById('push-lead').value,
        });

        toast('Notifications on for this device', 'ok');
        await loadPushState();
      } catch (e) {
        toast('Could not enable notifications: ' + (e.message || e), 'err');
      } finally {
        btn.disabled = false;
      }
    }

    async function disablePush() {
      try {
        const reg = await kbServiceWorker();
        const sub = await reg.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
        const mine = myRow();
        if (mine) await api('DELETE', '/api/push/subscriptions/' + mine.id);
        toast('Notifications off for this device', 'ok');
        await loadPushState();
      } catch (e) { toast(e.message, 'err'); }
    }

    function initPushUi() {
      const supported = kbPushSupported();
      document.getElementById('push-supported').classList.toggle('hidden', !supported);
      document.getElementById('push-unsupported').classList.toggle('hidden', supported);

      if (!supported) {
        // Be specific about WHY — "requires HTTPS" is actionable, "unsupported"
        // is not, and this is the single most likely support question.
        document.getElementById('push-unsupported-msg').textContent = !window.isSecureContext
          ? 'Push notifications need a secure connection (HTTPS). This page is loaded over plain HTTP, so your browser blocks them. Put Kinboard behind a reverse proxy with HTTPS to enable them — or use the WEBHOOK_URL setting (ntfy, Discord, Slack, Home Assistant) which works over plain HTTP. See the README.'
          : "This browser doesn't support push notifications. On iPhone or iPad, add Kinboard to your home screen first, then re-open it from there.";
        return;
      }

      document.getElementById('push-enable-btn').addEventListener('click', enablePush);
      document.getElementById('push-disable-btn').addEventListener('click', disablePush);
      document.getElementById('push-label').addEventListener('change', savePushPrefs);
      document.getElementById('push-lead').addEventListener('change', savePushPrefs);
      ['push-digest', 'push-reminders', 'push-onadd'].forEach(id =>
        document.getElementById(id).addEventListener('change', savePushPrefs));

      document.getElementById('push-test-btn').addEventListener('click', async () => {
        const btn = document.getElementById('push-test-btn');
        btn.disabled = true;
        try {
          const reg = await kbServiceWorker();
          const sub = await reg.pushManager.getSubscription();
          // No fallback to a bodyless request. That used to mean "test every
          // device in the household" server-side — so on exactly the device
          // whose subscription is broken (the one moment someone reaches for
          // this button), it silently buzzed a spouse's or child's phone
          // instead while reporting success here. If this device has nothing
          // to test, say so and stop; don't test somebody else's phone instead.
          if (!sub) {
            toast('This device isn\'t actually subscribed — turn notifications off and back on, then try again', 'err');
            return;
          }
          const res = await api('POST', '/api/push/test', { endpoint: sub.endpoint });
          toast(res.sent ? 'Test notification sent' : 'Nothing was sent — no active device', res.sent ? 'ok' : 'err');
        } catch (e) {
          toast(e.message, 'err');
        } finally {
          btn.disabled = false;
        }
      });
    }

    // ── Account: change household password ──
    document.getElementById('pw-save').addEventListener('click', async () => {
      const currentPassword = document.getElementById('pw-current').value;
      const newPassword = document.getElementById('pw-new').value;
      if (!newPassword || newPassword.length < 6) { toast('New password must be at least 6 characters', 'err'); return; }
      const btn = document.getElementById('pw-save');
      btn.disabled = true;
      try {
        await api('POST', '/api/account/password', { currentPassword, newPassword });
        document.getElementById('pw-current').value = '';
        document.getElementById('pw-new').value = '';
        toast('Password changed', 'ok');
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('add-member').addEventListener('click', () => {
      const item = memberRow({ color: COLORS[members.length % COLORS.length] });
      document.getElementById('members-list').appendChild(item);
      item.querySelector('.m-name').focus();
    });
    document.getElementById('add-feed').addEventListener('click', () => {
      const item = feedRow({});
      document.getElementById('feeds-list').appendChild(item);
      item.querySelector('.f-url').focus();
    });
    document.getElementById('save-all').addEventListener('click', saveAll);

    // ── Load ──
    async function loadAll() {
      // Make sure the category rows exist + are tagged as categories before we
      // read members, so Family/Birthday/Anniversary/Holiday always show up.
      try { await api('POST', '/api/categories/ensure'); } catch (e) { /* non-fatal */ }

      const [config, mres, fres] = await Promise.all([
        api('GET', '/api/config'),
        api('GET', '/api/members'),
        api('GET', '/api/feeds'),
      ]);

      document.getElementById('page-title').textContent = (config.name || 'Calendar') + ' — settings';
      document.title = (config.name || 'Calendar') + ' settings — Kinboard';

      if (config.donateUrl) {
        document.getElementById('donate-card').style.display = '';
        document.getElementById('donate-link').href = config.donateUrl;
      }

      members = mres.members || [];
      feeds = fres.feeds || [];
      renderMembers();
      renderCategories();
      renderFeeds();
      buildImportPersonOptions();
      buildHolidayGrid(config.holidays || []);
      loadShareState();
      loadApiKeys();
      shareKeywords = Array.isArray(config.shareKeywords) ? config.shareKeywords.slice() : [];
      renderKeywords();

      document.getElementById('set-name').value = config.name || '';
      document.getElementById('set-zip').value = config.zip || '';
      document.getElementById('set-units').value =
        (config.weather && config.weather.units) || 'fahrenheit';
      buildTzSelect(config.timeZone || 'America/New_York');
      document.getElementById('set-firstday').value = String(config.firstDayOfWeek ?? 0);
      document.getElementById('set-weeks').value = String(config.weeksToShow ?? 4);
      document.getElementById('app-version').textContent =
        config.version ? 'v' + config.version : 'version unknown';
      document.getElementById('set-public').checked = !!config.isPublic;
      wasPublic = !!config.isPublic;
      syncPublicWarning();
      document.getElementById('set-point-value').value =
        config.pointValueCents ? (config.pointValueCents / 100).toFixed(2) : '';
      document.getElementById('set-currency').value = config.currencySymbol || '$';
      {
        // A value set through the API may not be one of the listed choices;
        // show it rather than silently snapping to the nearest option.
        const sel = document.getElementById('set-default-len');
        const v = String(config.defaultEventMinutes ?? 60);
        if (![...sel.options].some(o => o.value === v)) sel.add(new Option(`${v} minutes`, v));
        sel.value = v;
      }
      // Reflect the theme actually in effect (the 🎨 button on the calendar sets
      // localStorage only) so saving a settings change doesn't clobber a
      // locally-chosen theme back to the account default.
      selectedTheme = localStorage.getItem('theme') || config.theme || 'dark';
      buildThemeGrid();

      // Notifications last — needs `members` (for the who-to-notify chips),
      // which is populated above.
      renderPushPeople();
      await loadPushState();

      show('main');
    }

    // Remember which sections were left open, per device. Someone who comes here
    // to adjust chores every week shouldn't have to re-open that section every
    // time — and someone who never touches Holidays shouldn't scroll past it.
    const OPEN_KEY = 'kb_settings_open';
    function restoreOpenSections() {
      let open;
      try { open = JSON.parse(localStorage.getItem(OPEN_KEY) || 'null'); } catch { open = null; }
      const cards = Array.from(document.querySelectorAll('details.card[data-sec]'));
      cards.forEach((c) => {
        // First visit: open Calendar only. It's the section people actually come
        // for, and one open section shows the pattern without restoring the wall
        // of text this replaced.
        c.open = Array.isArray(open) ? open.includes(c.dataset.sec) : c.dataset.sec === 'setup';
      });
      cards.forEach((c) => c.addEventListener('toggle', () => {
        const nowOpen = cards.filter((x) => x.open).map((x) => x.dataset.sec);
        try { localStorage.setItem(OPEN_KEY, JSON.stringify(nowOpen)); } catch { /* private mode */ }
      }));
    }

    // Deep links and in-page anchors have to win over the remembered state,
    // otherwise following one lands you on a collapsed section.
    function openSectionFromHash() {
      const id = (location.hash || '').replace('#', '');
      if (!id) return;
      const el = document.getElementById(id) || document.querySelector(`details.card[data-sec="${CSS.escape(id)}"]`);
      const card = el && el.closest('details.card');
      if (card) { card.open = true; card.scrollIntoView({ block: 'start' }); }
    }

    async function init() {
      restoreOpenSections();
      openSectionFromHash();
      window.addEventListener('hashchange', openSectionFromHash);
      // Wire the push UI before loading: initPushUi() decides whether the card
      // is even shown, and that shouldn't depend on the API call succeeding.
      initPushUi();
      try {
        await loadAll();
      } catch (e) {
        document.getElementById('state-loading').textContent = e.message;
      }
    }

    init();
