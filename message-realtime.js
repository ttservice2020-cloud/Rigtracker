const messageRealtime = (() => {
  const events = ['office_message', 'driver_message'];
  let connection;

  function active(scope) {
    return connection === scope && currentUser?.id === scope.userId;
  }

  function schedule(scope) {
    if (!active(scope) || document.hidden || scope.timer || scope.refreshing || !scope.pending.size) return;
    scope.timer = setTimeout(() => void refresh(scope), 100);
  }

  async function refresh(scope) {
    scope.timer = null;
    if (!active(scope) || document.hidden) return;
    const pending = [...scope.pending];
    scope.pending.clear();
    scope.refreshing = true;
    try {
      await Promise.allSettled(pending.map(event => event === 'office_message'
        ? fleetOfficeCommunications.messageArrived() : companyMessaging.messageArrived()));
    } finally {
      scope.refreshing = false;
      schedule(scope);
    }
  }

  function received(scope, event) {
    if (!active(scope)) return;
    scope.pending.add(event);
    schedule(scope);
  }

  function stop() {
    const scope = connection;
    connection = null;
    if (!scope) return;
    clearTimeout(scope.timer);
    if (scope.channel) void supabaseClient.removeChannel(scope.channel).catch(() => {});
  }

  async function start(user) {
    if (!user || !supabaseClient?.channel || connection?.userId === user.id) return;
    stop();
    const scope = { userId:user.id, pending:new Set(), nextCheck:new Map() };
    connection = scope;
    try {
      await supabaseClient.realtime.setAuth();
      if (!active(scope)) return;
      const topic = 'rigtracker:message-updates:' + scope.userId;
      scope.channel = supabaseClient.channel(topic, { config:{ private:true } });
      for (const event of events) scope.channel.on('broadcast', { event }, () => received(scope, event));
      scope.channel.subscribe(status => {
        if (!active(scope)) return;
        scope.connected = status === 'SUBSCRIBED';
        if (!scope.connected) return;
        for (const event of events) {
          scope.nextCheck.set(event, Date.now() + 60000);
          received(scope, event);
        }
      });
    } catch {
      if (active(scope)) stop();
    }
  }

  function shouldPoll(event) {
    const scope = connection;
    if (!scope || !active(scope) || !scope.connected) return true;
    const now = Date.now();
    if (now < (scope.nextCheck.get(event) ?? 0)) return false;
    scope.nextCheck.set(event, now + 60000);
    return true;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !currentUser) return;
    if (connection) schedule(connection);
    else void start(currentUser);
  });

  return { start, stop, shouldPoll };
})();
