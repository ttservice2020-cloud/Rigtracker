const fleetAdminDriver = (() => {
  const byId = id => document.getElementById(id);
  const page = byId('fleetAdminDriverPage');
  const form = byId('fleetAdminDriverForm');
  const status = byId('fleetAdminDriverStatus');
  const roster = byId('fleetAdminDriverRoster');
  const rosterName = byId('fleetAdminDriverRosterName');
  const loadsButton = byId('fleetAdminOpenMyLoads');
  const saveButton = form.querySelector('[type="submit"]');
  let view;

  function active(selection) {
    return view === selection && currentUser === selection.user && page.classList.contains('active');
  }

  function paint(data) {
    const { profile, available_drivers: available } = data;
    form.elements.first_name.value = profile?.first_name ?? '';
    form.elements.last_name.value = profile?.last_name ?? '';
    roster.replaceChildren(new Option('Create a new driver record', ''),
      ...available.map(driver => new Option([driver.name, driver.equipment].filter(Boolean).join(' · '), driver.id)));
    roster.disabled = Boolean(profile?.roster_name);
    byId('fleetAdminDriverRosterField').classList.toggle('hidden', roster.disabled);
    rosterName.classList.toggle('hidden', !roster.disabled);
    rosterName.textContent = profile?.roster_name ? 'Dispatch driver: ' + profile.roster_name : '';
    loadsButton.classList.toggle('hidden', !profile?.driver_id);
    form.classList.remove('hidden');
  }

  async function load(selection, action, values = {}) {
    try {
      const { data, error } = await supabaseClient.rpc('fleet_admin_driver_profile', { action, ...values });
      if (!active(selection)) return;
      if (error) throw error;
      if (selection.destination === 'loads' && data.profile?.driver_id) {
        if (action === 'save') showToast('Driver profile saved.');
        return driverLoadWorkflow.open();
      }
      paint(data);
      status.textContent = action === 'save' ? 'Driver profile saved.'
        : data.profile?.driver_id ? '' : 'Save your profile to assign loads to yourself in Dispatch.';
    } catch (error) {
      if (active(selection)) status.textContent = error.message || 'Could not load your driver profile.';
    }
  }

  async function open(destination = 'profile') {
    const user = currentUser;
    if (!user || accountTypeFor(user) !== 'fleet') return;
    if (fleetLoadState !== 'ready') return showToast('Wait for your fleet settings to load, then try again.');
    if (!adminFleetId) return showFleetSection('settings');
    reset();
    view = { user, destination };
    showPage('fleetAdminDriverPage');
    status.textContent = 'Loading your driver profile…';
    return load(view, 'get');
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const selection = view;
    if (!selection || !active(selection) || saveButton.disabled) return;
    const firstName = form.elements.first_name.value.trim();
    const lastName = form.elements.last_name.value.trim();
    if (!firstName || !lastName) {
      status.textContent = 'Enter your first and last name.';
      return;
    }
    saveButton.disabled = true;
    status.textContent = 'Saving your driver profile…';
    try {
      await load(selection, 'save', { first_name: firstName, last_name: lastName, roster_driver: roster.value || null });
    } finally {
      if (view === selection) saveButton.disabled = false;
    }
  });

  function reset() {
    view = null;
    form.reset();
    roster.replaceChildren();
    rosterName.textContent = '';
    form.classList.add('hidden');
    loadsButton.classList.add('hidden');
    status.textContent = '';
    saveButton.disabled = false;
  }

  return { open, reset };
})();
