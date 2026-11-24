const dispatchZipLookup = (() => {
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

  return {bind};
})();
