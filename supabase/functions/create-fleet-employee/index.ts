import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const officePermissions = new Set(["dispatch", "drivers", "assets", "messages", "hr", "payroll", "settlements", "hourly", "bank_ledger", "payments", "policies", "activity"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status: number, body: Record<string, unknown>) {
  return Response.json(body, { status, headers: corsHeaders });
}

function validTemporaryPassword(password: unknown): password is string {
  return typeof password === "string" && password.length >= 8 && new TextEncoder().encode(password).length <= 72;
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

  const payload = await request.json().catch(() => null);
  const employeeId = typeof payload?.employeeId === "string" ? payload.employeeId.trim() : "";
  const password = payload?.password;
  if (!/^[0-9]{1,6}$/.test(employeeId)) {
    return reply(400, { message: "Use 1–6 digits for the Employee ID." });
  }
  if (!validTemporaryPassword(password)) {
    return reply(400, { message: "Use at least 8 characters and at most 72 bytes for the password." });
  }

  if (payload?.action === "reset_password") {
    const fleetId = typeof payload.fleetId === "string" ? payload.fleetId : "";
    if (!/^[a-z0-9]{1,20}$/.test(fleetId)) return reply(400, { message: "Select an Office profile." });
    const { data: employee, error: accessError } = await client.rpc("office_profiles", {
      fleet: fleetId, action: "reset_target", employee_number: employeeId,
    });
    if (accessError || !employee?.user_id) {
      return reply(403, { message: accessError?.code === "42501" ? accessError.message : "You cannot reset this Office password." });
    }
    const service = createClient(url, serviceKey, { auth: authOptions });
    const { error } = await service.auth.admin.updateUserById(employee.user_id, {
      password,
      app_metadata: { office_password_reset_id: crypto.randomUUID(), office_password_reset_by: user.id },
    });
    if (error?.code === "weak_password") {
      return reply(400, { message: "Choose a stronger temporary password." });
    }
    if (error) return reply(502, { message: "Could not reset the password. Try again." });
    return reply(200, { username: fleetId + "-" + employeeId });
  }

  const { data: fleet, error: fleetError } = await client.from("fleets")
    .select("id").eq("admin_user_id", user.id).maybeSingle();
  if (fleetError) return reply(503, { message: "Could not verify your Fleet Admin account." });
  if (!fleet) return reply(403, { message: "Only the Fleet Admin can create employee accounts." });

  const firstName = typeof payload?.firstName === "string" ? payload.firstName.trim() : "";
  const lastName = typeof payload?.lastName === "string" ? payload.lastName.trim() : "";
  const officeRole = typeof payload?.officeRole === "string" ? payload.officeRole.trim() : "";
  const permissions = payload?.permissions;
  const hasDesignation = Object.hasOwn(payload ?? {}, "isOfficial") || Object.hasOwn(payload ?? {}, "canManageProfiles");
  const hasOfficeSetup = hasDesignation || ["firstName", "lastName", "officeRole", "permissions"]
    .some((key) => Object.hasOwn(payload ?? {}, key));
  if (hasDesignation && (typeof payload.isOfficial !== "boolean" || typeof payload.canManageProfiles !== "boolean")) {
    return reply(400, { message: "Choose Official or Unofficial and whether they can manage profiles." });
  }
  if (hasOfficeSetup) {
    if (!firstName || !lastName || firstName.length > 100 || lastName.length > 100) {
      return reply(400, { message: "Enter a first and last name, up to 100 characters each." });
    }
    if (!officeRole || officeRole.length > 100) {
      return reply(400, { message: "Enter an Office role, up to 100 characters." });
    }
    if (!Array.isArray(permissions) || permissions.some((value) => !officePermissions.has(value))) {
      return reply(400, { message: "Select valid Office access options." });
    }
  }
  const username = fleet.id + "-" + employeeId;
  const service = createClient(url, serviceKey, { auth: authOptions });
  const { error } = await service.auth.admin.createUser({
    email: username + "@fleet-login.rigtrackerpro.com",
    password,
    email_confirm: true,
    user_metadata: hasOfficeSetup ? { first_name: firstName, last_name: lastName } : {},
    app_metadata: {
      account_type: "fleet_employee", fleet_id: fleet.id, employee_id: employeeId, temporary_password: true,
      ...(hasOfficeSetup ? { office_role: officeRole, office_permissions: [...new Set(permissions)] } : {}),
      ...(hasDesignation ? { office_is_official: payload.isOfficial, office_can_manage_profiles: payload.canManageProfiles } : {}),
    },
  });
  if (error) {
    const [office, driver] = await Promise.all([
      client.from("fleet_employees").select("employee_id").eq("fleet_id", fleet.id).eq("employee_id", employeeId).maybeSingle(),
      client.from("rigtracker_fleet_links").select("employee_number").eq("fleet_id", fleet.id)
        .eq("employee_number", employeeId).is("unlinked_at", null).maybeSingle(),
    ]);
    if (office.data || driver.data || error.code === "email_exists" || error.code === "user_already_exists") {
      return reply(409, { message: "That Employee ID is already in use in this fleet." });
    }
    if (error.code === "weak_password") {
      return reply(400, { message: "Choose a stronger password that meets the account requirements." });
    }
    return reply(502, { message: "The employee account could not be created. Try again." });
  }

  return reply(201, { username });
});
