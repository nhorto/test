# 08 — Data Isolation: The Doc You Re-read Every Time You Add a Feature

> **This is the most security-critical doc in the series.** Multi-tenancy has exactly one job: Acme's users see Acme's data, and never anyone else's. Everything else is plumbing. The keystone idea is a single comparison — *who does the request claim to be for* vs *who has the server actually authenticated this user as* — and the rule that those two answers must agree, or the request is rejected. Re-read this doc before you ship anything that reads, writes, logs, or exports tenant data. Print it out. Tape it to the monitor.
>
> **Pre-reqs:** You should have already read `00-start-here.md` (vocabulary), `01-tenant-resolution.md` (how the URL becomes "this is Acme"), `05-cloudflare-architecture.md` (where Workers, KV, D1, R2 live), `06-customer-data-ingest.md` (how raw customer data lands), and `07-nightly-pipeline.md` (how it gets transformed into per-tenant snapshots). If any of those are fuzzy, isolation will be too — the layers below all build on the resolution and storage primitives those docs introduce.
>
> **What you'll know by the end:**
> - The **trust chain**: the difference between the tenant a request *claims* to be for and the tenant the server has *authenticated* it as, and why these must always agree.
> - Why the Cloudflare Worker is the single chokepoint where this check happens.
> - The **7 isolation layers** and the specific bug you'll see (and the fix) at each one — Worker, R2, KV/D1, auth/JWT, frontend, logging, backups/admin tooling.
> - The **classic attack** (subdomain swap with stolen cookie) and why the trust chain catches it.
> - A full attack table with 12 concrete attempts and what stops each one.
> - How to write a synthetic cross-tenant CI test that fails before bad code merges.
> - The **3-tenant rule** — the single highest-leverage practice for catching isolation bugs while developing.

---

## 1. Why this doc exists

Most bugs in a normal single-tenant web app are annoying. A button doesn't work. A chart shows the wrong number. You ship a fix on Monday.

Bugs in a multi-tenant app are different. If Acme can see Bob's Beams' job list, that's not a bug — that's a breach. Steel-fab shops compete on bid prices and customer relationships. One leak across tenants, even a small one, and your business is over before it starts. Customers won't say "let's give them a chance to fix it"; they'll cancel and tell their network.

This isn't paranoia. It's a structural property of the model. With one customer, isolation is trivially correct because there's nothing to mix up. The moment you have two, every line of code that touches tenant-scoped data has the potential to mix the wrong tenant's data into the wrong response. Multiply that by 200 tenants and 80 metrics and dozens of endpoints, and you have a vast surface area where the question "did I scope this query correctly?" must be answered *yes* every single time.

The good news: you don't have to be smart on every line. You have to set up a small number of patterns — chokepoints, wrappers, naming conventions — that make leaks structurally hard to introduce. This doc is those patterns.

---

## 2. The mental model: the trust chain

Here's the entire mental model. Memorize it.

**Every request to your app comes with two answers to the question "what tenant is this request for?"**

The two answers come from completely different sources:

| Answer | Where it comes from | Trust level |
|---|---|---|
| **Claimed tenant** | The subdomain in the URL, plus any query string, header, body field, or cookie that mentions a tenant | **Untrusted.** The user controls all of it. They can type any subdomain, set any header, send any body. |
| **Authenticated tenant** | The `tenant` claim inside the user's signed JWT (or signed session cookie) | **Trusted.** We — the server — generated and signed this token at login. The user can't modify it without invalidating the signature. |

**The fundamental rule:** On every request, derive both values, compare them, and return `403 Forbidden` if they differ. No exceptions. No "this endpoint is internal so it's fine." No "this is just the dev environment." No shortcuts.

```
   ┌──────────────────────────────────────────────────────┐
   │ Browser sends request to acme.app.example.com        │
   │                                                      │
   │   Host: acme.app.example.com    ← claimed tenant     │
   │   Cookie: pf_session=eyJhbGc... ← authenticated      │
   │                                   tenant lives in    │
   │                                   here, signed       │
   └──────────────────────────────────────────────────────┘
                         │
                         ▼
   ┌──────────────────────────────────────────────────────┐
   │ Worker (THE chokepoint)                              │
   │                                                      │
   │  1. claimed   = subdomain from Host header           │
   │  2. authenticated = verify JWT signature, read       │
   │                     `tenant` claim                   │
   │  3. if (claimed !== authenticated) → 403             │
   │  4. attach authenticated tenant to request context   │
   │                                                      │
   └──────────────────────────────────────────────────────┘
                         │
                         ▼
   ┌──────────────────────────────────────────────────────┐
   │ Every handler downstream                             │
   │                                                      │
   │  - reads tenant from context (NEVER from URL/body)   │
   │  - builds R2 keys, KV keys, D1 WHERE clauses from    │
   │    that tenant                                       │
   │                                                      │
   └──────────────────────────────────────────────────────┘
```

You might wonder: *why do we trust the JWT but not the subdomain?* Two reasons.

First, **the subdomain is just a string in the URL**. Anyone can type `bobsteel.app.example.com` into their address bar. If we used the subdomain alone to decide what data to return, we'd hand Bob's data to anyone who guessed Bob's subdomain.

Second, **the JWT is cryptographically signed by us at login**. When the user logged in, our server (after checking their password) created a token that says "this is user Sarah, employed at Acme, with these roles" and signed it with our private key. The user gets the token, but they can't change `tenant: acme` to `tenant: bobsteel` without breaking the signature — and our verification would reject the modified token.

So the subdomain tells us *what the user is asking for*. The JWT tells us *what the user has been authenticated to access*. The check that those agree is the one decision that prevents almost every cross-tenant leak.

There's a deeper rule that flows from this: **never use the claimed tenant to address data.** The subdomain is fine for routing the request and rendering the URL bar. But the R2 key, the KV prefix, the D1 `WHERE tenant_id = ?` parameter — all of those must be built from the **authenticated** tenant. The claimed value is a UX cue ("the user thinks they're on Acme"); the authenticated value is the source of truth.

If you internalize one paragraph from this doc, make it the one above.

---

## 3. The apartment-building analogy

If trust chains feel abstract, here's the real-world version.

You're the building manager of a 200-unit apartment building. The building (your app) houses many tenants (your customers). Each tenant has their own apartment (their data and view). The tenants don't share kitchens or mailboxes — Acme has their kitchen, Bob's Beams has theirs, and never the twain shall meet.

