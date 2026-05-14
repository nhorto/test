# 11 — Tenant Lifecycle: Onboarding, Updating, Suspending, and Offboarding

> **Prerequisites:** read 00, 01, 02, 05, 06, 09, and 10 first.

> **By the end of this doc you will know:** the four states every tenant moves through (`provisioning`, `active`, `expired`, `offboarded`) and how transitions work in the new desktop world. The full onboarding checklist (a copy-pasteable 14-step playbook) when your first paying customer signs. How to update an existing tenant's config or gateway. How to suspend (let the license expire) and offboard (delete the bundled config) cleanly. The pitfalls that catch teams in the wild.

This doc is the operational counterpart to the architectural ones. 05–10 explain *how the machine is built*. This doc explains *how you operate it day to day*: what to do when a customer signs, when one cancels, when one's check bounces.

The most valuable artifact here is the onboarding checklist in §4. If anything else has to be cut for length, it's not the checklist.

---

## 1. Vocabulary primer

- **Tenant slug** — the lowercase, hyphenated short name for the customer (`acme`). Picked at onboarding, never changed.
- **License key** — the signed JWT we mint, hand to the customer, that proves their installs are "Acme" (doc 01).
- **Gateway** — the small service that runs on a machine inside the customer's network, holds the DB creds, serves metric data (doc 05).
- **Bearer token** — the per-tenant secret shared between the gateway and the license keys (doc 10).
- **Status** — every tenant has a `status` field in your internal tracking (a spreadsheet, an Airtable, a small DB — your call). Statuses are `provisioning`, `active`, `expired`, `offboarded`.
- **Smoke test** — a quick narrow check that "the basic thing works at all." Activating the app on a freshly-installed laptop and seeing the dashboard render is a smoke test.

---

## 2. The tenant status machine

```
                +-----------+
                | provision-|
                |   ing     |
                +-----+-----+
                      |
       license key signed,
       gateway deployed,
       config bundled in next release
                      |
                      v
                +-----------+
                |  active   |<------+
                +-----+-----+       |
                      |             | renewal
        license       |             | (new key
        expiry        |             |  issued)
                      v             |
                +-----------+       |
                |  expired  +-------+
                +-----+-----+
                      |
        opt-in: leave them be (they can keep using
                if they reactivate)
                      |
                      v
                +-----------+
                | offboarded|
                +-----------+
```

Three transitions matter:

1. **provisioning → active** — first license key issued, customer installs and successfully activates. The onboarding checklist (§4) makes this transition explicit.
2. **active → expired** — natural license expiry, or we deliberately don't renew (suspension). The customer's existing installs stop working at midnight on the expiry day. They can't get into the dashboard.
3. **expired → offboarded** — we go in and clean up their entry from our records, remove their bundled config (next release), revoke gateway access.

Notice what's *not* in the machine: a "suspended" state. In the new architecture, "suspension" is just "don't issue a new license key when the current one expires." The license-key expiry is the natural mechanism. No code path needed.

---

## 3. Why the desktop world is simpler than the web one

In the old web plan, lifecycle work was constant: routes to add to DNS, certs to provision, configs to push to KV, snapshots to back up, accounts to suspend in a database. The tenant's data lived on infrastructure we ran, so we had to actively maintain it.

In the new plan:

- The tenant's data lives on **their** infrastructure (their gateway, their database). We never have it.
- The tenant's config either ships in our binary or is fetched from us — either way, we control it through the same Git workflow we already use for code.
- Activation is a one-time thing per laptop, not an ongoing session.

So lifecycle becomes: **mint license keys, help them stand up a gateway, occasionally update or revoke.** That's it. No "is this tenant currently active in our DB?" check on every request — the license is the answer.

---

## 4. The onboarding checklist (a fab shop signs)

Here's the 14-step playbook. Run through it in order; each step should take a few minutes. The whole thing is usually a half-day if the customer is responsive.

**Pre-reqs:** the customer has agreed to terms, you have their primary IT contact, and they've confirmed they have a Windows server (or capable Linux machine) on their LAN that can run the gateway.

### Onboarding checklist

- [ ] **1. Pick a tenant slug.** Lowercase, hyphenated, stable forever. `acme-steel`, not `Acme Steel Inc.`. Pick something short that the customer will recognize in support tickets. **Avoid reserved words** (test, demo, admin, dev) — keep a small list of these to refuse.

- [ ] **2. Pick a `tenantId`.** Generate a fresh ULID or UUID. Prefix it (e.g., `tnt_01HZX3K...`). Goes in their config. Never displayed.

- [ ] **3. Get the gateway's network address from the customer's IT.** They'll tell you either a LAN IP (`10.0.5.20`) or a local DNS name (`gateway.acme.local`). Whatever it is, this string ends up in the license key payload as `gateway_url`. Pick a port (8080 is fine).

- [ ] **4. Generate a per-tenant bearer token.** A long random string (64+ chars). `python -c 'import secrets; print(secrets.token_urlsafe(48))'` is fine.

