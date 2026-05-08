# 11 — Tenant Lifecycle: Onboarding, Offboarding, Suspension, and the Status Machine

> **Pre-reqs:** Read 00, 05, 06, 07, and 08 first. 00 establishes vocabulary (tenant, slug, KV, R2, Worker). 05 covers the Cloudflare product map (Pages, Workers, KV, D1, R2, Containers, SaaS hostnames, Tunnel). 06 covers the customer-side push agent install. 07 covers the nightly cron pipeline. 08 covers the trust chain — why each tenant's secret has to be isolated from every other tenant's container.
>
> **What you'll know by the end:** The four states every tenant lives in (`provisioning`, `active`, `suspended`, `offboarding`) and the rules for moving between them. A copy-pasteable 16-step onboarding checklist you can run when your first paying customer signs. The 30-day grace period for offboarding and why same-day deletion bites you. How a one-line status edit replaces "delete config and re-create it later" for suspensions. The three-tenant rule for dev (cross-references 08). How to schema-version your tenant config so 50-tenant migrations are boring. Seven pitfalls that have eaten teams in the wild.

This doc is the operational counterpart to the architectural ones. 05–08 explain *how the machine is built*. This doc explains *how you operate it day to day*: what to do when a customer signs, when one cancels, when one's check bounces, and when you need three fake tenants on your laptop to catch isolation bugs.

The most valuable artifact here is the onboarding checklist in §10. If anything else has to be cut for length, it's not the checklist.

---

## 1. Vocabulary primer (the new terms in this doc)

00 already defined tenant, slug, subdomain, Worker, KV, R2, schema, Zod. Here are the operational terms that show up first in this doc.

- **Status machine** — a small set of named states plus the rules for moving between them. Like a traffic light: red, yellow, green, and you can't jump between them arbitrarily. Every tenant has a `status` field that names which state they're in.
- **Denylist** — a fixed list of slugs you refuse to issue. `admin`, `api`, `www`, `login`, etc. — strings that would shadow real routes if a customer claimed them. Opposite of an allowlist.
- **Wildcard DNS / wildcard cert** — a DNS record that matches every subdomain (`*.app.example.com` covers `acme.app.example.com` and so on). With a wildcard TLS cert, you don't add a DNS row or issue a cert per tenant. Defined in 05.
- **CNAME flatten** — a Cloudflare feature that lets you put a CNAME at the apex of a domain (`example.com`, not just `www.example.com`). Not load-bearing here; worth knowing the term.
- **Grace period** — the delay between "customer cancels" and "we actually delete their data." Like the recycle bin asking "are you sure?" — except 30 days long.
- **JIT** ("just-in-time") — doing a thing the moment it's needed, not ahead of time. Used here for credential delivery: you don't email the temp password until the customer is ready to log in.
- **Smoke test** — a quick narrow check that "the basic thing works at all." Loading `acme.app.example.com` in incognito and seeing the SPA render is a smoke test.
- **Manifest** — a small index file that points at other files. In 07 the per-tenant manifest at `r2://powerfab-tenants/<slug>/inspections/manifest.json` says "the current snapshot is `2026-05-07.json`."
- **Signed download link** — a URL that grants temporary access to a file, signed by us, expiring after a window (we use 7 days). Used in offboarding exports.
- **Idempotent** — running it twice produces the same result as running it once. The migration script in §8 is idempotent.

---

## 2. The framing: tenants have a status machine

Every tenant in PowerFab Dashboard is in exactly one of four states at any moment. The state is a string in `tenants/<slug>.json`, validated by Zod, checked by Worker middleware on every request.

```
                            (new customer signs)
                                    |
                                    v
                            +---------------+
                            | provisioning  |
                            +-------+-------+
                                    | (smoke test passes)
                                    v
                            +---------------+
                            |    active     |<-----+
                            +---+---------+-+      |
                                |         |        | (reactivate)
            (customer cancels)  |         | (non-payment / hold)
                                |         |        |
                                |         v        |
                                |    +---------+   |
                                |    |suspended|---+
                                |    +----+----+
                                |         |
                                |         | (account closed)
                                v         v
                            +---------------+
                            |  offboarding  |
                            +-------+-------+
                                    | (30-day grace expires)
                                    v
                            +---------------+
                            |    deleted    |
                            +---------------+
                            (config file removed,
                             secret deleted, R2
                             prefix deleted)
```

