import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers });
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const employeeNumberPattern = /^[0-9]{1,6}$/;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return reply(405, { message: "Use POST to manage fleet links." });
  const authorization = request.headers.get("Authorization");
  const token = authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token || !authorization) return reply(401, { message: "Sign in as Fleet Admin." });
  const url = Deno.env.get("SUPABASE_URL");
  const publicKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !publicKey || !serviceKey) return reply(503, { message: "Fleet linking is unavailable." });

  const auth = { persistSession: false, autoRefreshToken: false };
  const client = createClient(url, publicKey, { auth, global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await client.auth.getUser(token);
  if (authError || !user) return reply(401, { message: "Sign in as Fleet Admin." });
  const { data: fleet, error: fleetError } = await client.from("fleets").select("id")
    .eq("admin_user_id", user.id).maybeSingle();
  if (fleetError) return reply(503, { message: "Could not verify fleet access." });
  if (!fleet) return reply(403, { message: "Only a Fleet Admin can manage fleet links." });

  const body = await request.json().catch(() => null);
  const service = createClient(url, serviceKey, { auth });
  switch (body?.action) {
    case "list": {
      const { data, error } = await service.from("rigtracker_fleet_links")
        .select("employee_number,rigtracker_profiles(profile_id,profile_type,first_name,last_name)")
        .eq("fleet_id", fleet.id).is("unlinked_at", null).order("profile_user_id");
      return error ? reply(503, { message: "Could not load linked profiles." }) : reply(200, { links: data });
    }
    case "link":
    case "unlink": {
      const id = text(body.profileId);
      const number = text(body.employeeNumber);
      if (!/^[0-9]{16}$/.test(id)) return reply(400, { message: "Enter the 16-digit RigTracker Profile ID." });
      if (number && !employeeNumberPattern.test(number)) {
        return reply(400, { message: "Use 1–6 digits for the employee number." });
      }
      const { error } = await service.rpc("manage_rigtracker_link", {
        acting_admin: user.id, target_fleet: fleet.id, target_profile_id: id,
        requested_number: number || null, removing: body.action === "unlink",
      });
      if (error?.code === "23505") return reply(409, { message: "That employee number is already in use." });
      if (error?.code === "22023") return reply(400, { message: error.message });
      return error ? reply(502, { message: "Could not update the link. Try again." }) : reply(200, { profileId: id });
    }
    case "create_company_driver": {
      const firstName = text(body.firstName);
      const lastName = text(body.lastName);
      const phone = text(body.phone);
      const licenseNumber = text(body.licenseNumber);
      const email = text(body.email).toLowerCase();
      const employeeNumber = text(body.employeeNumber);
      const password = typeof body.password === "string" ? body.password : "";
      if (!firstName || firstName.length > 100 || !lastName || lastName.length > 100 ||
          !phone || phone.length > 40 || !licenseNumber || licenseNumber.length > 80) {
        return reply(400, { message: "Enter the driver’s first name, last name, phone and license number." });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
          email.endsWith("@fleet-login.rigtrackerpro.com")) {
        return reply(400, { message: "Enter the driver’s email address." });
      }
      if (employeeNumber && !employeeNumberPattern.test(employeeNumber)) {
        return reply(400, { message: "Use 1–6 digits for the employee number." });
      }
      if (password.length < 8 || new TextEncoder().encode(password).length > 72) {
        return reply(400, { message: "Enter a temporary password with at least 8 characters and at most 72 bytes." });
      }
      const { data, error } = await service.auth.admin.createUser({
        email, password, email_confirm: false,
        app_metadata: {
          account_type: "company_driver",
          company_setup: {
            admin_id: user.id, fleet_id: fleet.id, first_name: firstName, last_name: lastName,
            phone, license_number: licenseNumber, employee_number: employeeNumber || null,
          },
        },
      });
      if (error) {
        if (error.code === "email_exists" || error.code === "user_already_exists") {
          return reply(409, { message: "That email already has an account. Link an existing driver using their RigTracker Profile ID." });
        }
        if (error.code === "weak_password") return reply(400, { message: "Choose a stronger temporary password." });
        if (employeeNumber) {
          const [office, driver] = await Promise.all([
            service.from("fleet_employees").select("employee_id").eq("fleet_id", fleet.id)
              .eq("employee_id", employeeNumber).maybeSingle(),
            service.from("rigtracker_fleet_links").select("employee_number").eq("fleet_id", fleet.id)
              .eq("employee_number", employeeNumber).is("unlinked_at", null).maybeSingle(),
          ]);
          if (office.data || driver.data) return reply(409, { message: "That employee number is already in use." });
        }
        return reply(502, { message: "Could not create the driver account. Try again." });
      }
      if (!data?.user) return reply(502, { message: "Could not confirm driver account creation. Check linked profiles." });
      const { data: profile } = await service.from("rigtracker_profiles").select("profile_id")
        .eq("user_id", data.user.id).maybeSingle();
      return reply(201, { profileId: profile?.profile_id });
    }
    default:
      return reply(400, { message: "Select a fleet profile action." });
  }
});
