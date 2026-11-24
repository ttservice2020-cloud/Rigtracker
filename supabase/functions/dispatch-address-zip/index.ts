import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

function reply(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status, headers: corsHeaders });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") return reply(405, { message: "Use POST to find a ZIP code." });

  const authorization = request.headers.get("Authorization");
  const token = authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (!authorization || !token) return reply(401, { message: "Sign in to Dispatch." });
  const payload = await request.json().catch(() => null);
  const field = (key: string) => typeof payload?.[key] === "string" ? payload[key].trim() : "";
  const fleetId = field("fleetId");
  const street = field("street");
  const city = field("city");
  const state = field("state").toUpperCase();
  if (!/^[a-z0-9]{1,20}$/.test(fleetId) || !street || street.length > 180 || !city || city.length > 80 ||
    !/^[A-Z]{2}$/.test(state)) {
    return reply(400, { message: "Enter a street address, city, and two-letter state." });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) return reply(503, { message: "ZIP lookup is unavailable." });

  try {
    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authorization } },
    });
    const { data: { user }, error } = await client.auth.getUser(token);
    if (error || !user) return reply(401, { message: "Sign in to Dispatch." });
    const [fleet, employee] = await Promise.all([
      client.from("fleets").select("id").eq("id", fleetId).eq("admin_user_id", user.id).maybeSingle(),
      client.from("fleet_employees").select("office_is_official,office_permissions,password_required")
        .eq("fleet_id", fleetId).eq("user_id", user.id).maybeSingle(),
    ]);
    if (fleet.error || employee.error) return reply(503, { message: "Could not verify Dispatch access." });
    const staff = employee.data;
    if (!fleet.data && (!staff || staff.password_required ||
      !(staff.office_is_official || staff.office_permissions?.includes("dispatch")))) {
      return reply(403, { message: "Dispatch access is required." });
    }

    const endpoint = new URL("https://geocoding.geo.census.gov/geocoder/locations/address");
    endpoint.search = new URLSearchParams({ street, city, state, benchmark: "Public_AR_Current", format: "json" }).toString();
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) return reply(502, { message: "Address lookup is unavailable." });
    const data = await response.json();
    const matches: { addressComponents?: { state?: string; zip?: string } }[] = data.result?.addressMatches;
    if (!Array.isArray(matches)) return reply(502, { message: "Address lookup is unavailable." });
    const zips = new Set(matches.flatMap(({ addressComponents }) => {
      const zip = addressComponents?.zip;
      return addressComponents?.state === state && typeof zip === "string" && /^\d{5}$/.test(zip) ? [zip] : [];
    }));
    return reply(200, { zip: zips.size === 1 ? [...zips][0] : null });
  } catch {
    return reply(502, { message: "Address lookup is unavailable." });
  }
});
