# 10 — Authentication: Where the JWT Actually Gets Made

> **Pre-reqs.** Read `00-start-here.md` (vocabulary), `05-cloudflare-architecture.md` (Workers, KV, D1), and especially `08-data-isolation.md` (the trust chain). This doc is the implementation of 08's keystone idea — 08 told you "the JWT is the trusted half"; this doc is where the JWT actually gets minted, signed, set as a cookie, verified, and destroyed.
>
> **What you'll know by the end:**
> - Why password hashing has to be **slow on purpose**, and what `argon2id` is.
> - The user table shape, why the unique constraint is `(tenant_slug, email)` and not `email` alone.
> - The honest tradeoff between **stateful sessions** and **stateless JWTs**, and why we pick stateless for MVP.
> - What goes in the JWT, why we sign it with HS256, where the secret lives.
> - The full login flow line by line — including the one-line tenant-cross-check that makes 08's trust chain real.
> - The cookie incantation, attribute by attribute — with the `Domain=` attribute that, if set wrong, ends the company.
> - How logout works, password reset, inviting users, and where SSO fits later.
> - A numbered list of catastrophic pitfalls and what stops each one.
>
> The whole doc keeps coming back to one phrase from 08: **the URL claims a tenant, the JWT proves a tenant, and we reject the request if they disagree.**

---

## 1. Why auth is the second-most-important thing here

Doc 08 said isolation is the most important thing. Auth is second because **auth is what makes isolation real.** Without auth, the trust chain has nothing on the trusted side; "URL claims a tenant, JWT proves a tenant" collapses to "URL claims a tenant, server believes the URL." This doc is the concrete implementation of 08's abstraction.

```
   ┌────────────────────────────────────────────┐
   │  Login (this doc)                          │
   │   - check password                         │
   │   - mint signed JWT with `tenant: acme`    │
   │   - set HttpOnly cookie locked to subdomain│
   └────────────────────────────────────────────┘
                        │
                        ▼
   ┌────────────────────────────────────────────┐
   │  Every later request (08's trust chain)    │
   │   - URL → claimed tenant                   │
   │   - verify JWT → authenticated tenant      │
   │   - if they disagree → 403                 │
   └────────────────────────────────────────────┘
```

Reassuring: this is **less code than you think** — roughly 200 lines for login, logout, reset, and middleware combined. No Auth0, no Clerk, no Firebase. Just D1, a signing secret, and `Set-Cookie`. Blunt: a few of those lines are catastrophic if you get them wrong. Flagged as we go.

---

## 2. Vocabulary primer

Building on the primer in `00-start-here.md`. Skim now, refer back as you read.

