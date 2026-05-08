# Research Brief: 10-auth.md — Authentication for PowerFab Dashboard

## Framing for the writer

This explainer sits downstream of 08 (data isolation / trust chain). The reader has already been told that "the JWT is the keystone." This document is where that JWT actually gets minted, signed, set as a cookie, verified on every request, and destroyed at logout. The whole document should keep coming back to one phrase: **the URL claims a tenant, the JWT proves a tenant, and we reject the request if they disagree.**

Beginner audience: solo developer, comfortable with React/TS, has built single-tenant apps with off-the-shelf auth (Auth0, Clerk, Firebase). Has never hand-rolled cookie-based session auth. Has never thought about multi-tenant cross-contamination. The tone should be reassuring — "this is less code than you think" — but blunt about the few places where mistakes are catastrophic.

---

## 1. Password storage

**Recommendation: argon2id with `m=19456 KiB, t=2, p=1` (the OWASP 2024 reference parameters), or bcrypt with cost factor 12 if argon2id is too painful to get running on Workers.**

Why argon2id:
- Memory-hard, so attackers can't trivially parallelize on GPUs/ASICs the way they can with bcrypt.
- Modern, designed after bcrypt, won the 2015 Password Hashing Competition.
- Has a WASM build that runs on Cloudflare Workers (`hash-wasm` package or `@node-rs/argon2` in Node-compatibility mode).

Bcrypt is the acceptable fallback. It's older, GPU-friendlier than argon2id, and capped at 72 bytes of input — but it has been in production for 25 years and is not broken. Cost factor 12 takes ~250ms on modern hardware. Ship bcrypt if argon2id-on-Workers turns into a yak shave; the difference matters when an attacker steals your DB, and at MVP the DB is small.

**What NOT to do — call this out emphatically:**
- Plain SHA-256, SHA-512, MD5 — these are designed to be FAST. Password hashes need to be SLOW.
- Salt-then-SHA — same problem. The salt prevents rainbow tables but does nothing against a GPU.
- "Encryption" of the password — passwords should be hashed (one-way), not encrypted (reversible).
- Truncating bcrypt input to fit 72 bytes without telling the user — silent data loss.

