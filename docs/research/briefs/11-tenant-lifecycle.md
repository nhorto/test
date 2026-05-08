# Research Brief: 11-tenant-lifecycle.md

## Purpose and Audience

This explainer teaches a solo developer (Nick) how to operate the day-to-day lifecycle of a multi-tenant SaaS — onboarding new shops, offboarding departing ones, suspending bad actors or non-payers, and keeping a clean dev environment. This is the operational counterpart to the architectural explainers (05 Cloudflare arch, 06 data ingest, 07 nightly job, 08 isolation trust chain). It assumes the reader already understands the stack but has never personally onboarded a paying customer to a SaaS they own.

The deliverable a reader should walk away with: a literal copy-pasteable checklist they can run when the first real customer signs the contract, plus enough mental model to handle the edge cases (slug collisions, suspensions, schema migrations) without panicking.

## Framing Concept: Tenants Have a Status Machine

Every tenant in PowerFab Dashboard is in exactly one of four states at any moment:

- `provisioning` — config file exists, infrastructure not fully wired yet. Worker returns "setup in progress" page.
- `active` — normal operation. Nightly job runs, dashboard serves.
- `suspended` — locked out, data preserved. Worker serves a friendly lockout page. Nightly job decision depends on policy (see suspension section).
- `offboarding` — cancellation in progress. Dashboard locked, grace period running, data scheduled for deletion.

This status field lives in `tenants/<slug>.json`, validated by Zod, and is checked by Worker middleware on every request. The whole explainer should be framed around this state machine because it makes the rest of the lifecycle easy to reason about — every event is just a state transition plus some side effects.

## Section 1: Onboarding a New Tenant

The end-to-end sequence from "Acme signed the contract" to "Acme logs in and sees yesterday's data." Cover this as ordered prose first, then collapse into the worked-example checklist at the end of the doc.

### Step 1: Pick a slug

Slug rules:
- lowercase a-z, 0-9, hyphens only
- must start with a letter
- 3 to 30 characters
- must not appear in the reserved-word denylist: `admin`, `api`, `app`, `www`, `mail`, `auth`, `login`, `static`, `cdn`, `docs`, `status`, `support`, `billing`, `internal`, `staging`, `dev`, `test`, `preview`, `dashboard`
- must not collide with an existing `tenants/<slug>.json`

Recommend the convention "company name, lowercased, dashes between words" (`acme-steel`, `bobs-fab`). For collisions between two real Acme Corps, append a city or a number: `acme-steel-tx`, `acme-steel-2`. Once issued, slugs are immutable — they're in DNS, in R2 prefixes, in user records. Renaming is a partial offboard plus onboard.

### Step 2: DNS

With Cloudflare for SaaS plus a wildcard `*.app.example.com` CNAME flatten, no per-tenant DNS work is needed — the wildcard absorbs `acme.app.example.com` automatically. This is the recommended path. The alternative (one A record per tenant via the Cloudflare API) means a DNS API call on every onboard, which works but adds a failure mode. Pick the wildcard.

If using a custom domain per tenant later (say `dashboard.acmesteel.com` instead of the subdomain), that's where Cloudflare for SaaS Custom Hostnames earns its keep — but defer that until a customer actually asks. MVP is subdomain only.

### Step 3: Create tenants/acme.json

Full shape (Nick should already have this from 05):

```json
{
  "schemaVersion": 1,
  "slug": "acme",
  "displayName": "Acme Steel Fabrication",
  "status": "provisioning",
  "modules": ["inspections", "time", "production"],
  "branding": { "logoUrl": null, "primaryColor": "#1f2937" },
  "createdAt": "2026-05-07T00:00:00Z",
  "ingest": { "agentVersion": null, "lastRunAt": null }
}
```

Status starts at `provisioning` — flips to `active` only at the end after the smoke test.

### Step 4: Validate

Run `pnpm validate:tenants`. This invokes the Zod schema against every file in `tenants/*.json`. CI runs the same check on PR. If it fails, the file never lands. This is the single most valuable guardrail — it catches typos in module names, missing fields, malformed branding colors, and schemaVersion drift before they hit production.

### Step 5: Coordinate the read-only DB account