- **Hash** — a one-way function. Turn a password into a fixed-length string from which the original can't be recovered. The vault stores hashes, not passwords; on login, hash the input and compare to the stored hash.
- **Salt** — random bytes mixed into the password before hashing, stored alongside the hash. Defeats **rainbow tables** (precomputed `hash → password` lookups). Modern hashes like argon2id include the salt automatically.
- **argon2id** — a modern password hash. **Memory-hard** and **slow on purpose.** Memory-hard = requires RAM to compute, hostile to GPUs. Slow = each verify takes ~50–250 ms — fine for one logging-in user, painful for an attacker trying billions of guesses.
- **bcrypt** — older password hash, still acceptable. Not memory-hard, so GPUs eat it faster than argon2id. Our fallback if argon2id won't run on Workers cleanly.
- **JWT (JSON Web Token)** — a string with three dot-joined parts (header, payload, signature). The payload is JSON of **claims** (`tenant: "acme"`). The signature is the server's cryptographic stamp. Change a byte of the payload, the signature stops matching, we reject. **Analogy: a tamper-evident wax seal on a letter — readable but you can tell instantly if it's been opened.**
- **HMAC** — signing data with a shared secret. Append `hash(data + secret)`; the receiver has the secret too, recomputes, checks. No secret, no forgery.
- **HS256** — HMAC using SHA-256. Symmetric (same secret signs and verifies). Microseconds per verify.
- **Stateful session** — server stores a row per active session; cookie holds a random session ID; server looks it up on every request.
- **Stateless session** — server stores nothing; cookie carries everything (a signed JWT); server verifies signature and trusts claims. No DB lookup per request.
- **Denylist** — a list of revoked token IDs the verifier checks. (Denylist is stateful sessions wearing a costume; we don't have one at MVP.)
- **HttpOnly** — cookie attribute; JS on the page cannot read or write the cookie. Defends against script theft.
- **SameSite** — cookie attribute controlling cross-site sending. `SameSite=Lax` allows top-level navigation (email link is fine) but blocks hidden cross-site POSTs. Primary **CSRF** defense (cross-site request forgery — making the logged-in user's browser make an attacker's request).
- **JIT-provisioning** — "just-in-time provisioning." First time a user logs in via SSO and we have no row, we create it right then. Section 13.
- **IdP** — Identity Provider. In SSO, the IdP is the customer's Okta/Azure AD/Google. Without SSO, we are the IdP.
- **OIDC, SAML** — two SSO protocols. OIDC is JSON-and-JWT shaped; SAML is XML from the 2000s. Section 13.

---

## 3. Password storage

The fundamental rule: **never store passwords. Store hashes.** When the user logs in, hash whatever they typed and compare; matches, password was right.

But not any hash — **the hash must be slow on purpose.** Imagine an attacker steals your `users` table. With plain SHA-256 (designed to be fast), a modern GPU computes billions of hashes per second; every weak password in your DB cracks in an afternoon. argon2id verifies take ~50–250 ms and chew ~19 MiB of memory. For one logging-in user, 250 ms is nothing. For an attacker trying a billion guesses, it's centuries. argon2id is a deliberately-slow lock on the password vault.

### Recommended: argon2id

```ts
// services/auth/password.ts
import { hash, verify } from '@node-rs/argon2'

const ARGON2_PARAMS = {
  memoryCost: 19456,  // 19 MiB
  timeCost: 2,        // iterations
  parallelism: 1,
}

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_PARAMS)
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  return verify(stored, plain)
}
```

- `@node-rs/argon2` runs on Workers in Node-compat mode (pure-WASM alternative: `hash-wasm`).
- `ARGON2_PARAMS` — OWASP 2024 reference parameters. `memoryCost` is KiB of RAM, `timeCost` is iterations, `parallelism` is CPU lanes (1 is fine; Workers don't expose threads).
- `hash(plain, params)` returns `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`. Salt and params live inside the string — store the whole thing as `password_hash`.
- `verify(stored, plain)` re-hashes using the params encoded in the stored string and compares. Because the params are in the string, you can raise `memoryCost` to 64 MiB in 2030 and old hashes still verify under their old params.

### Acceptable fallback: bcrypt cost 12

```ts
import bcrypt from 'bcryptjs'
const stored = await bcrypt.hash(plain, 12)
const ok = await bcrypt.compare(plain, stored)
```

bcrypt is older and GPU-friendlier, with one quirk: **it silently truncates input to 72 bytes.** A 100-char password and its first 72 chars produce the same hash. Rarely matters, but call it out in code so the next reader knows. Cost 12 takes ~250 ms; raise to 13 as hardware speeds up.

### What NOT to do

- **Plain SHA-256, SHA-512, MD5.** Designed to be fast. GPU bait.
- **Salt-then-SHA.** Salt prevents rainbow tables but does nothing against a GPU brute-forcing one row at a time. Necessary, not sufficient. argon2id includes its own salt *and* is slow.
- **"Encryption" of the password.** Encryption is reversible. If the DB and the key both leak, every password is plaintext. Hash, don't encrypt.
- **Silent bcrypt truncation.** Either reject >72-byte input with a clear error or pre-hash with SHA-256 — and document it.

---

## 4. The user data model

### The schema

```
users
├─ id            uuid          primary key
├─ tenant_slug   text          'acme', 'bobsteel'
├─ email         text
├─ password_hash text          argon2id encoded string
├─ created_at    timestamp
├─ last_login    timestamp     nullable
├─ status        text          'active', 'invited', 'disabled'
└─ UNIQUE (tenant_slug, email)
```

The unique constraint is `(tenant_slug, email)`, **not `email` alone.** Two tenants might legitimately have a user `nick@gmail.com` — say, a consultant who works at Acme and Bob's Beams. Unique-on-email alone breaks the consultant's second signup *and* leaks "this email exists somewhere in our system" via the error message. With `(tenant_slug, email)` unique, two rows can coexist for the same email under different tenants. Same isolation pattern as 08, enforced at the DB layer.

### Where the table lives

Three options:

| Option | Verdict |
|---|---|
| **D1** (SQLite at the edge) — real SQL, real unique constraints, transactions, indexes; 5 GB cap. | **Recommended for MVP.** |
| **KV** — already used for tenant config (05); globally replicated, cheap; **but** eventually consistent (~60s), no secondary indexes, no unique constraints. | Wrong tool. |
| **Durable Objects** — strongly consistent; storage API is key-value, not SQL. | Overkill for MVP. |

Recommend **D1.** One database for the whole platform (not per tenant — that doesn't scale to 200 customers), with `tenant_slug` on every row; every auth query is `WHERE tenant_slug = ? AND ...`. If D1 isn't workable, Postgres on Neon/Supabase over HTTP beats KV. **Don't put users in KV** — eventually-consistent writes mean a password change might not stick for 60 seconds, which becomes a security incident.

---

## 5. Sessions: stateful vs stateless

After login, we need to give the user a "you're logged in" token they send on every later request. Two paths:

**Stateful sessions:** login generates a random 32-byte session ID, stored in KV or D1 as `{user_id, tenant_slug, expires_at}`, set as a cookie. Every request reads the cookie, looks up the row, gets user/tenant. Logout deletes the row — instantly out everywhere. Cost: one KV/D1 read per request (~5–10 ms at the edge).

**Stateless JWT:** login generates a JWT signed with a server secret, set as a cookie. The cookie *is* the proof — no DB row. Every request verifies the signature and trusts the claims. Logout clears the client cookie. Cost: zero DB reads, HMAC verify is microseconds.

### Recommendation: stateless JWT for MVP

1. **08's trust chain names the JWT as the source of tenant identity.** Stateless pairs naturally — verify signature, read `tenant` claim, compare to URL, done. No DB hop on every API call.
2. At 5–10 customers, the "instant revocation" advantage of stateful is largely theoretical. Fire someone, change their password, set a short expiry; worst case they have access for the rest of the day.
3. Workers bills per CPU-ms. Skipping a KV read on every call adds up.

### The honest tradeoff: the revocation gap

Stateful has one real advantage: **instant revocation.** Delete the row, user is out on the next request. With stateless JWT, you cannot kick a user out before their `exp` without a denylist (which is stateful sessions wearing a costume).

What if a customer says "we fired Bob, lock him out NOW"? Three options, cheapest to most invasive:

- **Short access tokens + refresh tokens.** 15-min tokens, refresh by re-checking the DB. Compromise window bounded.
- **Denylist of revoked `jti` (JWT ID) values in KV with TTL = remaining lifetime.** One KV read added, only when revocations exist.
- **Switch to stateful.** Most invasive. Worth it past 100 customers with frequent revocation requests.

For MVP: stateless JWT, 24-hour expiry. **Document the path; don't prematurely build it.**

---

## 6. The JWT itself

Sign with **HS256** — HMAC-SHA256, symmetric. Reasons: one Worker mints and verifies (no third parties needing a public key, so RS256/ES256 buy nothing); HMAC is microseconds per verify (RSA ~1 ms, ES256 ~0.5 ms — per-request, it matters); smaller tokens.

The signing secret is a Cloudflare Worker secret deployed via `wrangler secret put JWT_SECRET`. At least 32 bytes of cryptographic randomness — `openssl rand -base64 32`. Treat it like a DB password: never commit, never log. Rotating means deploying a new secret and accepting old-and-new for one expiry cycle; handle that when the time comes.

### What goes in the payload

```json
{
  "sub": "user_uuid_here",
  "tenant": "acme",
  "email": "nick@acme.com",
  "iat": 1730000000,
  "exp": 1730086400
}
```

- `sub` — user ID. Standard "subject" claim.
- `tenant` — the tenant slug. **This is the field 08's middleware cross-checks against the URL.** This claim is the entire reason this doc exists.
- `email` — convenience for the UI ("Hi, nick@acme.com"). Not security-critical; the server never trusts `email` for authorization.
- `iat` / `exp` — issued-at and expiry, Unix seconds. We use 24-hour expiry: long enough that users don't get logged out mid-day, short enough that a stolen cookie isn't a forever-key.
- `role` — **leave OUT for MVP.** One role per tenant for now. RBAC arrives in Phase 4.

### Use a library, never hand-roll

Use `jose` or `hono/jwt`. Do **not** write your own verification. The spec has a notorious footgun — the **`alg=none` attack**: an old version of the spec allowed `"alg": "none"` meaning "no signature, just trust the payload." Hand-rolled parsers that forget to reject `alg: none` accept any forged token. Real libraries reject it.

---

## 7. The login flow, line by line

```ts
// POST /api/login on acme.app.example.com
app.post('/api/login', async (c) => {
  const tenantSlug = c.get('tenantSlug')          // 1
  const { email, password } = await c.req.json()   // 2

  const user = await c.env.DB.prepare(             // 3
    'SELECT id, password_hash, status FROM users WHERE tenant_slug = ? AND email = ?'
  ).bind(tenantSlug, email).first()

  if (!user || user.status !== 'active') {         // 4
    return c.json({ error: 'invalid credentials' }, 401)
  }

  const ok = await verifyPassword(password, user.password_hash)  // 5
  if (!ok) return c.json({ error: 'invalid credentials' }, 401)

  const token = await sign(                        // 6
    {
      sub: user.id,
      tenant: tenantSlug,
      email,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    },
    c.env.JWT_SECRET
  )

  c.header('Set-Cookie',                           // 7
    `pf_session=${token}; ` +
    `HttpOnly; Secure; SameSite=Lax; ` +
    `Domain=${tenantSlug}.app.example.com; ` +
    `Path=/; Max-Age=86400`
  )

  return c.json({ ok: true })                      // 8
})
```

Walking through it:

1. `c.get('tenantSlug')` — read the slug from request context, populated by the resolver in `01-tenant-resolution.md` from the hostname. **Read it from context, not from the body** — same rule as 08's storage layer. Login is a tenant-scoped operation; the URL decides the tenant.
2. Read `email` and `password` from the JSON body.
3. Look up the user **scoped to this tenant** — `WHERE tenant_slug = ? AND email = ?`. Parameterized (`?` placeholders bound separately), so no SQL injection.
4. If no row, or `status !== 'active'`, return a generic 401. **Generic on purpose** — never distinguish "user not found" from "wrong password." The asymmetry lets attackers enumerate valid emails.
5. Verify the password with argon2id. The ~250 ms slowness is by design.
6. Sign the JWT. Build the payload, call `sign(payload, secret)` (`jose` or `hono/jwt`). The `tenant: tenantSlug` line is **the keystone field.** Everything in 08 hinges on this value being correct at issuance time.
7. Set the cookie. The most important line in the flow — see next section for every attribute. The cookie carries the JWT, locked to `acme.app.example.com`, `HttpOnly` and `Secure`, `SameSite=Lax`, 24-hour lifetime.
8. Return `{ ok: true }`. The browser stores the cookie; the React app uses `credentials: 'include'` (see 09) so every later `fetch` carries it back.

You might be wondering where **rate limiting** is — five failed logins should slow the next attempt. Yes, add it before launch. Cloudflare offers per-route rate limiting at the platform level. For MVP, get the cookie and JWT right first.

---

## 8. The cookie incantation, attribute by attribute

Pull the Set-Cookie header out so we can pick it apart:

```ts
function sessionCookie(token: string, tenantSlug: string, maxAge: number) {
  return [
    `pf_session=${token}`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Lax`,
    `Domain=${tenantSlug}.app.example.com`,  // <-- subdomain, NOT parent
    `Path=/`,
    `Max-Age=${maxAge}`,
  ].join('; ')
}
```

Each attribute, with what it does and what breaks if it's wrong:

- **`pf_session=<token>`** — name (any label) and value (the JWT).
- **`HttpOnly`** — JS on the page **cannot read this cookie.** No `document.cookie` access. Defends against XSS: an injected script can't exfiltrate the token. Without this, every XSS becomes account theft. **Always on.**
- **`Secure`** — only sent over HTTPS. Mandatory in production. In local dev over `http://acme.localhost` this blocks the cookie from being set; either flip it conditionally or develop over local HTTPS.
- **`SameSite=Lax`** — CSRF defense. Cookie sent on top-level navigation (email links work), **not** on hidden cross-site POSTs. `Strict` would block even email links, breaking common UX. `Lax` is the right balance.
- **`Domain=<tenantSlug>.app.example.com`** — see next subsection. Its own subsection because it's the catastrophic bug.
- **`Path=/`** — sent on every path. Default; spelled out.
- **`Max-Age=86400`** — expires after 24 hours; match the JWT `exp`.

### 8.1 The `Domain=` attribute — the line that ends the company

Here is the catastrophic bug. Read it twice.

```
   ┌────────────────────────────────────────────────────────┐
   │  CORRECT — Domain=acme.app.example.com                 │
   │  Cookie scoped to acme.app.example.com only.           │
   │  NOT sent to bobsteel.app.example.com or app.example...│
   │  Acme's session is invisible to Bob's Beams.           │
   └────────────────────────────────────────────────────────┘

   ┌────────────────────────────────────────────────────────┐
   │  WRONG — Domain=app.example.com  (parent domain)       │
   │  Cookie scoped to *.app.example.com.                   │
   │  Sent to EVERY tenant subdomain on every page load.    │
   │  08's trust chain catches the mismatch — IF every      │
   │  endpoint runs the cross-check. One forgotten endpoint │
   │  = cross-tenant data exposure.                         │
   └────────────────────────────────────────────────────────┘
```

The `Domain=` attribute is like the address on an envelope: it tells the browser which sites get this cookie. `Domain=app.example.com` sends Acme's signed-in cookie to Bob's Beams' subdomain on every page load. The trust chain catches the mismatch — but you've turned a single forgotten check anywhere in the codebase into a cross-tenant data leak.

Lock the cookie to the exact subdomain. **If you set it on the parent by accident, the trust chain is your only defense.** Don't turn defense in depth into defense in width.

(Browsers default to *exact host* if you omit `Domain=` entirely — also tenant-locked, also safe. Explicit is clearer. The bug is **adding** `Domain=app.example.com` thinking it's convenient.)

You might be wondering: doesn't `Secure; HttpOnly; SameSite=Lax` prevent this? **No.** Those defend against script theft and CSRF. They don't stop the browser sending a parent-domain cookie to sibling subdomains — that's exactly what parent-domain cookies are *designed* to do for single-domain apps. Multi-tenant subdomains require subdomain-scoped cookies. No shortcut.

---

## 9. The verifier middleware — where 08's trust chain becomes real

Runs on every authenticated request. **Remember 08's trust chain? Watch for the cross-check on line 9.**

```ts
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const cookie = c.req.header('Cookie') || ''                  // 1
  const match = cookie.match(/pf_session=([^;]+)/)              // 2
  if (!match) return c.json({ error: 'unauthenticated' }, 401)  // 3

  let payload                                                   // 4
  try {
    payload = await verify(match[1], c.env.JWT_SECRET)          // 5
  } catch {
    return c.json({ error: 'invalid token' }, 401)              // 6
  }

  const urlTenant = c.get('tenantSlug')      // from hostname   // 7
  const tokenTenant = payload.tenant          // from JWT claim // 8

  // ▼ THE CROSS-CHECK — this is 08's trust chain
  if (urlTenant !== tokenTenant) {                              // 9
    return c.json({ error: 'tenant mismatch' }, 403)
  }

  c.set('userId', payload.sub)                                  // 10
  c.set('tenantSlug', tokenTenant)                              // 11
  await next()                                                  // 12
}
```

Line by line:

1. Read the `Cookie` header, or empty string if missing.
2. Extract the `pf_session` value with a regex. (Or use a cookie-parser library; regex shown for clarity.)
3. No cookie → 401. The user must log in.
4–5. Verify the JWT. `verify(token, secret)` from `jose` or `hono/jwt` recomputes the HS256 signature and checks `exp`. **This line turns the JWT from "untrusted bag of bytes" into "authenticated claims."** Throws on bad signature, expired, or malformed.
6. Catch the throw and return 401. Don't reveal *why* it failed.
7. `urlTenant` — slug from the URL, populated by the resolver in `01-tenant-resolution.md`. This is the **claimed** tenant from 08.
8. `tokenTenant` — the `tenant` claim from the JWT. This is the **authenticated** tenant from 08. We trust it because the signature verified.
9. **The cross-check.** Disagree → 403. **This single `if` is the entire trust-chain enforcement.**

   Without it, a valid signature only proves "we issued this token." It doesn't prove "this token belongs on this subdomain." A user with a valid Acme JWT pointing their browser at `bobsteel.app.example.com` (cookie scoped wrong, or replayed via curl) would be processed as Acme — and any downstream handler that builds keys from the URL has just leaked.

   With it, **the URL and JWT must agree before we serve any data.** This `if` is the concrete version of 08's section 5.1 diagram.

10–11. Attach the verified user ID and tenant to the request context. Handlers read `c.get('userId')` / `c.get('tenantSlug')` — never the URL, body, or a header — to scope queries.
12. `next()` — proceed to the handler.

You might wonder why we don't check the email or `sub` instead — those are claims like any other, but the question isn't "who is this user?" but "**does the URL agree with the tenant we authenticated them as?**" `sub` and `email` answer the first; only `tenant` answers the second.

---

## 10. Logout

```ts
app.post('/api/logout', (c) => {
  const tenantSlug = c.get('tenantSlug')
  c.header('Set-Cookie',
    `pf_session=; HttpOnly; Secure; SameSite=Lax; ` +
    `Domain=${tenantSlug}.app.example.com; Path=/; Max-Age=0`
  )
  return c.json({ ok: true })
})
```

Empty value, `Max-Age=0`, browser deletes it. Same `Domain=`, `Path=`, `SameSite=` as login — those must match for the browser to recognize this as the same cookie being deleted. Mismatch them and you set a *different* (empty) cookie, leaving the original in place.

### The honest revocation gap

With stateless JWT, **logout only deletes the client's copy.** The token itself stays cryptographically valid until `exp`. If malware on the user's machine copied the cookie value to a curl script before logout, that copy keeps working until expiry.

For a steel-fab dashboard at MVP, the threat model is low: internal users and stale credentials, not nation-state persistence. 24-hour expiry plus a logout button is fine. **But don't tell yourself "logout = locked out."** It means "this browser no longer carries credentials." Different thing. Need true revocation? See section 5's three options.

---

## 11. Password reset

A four-step dance. The discipline is in the rules around the token.

### Step 1 — User submits email on `/forgot-password`

```ts
app.post('/api/forgot-password', async (c) => {
  const tenantSlug = c.get('tenantSlug')
  const { email } = await c.req.json()

  const user = await c.env.DB.prepare(
    'SELECT id FROM users WHERE tenant_slug = ? AND email = ?'
  ).bind(tenantSlug, email).first()

  if (user) {
    const token = randomToken()  // 32 bytes, base64url
    await c.env.RESETS.put(
      `pwreset:${token}`,
      JSON.stringify({ user_id: user.id, tenant_slug: tenantSlug }),
      { expirationTtl: 60 * 60 }  // 1 hour
    )
    await sendEmail(email, `${tenantSlug}.app.example.com/reset?token=${token}`)
  }

  return c.json({ ok: true })  // SAME response either way
})
```

- Lookup is scoped `(tenant_slug, email)` — same isolation as login.
- **Same response whether the user exists or not.** No enumeration.
- `randomToken()` returns 32 bytes from `crypto.getRandomValues`, base64url-encoded. Never sequential, never timestamp-derived.
- Store in **KV** under `pwreset:<token>` with `{user_id, tenant_slug}`, TTL one hour. KV fits because the token is single-use, short-lived, and only ever looked up by token (never queried by user). (See 05 for KV.)
- Email the link with the **tenant subdomain** — `acme.app.example.com/reset?token=...`. Never apex-domain links; the trust chain depends on landing on the right subdomain. Transactional provider (Resend, Postmark, SES).

### Steps 2–3 — User clicks the link

Lands on the React reset page, renders "set new password." Nothing security-sensitive until submit.

### Step 4 — POST `/api/reset`

```ts
app.post('/api/reset', async (c) => {
  const { token, newPassword } = await c.req.json()

  const raw = await c.env.RESETS.get(`pwreset:${token}`)
  if (!raw) return c.json({ error: 'invalid or expired token' }, 400)

  const { user_id, tenant_slug } = JSON.parse(raw)

  const newHash = await hashPassword(newPassword)
  await c.env.DB.prepare(
    'UPDATE users SET password_hash = ? WHERE id = ? AND tenant_slug = ?'
  ).bind(newHash, user_id, tenant_slug).run()

  await c.env.RESETS.delete(`pwreset:${token}`)  // single-use

  return c.json({ ok: true })
})
```

Look up the token in KV, get user/tenant, hash the new password (argon2id), update scoped on `(id, tenant_slug)`, **delete the token** so it can't be reused. Single-use is enforced by the delete, not by hope.

### Non-negotiable token rules

- **Single-use** — delete on consumption.
- **Short TTL** — ≤1 hour. A 30-day reset token in an old email is a permanent backdoor.
- **Cryptographic randomness** — never sequential, never timestamp-derived.
- **Never log the token.** Not in tail logs, not in error messages, not in third-party telemetry.

---

## 12. Inviting additional users

At MVP, user accounts come into existence two ways:

1. **First user per tenant** — created by us during onboarding. A script or hidden admin endpoint inserts the row with `status='active'` and sends an initial reset link via the flow in section 11. No public signup form.
2. **Subsequent users** — invited by an existing user. They go to `/settings/users`, type an email, click "Invite." Server creates a row with `status='invited'`, generates an invite token (same shape as reset, but 7-day TTL since the recipient might be on PTO), emails the link. Invitee clicks, sets password, row flips to `status='active'`.

The invite flow **reuses 90% of password reset.** Same KV-stored token shape, same single-use rule, same email-with-tenant-subdomain pattern. The only difference: reset updates the password hash; invite sets it for the first time and flips status. Build them as **one mechanism with two entry points** — don't write a parallel invite system that diverges over time.

No self-service signup page at MVP. New tenants are sales-led — we provision them. This dodges signup spam, fake tenants, and junk data, which don't matter to solve at 5–10 customers. Tenant lifecycle is doc 11.

---

## 13. The path to SSO

When a 50-person shop says "we use Okta and IT won't approve passwords stored in your DB," that's the SSO conversation — probably at 20–30 customers. What changes is the **front of the login flow**, not the back. User hits `acme.app.example.com/login` → if Acme has an IdP configured, we redirect to their Okta/Azure AD/Google → IdP authenticates → redirects back with a SAML assertion or OIDC ID token → we verify it, look up or **JIT-provision** the row in `users`, then **mint our own JWT and set the cookie exactly as in section 7**. From the cookie onward every section here still applies.

Libraries: `@node-saml/node-saml` and `openid-client`, both Workers-compatible in Node-compat mode. Per-tenant IdP config lives in the tenant config blob (see 05). The point of mentioning SSO is so you know the password-based design does **not** box you out — only the "how do we know who you are" front-end swaps out.

---

## 14. Common pitfalls

Numbered, severity-tagged. Re-read before every auth-related PR.

1. **Cookie on parent domain.** `Domain=app.example.com` instead of `Domain=acme.app.example.com`. Cookie travels to every tenant subdomain. **Catastrophic** — the bug that ends the company.
2. **Verifying signature but not cross-checking `tenant` against the URL.** Signature only proves "we issued this." Without the section-9 check, any handler that uses the URL to build keys can leak. **Catastrophic** — the line of code 08 demanded.
3. **JWT in localStorage instead of HttpOnly cookie.** localStorage is readable by any JS. One bad npm package = every active session exfiltrated. **High.**
4. **Weak signing secret.** A 16-character secret is brute-forceable. Must be ≥32 bytes of crypto randomness. `supersecret123` is decoration, not auth. **High.**
5. **Hand-rolling JWT verification.** The `alg=none` attack: old spec versions let `"alg": "none"` mean "trust the payload, no signature." Use `jose` or `hono/jwt`. **High.**
6. **Forgetting the `tenant_slug` filter in user lookups.** `WHERE email = ?` without `AND tenant_slug = ?` and two tenants' users with the same email collide. **Catastrophic** — DB-level version of pitfall #2.
7. **Long-lived reset tokens.** A 30-day token in an old email is a permanent backdoor. TTL ≤1 hour, single-use, deleted on consumption. **Medium-high.**
8. **Different responses for "user not found" vs "wrong password."** Lets attackers enumerate valid emails. Generic 401 always. **Medium.**
9. **Logging request bodies that contain passwords or tokens.** Tail logs, Sentry, error reports. Scrub `password`, `token`, `newPassword` before anything leaves the Worker. **Medium.**

---

## 15. How this connects back to 08

Read 08 again with this doc in mind. The trust chain is now concrete:

- **The "claimed" tenant** in 08 = `c.get('tenantSlug')` populated from the hostname by the resolver in `01-tenant-resolution.md`.
- **The "authenticated" tenant** in 08 = the `tenant` claim inside the JWT — set in section 7, verified in section 9.
- **The keystone check** in 08's section 5.1 = the `if (urlTenant !== tokenTenant) return 403` in section 9 above.

08 said "the JWT is the keystone." This doc is the keystone. Every other layer in 08 (R2 prefixes, KV prefixes, D1 wrappers, log fields, admin tools) consumes the `tenant` value this doc produces. Right here = those layers have a trustworthy value. Wrong here (wrong cookie scope, missing cross-check, hand-rolled verifier) = every other layer in 08 is built on sand.

Cross-references:

- **05** — KV, D1, Workers, secrets. Reset tokens in KV; user rows in D1; `JWT_SECRET` is a Worker secret.
- **06** — the nightly job authenticates with **service credentials**, not a user JWT. Don't reuse `JWT_SECRET` for service tokens.
- **08** — this doc implements 08's section 5.4 (Auth/JWT) and 5.1 (Worker keystone).
- **09** — the React app's `fetch` calls send the cookie automatically same-origin. Cross-origin requires `credentials: 'include'`. Test in all three dev tenants (the 3-tenant rule from 08).

---

## 16. By the end of this doc you should know

- Why password hashes have to be **slow on purpose**, and what argon2id is.
- Why the unique constraint is `(tenant_slug, email)`.
- The honest tradeoff between stateful and stateless sessions, and the **revocation gap**.
- What goes inside our JWT, why HS256, where the secret lives.
- The login flow — including the `tenant: tenantSlug` keystone field.
- Every cookie attribute and what breaks if it's wrong, **especially `Domain=`**.
- The verifier middleware line by line, and why `urlTenant !== tokenTenant` is the whole point.
- Logout's honest limit, and the three escape hatches for true revocation.
- Password reset's four steps and the token rules.
- Invite as 90% the same machinery as reset.
- The shape of the path to SSO.
- Nine catastrophic-or-high pitfalls.

Section 8.1 (`Domain=`) and section 9 (the verifier) are the two you cannot afford to misunderstand.

---

**Next:** `11-tenant-lifecycle.md` — how tenants get provisioned, suspended, and deleted. Auth is per-user; lifecycle is per-tenant. They share the user table and the JWT, but operations (creating the first user, disabling a tenant, exporting on offboarding) are their own thing.