The hash output stores its parameters in the string itself (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`), so you can change parameters later and old hashes still verify. Re-hash on next successful login if parameters drift.

---

## 2. User data model

The schema, regardless of where it lives:

```
users:
  id          (uuid)
  tenant_slug (text)         -- "acme", "bobsteel"
  email       (text)
  password_hash (text)        -- argon2id encoded string
  created_at  (timestamp)
  last_login  (timestamp, nullable)
  status      (text)          -- "active", "invited", "disabled"
  UNIQUE (tenant_slug, email)
```

The unique constraint is `(tenant_slug, email)`, NOT `email` alone. Two tenants might legitimately have a user `nick@gmail.com` (consultant who works at multiple shops). This matters at the schema level — get it wrong and you create a privacy bug where one tenant's signup blocks another tenant's user.

**Where does this live? Three options for a Cloudflare-anchored stack:**

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **D1** (SQLite at the edge) | Real SQL, real unique constraints, transactions, indexes. Familiar mental model. | Beta-ish, regional read replicas still maturing, 5 GB cap per database. | **Recommended for MVP.** |
| **KV** | Already used for tenant config (see 05). Globally replicated. Cheap. | Eventually consistent (writes can take ~60s to propagate). No secondary indexes — looking up by email means scanning. No unique constraints. | Wrong tool for users. |
| **Durable Objects** | Strongly consistent. Can model a tenant as a single object and put users inside. | Heavier conceptually. Storage API is key-value, not SQL. | Overkill for MVP, good for Phase 4. |

**Recommend D1.** One D1 database for the platform (not per tenant — that doesn't scale to 200 customers), with `tenant_slug` as a column on every row. Every query the auth code runs is `WHERE tenant_slug = ? AND ...`. This is the same isolation pattern 08 enforces at the request level, now enforced at the query level.

If D1 isn't workable for some reason, the second-best option is Postgres on Neon or Supabase reached over HTTP from the Worker — not KV.

---

## 3. Session model — the big tradeoff

Two paths. Both are legitimate. The reader needs to understand both before they pick.

**Stateful sessions:**
- Login generates a random 32-byte session ID, stores it in KV or D1 with `{user_id, tenant_slug, expires_at}`, sets the session ID as a cookie.
- Every request: read cookie, look up session in KV/D1, get user/tenant.
- Logout: delete the row. User is instantly logged out everywhere.
- Cost: one extra KV/D1 read per request. KV at edge is ~5–10ms; not free, but not terrible.

**Stateless JWT:**
- Login generates a JWT signed with a server secret, sets it as a cookie.
- Every request: verify the JWT signature, trust the claims inside.
- Logout: clear the cookie on the client. The token is still valid until `exp` if someone copied it — but they'd need to have stolen an HttpOnly cookie, which means they already pwned the box.
- Cost: zero DB reads. Pure CPU (HMAC verification, microseconds).

**Recommend stateless JWT for MVP.** Reasons specific to this project:

1. The trust chain in 08 already names the JWT as the source of truth for tenant identity. Stateless JWT pairs naturally — verify signature, read `tenant` claim, compare to URL, done. No DB hop for every request to a static asset or API.
2. At 5–10 customers and a couple users each, the "instant revocation" advantage of stateful sessions is largely theoretical — if you fire someone, you can change their password and set a short JWT expiry; the worst case is they have access for 15 more minutes.
3. Workers bills per CPU-ms. Skipping a KV read on every API call adds up.

**But honestly, the stateful side has one real advantage worth naming:** revocation. With stateless JWT, you cannot kick a user out before their token expires unless you maintain a denylist (which is just stateful sessions wearing a costume). For an MVP this is fine. Once the product is real and a customer says "we fired Bob, lock him out NOW," you have three options:

- Short JWT expiry (15 min) + refresh token. Compromises window is bounded.
- Add a denylist of revoked JWT IDs (`jti` claim) in KV with TTL = remaining lifetime.
- Switch to stateful sessions.

Document the path; don't prematurely build it.

---

## 4. JWT signing

**Recommend HS256 (HMAC-SHA256, symmetric).** Reasons:
- Single Worker mints AND verifies the token. There's nobody else who needs to verify it. Asymmetric keys (RS256/ES256) are valuable when you publish a public key for third parties to verify your tokens — you don't have third parties.
- HMAC is fast: microseconds per verify. RSA verify is ~1ms, ES256 ~0.5ms. Per-request, this matters.
- Smaller tokens.

The signing secret is a Cloudflare Worker secret (`wrangler secret put JWT_SECRET`). Must be at least 32 bytes of cryptographic randomness. Generate with `openssl rand -base64 32` or `crypto.getRandomValues(new Uint8Array(32))`. Treat it like a database password — never commit, never log.

**JWT payload at MVP:**

```json
{
  "sub": "user_uuid_here",
  "tenant": "acme",
  "email": "nick@acme.com",
  "iat": 1730000000,
  "exp": 1730086400
}
```

- `sub` — user ID. The subject of the token.
- `tenant` — the tenant slug. **This is the field 08 cross-checks against the URL.**
- `email` — convenience for the UI ("Hi, nick@acme.com"). Not security-critical.
- `iat` / `exp` — issued-at and expiry, Unix seconds. Recommend 24-hour expiry at MVP (long enough that users don't get logged out mid-day, short enough that a stolen cookie isn't a forever-key).
- `role` — leave OUT for MVP. Single role per tenant. Add when RBAC arrives in Phase 4.

Use the `jose` library or `hono/jwt` — do not hand-roll JWT verification; the spec has a footgun (the `alg=none` attack) and the libraries handle it.

---

## 5. Login flow — line by line

```ts
// POST /api/login on acme.app.example.com
app.post('/api/login', async (c) => {
  const tenantSlug = c.get('tenantSlug') // extracted from hostname earlier
  const { email, password } = await c.req.json()

  // 1. Look up the user — SCOPED to tenant
  const user = await c.env.DB.prepare(
    'SELECT id, password_hash, status FROM users WHERE tenant_slug = ? AND email = ?'
  ).bind(tenantSlug, email).first()

  if (!user || user.status !== 'active') {
    // Generic message — do not leak whether the email exists
    return c.json({ error: 'invalid credentials' }, 401)
  }

  // 2. Verify password
  const ok = await argon2Verify(password, user.password_hash)
  if (!ok) return c.json({ error: 'invalid credentials' }, 401)

  // 3. Sign JWT
  const token = await sign(
    {
      sub: user.id,
      tenant: tenantSlug,
      email,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    },
    c.env.JWT_SECRET
  )

  // 4. Set cookie — SUBDOMAIN-LOCKED
  c.header('Set-Cookie',
    `pf_session=${token}; ` +
    `HttpOnly; Secure; SameSite=Lax; ` +
    `Domain=${tenantSlug}.app.example.com; ` +
    `Path=/; Max-Age=86400`
  )

  return c.json({ ok: true })
})
```

**Cookie attribute incantation — explain each one:**

- `HttpOnly` — JS in the browser cannot read this cookie. Defends against XSS reading the token.
- `Secure` — only sent over HTTPS. Always on in production.
- `SameSite=Lax` — not sent on cross-site POSTs (CSRF defense). Lax (not Strict) so that following a link from email logs the user in.
- `Domain=acme.app.example.com` — **the most important attribute.** Locks the cookie to ONE subdomain. If you set `Domain=app.example.com`, the cookie goes to every tenant. Disaster. (See pitfall #1.)
- `Path=/` — sent on all paths.
- `Max-Age=86400` — 24 hours. Match the JWT expiry.

---

## 6. Logout flow

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

Set the cookie to empty with `Max-Age=0`. The browser deletes it.

**Honest caveat:** with stateless JWT this only deletes the client's copy. If the user was malicious and copied their cookie value to a curl script before logging out, that script keeps working until `exp`. This is the revocation gap. For a steel-fab dashboard at MVP, the threat model is low — but the explainer should name it so the reader doesn't think "logout = locked out."

---

## 7. Password reset flow

The standard four-step dance:

1. **User submits email on `/forgot-password`.** Server looks up user by `(tenant_slug, email)`. Whether or not it finds them, return the same response ("if that account exists, we've sent a link"). No enumeration.
2. **Server generates token.** 32 random bytes, base64url-encoded. Store in KV: key `pwreset:<token>`, value `{user_id, tenant_slug}`, TTL 60 minutes. KV is fine here because the token is single-use, short-lived, and we don't care about indexes.
3. **Server emails link.** Format: `acme.app.example.com/reset?token=<base64url>`. The subdomain in the link is the tenant — do not send links pointing at the apex domain. Use a transactional email provider (Resend, Postmark, SES); the explainer can wave at this.
4. **User clicks, sets new password.** POST `/api/reset` with token + new password. Server looks up token in KV, gets user, hashes new password, updates `users.password_hash`, deletes the token from KV (consume on use).

**Token rules:**
- Single-use (delete after consumption).
- Short TTL (≤1 hour).
- Cryptographic randomness, never sequential or timestamp-based.
- Do not log the token. Do not include it in error messages.

---

## 8. Multi-user-per-tenant signup

At MVP there are two ways a user account comes into existence:

1. **First user per tenant** — created by us during onboarding. We run a script (or a hidden admin endpoint) that inserts the row with `status=active` and emails them an initial password reset link. There is no public signup form.
2. **Subsequent users** — invited by an existing user. Existing user goes to `/settings/users`, types email, clicks "Invite." Server creates row with `status=invited`, generates an invite token (same shape as password reset), emails the link. Invitee clicks, sets password, row flips to `status=active`.

No self-service "sign up for PowerFab Dashboard" page exists at MVP. New tenants are sales-led — we provision them. This dodges a whole class of abuse (signup spam, fake tenants) that doesn't matter to solve at 5–10 customers.

The invite flow reuses 90% of the password reset flow — same KV-stored token, same TTL, same single-use rule. Build them as one mechanism with two entry points.

---

## 9. Path to SSO

When a 50-person fabrication shop says "we use Okta and our IT department won't approve passwords stored in your DB," that's the SSO conversation. Probably hits at 20–30 customers.

What changes:
- **Per-tenant identity provider config** lives in the tenant JSON / KV blob (see 05). Fields: `idp_type` (saml/oidc), `idp_metadata_url`, `idp_entity_id`, etc.
- **Login flow becomes redirect-based.** User hits `acme.app.example.com/login` → if tenant has SSO configured, redirect to their IdP → IdP authenticates → redirects back with a SAML assertion or OIDC ID token → Worker validates, looks up or **JIT-provisions** the user row in `users`, mints our own JWT, sets cookie. From here on, everything else in this explainer works the same.
- **JIT provisioning** — the first time `nick@acme.com` logs in via SSO, no row exists. Create one with `status=active`, no password hash, `auth_method=sso`. Now they exist.
- **Library**: `@node-saml/node-saml` for SAML, `openid-client` for OIDC. Both run on Workers with Node-compat.

The point of mentioning this in 10-auth.md is so the reader knows the password-based design they're building does NOT box them out. The cookie/JWT layer is identical; only the "how do we know who you are" front-end of the flow swaps out.

---

## 10. Common pitfalls — at least 5, with severity

1. **Cookie set on parent domain.** `Domain=app.example.com` means the cookie is sent to every subdomain — every tenant. One tenant's session leaks to all others. **Catastrophic.** Severity: this is the bug that kills the company.

2. **Verifying JWT signature but not checking the `tenant` claim against the URL.** The signature being valid only proves "we issued this token." It does not prove "this token belongs on this subdomain." Without the cross-check, a user from tenant A whose cookie somehow lands on tenant B's domain (cookie misconfiguration, user pasting URLs, browser bug) gets access to tenant B's data. This is the cross-check 08 demands. **Catastrophic.**

3. **Storing JWT in localStorage instead of HttpOnly cookie.** localStorage is readable by any JS on the page. One XSS — one malicious npm package, one reflected error message — and the attacker exfiltrates every active session token. HttpOnly cookies are not visible to JS. **High.**

4. **Weak signing secret.** A 16-character secret is bruteforceable. Must be ≥32 bytes of cryptographic randomness. If your secret is "supersecret123" you do not have authentication, you have decoration. **High.**

5. **Long-lived password reset tokens.** A 30-day reset token in an old email is a permanent backdoor into the account. TTL ≤1 hour, single-use, deleted on consumption. **Medium-high.**

6. **(Bonus) Returning different responses for "user not found" vs "wrong password."** Lets attackers enumerate valid emails. Always return the same generic 401. **Medium.**

7. **(Bonus) Logging request bodies that contain passwords.** Worker tail logs, Sentry breadcrumbs, etc. Scrub `password` and `token` fields before logging. **Medium.**

---

## 11. Code sketches the writer can expand

The writer needs three concrete blocks for line-by-line walks. The login handler is in section 5 above. Here are the other two.

**JWT-verifying middleware that pins tenant:**

```ts
// Runs on every authenticated request
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const cookie = c.req.header('Cookie') || ''
  const match = cookie.match(/pf_session=([^;]+)/)
  if (!match) return c.json({ error: 'unauthenticated' }, 401)

  let payload
  try {
    payload = await verify(match[1], c.env.JWT_SECRET)
  } catch {
    return c.json({ error: 'invalid token' }, 401)
  }

  // THE CROSS-CHECK — see 08
  const urlTenant = c.get('tenantSlug')      // from hostname
  const tokenTenant = payload.tenant          // from JWT claim
  if (urlTenant !== tokenTenant) {
    // Token belongs to a different tenant than the URL claims.
    // Could be misconfiguration, could be attack. Either way, refuse.
    return c.json({ error: 'tenant mismatch' }, 403)
  }

  c.set('userId', payload.sub)
  c.set('tenantSlug', tokenTenant)
  await next()
}
```

The writer should land hard on the `urlTenant !== tokenTenant` check. That one `if` is what makes 08's trust chain real.

**The Set-Cookie incantation, isolated for emphasis:**

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

Pull this out as its own snippet so the writer can do the line-by-line on attributes without the noise of the surrounding handler.

---

## Cross-references for the writer to weave in

- **05** — what KV is, how tenant config is stored. Reference when discussing where reset tokens live.
- **08** — the data isolation trust chain. The cross-check in the middleware is THE concrete implementation of the abstraction 08 introduced. The writer should explicitly tie the two together: "remember the trust chain in 08? This is line 14."
- **06** — customer data ingest. Briefly mention that the nightly job authenticates differently (service credentials, not user JWT). Don't go deep.
- **09** — data fetching from the React frontend. The cookie set here is what those `fetch` calls send. Mention `credentials: 'include'` is required for cross-subdomain (it's not, since same-subdomain, but the frontend code should still be explicit).

## Suggested explainer outline for the writer

1. Why auth is the second-most-important thing in this codebase (after isolation, which it implements).
2. Password storage — argon2id, why slow hashing matters, what not to do.
3. The user data model and where it lives (D1, with the unique constraint).
4. Sessions: stateful vs stateless, recommend stateless JWT, name the revocation gap.
5. The JWT itself — HS256, claims, the secret.
6. Login flow with full code walk.
7. The cookie incantation, attribute by attribute, with `Domain=` getting its own subsection.
8. Logout (and its honest limits).
9. Password reset.
10. Inviting additional users.
11. SSO — one section, future-facing.
12. Pitfalls — numbered, scary, memorable.
13. Wrap-up: how this connects back to 08's trust chain.

Word budget guidance: sections 4, 5, 7, and 12 should get the most ink. Section 11 (SSO) should be the shortest substantive section — one or two paragraphs.
