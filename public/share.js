    const token = location.pathname.split('/').filter(Boolean).pop();

    function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }

    (async function () {
      // The server pre-expands recurrences into a flat, date-sorted list within
      // the family's next N days — this page is a pure renderer.
      let data;
      try {
        const res = await fetch(`/api/share/${token}/events`);
        if (!res.ok) throw new Error();
        data = await res.json();
      } catch {
        document.getElementById('agenda').innerHTML = '<p class="empty">This share link is no longer active.</p>';
        return;
      }

      const name = data.calendarName || 'Shared calendar';
      document.getElementById('tb-name').textContent = name;
      document.title = `${name} · Kinboard`;
      document.getElementById('cal-sub').textContent = `Next ${data.windowDays || 180} days`;

      const occ = data.occurrences || [];
      const agenda = document.getElementById('agenda');
      if (!occ.length) { agenda.innerHTML = '<p class="empty">No upcoming events.</p>'; return; }

      const todayStr = data.today;
      let curDay = null, dayEl = null;
      for (const ev of occ) {
        if (ev.date !== curDay) {
          curDay = ev.date;
          dayEl = document.createElement('div');
          dayEl.className = 'day';
          const label = new Date(ev.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
          const isToday = ev.date === todayStr;
          const head = document.createElement('p');
          head.className = 'day-head' + (isToday ? ' today' : '');
          if (isToday) head.id = 'today-anchor';
          head.textContent = (isToday ? 'Today · ' : '') + label;
          dayEl.appendChild(head);
          agenda.appendChild(dayEl);
        }
        const row = document.createElement('div');
        row.className = 'ev';
        // Color-code by the event's person (member color); fall back to the
        // neutral border when there's no assigned person/color.
        row.style.borderLeftColor = ev.color || 'var(--border)';
        const time = ev.timeLabel || 'All day';
        row.innerHTML = `
          <!-- Escaped like every other field here. timeLabel is server-built
               from a validated time today, so this isn't currently reachable —
               but this is the one public, unauthenticated page in the product,
               and it renders titles that can originate from a third-party iCal
               feed. It shouldn't be one new write path away from an injection. -->
          <span class="time">${esc(time)}</span>
          <span>
            <span class="title">${esc(ev.title)}</span>
            ${(ev.people && ev.people.length) ? `<span class="who"> · ${esc(ev.people.join(', '))}</span>` : ''}
            ${ev.location ? `<span class="loc">📍 ${esc(ev.location)}</span>` : ''}
          </span>`;
        dayEl.appendChild(row);
      }

      // "Today" button jumps back to today's section after browsing ahead.
      const anchor = document.getElementById('today-anchor');
      const todayBtn = document.getElementById('today-btn');
      if (anchor) {
        todayBtn.style.display = '';
        todayBtn.addEventListener('click', () => anchor.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
    })();
