const dispatchRouteMiles = (() => {
  const coordinates = new Map();
  const distances = new Map();
  let nextRouteRequest = 0;

  function zipCode(value) {
    return /^(\d{5})(?:-\d{4})?$/.exec(value.trim())?.[1] || '';
  }

  function remember(cache, key, value) {
    if (cache.size >= 200) cache.delete(cache.keys().next().value);
    cache.set(key, value);
    return value;
  }

  function delay(ms, signal) {
    signal.throwIfAborted();
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort',abort);
        resolve();
      },ms);
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener('abort',abort,{once:true});
    });
  }

  async function locate(zip, signal) {
    if (coordinates.has(zip)) return coordinates.get(zip);
    const result = await fetch('https://api.zippopotam.us/us/' + zip,{signal,credentials:'omit'});
    if (result.status === 404) throw new Error('ZIP ' + zip + ' could not be found. Check the ZIP or enter route miles.');
    if (!result.ok) throw new Error('ZIP lookup is unavailable. Enter route miles or try again.');
    const place = (await result.json()).places?.[0];
    const longitude = Number(place?.longitude);
    const latitude = Number(place?.latitude);
    if (!place?.longitude || !place?.latitude || !Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      throw new Error('ZIP ' + zip + ' could not be located. Check the ZIP or enter route miles.');
    }
    return remember(coordinates,zip,longitude + ',' + latitude);
  }

  async function estimate(zips, signal) {
    const key = zips.join(',');
    if (distances.has(key)) return distances.get(key);
    const unique = [...new Set(zips)];
    const places = new Map(await Promise.all(unique.map(async zip => [zip,await locate(zip,signal)])));
    const points = zips.map(zip => places.get(zip)).join(';');
    const now = Date.now();
    const slot = Math.max(now,nextRouteRequest);
    nextRouteRequest = slot + 1100;
    await delay(slot - now,signal);
    const result = await fetch('https://routing.openstreetmap.de/routed-car/route/v1/driving/' + points +
      '?overview=false&steps=false&generate_hints=false',{signal,credentials:'omit'});
    if (!result.ok) throw new Error('Road routing is unavailable. Enter route miles or try again.');
    const meters = (await result.json()).routes?.[0]?.distance;
    if (!Number.isFinite(meters) || meters <= 0) throw new Error('There’s no road estimate for these ZIPs. Enter route miles.');
    return remember(distances,key,Math.max(0.1,Math.round(meters / 1609.344 * 10) / 10));
  }

  return { zipCode,delay,estimate };
})();
