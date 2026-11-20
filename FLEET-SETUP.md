# Fleet Admin setup

Apply the migration in `supabase/migrations/20261120094000_fleet_accounts.sql` to the Supabase project used by RigTracker Pro. Then deploy the `create-fleet-employee` Edge Function. Do both before publishing the new `index.html`.

From this branch, an operator already authenticated to the Supabase CLI with project deployment access can run:

```sh
supabase link --project-ref pxxikzzfrcncwufpzdfp
supabase db query --linked --file supabase/migrations/20261120094000_fleet_accounts.sql
supabase functions deploy create-fleet-employee --no-verify-jwt
```

The SQL Editor can apply the migration when the CLI is unavailable. The function verifies the caller's bearer token with Supabase Auth and checks fleet ownership before creating an employee. Supabase provides its service-role key to the function automatically. Keep that key in Supabase.

After setup, sign in as **Fleet Admin** and set your Fleet ID if prompted. A new Fleet Admin enters the ID during sign-up. Create an employee using a one- to six-digit ID and a password. The employee signs in under **Employee** with their generated username, such as `tts-000123`, and password.

Before merging, verify that the admin can create an employee, that the employee can sign in without an email, and that the employee cannot create profiles or view the admin's roster. The old fleet sample data is local to each browser and doesn't transfer to the new system.
