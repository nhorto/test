# Research Brief: 08-data-isolation.md

**Audience:** Solo dev (Nick), new to multi-tenant SaaS, building PowerFab Dashboard on Cloudflare with subdomain-per-tenant routing.
**Purpose:** The doc Nick re-reads every time he adds a feature, to verify isolation isn't broken.

---

## 1. The Mental Model: The Tenant ID Trust Chain

Multi-tenancy has exactly one job: **Acme's users see Acme's data, and never anyone else's.** Everything else is plumbing.

The keystone idea is the **trust chain for "what tenant is this request for?"** A request involves two answers to that question, and they must agree:

| Source | Where it comes from | Trust level |
|---|---|---|
| **Claimed tenant** | The subdomain the browser sent, plus any query string, header, or body field | Untrusted — the user controls all of it |
| **Authenticated tenant** | The tenant ID baked into the user's signed session (JWT or signed cookie) | Trusted — we signed it |

**The fundamental rule:** On every request, derive both values, compare them, and reject with `403` if they differ. No exceptions, no shortcuts, no "this endpoint is internal so it's fine."

If this comparison ever gets skipped, every other layer below it is doing the wrong work for the wrong tenant. That's why this check lives at the Worker — the very first thing that touches the request.

A second, deeper rule: **never use the claimed tenant to address data.** The subdomain is fine for routing the request, but the R2 key, the KV prefix, the D1 `WHERE` clause must always be built from the **authenticated tenant**. The claimed value is just a UX cue — "the user thinks they're on Acme" — that we then verify.

---

## 2. Layer 1 — Worker / Edge

The Cloudflare Worker is PowerFab's security boundary. It is the only place where the trust chain check happens; nothing downstream re-validates.

### What the Worker does, in order

1. Parse the `Host` header → extract subdomain (`acme` from `acme.app.example.com`).
2. Look up the tenant slug in the tenant registry (KV or static map). If unknown subdomain → `404`.
3. Verify the auth token (JWT signature, expiry, issuer).
4. Extract `token.tenant` from the verified claims.
5. Compare `subdomain_tenant === token.tenant`. If mismatch → `403`.
6. Attach the **authenticated tenant** to the request context (e.g., `c.set('tenant', 'acme')`).
7. From this point on, every handler reads the tenant from context, never from the URL/headers/body.

### The classic attack this stops

A user logs in at `acme.app.example.com`, captures their session cookie, changes the URL to `bobsteel.app.example.com`, and replays the cookie. The browser dutifully sends it (cookies can be scoped to `*.app.example.com`). Step 5 above catches it: the JWT says `tenant: acme`, the subdomain says `bobsteel` → `403`.

### Pseudocode pattern (Hono-style) for the doc to reference

The explainer should show roughly:

- Middleware that runs on every route.
- Reads `Host`, extracts subdomain, calls `resolveTenant(subdomain)`.
- Reads `Authorization` or cookie, calls `verifyJwt(token)`.
- Throws `403` if `tenant.slug !== claims.tenant`.
- Sets `c.set('tenant', tenant)` for downstream handlers.

Show this once, near the top of the doc, then refer back to "the middleware" everywhere else.

### Why edge-layer enforcement matters

If the check were in the React app, every attacker would skip it. If it were in a per-route handler, Nick would forget it on his 17th endpoint. Single chokepoint at the Worker = one place to audit, one place to fix.

---

## 3. Layer 2 — R2 Path-Based Isolation

R2 is a flat object store. There are no per-prefix ACLs in R2 as of 2026 — the Worker either has the binding or doesn't, and that binding can read/write anything in the bucket.

**That means the application is the entire gatekeeper for R2.** It works because the Worker is the only thing with the binding, and the Worker always builds the key from the authenticated tenant.

### The key convention

```
tenants/<slug>/snapshots/<date>/<module>.json
tenants/<slug>/exports/<filename>
tenants/<slug>/uploads/<id>
```

Every R2 read or write is built like:

```
const key = `tenants/${c.get('tenant').slug}/snapshots/${date}/${module}.json`;
```

Note: `c.get('tenant')` is the **authenticated** tenant from middleware, not anything the client sent.

### The bug pattern to internalize

```ts
// BUG — instant cross-tenant leak
app.get('/snapshot', (c) => {
  const tenant = c.req.query('tenant');           // attacker-controlled
  return r2.get(`tenants/${tenant}/snapshots/...`); // serves any tenant
});
```

The fix is one line — `const tenant = c.get('tenant').slug` — but it's the kind of thing a tired solo dev writes without thinking. Every R2 access in code review must be checked: **where did the slug in the key come from?**

### Limitations of path-based isolation

- A bug in the Worker = full leak. There's no second wall.
- Listing operations (`r2.list({ prefix: 'tenants/acme/' })`) work fine, but a buggy `r2.list()` with no prefix would return everything. Always pass an explicit per-tenant prefix.
- Lifecycle rules and deletions are also bucket-wide; admin scripts must scope themselves.