A few rules baked into the diagram:

- **`provisioning` is the only entry state.** Brand-new tenants always start here, never at `active`.
- **`suspended` is reversible; `offboarding` is not** (getting back from `offboarding` to `active` is a re-onboard from scratch).
- **`deleted` isn't really a state in the JSON file** — it's the absence of the file. Named for clarity.

Why bother with this framing? Because every operation reduces to "edit the status field, do the right side effects." Onboarding: create file at `provisioning`, do work, flip to `active`. Suspending: flip to `suspended`. Offboarding: flip to `offboarding`, wait 30 days, delete. Without the status machine, each is a custom procedure. With it, they share one shape.

Analogy: the status field is a traffic light for the Worker. Green = serve the dashboard. Yellow = serve a lockout page. Red = serve a "this account is closed" page. The Worker reads the light; it doesn't need to know *why*.

**Before** (no status field): suspending means deleting the config and re-creating it later from memory. You forget which modules they had. Reactivation is a full re-onboard.

**After** (one-line status edit): suspending is one character. Reactivation is one character. Git history shows every transition with a commit message.

---

## 3. The slug — your tenant's license plate

A **slug** is the short, URL-safe identifier for one tenant. `acme` is a slug. So is `bobs-fab`. The slug is in DNS (`acme.app.example.com`), in R2 prefixes (`r2://powerfab-tenants/acme/`), in the secret name (`TENANT_ACME_DB_PASSWORD`), and in user records. **Once issued, slugs are immutable.** Like a license plate: once it's on the car and registered with the state, you don't change it without going through the DMV.

Slug rules:

- lowercase `a–z`, digits `0–9`, hyphens only
- must start with a letter
- 3 to 30 characters
- must not appear in the reserved-word denylist (full list in §4)
- must not collide with an existing `tenants/<slug>.json`

Naming convention: company name, lowercased, dashes between words.

- "Acme Steel Fabrication" → `acme-steel` (or just `acme` if it's available and unambiguous)
- "Bob's Fab Shop" → `bobs-fab`
- "Crucible Manufacturing Co." → `crucible`

Two real Acme Corps signing up six months apart is the most common collision. Don't reuse slugs ever — DNS, R2 prefix, user records, secrets, and old logs are all keyed on the slug. Either append a discriminator (`acme-tx` for the Texas one, `acme-pa` for the Pennsylvania one) or assign sequentially (`acme-1`, `acme-2`). Pick one convention up front, write it down, stick to it. Otherwise future-you will fight past-you over whether `acme-2` means "the second Acme" or "the upgraded Acme account."

Renaming a slug after issuance is technically possible — it's a partial offboard plus an onboard — but it's painful enough that you'll only do it if a customer is changing their legal name and absolutely needs the new identifier. For typo'd slugs caught within minutes, sure, fix it. For a slug that's been live a week with real users, live with it.

---

## 4. The reserved-word denylist

The denylist is a fixed array in the validator that rejects any slug matching a reserved word:

```
admin, api, app, www, mail, auth, login, static, cdn, docs,
status, support, billing, internal, staging, dev, test,
preview, dashboard
```

Categories: admin/dashboard routes (`admin`, `dashboard`), service routes (`api`, `auth`, `login`), habit-typed prefixes (`app`, `www`), spoofable identifiers (`mail`), likely future internal subdomains (`static`, `cdn`, `docs`, `support`, `status`), sensitive routes (`billing`, `internal`), and environment names (`staging`, `dev`, `test`, `preview`).

The denylist lives in the same file as the Zod tenant schema. CI runs it on every PR (§6 step 4). A customer asking for `admin` gets a polite "we reserve that one." Don't grant exceptions — slugs are immutable, so a one-time favor is forever (pitfall #4 in §11).

---

## 5. The tenant config file

Before walking the onboarding sequence, here's the shape of the file you're building. This is what `tenants/acme.json` looks like by the end of step 3.

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

Line-by-line:

- `"schemaVersion": 1` — which version of the tenant schema this conforms to. Bumped in §10 when the shape changes.
- `"slug": "acme"` — the immutable identifier from §3.
- `"displayName"` — UI label. Mutable; the slug stays the same.
- `"status": "provisioning"` — the state-machine field. Starts at `provisioning`, flipped to `active` at the end of onboarding.
- `"modules"` — which of the seven panels this tenant has paid for. Mutable; add/remove is a config edit plus deploy.
- `"branding"` — `logoUrl` (defaults `null`, shows the PowerFab logo) and `primaryColor` (accent). We deliberately don't add layout customization (anti-pattern in 04).
- `"createdAt"` — ISO 8601 timestamp. Audit field; never edit by hand.
- `"ingest"` — bookkeeping for the nightly job (07). `agentVersion` is the version of the customer-side push agent we last saw; `lastRunAt` is the last successful run. Both `null` at creation; the nightly job updates them.

Zod enforces every one of these. A typo in `enabeledModules` (extra `e`) fails the parse. A `status` of `"actve"` fails. CI runs the parse on every PR. This schema is the single most valuable guardrail we have.

---

## 6. Onboarding playbook (the 12-step sequence)

This is the path from "Acme signed the contract" to "Acme logs in and sees yesterday's data." Twelve steps, in order. The same content collapsed into a copy-pasteable checklist is in §10.

You're aiming for "Acme can log in by Friday afternoon." Most of the steps are five-minute tasks. The two slow ones are step 5 (waiting for IT to create the read-only DB user) and step 7 (the customer's IT installing the push agent). Both depend on a person on the customer side, so start them early.