Email the customer's IT contact. They create a SQL Server user named `powerfab_dashboard` with `SELECT` on the specific tables defined in 06 (job, inspection, time_entry, etc.). They send the password back via a secure channel (1Password share, signed encrypted email — never plain Slack/email).

### Step 6: Store the credential in Cloudflare secrets

```
wrangler secret put TENANT_ACME_DB_PASSWORD --env production
```

Naming convention: `TENANT_<SLUG_UPPER>_DB_PASSWORD`. The Container picks the right secret by reading `TENANT_${slug.toUpperCase()}_DB_PASSWORD` at job start. This convention matters — it's the only thing keeping Acme's password from being readable inside Bob's nightly job. See 08 for the full trust-chain reasoning.

### Step 7: Install the push agent (or tunnel for pilots)

Primary path: ship the C# .NET 8 push agent installer to the customer's IT, they install it as a Windows Service, it phones home with a one-time enrollment token. Fallback for the first two pilot customers: Cloudflare Tunnel running on a small box inside their network, which exposes the SQL Server to our Container. See 06 for the full agent install playbook.

### Step 8: Trigger the first nightly run manually

Don't wait for the 2am cron. Manually invoke:

```
wrangler dispatch nightly-job --tenant acme
```

(Or whatever the actual invocation ends up being in 07.) This catches credential typos, network issues, schema mismatches in minutes instead of next morning. Watch the logs, confirm the Container exits 0.

### Step 9: Verify R2 manifest

Check that `r2://powerfab-tenants/acme/inspections/manifest.json` exists and `current.json` points to a fresh dated snapshot. If the manifest is missing, the dashboard will serve nothing — the agent ran but the upload failed.

### Step 10: Smoke-test the Worker

Open `acme.app.example.com` in an incognito browser. The Worker should now load the SPA. Without auth, it should redirect to a login page. The fact that the Worker resolves the slug and serves something tenant-specific (logo, name) is the test that the Zod-validated config got picked up.

### Step 11: Create the first user

Run an admin script (`pnpm tenant:create-admin --slug acme --email ops@acmesteel.com`) that writes the user record and sets a temporary password. Send the temp password via the same secure channel as the DB credential. First login forces a password reset. The first user is always an admin and can invite others.

### Step 12: Customer logs in, sees yesterday's data

Last step: flip `status` from `provisioning` to `active` in `tenants/acme.json`. Commit. Deploy. Done.

## Section 2: Offboarding a Tenant

Acme cancelled. The hard rule: never destroy data the same day. Always grace-period.

Sequence:

