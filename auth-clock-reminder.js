const authClockReminder = (() => {
  const dialog = document.getElementById('authClockReminder');
  const form = dialog.querySelector('form');
  const title = document.getElementById('authClockReminderTitle');
  const detail = document.getElementById('authClockReminderDetail');
  const fleetField = document.getElementById('authClockReminderFleetField');
  const fleet = form.elements.fleet;
  const status = document.getElementById('authClockReminderStatus');
  const accept = document.getElementById('authClockReminderAccept');
  const skip = document.getElementById('authClockReminderSkip');

  function ask(clock, action, choices, active) {
    if (!active() || dialog.open) return;
    const clockingIn = action === 'clock_in';
    const chooseFleet = choices.length > 1;
    title.textContent = clockingIn ? 'Would you like to clock in?' : 'Would you like to clock out?';
    detail.textContent = clockingIn
      ? (chooseFleet ? 'Choose the fleet you’re working for.' : 'Start your shift for ' + choices[0].fleetId + '.')
      : 'Your shift for ' + choices[0].fleetId + ' will stay open if you skip.';
    fleetField.hidden = !chooseFleet;
    fleet.required = chooseFleet;
    fleet.replaceChildren(...(chooseFleet ? [new Option('Select a fleet', '')] : []),
      ...choices.map(({ fleetId }) => new Option(fleetId, fleetId)));
    accept.textContent = clockingIn ? 'Clock In' : 'Clock Out';
    accept.disabled = skip.disabled = false;
    status.textContent = '';

    return new Promise(resolve => {
      const events = new AbortController();
      const options = { signal: events.signal };
      dialog.addEventListener('close', () => {
        events.abort();
        resolve();
      }, { once: true });
      dialog.addEventListener('cancel', event => {
        if (accept.disabled) event.preventDefault();
      }, options);
      skip.addEventListener('click', () => dialog.close(), options);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (accept.disabled) return;
        if (!active()) { dialog.close(); return; }
        accept.disabled = skip.disabled = true;
        status.textContent = clockingIn ? 'Clocking in…' : 'Clocking out…';
        try {
          await clock.updateClock(action, fleet.value);
          dialog.close();
        } catch (error) {
          status.textContent = error.message || 'Could not update the time clock. Try again or choose Skip.';
          accept.disabled = skip.disabled = false;
        }
      }, options);
      dialog.showModal();
      (chooseFleet ? fleet : skip).focus();
    });
  }

  async function offer(user, action) {
    const active = () => currentUser === user && (action === 'clock_out' || !signingOut);
    if (!user || !active()) return;
    const role = accountTypeFor(user);
    const clock = role === 'employee' ? officeTools : role === 'company' ? companyDriverTools : null;
    if (!clock) return;
    let clocks;
    try { clocks = await clock.clockStatus(); }
    catch { return; }
    if (!active()) return;
    const running = clocks.filter(shift => shift.running);
    if (action === 'clock_out') {
      for (const shift of running) await ask(clock, action, [shift], active);
    } else if (!running.length) {
      const enabled = clocks.filter(shift => shift.enabled);
      if (enabled.length) await ask(clock, action, enabled, active);
    }
  }

  return { offer };
})();