### Step 1: Pick a slug

Follow the rules in §3. Verify against the denylist. Verify no `tenants/<slug>.json` exists. Confirm with the customer in writing ("your URL will be `acme.app.example.com` — confirm?"). You don't want to be three steps in before discovering they wanted something else.

### Step 2: DNS

Nothing to do, in the recommended path. The wildcard DNS record on `*.app.example.com` (set up once in 05) absorbs any new subdomain. Cloudflare for SaaS issues TLS from the wildcard cert with no API call.

The alternative — one A record per tenant via the Cloudflare API — works too, and you'd reach for it if you ever offer custom domains per tenant (`dashboard.acmesteel.com`). That's Cloudflare for SaaS Custom Hostnames territory. Defer until asked. The step exists in the checklist so you actually verify the wildcard is working — first onboards otherwise spend an hour debugging "the Worker isn't running" when really DNS isn't.

### Step 3: Create `tenants/acme.json`

Copy the shape from §5. Set `status` to `provisioning` (not `active`). Set `createdAt` to now in ISO 8601. Leave `ingest.agentVersion` and `ingest.lastRunAt` as `null` — the nightly job populates them after step 8. The Worker checks status on the first request and serves a "setup in progress" page until you flip to `active` at step 12.

### Step 4: Validate

Run locally:

```
pnpm validate:tenants
```

`pnpm` is the package manager. `validate:tenants` is a script in `package.json` that invokes the Zod schema against every file in `tenants/*.json`. CI runs the same check on PR — two gates, same schema, no typo survives both. The validator should also enforce the denylist and slug regex.

### Step 5: Coordinate the read-only DB account

Email the customer's IT contact: "we need a read-only SQL Server user named `powerfab_dashboard` with `SELECT` on these specific tables (`job`, `inspection`, `time_entry`, ...). Send the password back via 1Password share or signed encrypted email — never plain Slack." 06 has the full table list and the least-privilege SQL.

This is one of the long-pole steps — IT may take a day or three. Start it the moment the contract is signed.

### Step 6: Store the credential in Cloudflare secrets

When the password is back, run:

```
wrangler secret put TENANT_ACME_DB_PASSWORD --env production
```

Walk:
- `wrangler` — Cloudflare's CLI.
- `secret put` — sets a secret. Prompts for the value interactively, on purpose, so it doesn't end up in your shell history.
- `TENANT_ACME_DB_PASSWORD` — the secret name. **Convention: `TENANT_<SLUG_UPPER>_DB_PASSWORD`.** The Container picks the right secret at job start by reading `TENANT_${slug.toUpperCase()}_DB_PASSWORD`.
- `--env production` — push to production, not staging.

The naming convention is load-bearing: it's the only thing keeping Acme's password out of Bob's container. Each Container gets only the secret matching its slug. See 08 for the full trust-chain reasoning — this is the most security-relevant line in the playbook.

