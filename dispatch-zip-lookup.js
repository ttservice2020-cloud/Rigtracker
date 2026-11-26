const dispatchZipLookup = (() => {
  let timeZones;

  async function getZone(zip) {
    timeZones ??= fetch('./dispatch-zip-timezones.json?v=1').then(response => {
      if (!response.ok) throw new Error('ZIP time zones unavailable');
      return response.json();
    }).catch(error => {
      timeZones = null;
      throw error;
    });
    const { zones, ranges } = await timeZones;
    const code = Number(zip);
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const [start, end, index] = ranges[middle];
      if (code < start) high = middle - 1;
      else if (code > end) low = middle + 1;
      else return zones[index];
    }
    return '';
  }

  function bindTimeZone({ zip, zone, status }) {
    const zipCode = () => /^(\d{5})(?:-\d{4})?$/.exec(zip.value.trim())?.[1] ?? '';
    let previous = zipCode();
    let request;

    async function update() {
      const code = zipCode();
      if (code !== previous) {
        previous = code;
        zone.value = '';
      }
      if (!code || zone.value) {
        request = null;
        status.textContent = '';
        return;
      }
      if (request?.code === code) return;
      const pending = request = { code };
      status.textContent = 'Finding time zone…';
      try {
        const value = await getZone(code);
        if (request !== pending || !zip.isConnected) return;
        zone.value = value;
        status.textContent = zone.value ? 'Time zone filled from ZIP.' : 'Choose the time zone for this ZIP.';
      } catch {
        if (request === pending) status.textContent = 'ZIP lookup unavailable. Choose the time zone.';
      } finally {
        if (request === pending) request = null;
      }
    }

    zip.addEventListener('input', update);
    zone.addEventListener('change', () => {
      request = null;
      status.textContent = '';
    });
    return update;
  }

  function bind({street,city,state,zip,status,lookup,allowed}) {
    let timer;
    let request;
    let attempted;
    let generated;
    let filling = false;

    function cancel() {
      clearTimeout(timer);
      request = null;
    }

    function reset() {
      cancel();
      attempted = generated = null;
      status.textContent = '';
    }

    function fill(value) {
      filling = true;
      zip.value = value;
      zip.dispatchEvent(new Event('input',{bubbles:true}));
      filling = false;
    }

    function update() {
      if (!allowed()) return;
      const address = {street:street.value.trim(),city:city.value.trim(),state:state.value.trim().toUpperCase()};
      const key = JSON.stringify(Object.values(address).map(value => value.replace(/\s+/g,' ').toUpperCase()));
      if (generated && key !== generated.key && zip.value === generated.zip) {
        generated = null;
        fill('');
      }
      if (zip.value) {
        if (!generated || zip.value !== generated.zip) reset();
        return;
      }
      if (attempted === key) return;
      cancel();
      attempted = key;
      if (!address.street || !address.city || !/^[A-Z]{2}$/.test(address.state)) {
        status.textContent = '';
        return;
      }
      const pending = {};
      request = pending;
      status.textContent = 'Looking up ZIP…';
      timer = setTimeout(async () => {
        const active = () => allowed() && request === pending && !zip.value;
        if (!active()) {
          if (request === pending) reset();
          return;
        }
        try {
          const result = await lookup(key,address);
          if (!active()) return;
          if (!result) {
            status.textContent = 'Check the address or enter the ZIP manually.';
            return;
          }
          generated = {key,zip:result};
          status.textContent = 'ZIP filled from address.';
          fill(result);
        } catch {
          if (active()) status.textContent = 'ZIP lookup is unavailable. Enter the ZIP manually.';
        } finally {
          if (request === pending) {
            if (allowed()) request = null;
            else reset();
          }
        }
      },650);
    }

    for (const input of [street,city,state]) input.addEventListener('input',update);
    zip.addEventListener('input',() => {
      if (filling) return;
      reset();
      if (!zip.value) update();
    });
    zip.setAttribute('aria-describedby',status.id);
    return {update,reset};
  }

  return {bind, bindTimeZone};
})();
