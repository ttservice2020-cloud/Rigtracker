import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import webPush from "npm:web-push@3.6.7";

type Job = {
  id: number;
  lease: string;
  kind: "loads" | "messages";
  endpoint: string;
  p256dh: string;
  auth: string;
  deliver: boolean;
};

const url = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const database = url && serviceKey ? createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
}) : null;

function allowedEndpoint(value: string) {
  const endpoint = new URL(value);
  const host = endpoint.hostname;
  return endpoint.protocol === "https:" && !endpoint.username && !endpoint.password && !endpoint.port &&
    !endpoint.hash && (
      host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com" ||
      /^[a-z0-9-]+\.push\.apple\.com$/.test(host) || /^[a-z0-9-]+\.notify\.windows\.com$/.test(host)
    );
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const token = request.headers.get("x-rigtracker-worker");
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return new Response(null, { status: 401 });
  if (!database) return new Response(null, { status: 503 });
  try {
    const key = await database.rpc("driver_push_worker_key", {
      worker_token: token,
      candidate: webPush.generateVAPIDKeys(),
    });
    if (key.error) throw key.error;
    if (!key.data?.publicKey || !key.data?.privateKey) return new Response(null, { status: 401 });
    const { data, error } = await database.rpc("claim_driver_push");
    if (error) throw error;

    for (let offset = 0; offset < data.length; offset += 8) {
      await Promise.all((data as Job[]).slice(offset, offset + 8).map(async (job) => {
        let outcome = "done";
        try {
          if (job.deliver && allowedEndpoint(job.endpoint)) {
            await webPush.sendNotification(
              { endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.auth } },
              JSON.stringify({ kind: job.kind }),
              {
                TTL: 900,
                urgency: "normal",
                timeout: 3500,
                vapidDetails: {
                  subject: "https://rigtrackerpro.com",
                  publicKey: key.data.publicKey,
                  privateKey: key.data.privateKey,
                },
              },
            );
          }
        } catch (failure) {
          const status = (failure as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) outcome = "gone";
          if (!status || status === 429 || status >= 500) outcome = "retry";
          // Never log push URLs, subscription keys or signing credentials.
          if (status === 401 || status === 403) {
            console.error("Push provider declined the signing credentials", status);
            outcome = "retry";
          }
        }
        const finished = await database.rpc("finish_driver_push", {
          job_id: job.id,
          job_lease: job.lease,
          outcome,
        });
        if (finished.error) console.error("Could not record push delivery outcome", finished.error.code);
      }));
    }
    return new Response(null, { status: 204 });
  } catch {
    console.error("Driver push worker could not process the queue.");
    return new Response(null, { status: 503 });
  }
});