1. **Export first**. Customer asks for their data — offer a JSON dump per module (matches the R2 manifest format, easy to generate) and optionally a CSV per module for the non-technical folks. Generate via a script that reads R2 and writes a zip. Deliver via signed download link (Worker-authenticated, 7-day expiry). Keep a copy of the export in a separate "offboarded" R2 bucket for 90 days in case they ask again.
2. **Set status to offboarding**. Edit `tenants/acme.json`, set `status: "offboarding"`. Commit. Worker now serves a "this account has been cancelled" page instead of the dashboard.
3. **Disable the nightly cron for this tenant**. The cron handler in 07 already iterates `tenants/*.json` and skips any tenant whose status is not `active`. So this happens automatically — no extra step. Worth calling out because it's an example of the status field doing real work.
4. **Tear down the customer side**. Email IT, ask them to uninstall the push agent (or revoke the tunnel credential if it's a pilot). Delete the read-only DB user from their side. Their security team will appreciate the closure email.
5. **Grace period: 30 days**. Set a calendar reminder. During grace, data still exists in R2, status is `offboarding`, no jobs run, no dashboard access. Customer can ask for "one more export" up until day 30.
6. **Destroy**. After 30 days:
   - Delete the R2 prefix `r2://powerfab-tenants/acme/` (one CLI command, but log it).
   - Delete the Cloudflare secret `TENANT_ACME_DB_PASSWORD`.
   - Delete user accounts associated with `acme`.
   - Remove `tenants/acme.json` from the repo, commit with message `offboard: acme (30-day grace expired)`.
   - Write an entry in an `offboarding-log.md` (date, slug, who, what was deleted) — this is the audit trail.
7. **Billing**. Cancel their subscription in the billing system. Out of scope for this doc but mention it as the last step so it doesn't get forgotten.

The grace period is the critical decision. The alternative (delete same day) feels clean but bites you the first time a customer says "wait, our accountant needed Q3 numbers, can you re-export?" — and you can't. Thirty days is industry-standard and short enough that R2 storage cost is negligible.

## Section 3: Suspending a Tenant

Non-payment, security incident, dispute, or chargeback. The goal: customer cannot access the dashboard, but their data is preserved so reactivation is instant.

Sequence:

1. Set `tenants/acme.json` `status: "suspended"`. Commit, deploy.
2. Worker middleware checks status on every request. For `suspended`, return HTTP 402 Payment Required (semantically correct for non-payment) or 423 Locked (for security holds), with a friendly HTML page: "Your account is suspended. Contact support@example.com." Never return a 500 — that looks like an outage and triggers support tickets from the wrong direction.
3. **Nightly job decision**. Two valid policies:
   - **Pause the job during suspension**. Saves Container compute. Reactivation requires a fresh manual run before data is current.
   - **Keep running for up to 30 days**. Slightly more cost, but reactivation is instant — they pay, you flip status, dashboard immediately shows current data.
   
   Recommend the second policy for non-payment (most suspensions resolve in days) and the first for security holds (where you want to stop pulling their data while you investigate). Encode this as a `pauseIngestOnSuspend: boolean` in the tenant config.
4. **Reactivation**. Flip status back to `active`. Commit, deploy. Smoke-test the dashboard. If ingest was paused, trigger a manual nightly run to catch up. Send the customer a "you're back" email.

Middleware sketch:

```ts
app.use(async (c, next) => {
  const tenant = await loadTenant(c.req.header("host"));
  if (tenant.status === "suspended") {
    return c.html(suspendedPage(tenant), 402);
  }
  if (tenant.status === "offboarding") {
    return c.html(offboardingPage(tenant), 410);
  }
  if (tenant.status === "provisioning") {
    return c.html(provisioningPage(tenant), 503);
  }
  c.set("tenant", tenant);
  await next();
});
```

This middleware sits in front of every route except a small set of static assets (favicon, lockout-page CSS).

## Section 4: The 3-Tenant Rule for Dev

Why three, not one or two:

- **One tenant** in dev catches zero isolation bugs. Code that hardcodes the slug, leaks data across tenants, or uses a global cache will all look fine.
- **Two tenants** catches *some* isolation bugs (you'll notice if Acme's data shows up under Bob), but doesn't catch a class of bugs where the second tenant's data gets shown to the first because of a "first match wins" cache or list ordering. With two, you can't tell which one is the bug.
- **Three tenants** triangulates. If Acme sees Bob's data when logged in as Crucible, you know the bug is in the request handling, not just a swapped pair.

Set up: create `tenants/acme.json`, `tenants/bobsteel.json`, `tenants/crucible.json` with realistic-but-distinct module configs (Acme has all three modules, Bob has only inspections, Crucible has time + production). Seed each with different fake R2 data. The visible-difference rule: if you can't tell which tenant you're viewing from a single screenshot, you've made the test data too similar.

In `dev`, all three resolve to `localhost:5173` with a `?tenant=` query param or a cookie that the dev-only middleware reads. In `staging`, they're real subdomains.

Cross-reference 08 — the trust chain explainer leans heavily on this.

## Section 5: Schema Versioning

`schemaVersion: 1` lives in every `tenants/*.json` from day one. The Zod schema is versioned: `tenantSchemaV1`. When the shape changes, you write `tenantSchemaV2`, plus a migration:

```ts
// scripts/migrate-tenants-v1-to-v2.ts
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tenantSchemaV1, tenantSchemaV2 } from "../src/schemas/tenant";

for (const file of await readdir("tenants")) {
  const raw = JSON.parse(await readFile(`tenants/${file}`, "utf8"));
  const v1 = tenantSchemaV1.parse(raw);
  const v2 = tenantSchemaV2.parse({
    ...v1,
    schemaVersion: 2,
    newField: defaultForNewField(v1),
  });
  await writeFile(`tenants/${file}`, JSON.stringify(v2, null, 2));
}
```

Run it once, commit the result, bump the Worker to load v2, deploy. The Worker should error loudly if it sees a v1 file after the migration ships — silent fallbacks hide bugs.

Why this matters: with 5 tenants you can edit by hand, but at 50 you can't. Building the migration habit at tenant 1 means tenant 50 is boring.

## Section 6: Common Pitfalls

1. **Forgetting to delete secrets after offboarding.** Cloudflare secrets don't auto-expire. A stale `TENANT_ACME_DB_PASSWORD` is a liability — if the customer's IT didn't rotate, you're holding a working credential to their network months after they left. Make secret deletion a checklist item, not an afterthought.
2. **Onboarding straight to production without CI validation.** Always commit `tenants/<slug>.json` via a PR. CI runs `pnpm validate:tenants` on every PR. If you bypass the PR (direct commit to main), you can ship a malformed config that crashes the Worker for *all* tenants on next deploy — the Worker likely loads all configs at startup.
3. **Slug collisions.** First Acme Corp gets `acme`. Second Acme Corp signs up six months later. Don't reuse slugs ever (DNS, R2 prefix, user records are all keyed on it). Either append a discriminator (`acme-tx` vs `acme-pa`) or assign sequentially (`acme-1`, `acme-2`). Document the convention so future-you doesn't argue with past-you.
4. **No reserved-word denylist.** A customer cheekily asks for slug `admin` or `api`. You allow it. Now `admin.app.example.com` shadows your real admin route. Maintain the denylist (sketched above) and check it in `validate:tenants`.
5. **Hard-deleting offboarded tenants the same day.** Always grace-period. Customers ask for "one more export" surprisingly often.
6. **Status check missing on a route.** New route ships, developer forgets to put it behind the status middleware, suspended tenants can hit it. Mitigation: middleware applies at the app level, not per-route, with an explicit allowlist for public assets. See the middleware sketch above.
7. **Letting the customer pick the subdomain freely.** Customer wants `mailroom.app.example.com` or something with a typo. Every subdomain is forever. Have a one-line convention ("we use your company name") and stick to it.

## Section 7: Worked Example Checklist (the artifact)

This is the most valuable part of the doc. Format it as a literal numbered checklist with check-boxes that Nick can copy into a Notion page or paste into a PR description when his first customer signs.

```markdown
# Onboarding checklist: <slug>

Customer: ____________________
Slug: ____________________
IT contact: ____________________
Date contract signed: ____________________

- [ ] Slug picked, validated against denylist and existing tenants
- [ ] tenants/<slug>.json created with status: "provisioning"
- [ ] pnpm validate:tenants passes locally
- [ ] PR opened, CI green, merged
- [ ] DNS verified (acme.app.example.com resolves)
- [ ] IT created powerfab_dashboard read-only DB user
- [ ] Credential stored: wrangler secret put TENANT_<SLUG>_DB_PASSWORD
- [ ] Push agent installed at customer (or tunnel configured for pilot)
- [ ] First nightly run triggered manually, exits 0
- [ ] R2 manifest written, current.json pointer fresh
- [ ] Worker smoke test: acme.app.example.com loads SPA
- [ ] First admin user created via pnpm tenant:create-admin
- [ ] Temp password sent via secure channel
- [ ] Customer logged in successfully, saw yesterday's data
- [ ] Status flipped from "provisioning" to "active"
- [ ] Onboarding-log.md entry written
```

Mirror this with a shorter offboarding checklist and an even shorter suspension checklist.

## Style notes for the writer

- Lead with the state machine framing — it makes everything else click.
- The onboarding section is the longest because it's the most operational. Resist condensing it.
- Use second-person ("you flip the status, you commit"). Nick is the operator.
- Code blocks are fine and encouraged; keep them short.
- Avoid hedging ("you might want to consider"). Make recommendations and explain the tradeoff in one sentence.
- Cross-reference 05 (Cloudflare arch / KV), 06 (data ingest agent), 07 (nightly job), 08 (trust chain) by number, not by URL.