- [ ] **5. Mint the license key.** Run the signing tool:

   ```bash
   $ npx tsx tools/sign-license.ts \
       --tenant acme-steel \
       --gateway-url http://10.0.5.20:8080 \
       --bearer-token "$BEARER" \
       --days 365
   eyJhbGciOiJFZERTQSJ9...
   ```

   Save the key in your records (the same place you track customer accounts). Don't email it yet — wait until step 11.

- [ ] **6. Create their config file.** Add `src/tenants/acme-steel.json` to the repo:

   ```jsonc
   {
     "schemaVersion": 1,
     "tenantId": "tnt_01HZX3K2A8N1B...",
     "slug": "acme-steel",
     "enabledModules": [/* whatever they paid for */]
   }
   ```

   Open a PR. CI runs `npm run validate:tenants`. Merge when green.

- [ ] **7. Deploy the gateway to the customer.** Hand the customer's IT:
   - The gateway installer (or container image, or whatever you're shipping — doc 12 covers the build).
   - A config template (`/etc/gateway.env` or `config.yaml`) with placeholders for `DATABASE_URL` and `GATEWAY_BEARER_TOKEN`.
   - The bearer token from step 4.
   - The exact SQL `GRANT` statements from doc 06 §3 for the DBA to run.

   Schedule a short remote session to install, configure, and test. Goal of the session: gateway is running, can connect to the DB, returns 200 for `GET /health`.

- [ ] **8. Smoke test the gateway from the gateway machine.**

   ```bash
   $ curl -H "Authorization: Bearer $BEARER" \
       http://10.0.5.20:8080/metrics/time/monthly-hours
   {"metric": "time.monthly-hours", "data": [...], "fetched_at": "..."}
   ```

   If this works, the gateway is set up correctly.

- [ ] **9. Build and publish the new dashboard release.** Now that `src/tenants/acme-steel.json` is in `main`, CI builds installers including their config. Push the release through the normal channel (doc 12 / doc 13). Wait for the update manifest to publish.

- [ ] **10. Install on a test laptop in the customer's network.** Either a laptop you remote into, or one their IT controls. Run the installer, activate with the license key from step 5, watch the dashboard render.

- [ ] **11. Hand off to the customer.** Email IT with:
   - Their license key (clearly labeled as confidential).
   - Download link for the installer.
   - A short "first-time activation" guide (3 lines: install, paste key, click Activate).
   - Who to contact for support.

- [ ] **12. Mark the tenant `active` in your tracking.**

- [ ] **13. 7-day check-in.** Email the customer a week later. Ask if everything's working. Especially: are the numbers right? (Catches gateway query bugs that look fine in a smoke test but are wrong for their real data.)

- [ ] **14. 30-day check-in.** Same email, looking for slower-burning issues (auto-update working? new employees onboarded smoothly? performance acceptable?).

Done. The customer is live. The whole flow involved exactly one piece of infra we run (CI + update server); the rest happens on the customer's side.

---

## 5. Updating an existing tenant

A live customer wants something changed. Examples and how to handle them.

### 5.1 They want to add or remove a module

Edit `src/tenants/acme-steel.json`. Bump nothing, no schema change. Open PR. CI validates. Merge. New installer goes through auto-update to all their laptops within ~24 hours (auto-updater polling cadence — doc 12 §4).

If they need it *today*: skip the auto-updater, hand them a direct download link to the freshly-built installer. They reinstall, immediate.

### 5.2 They want to add a custom metric

Two paths:

- **Metric only they need.** Add the metric to the registry (`src/registry/metrics.ts`), add the gateway endpoint, add `"addMetrics"` to their config. Same release flow.
- **Metric others might need too.** Add it as a normal optional metric, list them in `addMetrics`. Easier to give to a second tenant later.

### 5.3 Their gateway moves to a new IP

Their IT changes the LAN address. License keys say `http://10.0.5.20:8080`; new address is `http://10.0.7.50:8080`.

Two options:

- **Reissue the license key** with the new gateway URL. Push to all their laptops. Old laptops with old keys won't reach the gateway and will surface a "gateway unreachable" banner — their IT helps re-activate.
- **Or: set up a local DNS name** the customer's IT can repoint. License key has `http://gateway.acme.local:8080`; IT changes DNS to point at the new IP. No license reissue needed.

The second is much better for any customer with even a small IT team. Recommend it during onboarding.

### 5.4 Their license is about to expire

Mint a new license key (step 5 above), send it to IT, they push to laptops. Old keys keep working until expiry; new keys take over before expiry. Zero downtime.

### 5.5 Their bearer token is compromised

(Worst case — a laptop got stolen and you want to be safe.)

1. Generate a new bearer token.
2. Update the gateway config and restart the gateway (handles incoming auth with the new token).
3. Mint a new license key with the new bearer token, ship to all laptops.
4. Old keys stop working at the moment the gateway restarts. There's a small window where some laptops have the old key — they'll see "gateway unreachable" until they get the new license.

Plan a short maintenance window for this. 15 minutes, end of day.

### 5.6 They want to add new employees

Just hand new employees the installer link and their existing license key. No central provisioning needed.

---

## 6. Suspensions (the "their check bounced" case)

You don't pay → your license doesn't renew. That's it.

When the license expires, the app drops to the activation screen and says "Your license key expired on <date>. Contact support." All employees see this on next launch.

You don't have to *do* anything on the day of suspension. The expiry is baked into the JWT. No "suspension API" to call.

If they pay up: mint a new key, hand it over, employees re-activate. Back to normal.

This is the operational simplicity of the offline-signed license model. The dark side: if you accidentally mint a 10-year key, you can't easily revoke it. Default to 1-year expiries.

---

## 7. Offboarding (they're really gone)

When a customer is truly leaving, not coming back:

- [ ] **1. Mark them `offboarded` in your tracking.**
- [ ] **2. Don't mint any more license keys for them.**
- [ ] **3. Let the current license expire** (or, if it's far in the future, plan a short notice email and live with the expiry date).
- [ ] **4. Next release after expiry: remove `src/tenants/<slug>.json` from the repo.** Bundled configs no longer include them.
- [ ] **5. Confirm with the customer that they've uninstalled** from their laptops. They probably have. The app won't work anyway with an expired license, but it's polite to ask.
- [ ] **6. They handle their own gateway.** We never had their data; they keep their DB; they remove the gateway machine (or leave it idle).

That's it. No "wipe their data from our infrastructure" because we never had any.

### 7.1 What if they want their data exported?

We don't have any of their data. Their dashboard read from their own DB. The data is, and always was, theirs. The only thing they might want from us is "what queries did the dashboard run against our DB?" — give them the gateway source (or just the queries), or point them at the gateway machine which they own.

---

## 8. Bulk operations (renaming a metric across all tenants)

Covered in doc 04 §5. To summarize: rename in the registry; CI catches every tenant config that mentions the old ID; you go fix them in one PR; build a new release; auto-updater rolls it out.

There's no "migrate every tenant's KV entry" step because there's no KV. Every tenant's config lives in our repo until offboarded. Mass changes are just Git commits.

---

## 9. Schema versioning

The `schemaVersion` field (doc 02 §2.1) is for backward-incompatible schema changes. The pattern:

1. Define `v2` with the new shape.
2. Write the migration `v1 → v2` in `loadTenantConfig`.
3. Update your test fixtures.
4. Optionally: in the next release after every active tenant has updated to a recent app version, retire the v1 schema and tighten validation.

Old releases keep working with v1 configs. New releases work with both. No 200-tenant cutover.

---

## 10. The dev "three-tenant rule"

Even though each install is single-tenant, you (the developer) should regularly test the app with at least three tenants in dev. Why:

- Catches per-tenant assumptions that accidentally hardcode to one customer.
- Forces you to think about onboarding when you change config structure.
- Surfaces UI bugs that happen when `enabledModules` is short vs. full.

The dev license-signing tool (doc 01 §6.1) makes this trivial: keep three `*.json` configs (`acme`, `bigshop`, `briansbeams`) and switch between activations with the `DEV_TENANT` env var.

---

## 11. Seven pitfalls

### 11.1 Reusing a slug

If you offboard `acme` and later a different customer wants to be `acme`, **don't reuse the slug.** Old keys, old configs, old support tickets are all tied to it. Use `acme-2` or `acme-corp`. Slugs are forever.

### 11.2 Issuing a license without an expiry

Don't. Always set `--days`. 365 is the default for paying customers; 30 for trials. A license with no expiry can never be revoked.

### 11.3 Sharing one bearer token across tenants

One leak = every gateway is compromised. Always per-tenant.

### 11.4 Updating a gateway without warning the customer

The gateway is on their hardware. A surprise update can break things their IT doesn't expect. Coordinate gateway updates with the customer's IT — not auto-update like the desktop app.

### 11.5 Onboarding without the smoke test

Step 8 (curl the gateway with the bearer token) is non-negotiable. If you skip it, the first sign of failure is the customer activating and seeing "gateway unreachable" everywhere. Embarrassing.

### 11.6 Hand-editing tenant configs in production

Always go through a PR. Always run `validate:tenants` in CI. The whole config-driven UI premise depends on this discipline.

### 11.7 Not tracking which version each tenant is on

The auto-updater is great but customers can lag (laptops not online, updates failing). A small admin tool that pings each gateway's `/health` and asks "what client versions are talking to you?" is a high-leverage day-of-week project once you have 20+ tenants.

---

## 12. By the end of this doc you should know

- The four-state status machine: provisioning, active, expired, offboarded.
- The 14-step onboarding checklist for a new fab shop.
- How to update a live tenant: config changes, gateway moves, bearer token rotation, new employees.
- That suspension is "the license expires naturally" — no separate code path.
- The clean offboarding flow: expire, remove from bundled configs, no data wipe needed (we never had it).
- The dev "three-tenant rule" and how to enforce it in your local dev loop.
- The seven pitfalls — slug reuse, no-expiry licenses, shared bearer tokens, surprise gateway updates, skipping smoke tests, hand-edited configs, not tracking versions.

---

**Next:** [`12-local-dev-and-deploy.md`](./12-local-dev-and-deploy.md) — running Tauri in dev mode, building installers for Windows/Mac/Linux, and the painful (but necessary) code-signing dance.
