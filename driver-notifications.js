const driverNotifications = (() => {
  const panel = document.getElementById('driverPushSettings');
  const status = document.getElementById('driverPushStatus');
  const toggle = document.getElementById('driverPushToggle');
  let setup;
  let busy = false;

  function iosNeedsInstall() {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return ios && !window.matchMedia('(display-mode: standalone)').matches && navigator.standalone !== true;
  }

  async function request(action, device) {
    const {data,error} = await supabaseClient.rpc('driver_push_device',{action,device});
    if (error) throw error;
    return data;
  }

  async function prepare(user) {
    panel.classList.remove('hidden');
    setup = null;
    toggle.disabled = true;
    toggle.textContent = 'Turn On Notifications';
    if (iosNeedsInstall()) {
      status.textContent = 'On iPhone or iPad, add RigTracker to your Home Screen, then open the app to turn on notifications.';
      return;
    }
    if (!window.isSecureContext || !('Notification' in window) || !('PushManager' in window) ||
        !('serviceWorker' in navigator)) {
      status.textContent = 'Push notifications are unavailable in this browser.';
      return;
    }
    if (Notification.permission === 'denied') {
      status.textContent = 'Allow RigTracker notifications in your device or browser settings, then reopen this page.';
      return;
    }
    status.textContent = 'Checking notification settings…';
    const attempt = {user};
    setup = attempt;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      // The app's service worker may still be activating on the first visit.
      attempt.registration = registration?.active ? registration : await navigator.serviceWorker.ready;
      const subscription = await attempt.registration.pushManager.getSubscription();
      const device = await request('status',subscription ? {endpoint:subscription.endpoint} : null);
      if (setup !== attempt || user !== currentUser) return;
      attempt.subscription = subscription;
      attempt.enabled = device.enabled;
      attempt.publicKey = device.publicKey;
      toggle.textContent = device.enabled ? 'Turn Off Notifications' : 'Turn On Notifications';
      toggle.disabled = !device.enabled && !device.publicKey;
      status.textContent = device.enabled ? 'Notifications are on for this device.'
        : device.publicKey ? 'Get alerts for new loads and incoming fleet messages.'
          : 'Notifications are getting set up. Reopen this page in a minute.';
    } catch {
      if (setup === attempt && user === currentUser) {
        status.textContent = 'Could not check notification settings. Reopen this page to try again.';
      }
    }
  }

  function keyBytes(key) {
    const padded = key.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(key.length / 4) * 4,'=');
    return Uint8Array.from(atob(padded),character => character.charCodeAt(0));
  }

  toggle.addEventListener('click',async () => {
    const device = setup;
    if (!device || device.user !== currentUser || busy || toggle.disabled) return;
    busy = true;
    toggle.disabled = true;
    try {
      if (device.enabled && device.subscription) {
        await request('disable',{endpoint:device.subscription.endpoint});
        await device.subscription.unsubscribe().catch(() => {});
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          status.textContent = permission === 'denied' ? 'Notifications are blocked in your device or browser settings.'
            : 'Allow notifications to turn them on.';
          return;
        }
        if (device.user !== currentUser || setup !== device) return;
        if (device.subscription) await device.subscription.unsubscribe();
        const subscription = await device.registration.pushManager.subscribe({
          userVisibleOnly:true,applicationServerKey:keyBytes(device.publicKey)
        });
        if (device.user !== currentUser || setup !== device) {
          await subscription.unsubscribe();
          return;
        }
        try {
          await request('enable',subscription.toJSON());
        } catch (error) {
          await subscription.unsubscribe().catch(() => {});
          throw error;
        }
      }
      if (device.user === currentUser) await prepare(device.user);
    } catch {
      if (device.user === currentUser) status.textContent = 'Could not change notifications. Try again.';
    } finally {
      busy = false;
      if (setup === device) toggle.disabled = Notification.permission === 'denied';
    }
  });

  async function signOut() {
    if (!('serviceWorker' in navigator) || !['company','driver'].includes(accountTypeFor(currentUser))) return;
    setup = null;
    const registration = await navigator.serviceWorker.getRegistration().catch(() => null);
    const subscription = await registration?.pushManager?.getSubscription().catch(() => null);
    if (!subscription) return;
    await Promise.allSettled([
      request('disable',{endpoint:subscription.endpoint}),
      subscription.unsubscribe()
    ]);
  }

  function openRequestedPage() {
    const url = new URL(location.href);
    const target = url.searchParams.get('push');
    const role = accountTypeFor(currentUser);
    if (target !== 'loads' && target !== 'messages' || !['company','driver'].includes(role)) return false;
    url.searchParams.delete('push');
    history.replaceState(history.state,'',url);
    if (target === 'messages' && role === 'company') void companyMessaging.open();
    else void driverLoadWorkflow.open();
    return true;
  }

  return {prepare,signOut,openRequestedPage};
})();
