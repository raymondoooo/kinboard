    const TZS = [
      ['America/New_York','Eastern (New York)'], ['America/Chicago','Central (Chicago)'],
      ['America/Denver','Mountain (Denver)'], ['America/Phoenix','Arizona (Phoenix)'],
      ['America/Los_Angeles','Pacific (Los Angeles)'], ['America/Anchorage','Alaska (Anchorage)'],
      ['Pacific/Honolulu','Hawaii (Honolulu)'], ['America/Toronto','Toronto'],
      ['America/Vancouver','Vancouver'], ['Europe/London','London'],
      ['Europe/Paris','Central Europe (Paris)'], ['Australia/Sydney','Sydney'],
    ];
    const tzSel = document.getElementById('s-tz');
    const guessed = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const list = TZS.slice();
    if (guessed && !list.some(([z]) => z === guessed)) list.unshift([guessed, guessed + ' (detected)']);
    list.forEach(([z, label]) => {
      const o = document.createElement('option');
      o.value = z; o.textContent = label;
      tzSel.appendChild(o);
    });
    tzSel.value = guessed && list.some(([z]) => z === guessed) ? guessed : 'America/New_York';

    document.getElementById('setup-form').addEventListener('submit', async e => {
      e.preventDefault();
      const errEl = document.getElementById('error');
      const btn = document.getElementById('submit-btn');
      errEl.style.display = 'none';

      const name = document.getElementById('s-name').value.trim();
      const timeZone = document.getElementById('s-tz').value;
      const password = document.getElementById('s-password').value;
      const password2 = document.getElementById('s-password2').value;

      if (password !== password2) {
        errEl.textContent = 'Passwords do not match.';
        errEl.style.display = 'block';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Creating…';
      try {
        const res = await fetch('/api/setup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin', body: JSON.stringify({ name, timeZone, password }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Could not complete setup.');
        }
        location.href = '/';
      } catch (err) {
        errEl.textContent = err.message || 'Could not complete setup.';
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Create calendar';
      }
    });
