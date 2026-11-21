const offlinePage = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>RigTracker Pro · Offline</title>
<style>body{background:#05080d;color:#f3f7fc;font:16px system-ui,sans-serif;margin:0;padding:28px}
main{max-width:480px;margin:15vh auto}a{display:inline-block;padding:12px 20px;background:#164b84;border-radius:8px;color:#fff}</style></head>
<body><main><h1>You’re offline</h1><p>Reconnect to open your loads, messages, and settlements.</p>
<a href="./?app=driver">Try again</a></main></body></html>`;

self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  const scope = new URL(self.registration.scope);
  const url = new URL(request.url);
  if (url.origin !== scope.origin || ![scope.pathname, scope.pathname + 'index.html'].includes(url.pathname)) return;
  // Driver and account data always come from the live site. Only serve a static message offline.
  event.respondWith(fetch(request).catch(() => new Response(offlinePage, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  })));
});
