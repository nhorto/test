# 08 — Data Isolation: What Still Needs Care When Each Install Is Single-Tenant

> **Prerequisites:** read `00-start-here.md`, `01-tenant-resolution.md`, `05-cloudflare-architecture.md` (Tauri architecture), and `06-customer-data-ingest.md`.

> **By the end of this doc you will know:**
> - Why the *big* cross-tenant leak risks from the old web plan **mostly disappear** in the desktop architecture, because each install is single-tenant by default.
> - The four ways tenant data can still leak in the new architecture: license keys, bundled configs, logs/telemetry, and the gateway's auth surface.
> - The principle: each piece of tenant data should only ever touch *that tenant's* infrastructure.
> - A short checklist to run through before shipping any feature that touches tenant data, logs, or error reporting.

---

## 1. Why this doc is shorter than the old version

In the old web plan, every tenant's data lived on shared infrastructure. The Cloudflare Worker handled requests for *all* customers; KV held *all* tenants' configs; R2 held *all* tenants' snapshots. A single bug — a missing `WHERE tenant_id = ?` clause, a wrong cache key, a logging line that printed the wrong slug — could leak Acme's data to BigShop. The old doc had 12 pages of patterns to prevent that.

In the new desktop architecture, the picture is fundamentally different:

- Each **Tauri install** is for exactly one tenant. There's no "switch tenants" in the UI. The activation flow locks the app to Acme, and that's it forever.
- Each **gateway** is for exactly one tenant. It runs inside Acme's network, holds Acme's DB credentials, serves Acme's data. It doesn't know any other tenants exist.
- Each **database** is the customer's own. We don't have a "shared database with a tenant_id column" — there's no shared anything.

So the entire class of "row-level isolation in a shared database" bugs is gone. We literally don't have a shared database.

What's left is a smaller, more boring list of things you can still get wrong. This doc is that list.

---

## 2. The leak surfaces that remain

There are four places where tenant data can still leak in the new architecture. None of them is exotic; all of them are easy to handle once you know to look.

### 2.1 License keys getting reused or shared

A license key for Acme says, in its payload, `{ "tenant": "acme", "gateway_url": "http://10.0.5.20:8080" }`. If that key gets pasted on a BigShop employee's laptop:

- The app activates as Acme.
- It tries to fetch from `10.0.5.20:8080` — Acme's gateway URL.
- If BigShop happens to be on the same network or has reachability, they now see Acme's data.

This is the closest the new architecture has to a "cross-tenant" leak.

**Mitigations:**

- License keys should be treated as confidential — sent only to the tenant's IT person, not posted in customer support tickets, not pasted into shared documents.
- Bake the gateway URL into the license key (we do — §1 of doc 01) so that even a leaked key needs network reachability to the gateway. Across-the-internet networks won't have it.
- Per-tenant bearer tokens (§2.4 below) so even if a key reaches a different tenant's network, it can't authenticate to a different gateway.
- Short license expirations (12 months) so a leaked key has a bounded blast radius.

### 2.2 Bundled configs containing other tenants' settings

If you went with Option A in doc 02 §6 — bundling all `tenants/*.json` into the app — every install contains every tenant's config. That config is just module/metric IDs and slugs; it's not customer data. But it does reveal:

- The list of all your customers' slugs.
- Each customer's enabled modules and metric overrides.
- Their `tenantId` strings.

For most fab shops this is not sensitive ("Acme uses Inspections" is not a secret), but for some customers it might be ("we found out Customer X is on the basic tier from poking around the installer"). Worth knowing.

**Mitigations:**

- Migrate to Option B (fetched configs) when this matters. Doc 02 §6.2. Each install then only ever sees its own tenant's config.
- Don't put genuinely sensitive material in the config. Configs are not the place for connection strings, internal slugs, or anything you wouldn't want a competitor to read.

### 2.3 Logs, telemetry, and error reports leaking customer data

This is the most likely real-world leak. The flow:

1. Acme employee uses the dashboard.
2. Something goes wrong — say a chart fails to render because a JSON field is unexpectedly null.
3. The app captures an error report. The report includes a stack trace and (often) the data that caused the error.
4. That report gets sent to your error-reporting service (Sentry, Bugsnag, whatever).
5. Now the error report contains *Acme's actual data* — job numbers, part names, time entries, dollar amounts.

You now hold customer data on infrastructure they didn't agree to.

**Mitigations:**

- **Default to NOT sending data from the desktop app to any external service** unless the customer has explicitly opted in.
- If you have error reporting, scrub it ruthlessly: stack traces only, never values. Library: most error reporters have a `beforeSend` hook to filter.
- Log to the gateway's local disk, not to our cloud. The gateway is inside the customer's network — logs there are "their" logs.
- If a customer asks for support, ask them to attach their gateway log file to the ticket. They're sending it; they're consenting.
- Telemetry (usage counts, performance metrics) should be aggregated and de-identified before leaving the customer. "Acme rendered 27 metrics in 4.2 seconds" should leave the customer as "tenant rendered N metrics in T seconds, version X.Y.Z" — without the slug. Doc 14 covers this.

### 2.4 The gateway's bearer token: per-tenant, not global

The gateway requires a bearer token on every request. If we use the *same* bearer token for every customer's gateway, then anyone who extracts the token from one tenant's app can call any tenant's gateway (provided they can reach it).

**Mitigations:**

