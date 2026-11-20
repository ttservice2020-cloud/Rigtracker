import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status, headers: corsHeaders });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") return reply(405, { message: "Use POST to create an employee." });

  const authorization = request.headers.get("Authorization");
  const token = authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token || !authorization) return reply(401, { message: "Sign in as Fleet Admin." });

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return reply(503, { message: "Employee account setup is unavailable." });

  const authOptions = { persistSession: false, autoRefreshToken: false };
  const client = createClient(url, anonKey, {
    auth: authOptions,
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user }, error: authError } = await client.auth.getUser(token);
  if (authError || !user) return reply(401, { message: "Sign in as Fleet Admin." });

  const { data: fleet, error: fleetError } = await client.from("fleets")
    .select("id").eq("admin_user_id", user.id).maybeSingle();
  if (fleetError) return reply(503, { message: "Could not verify your Fleet Admin account." });
  if (!fleet) return reply(403, { message: "Only the Fleet Admin can create employee accounts." });

  const payload = await request.json().catch(() => null);
  const employeeId = typeof payload?.employeeId === "string" ? payload.employeeId.trim() : "";
  const password = typeof payload?.password === "string" ? payload.password : "";
  if (!/^[0-9]{1,6}$/.test(employeeId)) {
    return reply(400, { message: "Use 1–6 digits for the Employee ID." });
  }
  if (password.length < 8 || new TextEncoder().encode(password).length > 72) {
    return reply(400, { message: "Use at least 8 characters and at most 72 bytes for the password." });
  }

  const username = fleet.id + "-" + employeeId;
  const service = createClient(url, serviceKey, { auth: authOptions });
  const { error } = await service.auth.admin.createUser({
    email: username + "@fleet-login.rigtrackerpro.com",
    password,
    email_confirm: true,
    app_metadata: { account_type: "fleet_employee", fleet_id: fleet.id, employee_id: employeeId },
  });
  if (error) {
    const { data: existing } = await client.from("fleet_employees").select("employee_id")
      .eq("fleet_id", fleet.id).eq("employee_id", employeeId).maybeSingle();
    if (existing || error.code === "email_exists" || error.code === "user_already_exists") {
      return reply(409, { message: "That Employee ID is already in use in this fleet." });
    }
    if (error.code === "weak_password") {
      return reply(400, { message: "Choose a stronger password that meets the account requirements." });
    }
    return reply(502, { message: "The employee account could not be created. Try again." });
  }

  return reply(201, { username });
});