### Step 7: Install the push agent (or tunnel for pilots)

Primary path: ship the C# .NET 8 push agent installer. Customer IT installs it as a Windows Service; it phones home with a one-time enrollment token tied to the slug. 06 has the full install playbook including the firewall conversation.

Fallback for the first two pilots (or any customer where the agent isn't ready yet): Cloudflare Tunnel on a small box inside their network. Outbound-only, so IT doesn't have to open inbound ports. 05 §13 covers Tunnel.

Second long-pole step. Customer IT may schedule the install for "next week's maintenance window."

### Step 8: Trigger the first nightly run manually

Don't wait for the 2 a.m. cron. Manually invoke:

```
wrangler dispatch nightly-job --tenant acme
```

`wrangler dispatch` invokes a Worker on demand. `nightly-job` is the Worker name from 07. `--tenant acme` scopes the orchestrator to one tenant.

Watch the logs. The Container should connect, query, write JSON to KV (hot) and R2 (archive), and exit 0. Usually under 60 seconds. Common errors:

- `bad credentials` → step 6 typo, wrong password, or IT created the user without the right `SELECT` grants.
- `connection refused` → step 7 didn't take effect.
- `schema mismatch` → customer is on a different version of the upstream system than the agent expects.

You catch all these in the daytime instead of at 9 a.m. the morning after the cron silently fails.

### Step 9: Verify the R2 manifest

Check that `r2://powerfab-tenants/acme/inspections/manifest.json` exists and its `current.json` field points to a fresh dated snapshot. Same for `time` and `production`. Missing manifest = dashboard loads but shows nothing. Logs from step 8 should tell you which step failed.

### Step 10: Smoke-test the Worker

Open `acme.app.example.com` in an **incognito** window (so you don't see a cached session from another tenant). The Worker should serve the SPA; without auth it should redirect to a login page. The display name (and logo, if set) rendering correctly proves the Zod-validated config got picked up.

### Step 11: Create the first user

```
pnpm tenant:create-admin --slug acme --email ops@acmesteel.com
```

`tenant:create-admin` writes a user record (email + tenant association) and generates a temporary password. `--slug` scopes the user to the tenant; `--email` is the admin's address. The script prints the temp password once; send it via the same secure channel as the DB credential. First login forces a password reset. The first user is always an admin and invites the rest via the in-app UI.

### Step 12: Customer logs in, sees yesterday's data

Customer logs in, confirms data. Flip `status` from `"provisioning"` to `"active"` in `tenants/acme.json`. Commit:

```
status: acme -> active (onboarded)
```

Push, deploy. Done. The nightly cron (07) picks them up; the Worker middleware serves the dashboard normally.

---

## 7. Offboarding playbook

Acme cancelled. The hard rule: **never destroy data the same day.** Always grace-period.

You might be wondering why we don't just delete the file. The reason: customers ask for "one more export" surprisingly often — their accountant needs Q3 numbers, the replacement tool's import script broke, they restart two weeks later. Each is fine if you grace-perioded; each is a panic if you hard-deleted.

Seven-step sequence:

1. **Export first.** Offer a JSON dump per module (same shape as R2 manifest, easy to generate) and optionally a CSV per module. Deliver via signed download link with 7-day expiry. Keep a copy in a separate "offboarded" R2 bucket for 90 days.

2. **Set status to `offboarding`.** Edit `tenants/acme.json`, set `"status": "offboarding"`. Commit. Worker now serves a "this account has been cancelled" page (HTTP 410) instead of the dashboard.

3. **Disable the nightly cron for this tenant.** Nothing to do — the cron handler in 07 iterates `tenants/*.json` and skips any non-`active` tenant. The status field doing real work for free is exactly why the framing pays off.

4. **Tear down the customer side.** Email IT to uninstall the push agent (or revoke tunnel credentials). Ask them to delete the read-only DB user. Their security team appreciates the explicit close.

5. **Grace period: 30 days.** Set a calendar reminder. Data still exists in R2; no jobs run; no dashboard access. If they reactivate during grace, reverse status to `active` and redo steps 5–11 of §6 — faster than a cold onboard because slug, R2 prefix, and history are intact.

6. **Destroy.** After 30 days:
   - Delete the R2 prefix (`wrangler r2 object delete --prefix tenants/acme/`). Log to `offboarding-log.md`.
   - Delete the Cloudflare secret (`wrangler secret delete TENANT_ACME_DB_PASSWORD --env production`). Most security-relevant line in the sequence — see pitfall #1.
   - Delete user accounts (`pnpm tenant:delete-users --slug acme`).
   - Remove `tenants/acme.json`. Commit `offboard: acme (30-day grace expired)`.
   - Append a row to `offboarding-log.md`: date, slug, who initiated, what was deleted.

7. **Cancel billing.** Separate system; mention last so it doesn't get forgotten.

Why 30 days specifically? Industry-standard, R2 storage during grace is essentially free (1.6 MB at $0.015/GB/month for a month is rounding error), and it absorbs the most common "wait, one more export" requests. Shorter grace periods feel cleaner and bite you in week 2.

---

## 8. Suspension playbook

Non-payment, security incident, dispute, chargeback. Goal: customer cannot access the dashboard, **but their data is preserved** so reactivation is instant.

A suspension is a one-character edit (`"active"` → `"suspended"`), commit, deploy. Reactivation is the same in reverse. No data movement, no pipeline reconfiguration.

Sequence:

1. Set `"status": "suspended"`. Commit, deploy.

2. **Middleware checks status on every request.** For `suspended`, return HTTP 402 Payment Required (semantically correct for non-payment) or 423 Locked (for security holds), with a friendly page: "Your account is suspended. Contact support." Never return 500 — that looks like an outage.

3. **Nightly job decision.** Two valid policies:
   - **Pause during suspension.** Saves Container compute. Reactivation requires a fresh manual run.
   - **Keep running up to 30 days.** Slight cost; reactivation is instant.

   Recommend the second for **non-payment** (most resolve in days; instant reactivation is a better experience) and the first for **security holds** (you want to stop pulling their data). Encode as `pauseIngestOnSuspend: boolean` in the config so the cron handler in 07 branches on it without per-incident code edits. Honest tradeoff: keeping the job running at 60 seconds of basic-tier Container per night is cents per tenant per month — small enough that customer experience wins by default.

4. **Reactivation.** Flip status back to `active`. Commit, deploy. Smoke-test. If ingest was paused, trigger a manual run (§6 step 8). Send a "you're back" email.

Middleware sketch (TypeScript, in the Worker):

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

Walk:

- `app.use(async (c, next) => { ... })` — Hono middleware. `c` is the context (request, response, env); `next()` invokes the next handler.
- `loadTenant(c.req.header("host"))` — read the `Host` header, strip the suffix to get the slug, look up the Zod-validated config from KV (or the in-memory map in MVP).
- Three `if` blocks, one per non-`active` state. Each returns immediately with a custom HTML page and a semantically appropriate HTTP code (402 / 410 / 503).
- `c.set("tenant", tenant); await next()` — for `active` tenants, attach to the request context so downstream handlers can read it, then continue the chain.

This middleware sits at `app.use('*', ...)` in front of every route except a small allowlist of public assets (favicon, lockout-page CSS — otherwise the lockout page loads CSS from a locked route and renders unstyled).

---

## 9. The 3-tenant rule for dev

In local dev, run **three** tenants — not one, not two. Full reasoning is in 08; the operational rule:

- **One tenant** catches zero isolation bugs. Hardcoded slugs, cross-tenant leaks, global caches all look fine.
- **Two tenants** catches *some* isolation bugs but can't distinguish "Acme leaks to Bob" from "Bob leaks to Acme."
- **Three tenants** triangulates. If Acme sees Bob's data while logged in as Crucible, the bug is in request handling, not a swapped pair.

Set up `tenants/acme.json`, `tenants/bobsteel.json`, `tenants/crucible.json` with distinct module configs (Acme has all three modules, Bob only `inspections`, Crucible has `time` + `production`). Seed different fake R2 data. **Visible-difference rule:** if a single screenshot can't tell you which tenant you're viewing, the test data is too similar.

In dev, all three resolve to `localhost:5173` with a `?tenant=` query param or cookie that dev-only middleware reads. In staging, they're real subdomains. 08 leans heavily on this setup.

---

## 10. Schema versioning

`schemaVersion: 1` lives in every `tenants/*.json` from day one. The Zod schema is versioned: `tenantSchemaV1` in `src/schemas/tenant.ts`. When the shape changes, you write `tenantSchemaV2` plus a migration script.

Why bother at one tenant? At five you can edit by hand; at fifty you can't. Building the habit at tenant 1 means tenant 50 is boring.

Migration script (`scripts/migrate-tenants-v1-to-v2.ts`):

```ts
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tenantSchemaV1, tenantSchemaV2 } from "../src/schemas/tenant";

for (const file of await readdir("tenants")) {
  const raw = JSON.parse(await readFile(`tenants/${file}`, "utf8"));
  if (raw.schemaVersion === 2) continue;
  const v1 = tenantSchemaV1.parse(raw);
  const v2 = tenantSchemaV2.parse({
    ...v1,
    schemaVersion: 2,
    newField: defaultForNewField(v1),
  });
  await writeFile(`tenants/${file}`, JSON.stringify(v2, null, 2));
}
```

Walk:

- `import { readdir, readFile, writeFile } from "node:fs/promises"` — Node fs APIs. This runs in Node, not in a Worker.
- `import { tenantSchemaV1, tenantSchemaV2 }` — both versions exported side by side. Don't delete v1 when you add v2.
- `for (const file of await readdir("tenants"))` — loop every JSON in `tenants/`.
- `JSON.parse(await readFile(...))` — read and parse. No validation yet.
- `if (raw.schemaVersion === 2) continue` — skip already-migrated files. This is what makes the script idempotent (§1) — re-running is a no-op, not corruption.
- `tenantSchemaV1.parse(raw)` — validate against v1. Throws if malformed.
- `tenantSchemaV2.parse({ ...v1, schemaVersion: 2, newField: defaultForNewField(v1) })` — spread v1, bump version, compute the new field's default. `defaultForNewField` is per-migration; could be `() => false` for a new boolean or derived from v1 data.
- `writeFile(..., JSON.stringify(v2, null, 2))` — write v2 back pretty-printed so git diffs are readable.

Run once locally. Inspect the diff. Commit. Bump the Worker to load `tenantSchemaV2`. Deploy. The Worker should **error loudly** if it sees a v1 file post-migration — silent fallback hides bugs (a missed file, a new tenant created with the old shape, a manual revert).

---

## 11. Common pitfalls

1. **Forgetting to delete secrets after offboarding.** Cloudflare secrets don't auto-expire. A stale `TENANT_ACME_DB_PASSWORD` is a liability — if the customer's IT didn't rotate after step 4 of §7, you're holding a working credential to their network months after they left. Make secret deletion a checklist item. Most security-relevant line in this doc.

2. **Onboarding straight to production without CI validation.** Always commit via a PR. CI runs `pnpm validate:tenants`. Bypassing the PR can ship a malformed config that crashes the Worker for *all* tenants on next deploy.

3. **Slug collisions.** Don't reuse slugs ever — DNS, R2 prefix, user records all key on them. Append a discriminator (`acme-tx` vs `acme-pa`) or sequence (`acme-1`, `acme-2`). Document the convention.

4. **No reserved-word denylist.** A customer asks for `admin` or `api` as a favor. You allow it. Now `admin.app.example.com` shadows your real admin route forever — slugs are immutable. Maintain the denylist (§4) and never grant exceptions.

5. **Hard-deleting offboarded tenants the same day.** Always grace-period. Customers ask for "one more export" surprisingly often.

6. **Status check missing on a route.** New route ships, developer forgets the status middleware, suspended tenants can hit it. **Mitigation:** middleware at the **app level**, not per-route, with an explicit allowlist for public assets. The §8 sketch sits at `app.use('*', ...)` before any route handlers.

7. **Letting the customer pick the subdomain freely.** Every subdomain is forever. One-line convention: "we use your company name, lowercased, dashes between words." Friendly, firm, in writing.

---

## 12. The worked-example onboarding checklist (the artifact)

This is the most valuable part of the doc. Copy-paste it into a Notion page or paste it into a PR description when your first customer signs.

```markdown
# Onboarding checklist: <slug>

Customer:               ____________________
Slug:                   ____________________
IT contact:             ____________________
Date contract signed:   ____________________

- [ ] Slug picked, validated against denylist and existing tenants
- [ ] DNS verified (acme.app.example.com resolves, wildcard working)
- [ ] tenants/<slug>.json created with status: "provisioning"
- [ ] pnpm validate:tenants passes locally
- [ ] PR opened, CI green, merged
- [ ] IT created powerfab_dashboard read-only DB user
- [ ] Credential delivered via secure channel (1Password / signed email)
- [ ] Credential stored: wrangler secret put TENANT_<SLUG>_DB_PASSWORD
- [ ] Push agent installed at customer (or tunnel configured for pilot)
- [ ] First nightly run triggered manually, exits 0
- [ ] R2 manifest written, current.json pointer fresh (per module)
- [ ] Worker smoke test: <slug>.app.example.com loads SPA in incognito
- [ ] First admin user created via pnpm tenant:create-admin
- [ ] Temp password sent via secure channel (same as DB credential)
- [ ] Customer logged in successfully, saw yesterday's data
- [ ] Status flipped from "provisioning" to "active", deployed
- [ ] Onboarding-log.md entry written
```

Mirror this with two shorter checklists for the other operations:

```markdown
# Offboarding checklist: <slug>

Date cancellation requested: ____________________
Reason:                      ____________________
Grace period ends:           ____________________ (cancellation date + 30 days)

- [ ] Final export generated, signed download link sent
- [ ] Export copy in offboarded-bucket for 90-day retention
- [ ] tenants/<slug>.json status set to "offboarding"
- [ ] Customer IT notified, push agent uninstall confirmed
- [ ] Customer IT confirmed read-only DB user deleted
- [ ] Calendar reminder set for day 30
- [ ] (Day 30) R2 prefix tenants/<slug>/ deleted, command logged
- [ ] (Day 30) Cloudflare secret TENANT_<SLUG>_DB_PASSWORD deleted
- [ ] (Day 30) User accounts deleted via pnpm tenant:delete-users
- [ ] (Day 30) tenants/<slug>.json removed, commit landed
- [ ] (Day 30) offboarding-log.md entry written
- [ ] Billing subscription cancelled
```

```markdown
# Suspension checklist: <slug>

Date suspended: ____________________
Reason:         ____________________ (non-payment / security hold / dispute)

- [ ] tenants/<slug>.json status set to "suspended"
- [ ] pauseIngestOnSuspend set per policy (true for security, false default)
- [ ] Customer notified by email (template: account-suspended)
- [ ] Reactivation criteria documented in suspension-log.md
- [ ] (On reactivation) Status flipped back to "active"
- [ ] (On reactivation) Manual nightly run triggered if ingest was paused
- [ ] (On reactivation) Smoke test in incognito
- [ ] (On reactivation) "You're back" email sent
```

These three checklists are the operational core of the doc. Print them, paste them, copy them into your team wiki. They're the thing you'll reach for at 8 a.m. on a Monday after a contract signed over the weekend.

---

## 13. By the end of this doc you should know

- The four states a tenant is in: `provisioning`, `active`, `suspended`, `offboarding` — and the rules for moving between them.
- The slug rules and the reserved-word denylist, and why slugs are immutable.
- The 12-step onboarding sequence end to end, and which steps are long-poles (5 and 7).
- The secret-naming convention `TENANT_<SLUG_UPPER>_DB_PASSWORD` and why it's the only thing keeping one tenant's password out of another tenant's container (cross-reference 08).
- The 30-day offboarding grace period and what specifically gets deleted on day 30.
- The two suspension policies (`pauseIngestOnSuspend` true vs false) and which to recommend for which suspension reason.
- The middleware pattern that turns `status` into "served dashboard / served lockout / served setup-in-progress" with a single `if`-chain.
- The 3-tenant rule for dev and why 1 or 2 tenants doesn't catch isolation bugs.
- How to schema-version the tenant config so a 50-tenant migration is boring.
- The seven pitfalls — especially #1 (delete secrets after offboarding) and #4 (no slug exceptions ever).
- The three operational checklists in §12, ready to copy.

If any of those still feel hazy, scroll back. The status-machine framing in §2 is the keystone — if that's clear, everything else slots in around it.

---

**Next:** Phase 3: 12-local-dev-and-deploy.md (coming next) — local dev environment with three fake tenants, the `localhost:5173?tenant=` middleware, the deploy pipeline from `git push` to live `*.app.example.com`, and how staging fits in between.
