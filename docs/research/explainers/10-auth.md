# 10 — Authentication: License Keys First, Per-User Login Later (Optional)

> **Prerequisites:** read `00-start-here.md`, `01-tenant-resolution.md` (the license-key activation flow — that's the core of v1 auth), `05-cloudflare-architecture.md` (Tauri architecture), and `08-data-isolation.md` (where the per-tenant bearer token lives).

> **By the end of this doc you will know:**
> - Why **the license key is the auth in v1** — there's no separate login screen.
> - The two layers of auth in the current architecture: license key (proves "this install belongs to Acme") and bearer token (proves "this request to the gateway is from a legitimate Acme app").
> - What changes from the old web plan, and what stays.
> - The two scenarios where you'd add **per-user auth** on top, and what that looks like (in the gateway, not the desktop app).
> - The pitfalls — including the one that makes the bearer-token approach safe even though the token sits on every employee's laptop.
> - A short pattern for "logout" / "re-activate as a different tenant" if/when you need it.

---

## 1. The big shift from the web plan

In the old web plan, auth was a real thing you built: a login form, password hashing with argon2id, a `users` table, JWT minting, an HttpOnly cookie locked to the tenant's subdomain. There were many ways for it to go wrong, and the entire doc was about getting it right.

In the new Tauri plan, **most of that goes away.** The license key activation flow (doc 01) is the auth. There's no login screen. There's no users table. The app proves who it is by holding a valid license key signed by our private key; the gateway accepts requests bearing the per-tenant token embedded in that license.

This is the right choice for v1 because:

- The dashboard is read-only. There's no "Acme deletes BigShop's data" risk — we don't write anything back.
- Each desktop install is single-tenant. The "URL claims a tenant, the JWT proves a tenant" trust chain from the old plan collapses to "the license key proves a tenant, period."
- Building a full user-account system is real work. We don't need it to ship.

What you lose: per-user identity. The gateway sees "a request from Acme's app" but doesn't know *which* Acme employee. For most fab shop dashboards, that's fine.

---

## 2. The two layers of v1 auth

### 2.1 Layer 1 — License key (per install)

Covered in doc 01. To recap:

1. We sign a JWT with our private key. Payload contains `{ tenant, gateway_url, bearer_token, exp }`.
2. The user pastes it on first launch. Rust verifies the signature with our baked-in public key.
3. On success, the payload is saved to `activation.json` in the OS app-data directory.
4. Every subsequent launch reads from that file. No re-activation prompt.

**This is what proves the install is Acme.** A laptop without `activation.json` cannot enter the dashboard at all. A laptop with someone else's `activation.json` enters someone else's dashboard.

### 2.2 Layer 2 — Bearer token (per gateway call)

Covered in doc 09 (the data-fetching flow). Every call to the gateway has:

```
GET http://10.0.5.20:8080/metrics/time/monthly-hours
Authorization: Bearer <tenant-specific token>
```

The token is the `bearer_token` field from the license key's payload. The gateway has the same token in its own config and rejects calls without it.

**This is what proves the request is from the Acme app**, not random LAN traffic.

### 2.3 Why two layers and not one

Couldn't the gateway just trust the LAN? In theory yes — it's behind the customer's firewall and only their employees can talk to it. In practice:

- Guest WiFi sometimes ends up on the same VLAN by accident.
- An infected laptop on the LAN shouldn't be able to scrape Acme's data.
- We don't want the gateway to be "anyone who can ping it gets data."

The bearer token is cheap insurance. Even a non-employee on the LAN can't query the gateway without the token.

---

## 3. Where each piece of secret material lives

| Secret | Lives where | Risk if exposed |
|---|---|---|
| **Our private signing key** | Your password manager / hardware token | Catastrophic — anyone can mint license keys for any tenant. Protect like a root credential. |
| **Our public verification key** | Source code, baked into the app | None — public keys are public. |
| **Tenant license key (JWT)** | Customer IT's records; `activation.json` on each laptop | Medium — see §4 below. |
| **Bearer token (per tenant)** | Inside the license key payload; gateway config | Medium — anyone with token + network reachability can call the gateway. Rotate by reissuing the license. |
| **Database credentials** | Gateway config only | High — direct DB access. Never put these on a laptop. |

The cleanly separated layers mean a compromised laptop loses one tenant's bearer token (bounded blast radius), not the database creds (catastrophic) and not the signing key (game over).

---

## 4. What happens if a license key leaks?

The bearer token sits on every employee laptop inside Acme. If a laptop is lost or compromised, the attacker has:

- The license key (which proves "I am Acme").
- The gateway URL (e.g., `http://10.0.5.20:8080`).
- The bearer token to authenticate to the gateway.

**To actually use them**, the attacker also needs to be on a network that can reach `10.0.5.20:8080`. That's Acme's LAN. Without LAN reachability (or VPN access), the license is useless.

This is the property that makes "ship the bearer token on every laptop" tolerable:

- The token is **scoped to the network**, not the laptop.
- An attacker outside Acme's LAN can't use it.
- An attacker inside Acme's LAN already has bigger problems and would still have to hit the gateway through its bearer-token-required API rather than the DB directly.

Mitigations to layer on:

- **Short license expirations** (12 months) limit blast radius.
- **Bearer-token rotation** during onboarding: if a customer reports a stolen laptop, reissue the license key with a new token, update the gateway, push the new license to the remaining laptops. (Doc 11 covers the operational playbook.)
- **Gateway-side rate limiting**: the gateway should not happily serve 10,000 requests per second to an authenticated caller. Throttling makes a leak less interesting.

---

## 5. When you'd add per-user auth (and what it looks like)

Per-user auth answers: "which Acme employee made this request?" v1 doesn't track that. Two scenarios will pull you toward adding it:

### 5.1 You need per-user permissions

Example: "Acme's hourly employees should see the Time module but not Estimating; only managers see Estimating." Today the app shows all modules to anyone with the license. To gate by role, the gateway has to know who's asking.

### 5.2 You need an audit trail

Example: "Who looked at the win-rate chart yesterday at 3pm?" Today the answer is "an Acme app on the LAN." To get "Jane in Accounting looked at it," each request has to carry a user identity.

### 5.3 The smallest version of per-user auth

You don't have to build a full SSO system to add per-user identity. The smallest version:

1. **Add an email + password login screen** in the app, **shown after activation** (the user activates as Acme first; then signs in as themselves).
2. The credentials are validated by the gateway against a small `users` table the gateway maintains for its tenant.
3. On successful login, the gateway returns a **per-user JWT** the app uses on every subsequent call (in addition to the bearer token).
4. The gateway uses that JWT to know "this request is from `jane@acme.com`."

The shape:

```
   App                              Gateway
    |  POST /login                    |
    |  { email, password }            |
    | -----------------------------> |
    |                                 |  bcrypt-check password,
    |                                 |  sign a JWT
    |  <--------------------------- |  { user_jwt }
    |                                 |
    |  GET /metrics/...               |
    |  Authorization: Bearer <token>  |
    |  X-User-Token: <user_jwt>       |
    | -----------------------------> |  verify bearer token,
    |                                 |  verify user JWT,
    |                                 |  check role permissions,
    |  <--------------------------- |  return data
```

A few design notes:

- The bearer token is still required. The user JWT is *additional*, not a replacement.
- The user JWT is signed by the gateway itself (a per-gateway secret), not by us. Means we don't run an auth service.
- Password reset, "I forgot my password," etc. is a feature of the gateway. The gateway gets bigger; we still don't.
- For real production, prefer integrating with the customer's existing identity provider (SSO via SAML / OIDC) instead of running yet another password store. That's a v2 conversation.

### 5.4 What stays the same

- The license-key activation flow doesn't change.
- The bearer token doesn't change.
- The dashboard's React side adds a login screen and a "current user" indicator — same patterns as any web app.

---

## 6. Logout and re-activation

There's no "logout" in v1 because there's no login. What you might want:

### 6.1 "Switch to a different tenant"

Useful for IT or for a user who genuinely works for two fab shops. Wipe `activation.json`, reload, drop back to the activation screen.

```rust
// src-tauri/src/commands.rs
#[tauri::command]
fn clear_activation(app: tauri::AppHandle) -> Result<(), String> {
    let path = app.path().app_data_dir().unwrap().join("activation.json");
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

From React, a "Switch tenant" menu item:

```tsx
async function switchTenant() {
  await invoke('clear_activation');
  window.location.reload();
}
```

### 6.2 "Sign out" (when per-user auth is added)

Delete the user JWT from local storage / a Tauri-managed file. Drop to the login screen. The activation persists (the install is still Acme); only the user identity is cleared.

---

## 7. The pitfalls

### 7.1 Don't reuse the bearer token across tenants

If every gateway accepts the same bearer token, the system is one shared secret away from a cross-tenant leak. Each tenant gets a unique token, generated during onboarding (doc 11), embedded in their license key.

### 7.2 Don't store the bearer token in localStorage

The `bearer_token` from the license payload lives in `activation.json`, written by Rust to the OS app-data directory with default OS permissions (user-only). It should **not** be passed to React and stored in `localStorage` — `localStorage` is plaintext, accessible to any script in the webview. Keep it in Rust.

### 7.3 Don't skip the bearer-token check on the gateway

"It's on the LAN, it's safe enough" is wrong. The gateway must check the token on every request. The check is one line; the missing check is a back door.

### 7.4 Don't use the license-signing private key for anything else

It's the most valuable secret in the system. Don't use it to sign user JWTs, don't use it to encrypt config, don't use it for the gateway. One key, one job.

### 7.5 Don't hand-roll your own JWT library

Use a maintained library on both sides:

- Rust: `jsonwebtoken` (for verifying the license JWT) and `ed25519-dalek` (for signature primitives).
- Python (gateway): `pyjwt`.
- The signing tool can use `jose` (Node) or `pyjwt` — whichever's easier.

Rolling your own JWT verification is a classic foot-gun (algorithm confusion attacks, etc.). Use the libraries.

### 7.6 Don't expose `/login` (or any endpoint) without bearer-token gating, even before per-user auth

If/when you add a `/login` endpoint to the gateway, it still requires the per-tenant bearer token. The bearer token is a *prerequisite* to even attempting to log in.

---

## 8. The full picture in one diagram

```
   +----------------------------------------+
   |  YOU (the developer)                   |
   |   - private signing key                |
   |   - tools/sign-license.ts              |
   +-------+--------------------------------+
           |
           | issues per tenant:
           |   - license key (signed JWT)
           |   - bearer token (embedded in JWT)
           v
   +----------------------------------------+
   |  CUSTOMER IT                           |
   |   - hands license key to employees     |
   |   - puts bearer token in gateway config|
   +-------+----------+---------------------+
           |          |
   activate|          |configures
           v          v
   +--------------+   +--------------+
   | Each laptop  |   | Gateway      |
   |  activation. |   |  bearer token|
   |   json       |   |   matches    |
   |   (license + |   |              |
   |    token)    |   |              |
   +--------------+   +--------------+
           |                 ^
           +-----------------+
              every request:
              Authorization: Bearer <token>
```

That's the whole v1 auth model. License key proves the install. Bearer token proves the request to the gateway. The dashboard is single-user-aware (it doesn't ask who you are); the gateway is single-tenant-aware (it only serves its own tenant).

---

## 9. By the end of this doc you should know

- The license key is the auth in v1. There is no separate login.
- The two layers: license key (install-level) and bearer token (request-level).
- Where each secret lives and what happens if it leaks.
- The two scenarios that would lead you to add per-user auth, and the small shape it takes (login → gateway-signed user JWT → on every request, alongside the bearer token).
- How "switch tenant" works (clear `activation.json` and reload).
- The six pitfalls: token sharing, localStorage storage, missing gateway check, signing-key reuse, hand-rolled JWT code, ungated `/login`.

---

**Next:** [`11-tenant-lifecycle.md`](./11-tenant-lifecycle.md) — onboarding a new fab shop end to end: issuing keys, deploying their gateway, shipping their config, and what happens when they leave.