- Generate a unique bearer token per tenant during onboarding.
- Embed the token in that tenant's license key (so it travels with the activation).
- The gateway only accepts its own tenant's token.
- Rotate the token by reissuing the license key + updating the gateway config (doc 11 covers this).

This is the gateway-side equivalent of the "tenant claim" check from the old multi-tenant trust chain. Each request to a gateway carries proof that it's for *that* tenant; the gateway only trusts its own token.

---

## 3. The principle: a tenant's data only touches their infrastructure

If you internalize one rule from this doc, make it this:

> **Acme's data should never sit on a computer that any other tenant could ever access.**

That means:

- Acme's data goes from Acme's DB to Acme's gateway to Acme's employees' laptops. Period.
- Acme's logs live on Acme's gateway. Or, if forwarded somewhere, on infra dedicated to Acme.
- Acme's error reports — if you collect any — should not contain Acme's actual data fields. Stack traces only.
- Our update server (which is shared infrastructure) never sees any customer data. Only installer downloads.
- Our license-signing server (which is just your laptop / password manager) only sees tenant slugs and gateway URLs, never customer data.

Anywhere you find yourself thinking "we'll just save it to a central place to look at later" — that's the moment to stop and ask whether that central place becomes a target.

---

## 4. The pre-feature checklist

Before merging any feature that touches tenant data, run through this:

1. **Where does the data come from?** If it's the gateway, fine. If it's another tenant's gateway, that's a bug.
2. **Where does the data go?** If it stays in the webview / gets rendered on screen, fine. If it gets sent anywhere, ask why.
3. **What happens on error?** Is the error report going to contain a row of the customer's data? If yes, sanitize.
4. **What does it log?** If you're logging a metric value, you're logging the customer's data. Decide whether the log line ever leaves their network.
5. **What does the test suite touch?** If your test fixtures contain "real-looking" Acme data and they're committed to the repo, that data is now on every dev's laptop. Use synthetic fixtures.

That's the whole checklist. Five questions. Run through them quickly; usually nothing's wrong, but the discipline matters.

---

## 5. What the old isolation patterns mapped to (the migration)

The old doc had seven "isolation layers." Here's where each one lands in the new world, just so you have the cross-reference:

| Old layer | New equivalent | Notes |
|---|---|---|
| Worker (chokepoint check on every request) | Gateway (auth check on every request) | Same idea — single bouncer at the edge |
| R2 (per-tenant prefixes) | Each customer's own DB | No shared store |
| KV / D1 (`tenant_id` in keys / rows) | n/a | No shared store |
| Auth / JWT | License key activation + bearer token to gateway | Per-tenant tokens |
| Frontend (don't trust client-side tenant claims) | n/a-ish | Frontend is locked to one tenant by activation; nothing to mis-claim |
| Logging (always include tenant slug, never confuse) | Gateway-local logs | Stay on the tenant's network |
| Backups / admin tooling | n/a — we don't have backups | Customer backs up their own DB |

Most of the rows collapse to "n/a" because we removed the shared infrastructure. The two that remain (gateway auth, logging) are §2.3 and §2.4 above.

---

## 6. A note on multi-tenant laptops (rare, but real)

What if one person works for two fab shops and wants both dashboards on the same laptop?

Two reasonable answers:

- **Make them install twice with different app IDs.** Tauri's app identifier (in `tauri.conf.json`) is set at build time. You could ship a "Dashboard A" build and a "Dashboard B" build. Heavy.
- **Add a "switch tenant" feature later.** Each tenant's activation lives in a separate file. The activation screen has a "previously activated:" list. Switching tenants reloads the app.

For Day 1, just say "one install per tenant per machine." If someone genuinely needs two, they install two copies under different paths. Cross that bridge if a customer brings it up.

---

## 7. The cross-tenant CI test (and why it's almost a no-op)

In the old plan, a CI test would simulate "Acme's session, asking for BigShop's data" and assert the response was 403. Important because the shared infrastructure made cross-tenant access *possible*; the test ensured it was *forbidden*.

In the new plan, that test is almost meaningless because the access isn't even structurally possible. The Tauri app's `fetch_metric` command knows only its own gateway URL (read from `activation.json`). There's no way to request data from a different tenant — the desktop app doesn't have any other gateway URLs to send to.

The closest CI test that still makes sense:

```rust
#[test]
fn fetch_metric_uses_activation_gateway_url() {
    // Given an activation.json with gateway_url = "http://10.0.5.20:8080",
    // fetch_metric should call that URL, not some default or hard-coded value.
    // Regression test for "did we hard-code a gateway URL somewhere?"
}
```

That's still worth having. It catches the "developer accidentally hard-coded a URL during debugging" failure mode.

---

## 8. By the end of this doc you should know

- Why the new architecture eliminates most cross-tenant leak risks at a structural level.
- The four leak surfaces that remain: license-key sharing, bundled-config exposure, logs/telemetry, gateway auth tokens.
- The single rule: a tenant's data only ever touches that tenant's infrastructure.
- A five-question pre-feature checklist for anyone shipping a change that touches tenant data.
- Why per-tenant bearer tokens matter even though each gateway only serves one tenant.

Print this checklist and stick it next to your monitor anyway — even though the surface is smaller, the cost of getting it wrong is still high.

---

**Next:** [`09-data-fetching.md`](./09-data-fetching.md) — the React → Tauri → gateway call path in detail. Caching, retries, offline behavior, and what to show in the UI while data loads.