Now imagine someone walks up to the front door and says "I'd like to go up to apartment 14B." That's the **claimed** tenant — they've stated which unit they want.

You, the manager, ask: "Show me your key." The key has been issued by you, with a magnetic stripe that encodes which unit it opens. That's the **authenticated** tenant — the unit *you* assigned them when they signed the lease.

You then check: does the key actually open 14B? If the person says "I'm going to 14B" but their key opens 22C, you don't let them up. Doesn't matter how confident they sound, doesn't matter what they're carrying, doesn't matter if they yell. *The key wins*. That's the trust chain.

The mailboxes are R2 path-based isolation — every tenant's mail is stamped with their unit number, and the mail-sorting room only puts each piece in the right slot. The hallway cameras are logging. The fire-safety inspector who can enter any unit is the admin tool, with separate keys, separate procedures, and a logbook.

Hold this picture. Every layer below is one of these mechanisms.

---

## 4. Vocabulary primer

Some new words this doc uses on top of the ones from `00-start-here.md`. Skim now, refer back as you read.

- **Tenant ID** — a stable internal identifier for a tenant. Could be the slug (`acme`) or a generated ID (`tnt_01HZX3K...`). The slug is good enough for our scale; some teams use both. In this doc, "tenant ID" and "slug" are interchangeable.

- **JWT** (JSON Web Token) — a small string that encodes a JSON payload (the **claims**) plus a cryptographic signature. The browser stores it (usually in a cookie), sends it on every request, and the server verifies it. Reads as base64-encoded gibberish but the payload is just JSON.

- **Claim** — a field inside the JWT payload, like `sub` (subject = user ID), `tenant` (slug), `roles`, `exp` (expiration). When we say "the JWT's `tenant` claim," we mean the value of that field.

- **Signature** — the cryptographic proof at the end of the JWT. Computed using our server's private key. If the user changes any byte of the payload, the signature no longer matches and our verification step rejects the token.

- **Middleware** — a function that runs on every request, before the actual route handler. Hono's `app.use('*', ...)` registers middleware. The trust-chain check lives here.

- **Subdomain swap** — the classic attack: log in at `acme.app.example.com`, capture the cookie, change the URL to `bobsteel.app.example.com`, and replay the cookie. The browser will dutifully send the cookie if it's scoped to `*.app.example.com`.

- **Prefix** (in storage) — the first few characters of a storage key, used to scope data. `tenants/acme/...` prefixes Acme's R2 objects. `config:acme:...` prefixes Acme's KV entries.

- **Row-level security (RLS)** — a database feature (in PostgreSQL, etc.) that lets you write rules like "user X can only see rows where `tenant_id = X`." Postgres enforces it at the engine level. **D1 (SQLite) does not have RLS as of 2026** — you have to enforce tenant scoping in application code.

- **Defense in depth** — security philosophy: assume any one layer might fail, and add others so a single bug doesn't become a breach. The 7 layers below are exactly this.

- **Attack surface** — the set of places an attacker can poke at your system. URLs, headers, cookies, body fields, query strings, error messages, log files, backup files, admin tools — all attack surface. Reducing it (e.g., by removing client-controlled tenant fields entirely) is more valuable than guarding it.

- **Chokepoint** — a single place every request must pass through. The Worker is the trust-chain chokepoint; nothing reaches a handler without going through it. Chokepoints are how you make security tractable for a solo dev.

- **Path traversal** — an attack where the user includes `..` or other special characters in a string that becomes part of a path, escaping the intended directory. `tenants/../../../etc/passwd` style. Prevented by validating slugs against a strict regex.

- **Audit log** — a record of who did what and when, separate from regular logs. Used for sensitive operations (admin tools accessing tenant data, configuration changes). Required for any code path that legitimately spans tenants.

---

## 5. The 7 isolation layers

These are listed in order of how the request flows through your system. Every layer is a chance for things to go right (defense in depth) and a chance for them to go wrong (forgetting a check). Walk through them in order.

```
Layer 1: Worker / edge ........... THE keystone trust-chain check
Layer 2: R2 path-based isolation . tenant prefix in every object key
Layer 3: KV + D1 prefix/column ... tenant prefix in every KV key, WHERE in every query
Layer 4: Auth / JWT .............. signed `tenant` claim, no in-session switching
Layer 5: Frontend / React ........ UX-only — never trusted for security
Layer 6: Logging / errors ........ structured tenant tags, no payload leakage
Layer 7: Backups / exports / admin per-tenant filenames, separate admin auth
```

For each layer below, expect this shape: what the layer does, the bug pattern (BUG), the fix (FIX), and any honest tradeoffs.

---

### 5.1 Layer 1 — Worker / edge: the keystone check

**What it does.** The Cloudflare Worker is PowerFab's security boundary. It is the *only* place where the trust chain check happens — nothing downstream re-validates. Every request hits the Worker first; the Worker either rejects it or attaches the authenticated tenant to the request context and lets it through.