### Why this is fine in practice

For 5–200 tenants of low-sensitivity manufacturing data, application-level isolation with one Worker chokepoint is the industry norm. The alternative (one R2 bucket per tenant) creates 200 buckets, 200 bindings, 200 lifecycle policies — operationally worse for the actual risk profile.

---

## 4. Layer 3 — KV and D1 Isolation

### KV

Same pattern as R2: prefix every key with the tenant slug.

| Use | Key shape |
|---|---|
| Layout config | `config:acme:layout` |
| Metric definitions | `config:acme:metrics` |
| Feature flags | `flags:acme` |
| Session cache | `session:<jwt-jti>` (tenant-implicit via JWT) |

Server derives the prefix from `c.get('tenant')`. Never accept a key, or even a partial key, from the client.

### D1

D1 is SQLite. It has no row-level security in the PostgreSQL sense — there's no `CREATE POLICY` as of 2026. **Tenant isolation is pure application discipline.**

The discipline:

1. Every tenant-scoped table has a `tenant_id` column, indexed.
2. Every `SELECT`, `UPDATE`, `DELETE` includes `WHERE tenant_id = ?`.
3. Every `INSERT` sets `tenant_id` from the authenticated tenant.

This is the layer where one forgotten `WHERE` clause leaks every tenant's data. It happens. The mitigation is to remove the chance to forget.

### The tenant-scoped DB wrapper pattern

Wrap the D1 binding in a small helper that auto-injects the tenant:

```ts
function tenantDb(db, tenantId) {
  return {
    select: (sql, params) => db.prepare(`${sql} AND tenant_id = ?`).bind(...params, tenantId),
    insert: (table, row) => db.prepare(...).bind({ ...row, tenant_id: tenantId }),
    // ...
  };
}
```

In handlers, you only ever get a `tenantDb` instance — there's no path to the raw `db` binding. Forgetting the `WHERE` becomes structurally hard rather than just discouraged.

### Cross-tenant queries (admin only)

Operations like "count all jobs across all tenants" exist (for billing, observability). Those use a separate, explicitly-named API (`adminDb.unsafeCrossTenantQuery(...)`) that requires admin auth and logs every call. The naming is deliberately ugly to prevent it being used by mistake.

---

## 5. Layer 4 — Auth / Session

### What the JWT must contain

| Claim | Why |
|---|---|
| `sub` (user ID) | Identifies the user |
| `tenant` (slug) | The keystone — server-signed, can't be forged |
| `roles` | What the user can do within their tenant |
| `iat`, `exp` | Issued-at, expiry |
| `iss` | Issuer (PowerFab auth) |

The JWT is signed with PowerFab's private key. Users see the token but can't modify the `tenant` claim without invalidating the signature.

### Re-issuing tokens

If a user moves between tenants (rare at MVP), the user must log out and back in. The new token has the new `tenant` claim. Don't try to "switch tenants" inside an existing session — that path is where bugs live.

### Multiple users per tenant

Normal and expected. All Acme employees have JWTs with `tenant: acme`. Their `sub` differs, their `roles` may differ, but their `tenant` is identical. Nothing special.

### A user belonging to two tenants

**Out of scope for MVP.** Document this loudly. If/when needed, the model is: each user has one JWT per tenant, the user explicitly chooses which tenant they're operating in (separate login session), and tokens never overlap.

---

## 6. Layer 5 — Frontend / React

The injected `<script type="application/json" id="tenant-config">` block in the HTML carries the tenant's layout, enabled modules, and theme.

**Client-side checks are UX, not security.** Repeat this until it's reflex:

| Frontend does | Worker does |
|---|---|
| Hides module X tab from Bob's UI | Refuses to serve module X data to a Bob token |
| Greys out the export button | Returns `403` if Bob calls the export endpoint |
| Routes `/dashboard` differently per tenant | Validates tenant on every `/api/*` call |

If the frontend is the only thing stopping access, anyone with the developer console can bypass it in 30 seconds.

### The pitfall

A new feature gets a feature flag. The React app respects the flag and hides the button. But the new `/api/v1/new-feature` endpoint was added without going through the tenant middleware, or its handler reads the tenant from the query string. Now any tenant can call it.

**Rule:** Every new API endpoint goes through the tenant middleware before any handler-specific logic. Make the middleware global, not per-route, so it can't be skipped.

---

## 7. Layer 6 — Logging and Error Reporting

### Logs

Every log line includes:

- `tenant` (slug)
- `user_id`
- `request_id`
- `route`

Structured JSON, not free-form strings. This way, when triaging "Acme reports the dashboard is slow," Nick filters by `tenant=acme` and gets exactly Acme's traffic.

### Errors

Errors are the most common accidental leak. A 500 error that returns a database row in the body to "help debugging" leaks data. A stack trace logged to a shared Sentry project that includes a JSON payload with another tenant's data leaks data.

Defenses:

| Concern | Practice |
|---|---|
| Error response body | Generic message + `request_id` only. Never the failed query, row, or payload. |
| Stack trace storage | Scrub before sending. Strip request bodies, query params containing IDs, response bodies. |
| Sentry-style tools | Tag every event with `tenant`, but never include other tenants' data in the event itself. |
| Aggregation across tenants | Allowed for counts/rates. Forbidden for individual records or PII. |

---

## 8. Layer 7 — Backups, Exports, Support Tools

When Nick (the only operator) downloads a snapshot to debug Acme's issue, the file is named `acme-2026-05-07-snapshot.json` and lives in a folder labeled by tenant. **Mixing exports from multiple tenants in one folder is how cross-tenant leaks happen during support work.**

### Admin tools that span tenants

A future "ops dashboard" that shows all tenants' health metrics is legitimate. It must:

1. Live on a separate subdomain (`ops.example.com`) or be gated behind a separate auth flow.
2. Use admin-only JWTs that don't carry a `tenant` claim — they carry an `admin: true` claim instead.
3. Log every cross-tenant access with the admin user ID and the tenant accessed.
4. Never share code paths with the tenant-scoped app.

The principle: a normal user-grade auth must never be able to read across tenants. Crossing the boundary requires explicitly-different auth, explicitly-different code, and an audit log.

---

## 9. Concrete Attack Patterns and Defenses

| # | Attack | Defense layer | What stops it |
|---|---|---|---|
| 1 | Subdomain swap with stolen cookie | Worker (Layer 1) | `subdomain.tenant !== token.tenant` → `403` |
| 2 | URL `?tenant=` tampering | R2/KV/D1 (Layers 2-3) | Server ignores the param; uses `c.get('tenant')` from JWT |
| 3 | Hand-crafted tenant header (`X-Tenant: bobsteel`) | Worker + handlers | All handlers ignore client-supplied tenant headers |
| 4 | JWT replay across tenants | Auth (Layer 4) | JWT is signed; replaying it on another subdomain still fails Layer 1's compare |
| 5 | Path traversal in tenant slug (`../bobsteel`) | Tenant resolver | Strict regex on slug (`/^[a-z0-9-]{3,32}$/`); never use raw subdomain in a path |
| 6 | SQL injection putting different `tenant_id` in WHERE | D1 wrapper | All queries parameterized; tenant injected by wrapper, not interpolated |
| 7 | Race condition during tenant switch | Auth (Layer 4) | No in-session switching; user must log out and back in |
| 8 | Cache poisoning across tenants | Edge cache | Cache key includes tenant slug; never cache tenant-scoped responses without the slug |
| 9 | Filename collision in shared storage | R2 (Layer 2) | Tenant prefix in every key — no shared namespace exists |
| 10 | Error message leaking internal shape | Logging (Layer 6) | Generic error bodies; full details only in scrubbed server logs |
| 11 | Forgotten endpoint missing middleware | Worker (Layer 1) | Middleware mounted globally on `/*`, not per-route |
| 12 | Admin tool re-used by a normal user | Admin tooling (Layer 7) | Separate subdomain, separate auth, separate code paths |

---

## 10. Testing Isolation

### Synthetic cross-tenant test (CI smoke test)

The doc should specify exactly this test, runnable in CI:

1. Seed three tenants: `acme`, `bobsteel`, `crucible`.
2. Create one user per tenant.
3. Log in as Acme's user, save the JWT.
4. With Acme's JWT, hit every read endpoint while spoofing each of: `Host: bobsteel.app.example.com`, `?tenant=bobsteel`, `X-Tenant: bobsteel`, `body: { tenant: 'bobsteel' }`.
5. Every single response must be `403` or "no data found for Acme."
6. Repeat for write endpoints — every one must reject.
7. Repeat the same matrix with each tenant pair.

Run on every PR. If isolation breaks, this test catches it before merge.

### Cross-tenant fuzzing (basic)

A test that, for each endpoint, mutates the tenant identifier in every place a tenant identifier appears in the request and asserts the result is identical (i.e., the mutation had no effect, because the server only reads the JWT). Even a 30-line version of this catches 80% of regressions.

### Manual quarterly audit

Once a quarter, Nick walks through the routes file with this doc open and checks each endpoint against Layer 1–7. Boring, but it's how isolation stays correct as the codebase grows.

---

## 11. The 3-Tenant Rule

**With 1 tenant in the system, isolation bugs are invisible.** Every query "works." Every R2 key resolves. The dashboard renders. There's nothing to compare against.

**With 3 tenants, every isolation bug is obvious within minutes.** Acme's user sees Bob's job count. The export download contains Crucible's data. The dashboard module list is wrong.

Recommendation in the doc: **Nick should run dev with 3 dummy tenants from day one** — `acme`, `bobsteel`, `crucible` — each with distinct, recognizable data (different job counts, different shop names, different colors). Switch between them constantly during development. The first time the wrong tenant's data renders, the bug catches itself.

This is cheaper than any test, any audit, any framework. It is the single highest-leverage practice for a solo dev building multi-tenant software.