**Why here?** Single chokepoint. If the check were in the React app, every attacker would skip it (they don't have to use your React app — they can `curl` your endpoints directly). If it were in each route handler, you'd forget it on your 17th endpoint. One global middleware = one place to audit, one place to fix.

**What the middleware does, in order:**

1. Parse the `Host` header → extract subdomain → that's the **claimed** tenant slug.
2. Look up the slug in a tenant registry (KV or static map). If unknown → `404 Unknown tenant`.
3. Read the auth token (from `Authorization` header or cookie). If missing → `401 Unauthorized`.
4. Verify the JWT: signature, expiry, issuer. If any check fails → `401 Invalid token`.
5. Read `claims.tenant` — that's the **authenticated** tenant.
6. Compare: `subdomain_tenant === claims.tenant`. If they differ → `403 Forbidden`.
7. Attach the authenticated tenant to the request context (`c.set('tenant', tenant)`).
8. Call `next()` to pass the request to the actual handler.

#### Pseudocode (Hono-style), line by line

```ts
// worker/index.ts (excerpt)
import { Hono } from 'hono';
import { verifyJwt } from './auth';
import { resolveTenant } from './tenants';

type Env = { TENANTS: KVNamespace; JWT_SECRET: string };
const app = new Hono<{ Bindings: Env; Variables: { tenant: Tenant } }>();

app.use('*', async (c, next) => {
  // 1. Claimed tenant from the URL
  const host = c.req.header('host') ?? '';
  const subdomain = host.split('.')[0];

  // 2. Validate slug shape (defense vs path traversal, garbage, etc.)
  if (!/^[a-z0-9-]{3,32}$/.test(subdomain)) {
    return c.text('Bad subdomain', 400);
  }

  // 3. Resolve to a tenant record (or 404 if unknown)
  const tenant = await resolveTenant(c.env.TENANTS, subdomain);
  if (!tenant) return c.text('Unknown tenant', 404);

  // 4. Read the auth token
  const cookie = c.req.header('cookie') ?? '';
  const token = parseCookie(cookie, 'pf_session');
  if (!token) return c.text('Unauthorized', 401);

  // 5. Verify the JWT (signature, expiry, issuer)
  const claims = await verifyJwt(token, c.env.JWT_SECRET);
  if (!claims) return c.text('Invalid token', 401);

  // 6. THE KEYSTONE CHECK
  if (claims.tenant !== tenant.slug) {
    return c.text('Forbidden', 403);
  }

  // 7. Attach to context
  c.set('tenant', tenant);

  // 8. Continue to the handler
  await next();
});
```

Walking through it line by line:

- `import { Hono }` — the Worker framework from doc 01.
- `verifyJwt` and `resolveTenant` — helper modules. `verifyJwt` checks the signature and decodes claims; `resolveTenant` looks up the slug in KV.
- `type Env` — the bindings (KV namespace plus the secret used to sign JWTs). The secret never leaves the Worker.
- `Variables: { tenant: Tenant }` — declares that downstream handlers can read `c.get('tenant')` as a typed `Tenant` object. That's how the keystone value flows to the rest of your code.
- `app.use('*', async (c, next) => {` — global middleware. The `*` means every path. There is no "this route is internal so it skips middleware." You can't skip it because it's mounted globally.
- `const host = c.req.header('host') ?? ''` — the `Host` header (`acme.app.example.com`). The `?? ''` falls back if it's missing.
- `const subdomain = host.split('.')[0]` — `'acme'` from `'acme.app.example.com'`. That's the claimed tenant.
- `if (!/^[a-z0-9-]{3,32}$/.test(subdomain))` — strict regex. Lowercase letters, digits, hyphens, 3 to 32 chars. Rejects anything weird (`..`, slashes, uppercase, unicode, the empty string). This is your path-traversal defense; without it, someone could craft a subdomain that, if you ever interpolated it into a path, would escape the tenant directory.
- `const tenant = await resolveTenant(c.env.TENANTS, subdomain)` — KV lookup `tenants:acme` → tenant record. Returns `null` if no such tenant.
- `if (!tenant) return c.text('Unknown tenant', 404)` — the gate from doc 01. Unknown subdomains never reach handlers.
- `const cookie = c.req.header('cookie') ?? ''` and `parseCookie(...)` — extract the JWT from the `pf_session` cookie. (Helper omitted; it's a one-liner.)
- `if (!token) return c.text('Unauthorized', 401)` — unauthenticated requests don't get past here.
- `const claims = await verifyJwt(token, c.env.JWT_SECRET)` — verify signature, decode payload, check expiry. Returns the claims object or `null` if invalid.
- `if (!claims) return c.text('Invalid token', 401)` — bad/expired/forged tokens are rejected.
- `if (claims.tenant !== tenant.slug)` — **this is the keystone**. The claimed tenant (from the URL) must equal the authenticated tenant (from the signed token). If not, `403`.
- `c.set('tenant', tenant)` — attach the *authenticated* tenant to the request context. Downstream handlers will read this. **They never read the URL or the body to figure out which tenant.**
- `await next()` — proceed to the route handler.

That middleware, mounted globally, is the entire trust chain. Every line below in your codebase that addresses tenant-scoped data must read from `c.get('tenant')` and never from the URL or any client-controlled field.

#### BUG (the easy mistake) — checking only one side

```ts
// BUG — only verifies the JWT, never checks against the subdomain
app.use('*', async (c, next) => {
  const claims = await verifyJwt(c.req.header('cookie'));
  if (!claims) return c.text('Unauthorized', 401);
  c.set('tenant', claims.tenant);   // ← uses JWT's tenant only
  await next();
});
```

This would let Acme's user, with a valid Acme JWT, view `bobsteel.app.example.com` and the URL says "Bob's Beams" but the data is Acme's. Or worse — if any downstream handler reads the subdomain (instead of `c.get('tenant')`) to build a key, you've leaked across.

#### FIX — compare both, reject on mismatch

```ts
// FIX — the keystone check
const subdomain = c.req.header('host').split('.')[0];
const claims = await verifyJwt(c.req.header('cookie'));
if (!claims) return c.text('Unauthorized', 401);
if (claims.tenant !== subdomain) return c.text('Forbidden', 403);
c.set('tenant', { slug: claims.tenant });
await next();
```

The mismatch returns `403`, the user sees a clean error, and there's no path to data that doesn't match their token.

---

### 5.2 Layer 2 — R2 path-based isolation

**What it does.** R2 is a flat object store (think S3). There are no per-prefix permissions in R2 as of 2026 — the Worker either has the binding to the bucket or it doesn't, and that binding can read or write any object in the bucket. **That means the application is the entire gatekeeper for R2.** Isolation works because (a) only the Worker has the binding, and (b) the Worker always builds the object key from the authenticated tenant.

**The key convention.** Every R2 object lives under a tenant-scoped prefix:

```
tenants/<slug>/snapshots/<date>/<module>.json
tenants/<slug>/exports/<filename>
tenants/<slug>/uploads/<id>
```

Every read or write builds the key from `c.get('tenant').slug`:

```ts
const tenant = c.get('tenant');
const key = `tenants/${tenant.slug}/snapshots/${date}/${module}.json`;
const obj = await c.env.R2_DATA.get(key);
```

#### BUG — using a client-controlled value to build the key

```ts
// BUG — instant cross-tenant leak
app.get('/api/snapshot', (c) => {
  const tenant = c.req.query('tenant');             // attacker-controlled
  const date = c.req.query('date');
  return c.env.R2_DATA.get(`tenants/${tenant}/snapshots/${date}/time.json`);
});
```

Acme's user appends `?tenant=bobsteel` and the server happily fetches Bob's snapshot. The Worker middleware verified Acme's JWT, but the *handler* used the URL's tenant param to build the R2 key. The trust chain was bypassed at the storage layer.

#### FIX — never read the tenant from the request, always from context

```ts
// FIX
app.get('/api/snapshot', (c) => {
  const tenant = c.get('tenant');                   // authenticated
  const date = c.req.query('date');
  return c.env.R2_DATA.get(`tenants/${tenant.slug}/snapshots/${date}/time.json`);
});
```

Every R2 access in code review must answer one question: *where did the slug in the key come from?* If the answer is "from the request, indirectly," you have a bug.

#### Listing operations are the sneaky one

```ts
// BUG — lists every tenant's snapshots
const all = await c.env.R2_DATA.list();
```

`r2.list()` with no `prefix` returns *every* object in the bucket. Always pass an explicit per-tenant prefix:

```ts
// FIX
const tenant = c.get('tenant');
const all = await c.env.R2_DATA.list({ prefix: `tenants/${tenant.slug}/` });
```

#### Honest tradeoff

A bug in the Worker = full leak. There's no second wall. The alternative — one R2 bucket per tenant — gives you a true wall, but creates 200 buckets, 200 bindings, 200 lifecycle policies, 200 things to misconfigure during onboarding. For 5–200 tenants of low-sensitivity manufacturing data, application-level isolation with one Worker chokepoint is the industry norm. The chokepoint pays for itself by being one place to audit. (If your tenant data ever includes PII or financial records that change the risk profile, revisit this — at that point per-tenant buckets become reasonable.)

---

### 5.3 Layer 3 — KV and D1: prefix and column isolation

#### KV

KV is the same shape as R2: prefix every key with the tenant slug.

| Use | Key shape |
|---|---|
| Layout config | `config:acme:layout` |
| Metric definitions | `config:acme:metrics` |
| Feature flags | `flags:acme` |
| Session cache | `session:<jwt-jti>` (tenant-implicit via the JWT's unique ID) |

The Worker derives the prefix from `c.get('tenant')`. Never accept a key — or even a partial key — from the client.

#### D1 — SQLite at the edge, no row-level security

D1 is SQLite. SQLite has no row-level security in the PostgreSQL sense — there's no `CREATE POLICY` statement that says "user X only sees rows where `tenant_id = X`" enforced by the engine. **Tenant isolation in D1 is pure application discipline.**

The discipline:

1. Every tenant-scoped table has a `tenant_id` column, indexed.
2. Every `SELECT`, `UPDATE`, `DELETE` includes `WHERE tenant_id = ?` (parameterized).
3. Every `INSERT` sets `tenant_id` from the authenticated tenant.

This is the layer where one forgotten `WHERE` clause leaks every tenant's data. It happens. It happens to good engineers. The mitigation is to remove the chance to forget.

#### BUG — raw D1 binding in handlers

```ts
// BUG — handler has direct DB access; easy to forget WHERE
app.get('/api/jobs', async (c) => {
  const tenant = c.get('tenant');
  // forgot the WHERE!
  const result = await c.env.DB.prepare('SELECT * FROM jobs').all();
  return c.json(result);
});
```

Returns every tenant's jobs. The next code review might catch it, or might not.

#### FIX — the tenant-scoped DB wrapper

Wrap the D1 binding in a small helper that auto-injects the tenant. Handlers never get the raw binding.

```ts
// db/tenantDb.ts
type TenantDb = {
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
  selectOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  insert(table: string, row: Record<string, unknown>): Promise<void>;
  update(table: string, id: string, patch: Record<string, unknown>): Promise<void>;
  remove(table: string, id: string): Promise<void>;
};

export function tenantDb(db: D1Database, tenantId: string): TenantDb {
  return {
    async select<T>(sql, params = []) {
      // Append AND tenant_id = ? to every WHERE clause
      const scoped = appendTenantFilter(sql);
      const stmt = db.prepare(scoped).bind(...params, tenantId);
      const { results } = await stmt.all<T>();
      return results;
    },
    async selectOne<T>(sql, params = []) {
      const scoped = appendTenantFilter(sql);
      return db.prepare(scoped).bind(...params, tenantId).first<T>();
    },
    async insert(table, row) {
      const cols = [...Object.keys(row), 'tenant_id'];
      const vals = [...Object.values(row), tenantId];
      const placeholders = cols.map(() => '?').join(', ');
      const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`;
      await db.prepare(sql).bind(...vals).run();
    },
    async update(table, id, patch) {
      const setClauses = Object.keys(patch).map(k => `${k} = ?`).join(', ');
      const sql = `UPDATE ${table} SET ${setClauses} WHERE id = ? AND tenant_id = ?`;
      const vals = [...Object.values(patch), id, tenantId];
      await db.prepare(sql).bind(...vals).run();
    },
    async remove(table, id) {
      const sql = `DELETE FROM ${table} WHERE id = ? AND tenant_id = ?`;
      await db.prepare(sql).bind(id, tenantId).run();
    },
  };
}
```

Walking through it line by line:

- `type TenantDb` — the public surface. `select`, `selectOne`, `insert`, `update`, `remove`. **No raw `prepare` method exposed.** Handlers that want a raw `db` would have to import D1 directly, and that import would jump out in code review.
- `function tenantDb(db, tenantId)` — factory that closes over the D1 binding *and* the authenticated tenant ID. Each request gets its own `tenantDb` instance, scoped to that request's tenant.
- `async select(sql, params = [])` — public method. Takes SQL like `SELECT * FROM jobs WHERE status = ?` and an array of params.
- `const scoped = appendTenantFilter(sql)` — a helper (your job to write) that turns `WHERE status = ?` into `WHERE status = ? AND tenant_id = ?`, or adds `WHERE tenant_id = ?` if there's no `WHERE` at all. (Yes, this requires SQL parsing care; for MVP a simple regex is fine and it's only ever applied to your own queries.)
- `const stmt = db.prepare(scoped).bind(...params, tenantId)` — prepares the parameterized statement, binds the user-provided params *plus* the tenant ID at the end. The tenant ID is *never* a string interpolation — it's a parameter binding, so SQL injection on the tenant ID is structurally impossible.
- `const { results } = await stmt.all<T>()` — execute and read all rows.
- `async insert(table, row)` — every insert auto-adds `tenant_id` to the columns and the bound values. Handlers can't insert a row without a tenant ID, even if they wanted to.
- `async update(table, id, patch)` — every update has a hardcoded `WHERE id = ? AND tenant_id = ?`. Even if the handler passes a row ID belonging to another tenant, the tenant filter rejects it (zero rows updated, no error).
- `async remove(table, id)` — same shape as update. You cannot delete another tenant's row through this API.

In handlers, the only way to reach D1 is through `tenantDb`:

```ts
// handler
app.get('/api/jobs', async (c) => {
  const tdb = tenantDb(c.env.DB, c.get('tenant').slug);
  const jobs = await tdb.select<Job>('SELECT * FROM jobs WHERE status = ?', ['active']);
  return c.json(jobs);
});
```

Forgetting the tenant filter becomes structurally hard. You'd have to replace the wrapper with a raw `c.env.DB.prepare(...)` call — which jumps off the page in PR review.

#### Cross-tenant queries (admin only)

Some operations legitimately span tenants — billing summaries, ops dashboards, system-wide health metrics. Those use a *separate*, explicitly-named API:

```ts
adminDb.unsafeCrossTenantQuery('SELECT COUNT(*) FROM jobs');
```

The name is deliberately ugly. It's gated behind admin auth (Layer 7) and logs every call. If you ever see `unsafeCrossTenantQuery` in a regular handler during code review, that's a stop-the-presses moment.

---

### 5.4 Layer 4 — Auth / JWT

**What it does.** Issues the trusted half of the trust chain. Every JWT carries a `tenant` claim that's been signed with our private key, so the user can't tamper with it.

#### What the JWT must contain

| Claim | Why |
|---|---|
| `sub` | User ID. Identifies *who* the user is. |
| `tenant` | The tenant slug. The keystone — server-signed, can't be forged. |
| `roles` | What the user can do *within* their tenant (e.g., `admin`, `viewer`). |
| `iat` | Issued-at timestamp. |
| `exp` | Expiration. Force re-login periodically. |
| `iss` | Issuer (e.g., `powerfab-auth`). Lets verifiers reject tokens from elsewhere. |
| `jti` | Unique token ID. Useful for revocation lists. |

The JWT is signed with PowerFab's private key (an HS256 secret or RS256 keypair). Users see the token but can't modify any claim without invalidating the signature.

#### BUG — trusting the JWT without verifying

```ts
// BUG — decoding without verifying
const payload = JSON.parse(atob(token.split('.')[1]));
const tenant = payload.tenant;   // attacker-set
```

This *parses* the JWT but never *verifies* the signature. An attacker can craft a token with `tenant: bobsteel` and your code will believe them.

#### FIX — verify, don't decode

```ts
// FIX
import { jwtVerify } from 'jose';   // or any JWT lib
const { payload } = await jwtVerify(token, secret, { issuer: 'powerfab-auth' });
const tenant = payload.tenant as string;
```

`jwtVerify` recomputes the signature with the secret and rejects the token if it doesn't match. This is the line that turns the JWT from "untrusted bag of bytes" into "authenticated claims."

#### Re-issuing tokens

If a user moves between tenants (rare at MVP), they must log out and back in. The new token has the new `tenant` claim. **Don't try to "switch tenants" inside an existing session** — that path is where bugs live. Imagine a UI button "Switch to Bob's Beams"; if it sets a cookie or local-storage value that overrides the JWT's claim, you've recreated the trust chain bypass.

#### Multiple users per tenant

Normal and expected. All Acme employees have JWTs with `tenant: acme`. Their `sub` differs, their `roles` may differ, but their `tenant` is identical. Nothing special.

#### A user belonging to two tenants

**Out of scope for MVP.** Document this loudly. If/when needed, the model is: each user has *one JWT per tenant*, the user explicitly chooses which tenant they're operating in (separate login flow), and tokens for different tenants never overlap in the same browser session.

---

### 5.5 Layer 5 — Frontend / React: UX, never security

**What it does.** Hides things the user shouldn't see. Greys out buttons. Routes around modules the tenant didn't enable. **All of this is for usability, not security.**

Repeat this until it's reflex:

| Frontend does | Worker does |
|---|---|
| Hides Inspections tab from Acme's UI (they didn't pay for it) | Refuses to serve Inspections data to an Acme JWT |
| Greys out the export button for read-only users | Returns `403` if a read-only user calls the export endpoint |
| Routes `/dashboard` differently per tenant | Validates tenant on every `/api/*` call |
| Filters the dropdown to "your team's projects" | Filters the SQL `WHERE` clause to your team's projects |

If the frontend is the *only* thing stopping access, anyone with the developer console can bypass it in 30 seconds. They open Chrome devtools, change a CSS rule, click the now-visible button, and your endpoint returns the data because the only "check" was the missing button.

#### The pitfall

You ship a new feature behind a feature flag. The React app respects the flag and hides the UI. The new `/api/v1/new-feature` endpoint, however, was added without going through the tenant middleware — or its handler reads the tenant from the query string. Now any tenant can call it, and the only "isolation" was a hidden button.

#### BUG — per-route middleware

```ts
// BUG — middleware applied per-route; the new endpoint is forgotten
app.get('/api/jobs', tenantMiddleware, jobsHandler);
app.get('/api/exports', tenantMiddleware, exportsHandler);
app.get('/api/new-feature', newFeatureHandler);   // ← forgot the middleware
```

#### FIX — global middleware

```ts
// FIX — middleware mounted globally, can't be forgotten
app.use('*', tenantMiddleware);
app.get('/api/jobs', jobsHandler);
app.get('/api/exports', exportsHandler);
app.get('/api/new-feature', newFeatureHandler);   // automatically protected
```

Make the middleware global, not per-route, so it can't be skipped. Any new endpoint you add is protected by default.

---

### 5.6 Layer 6 — Logging and error reporting

**What it does.** Captures what your app did, for debugging and observability. The risk: logs and errors are the most common accidental cross-tenant leak vector.

#### Logs

Every log line includes:

- `tenant` (slug)
- `user_id`
- `request_id`
- `route`

Structured JSON, not free-form strings. When triaging "Acme reports the dashboard is slow," you filter by `tenant=acme` and get exactly Acme's traffic.

```ts
// FIX — structured logger that always includes tenant context
function log(c, event, data) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    tenant: c.get('tenant')?.slug ?? 'unknown',
    user_id: c.get('user')?.id ?? 'anon',
    request_id: c.get('requestId'),
    route: c.req.path,
    event,
    ...data,
  }));
}
```

Walking the fields: `ts` is the timestamp, `tenant` is read from context (the authenticated value), `user_id` and `request_id` from context too, `route` from the request, `event` is a short label like `"snapshot.fetch"`, and `...data` spreads in any extra fields.

#### Errors

A 500 error response that returns a database row in the body to "help debugging" is a data leak. A stack trace logged to a shared Sentry project that includes a JSON payload from another tenant is a data leak. Errors are attractive vectors because we *want* to make them informative.

| Concern | Practice |
|---|---|
| Error response body | Generic message + `request_id` only. Never the failed query, the row, or the request payload. |
| Stack trace storage | Scrub before sending. Strip request bodies, query params containing IDs, response bodies. |
| Sentry-style tools | Tag every event with `tenant`, but never include another tenant's data in the event itself. |
| Aggregation across tenants | Allowed for counts/rates ("we had 500 errors today"). Forbidden for individual records or PII. |

#### BUG — leaky error handler

```ts
// BUG — leaks the failed query and bind values into the response
app.onError((err, c) => {
  return c.json({ error: err.message, query: err.query, params: err.params }, 500);
});
```

If `err.message` contains a row of another tenant's data (say, a unique-constraint violation that includes the conflicting row), or if `err.query` reveals internal column names, you've leaked.

#### FIX — generic body, scrubbed log

```ts
// FIX
app.onError((err, c) => {
  const requestId = c.get('requestId');
  log(c, 'error', { message: err.message, stack: err.stack });   // server-side only
  return c.json({ error: 'Internal error', requestId }, 500);    // user gets nothing
});
```

The user gets `Internal error` plus a request ID they can paste in a support ticket. The full details are in your server log, where only operators can see them — and even there, you scrub before forwarding to any third-party log aggregator.

---

### 5.7 Layer 7 — Backups, exports, and admin tooling

**What it does.** Operates on tenant data outside the normal request flow. The risk: when *you* (the operator) download a snapshot to debug Acme's issue, it's tempting to drop it in `~/Desktop/snapshot.json`. Then next week you debug Bob's issue and overwrite the same file. Then you accidentally email the wrong one. **Mixing exports from multiple tenants in one folder, on one local machine, is how cross-tenant leaks happen during support work.**

#### Naming convention for support exports

Every file you download from R2/D1 for support work is named with the tenant in the filename and lives in a folder labeled by tenant:

```
~/powerfab-support/
├── acme/
│   └── 2026-05-07-snapshot.json
├── bobsteel/
│   └── 2026-05-07-snapshot.json
└── crucible/
    └── 2026-05-07-snapshot.json
```

Boring discipline. Saves you from one terrible mistake on a Friday afternoon.

#### Admin tools that span tenants

A future "ops dashboard" that shows all tenants' health metrics is legitimate. It must:

1. **Live on a separate subdomain** (`ops.example.com`) or behind a separate auth flow.
2. **Use admin-only JWTs** that don't carry a `tenant` claim — they carry an `admin: true` claim instead. The Worker middleware special-cases admin tokens: they bypass the tenant comparison but only on the admin subdomain.
3. **Log every cross-tenant access** with the admin user's ID and the tenant accessed. This is the audit log.
4. **Never share code paths** with the tenant-scoped app. The admin app uses `unsafeCrossTenantQuery`-style APIs that the regular app cannot import.

The principle: a normal user-grade auth must never be able to read across tenants. Crossing the boundary requires explicitly-different auth, explicitly-different code, and an audit log. Three deliberate switches between "I am acting on behalf of one tenant" and "I am acting as the operator across tenants."

#### BUG — re-using app routes for admin

```ts
// BUG — adds an admin-only header check inside a tenant-scoped handler
app.get('/api/jobs', (c) => {
  if (c.req.header('x-admin') === 'true') {
    return allJobsAcrossAllTenants();
  }
  return jobsForCurrentTenant();
});
```

The `x-admin` header is client-controlled. Any user can set it. You've created a trivial bypass.

#### FIX — separate app, separate auth, separate code paths

```ts
// admin/index.ts — a SEPARATE Worker on ops.example.com
const admin = new Hono<{ Bindings: AdminEnv }>();

admin.use('*', async (c, next) => {
  const claims = await verifyAdminJwt(c.req.header('cookie'));   // different verifier
  if (!claims?.admin) return c.text('Forbidden', 403);
  c.set('admin', claims);
  await auditLog('admin.access', { user: claims.sub, route: c.req.path });
  await next();
});

admin.get('/jobs', (c) => allJobsAcrossAllTenants());   // explicitly cross-tenant
```

Different Worker, different verifier, different routes, audit log on every call. You couldn't accidentally call this from the user-facing app even if you tried.

---

## 6. The classic attack: subdomain swap with a stolen cookie

This is *the* attack you're guarding against. Walk through it carefully.

**Setup.** A user from Acme — call her Sarah — logs into `acme.app.example.com`. She enters her password, the server verifies it, and issues a JWT that says `{ sub: "user_42", tenant: "acme", roles: ["editor"] }`. The browser stores this JWT in a cookie scoped to `*.app.example.com` (so it's sent on requests to any subdomain of `app.example.com`).

**The attack.** Sarah's laptop gets compromised, or she leaves it open at a coffee shop. An attacker (or even a curious co-worker who knows the names of other tenants) opens dev tools, copies the cookie, and now has Sarah's session token.

The attacker types `https://bobsteel.app.example.com` into the URL bar. Their browser sends:

```
GET / HTTP/1.1
Host: bobsteel.app.example.com
Cookie: pf_session=eyJhbGc...   ← Sarah's token, tenant: acme
```

The browser dutifully sends the cookie because the cookie's domain scope (`*.app.example.com`) matches the new subdomain. Critically, **the cookie says `tenant: acme` inside, but the URL says `bobsteel`**.

**Without the trust-chain check.** A naive Worker reads the JWT, sees a valid signature, and trusts `claims.tenant = "acme"`. It serves Acme's data. The URL bar says Bob's Beams, the dashboard says Acme — confusing, but probably not a leak. *Unless* somewhere in the codebase a handler reads the subdomain (instead of `c.get('tenant')`) to build an R2 key. In that case, the attacker is reading Bob's data with Acme's credentials. Cross-tenant leak.

**With the trust-chain check.** The middleware compares: `claims.tenant ("acme") !== subdomain ("bobsteel")`. Returns `403 Forbidden`. The attacker sees a clean error and gets nothing.

```
   1. Attacker has Sarah's cookie (tenant: acme inside)
                       │
                       ▼
   2. Attacker visits bobsteel.app.example.com
                       │
                       ▼
   3. Browser sends:
        Host: bobsteel.app.example.com
        Cookie: pf_session=... (tenant: acme)
                       │
                       ▼
   4. Worker middleware:
        subdomain  = "bobsteel"
        claims.tenant = "acme"
        bobsteel !== acme → 403
                       │
                       ▼
   5. Attacker sees: "Forbidden"
      Bob's data is untouched
      Acme's data is untouched (attacker is on the wrong subdomain)
```

The attacker still has Sarah's cookie. They can use it on `acme.app.example.com` and successfully impersonate Sarah *within Acme*. That's a different problem (session security: cookie stealing, MFA, short JWT expiry, IP binding) and isn't tenant isolation. **Tenant isolation specifically guarantees: even with a stolen cookie, the attacker cannot pivot across tenants.**

---

## 7. The attack table

These are the 12 attack patterns you should mentally walk through once a quarter, with the doc open and the routes file next to it.

| # | Attack | Defense layer | What stops it |
|---|---|---|---|
| 1 | Subdomain swap with stolen cookie | Worker (Layer 1) | `subdomain !== claims.tenant` → `403` |
| 2 | URL `?tenant=` tampering | R2/KV/D1 (Layers 2–3) | Server ignores the param; uses `c.get('tenant')` from JWT |
| 3 | Hand-crafted tenant header (`X-Tenant: bobsteel`) | Worker + handlers | All handlers ignore client-supplied tenant headers |
| 4 | JWT replay across tenants | Auth (Layer 4) | JWT is signed; replaying it on another subdomain still fails Layer 1's compare |
| 5 | Path traversal in tenant slug (`../bobsteel`) | Tenant resolver (Layer 1) | Strict regex on slug (`/^[a-z0-9-]{3,32}$/`); never use raw subdomain in a path |
| 6 | SQL injection putting different `tenant_id` in `WHERE` | D1 wrapper (Layer 3) | All queries parameterized; tenant injected by wrapper, not interpolated |
| 7 | Race condition during tenant switch | Auth (Layer 4) | No in-session switching; user must log out and back in |
| 8 | Cache poisoning across tenants | Edge cache | Cache key includes tenant slug; never cache tenant-scoped responses without the slug |
| 9 | Filename collision in shared storage | R2 (Layer 2) | Tenant prefix in every key — no shared namespace exists |
| 10 | Error message leaking internal shape | Logging (Layer 6) | Generic error bodies; full details only in scrubbed server logs |
| 11 | Forgotten endpoint missing middleware | Worker (Layer 1) | Middleware mounted globally on `/*`, not per-route |
| 12 | Admin tool re-used by a normal user | Admin tooling (Layer 7) | Separate subdomain, separate auth, separate code paths |

Each row is a story. If any row's "what stops it" feels weak in your codebase, that's your next refactor.

---

## 8. Testing isolation

You cannot eyeball your way to tenant isolation. You need automated tests that try to break it.

### 8.1 The synthetic cross-tenant CI smoke test

This is the single most valuable test in the codebase. Write it once, run it on every PR.

**Setup:**
1. Seed three tenants in the test DB: `acme`, `bobsteel`, `crucible`. Each gets one user.
2. Each tenant has distinct, recognizable data — different job counts, different shop names, different colors. (More on this in the 3-tenant rule below.)

**The test, in pseudocode:**

```ts
// tests/cross-tenant.test.ts
const tenants = ['acme', 'bobsteel', 'crucible'];

for (const me of tenants) {
  for (const other of tenants.filter(t => t !== me)) {
    test(`${me}'s JWT cannot read ${other}'s data`, async () => {
      const myToken = await login(me);
      const endpoints = await listAllReadEndpoints();   // your route registry

      for (const ep of endpoints) {
        // Try every place a tenant identifier could be smuggled
        const responses = await Promise.all([
          fetch(`https://${other}.app.example.com${ep}`, { token: myToken }),
          fetch(`https://${me}.app.example.com${ep}?tenant=${other}`, { token: myToken }),
          fetch(`https://${me}.app.example.com${ep}`, { token: myToken, headers: { 'X-Tenant': other } }),
          fetch(`https://${me}.app.example.com${ep}`, { token: myToken, body: { tenant: other } }),
        ]);

        for (const res of responses) {
          // Either 403 outright, or a 200 with no `other`-specific data
          if (res.status === 200) {
            const body = await res.json();
            expect(JSON.stringify(body)).not.toContain(otherSpecificMarker(other));
          } else {
            expect(res.status).toBe(403);
          }
        }
      }
    });
  }
}
```

Walking through it:

- The outer loops generate every (me, other) pair where me ≠ other.
- `login(me)` performs a real login flow and returns a valid JWT for the user of tenant `me`.
- `listAllReadEndpoints()` is your discipline: maintain a registry of all endpoints, so this test runs against all of them automatically as you add new ones. (You can also derive this from your Hono routes at runtime.)
- For each endpoint, four attack vectors are tried in parallel: subdomain swap, query string tampering, header tampering, body tampering.
- Every response must either be `403` or contain *no* data specific to the other tenant. `otherSpecificMarker` is a sentinel value you bake into each tenant's seed data — Acme's shop name, a unique job number, etc. If that string ever appears in a response that Acme didn't ask for, the test fails.

Repeat for write endpoints — every one must reject.

### 8.2 Cross-tenant fuzzing

A short test that, for each endpoint, mutates the tenant identifier in every place a tenant identifier might appear in the request and asserts the result is identical to the unmutated request. The premise: the server should ignore client-supplied tenant fields. Even a 30-line version of this catches 80% of regressions.

### 8.3 Reference: Supabase RLS test patterns

The closest public reference for tests of this shape is the `supabase` RLS test suite. Supabase enforces tenant isolation via PostgreSQL row-level security (different mechanism), but their *test shape* is the gold standard:

- Seed two or more tenants with sentinel data.
- Authenticate as one.
- Try to read/write the other's data through every conceivable API surface.
- Assert: every attempt is denied or returns no rows.

Read 3–4 test files in their RLS suite — even though our isolation lives in the Worker (not in the database), the test pattern transfers cleanly. The assertions look almost identical.

`cal.com`'s e2e suite has cross-org access denial tests buried in their large test tree; another good reference, with assertions like "user A cannot read org B's bookings."

### 8.4 The manual quarterly audit

Once a quarter, walk through `worker/index.ts` (or wherever your routes live) with this doc open. For every endpoint, check it against Layers 1–7:

- Does the keystone middleware run? (Layer 1 — yes, it's global.)
- Is every R2 key built from `c.get('tenant')`? (Layer 2 — grep for `R2.get(` and check.)
- Is every D1 access through `tenantDb`? (Layer 3 — grep for `c.env.DB.prepare` outside the wrapper.)
- Are there any places that read a tenant from the URL/body/header? (All layers.)
- Are there any new admin tools that share code with the user app? (Layer 7.)

Boring, but it's how isolation stays correct as the codebase grows.

---

## 9. The 3-tenant rule

This is the single most important practical advice in this doc. If you take only one habit away, take this one.

**With 1 tenant in the system, isolation bugs are invisible.** Every query "works." Every R2 key resolves. The dashboard renders. There's nothing to compare against — the wrong-tenant's data and the right-tenant's data are the same data, because there's only one tenant.

**With 2 tenants, you might or might not catch a bug.** A leak shows up only if you happen to test the right (wrong) thing. If your dev environment has Acme and Bob's Beams but you only ever click around as Acme, you won't notice the bug that's silently serving Acme's data on Bob's pages.

**With 3 tenants, every isolation bug is obvious within minutes.** Why three and not two? With three, when something goes wrong you immediately notice "I'm logged in as Acme, but I'm seeing Bob's data while looking at Crucible's URL." The contradiction is loud. Bugs that would be subtle with two tenants are screaming with three.

### The recommendation

**Run dev with three dummy tenants from day one.** Set up `acme`, `bobsteel`, and `crucible` (or whatever names you like — keep them distinct enough that you can't confuse them at a glance). Give each one wildly different data:

- Acme: 12 jobs, blue branding, shop name "ACME Steel"
- Bob's Beams: 47 jobs, red branding, shop name "BOB'S BEAMS"
- Crucible: 3 jobs, green branding, shop name "Crucible Fab"

Switch between them constantly during development. Have all three open in different browser windows. Hit refresh. The first time the wrong tenant's data renders, you'll notice immediately — Bob's screaming red dashboard does not look like Acme's blue one.

```
   ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
   │ acme.localhost │  │ bobsteel.local │  │ crucible.local │
   │  (blue, 12 j.) │  │  (red, 47 j.)  │  │ (green, 3 j.)  │
   └────────────────┘  └────────────────┘  └────────────────┘
            │                  │                  │
            │     If any of these renders the     │
            │     other's data, you SEE IT.       │
```

This is cheaper than any test, any audit, any framework. It is the single highest-leverage practice for a solo dev building multi-tenant software. You will catch isolation bugs you would never have written tests for, simply because the wrong number on the dashboard *looks* wrong.

Combine with the synthetic cross-tenant CI test (§8.1) and you have manual coverage during development plus automated coverage on every PR. That's the full picture.

---

## 10. End-of-doc checklist

Before you ship a feature that touches tenant data, confirm all of the following. If any answer is "I'm not sure," go re-read the matching section.

- [ ] **Layer 1 — Worker.** Does my Worker have a *global* middleware (`app.use('*', ...)`) that performs the trust-chain check? Does it compare `subdomain` to `claims.tenant` and return `403` on mismatch?
- [ ] **Layer 1 — Slug regex.** Does the middleware validate the subdomain against a strict regex (`/^[a-z0-9-]{3,32}$/`) before using it?
- [ ] **Layer 2 — R2.** Does every R2 read/write build the key from `c.get('tenant').slug`, never from a query/header/body field?
- [ ] **Layer 2 — R2 list.** Does every `R2.list()` call pass an explicit per-tenant `prefix`?
- [ ] **Layer 3 — KV.** Does every KV key include the tenant slug as a prefix?
- [ ] **Layer 3 — D1.** Does every D1 access go through `tenantDb`? No raw `c.env.DB.prepare(...)` calls in handlers?
- [ ] **Layer 3 — Cross-tenant.** Are cross-tenant queries (if any) named `unsafeCrossTenant*` and gated behind admin auth?
- [ ] **Layer 4 — JWT.** Is the JWT *verified* (signature checked) and not just decoded? Does the verifier check `iss` and `exp`?
- [ ] **Layer 4 — No in-session switching.** Is there no UI or code path that "switches tenants" without re-login?
- [ ] **Layer 5 — Frontend.** Are all client-side filters/hides UX-only, with the server enforcing the same rules independently?
- [ ] **Layer 6 — Logs.** Does every log line include `tenant`, `user_id`, `request_id`, `route`?
- [ ] **Layer 6 — Errors.** Do error responses contain only `{ error: 'Generic message', requestId }` — never queries, params, or other tenants' data?
- [ ] **Layer 7 — Support exports.** Are downloaded files named with the tenant slug and stored in tenant-labeled folders?
- [ ] **Layer 7 — Admin tools.** If admin tools exist, are they on a separate subdomain, with separate auth, separate code paths, and an audit log?
- [ ] **Tests.** Is the synthetic cross-tenant test in CI? Does it run on every PR?
- [ ] **3-tenant rule.** Does my local dev environment have *three* tenants with distinct data? Have I clicked around as all three today?

If you can check every box, you're shipping with isolation intact. If you can't, fix the gap before you ship — not after.

---

**Next:** `09-data-fetching.md` — how the React app actually pulls per-tenant data from R2 (and later D1), how TanStack Query's cache stays scoped per tenant, how to invalidate correctly when a snapshot updates, and how to keep the trust chain intact through the data-fetching layer. The patterns from this doc — `c.get('tenant')`, tenant-prefixed keys, server-enforced filtering — extend directly into how queries are keyed and cached.
