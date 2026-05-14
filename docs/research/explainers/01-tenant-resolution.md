# 01 — Tenant Resolution: How the App Knows Who It's For

> **Prerequisite:** read [`00-start-here.md`](./00-start-here.md). This doc assumes you know what a tenant, a license key, and a Tauri app are.

> **By the end of this doc you will know:** what "tenant resolution" means in a desktop app, six different ways to do it (with honest pros/cons of each), our recommended approach and why, and a line-by-line walk-through of the recommended code path — from the user pasting a license key to the app saying "I am Acme."

---

## 1. What "tenant resolution" means

Tenant resolution is the part of the app that answers the question:

> *Which customer is this install for?*

On the web (the old plan), this was easy: read the subdomain. `acme.app.example.com` → tenant is `acme`. The URL itself carried the identity.

On the desktop there is no URL. The app is just sitting in `C:\Program Files\Dashboard\dashboard.exe`. There's no `acme` anywhere on disk. So we need a different mechanism for the app to figure out who it's for.

That mechanism — whatever we pick — is what tenant resolution means in the new world.

Tenant resolution always happens **once per install, on first launch**. After that the answer is cached in a local file (or the OS keychain), and every subsequent launch just reads the cached answer. We do not ask the user to prove who they are every single time the app opens — that would be annoying.

---

## 2. The six options for tenant resolution

There is no single "correct" answer here. The right pick depends on three things:

1. **How many customers do you expect?** 10 vs. 200 changes the math.
2. **How technical is the customer's IT person?** Some shops have an IT manager who can run an installer with a config file; some have a single owner who needs zero friction.
3. **How much infrastructure do you want to run?** Some options require us to host a small server; some don't.

I'm going to lay out six options, in roughly increasing order of friction, and at the end recommend one. Skim them all first before judging.

### Option A — Per-tenant installer (single-tenant builds)

**How it works.** We build a separate installer for each customer. `acme-dashboard-1.2.3.msi`, `bigshop-dashboard-1.2.3.msi`, etc. Each one has the tenant slug compiled in as a constant — like a `TENANT_ID = "acme"` line in the code, set at build time. The user just runs the installer and the app already knows who it is.

**Pros.**
- Zero friction for the end user. No code to enter, no login screen.
- No client-side validation logic. The tenant identity is just *there*.
- Easy to reason about. You can hand-inspect a build and know which tenant it belongs to.

**Cons.**
- A new release means recompiling and signing **N installers** (one per customer). At 200 customers, this is many minutes of CI time and 200 signed binaries to host. Manageable, but operationally heavy.
- A new customer means a new build before they can install. Onboarding is slower.
- If a user accidentally downloads the wrong installer, they get the wrong tenant. (Mitigated by tenant-specific download URLs.)
- You're effectively running a single-tenant deployment with multi-tenant code. Defeats some of the "one app many tenants" elegance.

**Good for.** Small numbers of high-value customers (say <20), or environments where you absolutely cannot ask the user to do anything on first launch.

### Option B — Drop-a-config-file activation

**How it works.** Same installer for everyone. After install, the customer's IT person drops a small file — `tenant.json` — into a well-known location next to the app (e.g., `C:\ProgramData\Dashboard\tenant.json`). On launch, the app looks for that file, reads it, and learns who it is. No UI for activation.

**Pros.**
- One installer for everyone. Build once, ship to all.
- IT-friendly. IT departments can push the file via Group Policy, Intune, JAMF, or a deployment script.
- Zero end-user friction. The employee just opens the app and it works.

**Cons.**
- Requires the customer to have an IT capability — not every fab shop does.
- The file is on disk in plain view. Anyone with file-system access can edit it and pretend to be another tenant. (For our case, that's mostly a non-issue because the data gateway will reject queries from a tenant it doesn't recognize — but it's not ideal.)
- If the file is missing on first launch, the app has to know how to recover (show an "ask your IT person for tenant.json" screen).

**Good for.** Mid-size or larger customers who have an IT person and prefer "zero-touch" rollouts to many employees.

### Option C — Offline-signed license key (the recommended approach)

**How it works.** Same installer for everyone. On first launch the app shows a single screen: "Enter your license key." The user pastes a long string like:

```
eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJ0ZW5hbnQiOiJhY21lIiwiZ2F0Z
XdheV91cmwiOiJodHRwOi8vMTAuMC41LjIwOjgwODAiLCJleHAiOjE3OTk5OTk5OT
l9.0pXc3K2vWeQZk5L8wQ3p9C7gZ4mE5tH7zJ9...
```

That string is a **JWT** (JSON Web Token) — three base64 chunks separated by dots: `header.payload.signature`. The middle chunk decodes to JSON like:

```json
{
  "tenant": "acme",
  "gateway_url": "http://10.0.5.20:8080",
  "exp": 1799999999
}
```

The app has our **public key** baked into its source code. It uses the public key to verify the JWT's signature. If the signature checks out, the app trusts the payload, extracts the tenant slug, saves everything to a local config file, and never asks again. No server call required at any point.

**Pros.**
- One installer for everyone. No per-tenant builds.
- No server required for activation. The verification happens entirely on the user's machine using the public key baked into the app.
- Tamper-proof. The user can't edit the token to change the tenant slug because they don't have our private key — any change breaks the signature.
- Expiry is supported (the `exp` field). Stops working after a date.
- Easy to reissue if a customer loses their key (we just sign a new one).

**Cons.**
- The end user has to paste a long string once. (Real friction, but a one-time event.)
- Revocation is awkward. Because verification is offline, we can't "kill" a key once it's issued. The best we can do is set short expirations and force renewal, or maintain a revocation list the app fetches on launch (which then makes it not really offline).
- We have to manage a private key safely. Lose it = anyone can forge keys. Leak it = same.

**Good for.** Most customers, in most cases. This is the default we'll build first.

### Option D — Server-verified license key (online activation)

**How it works.** Same UI as Option C — user pastes a license key on first launch. But instead of verifying the signature offline, the app sends the key to our small activation server. The server says "yes, that's Acme's key, valid until 2027" or "no, that key was revoked." The server returns a longer-lived auth token (often a JWT we sign on the fly) that the app uses for subsequent calls.

**Pros.**
- Revocation is easy: we mark the key as revoked in our DB, and the next activation attempt fails.
- We can update the tenant's config or gateway URL by re-issuing the response without changing the key the user has.
- We can see who has activated (telemetry).

**Cons.**
- Requires us to run and maintain a server. Even a tiny one.
- Requires the user to have internet on first launch. Annoying for offline-first shops.
- One more thing to monitor and keep up. Outage = no new activations.

**Good for.** Cases where you need real revocation, or where you anticipate frequent license issuance/changes.

### Option E — Email/password account login

**How it works.** Like signing into a normal SaaS app. The user types their email and password. The server says "your email belongs to Acme" and returns an auth token. The app stores the token and knows it's Acme.

**Pros.**
- Familiar pattern — every user understands "sign in with email and password."
- Naturally per-user. You get individual user identities for free, which is useful for permissions and audit logs.
- Password resets are a well-trodden problem with off-the-shelf solutions.

**Cons.**
- Requires us to run an auth server, manage password storage, handle resets, do all of the user-management drudgery.
- Requires every employee to have an account before they can use the app. Onboarding 30 employees at a new fab shop means provisioning 30 accounts.
- Annoying for offline-first shops (auth requires network).
- For a dashboard that primarily *reads* live data from a local gateway, you're adding a whole user-account system just to learn the tenant slug. Heavy.

**Good for.** Cases where per-user identity matters (e.g., approvals, comments, role-based access) — typically a later phase of the product, not Day 1.

### Option F — MDM / Group Policy push

**How it works.** The customer's IT department uses their device-management tool (Intune, JAMF, Workspace ONE, Group Policy, etc.) to push a registry key, plist entry, or config file containing the tenant slug to every employee's machine. The app reads from the OS-managed location on launch.

**Pros.**
- Truly zero-touch. Employees don't see an activation screen ever.
- Centralized: IT can change the tenant assignment for a whole fleet at once.
- IT departments already do this for other software, so it fits their workflow.

**Cons.**
- Only feasible for customers with managed devices and an IT team that does device management.
- Different per OS — we have to support a Windows path, a macOS path, a Linux path. More code.
- For Linux/personal Macs, may not apply.

**Good for.** Large customers with proper IT (think 200+ employees with managed laptops). Not the default for a 100-employee fab shop, but nice to support eventually.

### Comparison table

| Option | One installer? | User friction | Server required? | Revocable? | Per-user identity? |
|---|---|---|---|---|---|
| A — Per-tenant installer | No | None | No | No (would need an updater) | No |
| B — Drop-a-config-file | Yes | None for user; IT does setup | No | Weak (file can be replaced) | No |
| **C — Offline license key** | **Yes** | **Paste a key once** | **No** | **Weak (expiry only)** | **No** |
| D — Server-verified key | Yes | Paste a key once | Yes | Yes | No |
| E — Email/password login | Yes | Sign in like SaaS | Yes | Yes | Yes |
| F — MDM push | Yes | None | No | Via MDM | No |

---

## 3. The recommendation: start with C, design so D and F can be added later

**For Day 1 of the new product, we'll do Option C — offline-signed license keys.** Reasons:

- It's the only option that's both "one installer for everyone" AND "no server we have to run." Those two properties are huge early. We can ship updates and onboard new customers without standing up infrastructure.
- It's tamper-proof. Users can't pretend to be someone else by editing files.
- It's familiar from products like JetBrains IDEs and offline-licensed software — it's a model people have seen.

**Design escape hatches now so we can evolve later:**

- The license key payload contains a `gateway_url` (and other tenant-specific knobs). That means we can change a tenant's gateway URL by reissuing a key — no code change required.
- The activation flow saves "tenant slug + tenant config" into a single local file. If we later want to switch to Option D (server-verified), we just change *how that file gets populated* — the rest of the app reads from the same place.
- If a big customer asks for MDM (Option F) later, we add a "read from the OS-managed config location BEFORE showing the activation screen" check at the very top. Backward-compatible.

We won't build E (full user accounts) yet, because the dashboard mostly just *displays* data — there's no obvious need for per-user identity in v1. We can add it later if the product grows toward features that need it (sign-offs, comments, etc.).

---

## 4. JWTs in plain English (because the rest of this doc uses them)

You don't have to understand the cryptography to read the rest of this doc, but you should know what a JWT is mechanically.

A **JWT** is a string with three parts separated by dots:

```
HEADER.PAYLOAD.SIGNATURE
```

Each part is **base64url-encoded** — base64 is a way to write any data using only letters, digits, `-`, and `_`. So a JWT looks like a long jumble, but if you base64-decode each part:

- **Header** decodes to JSON like `{"alg": "EdDSA", "typ": "JWT"}`. Says what algorithm signed it. `EdDSA` is a modern signature algorithm. Don't worry about the choice; we'll standardize on one.

- **Payload** decodes to JSON like `{"tenant": "acme", "gateway_url": "http://10.0.5.20:8080", "exp": 1799999999}`. The actual claims. Tenant slug, expiry timestamp, gateway URL, anything else we want to ship in the key.

- **Signature** is a cryptographic signature over the header + payload. It's computed using our **private key**. Anyone with our **public key** can verify it. Without the private key, you can't produce a valid signature for any change to the payload.

That last property is the magic: **the payload is public (anyone can read it), but no one except us can modify it without breaking the signature.**

To create a license key for Acme, we (on our laptop) do:

```bash
# Pseudo-code
PAYLOAD='{"tenant":"acme","gateway_url":"http://10.0.5.20:8080","exp":1799999999}'
SIGNATURE=ed25519_sign(PAYLOAD, OUR_PRIVATE_KEY)
LICENSE=base64(HEADER) + "." + base64(PAYLOAD) + "." + base64(SIGNATURE)
```

We hand `LICENSE` to Acme. They paste it. The app:

```rust
// Pseudo-code, in the Rust side of Tauri
let (header, payload, signature) = split_dots(license);
if ed25519_verify(payload, signature, BAKED_IN_PUBLIC_KEY) {
    let claims = parse_json(payload);
    if claims.exp > now() {
        save_to_local_config(claims);
        return Ok(claims.tenant);
    } else {
        return Err("expired");
    }
} else {
    return Err("invalid signature");
}
```

That's the whole mechanism. No server, no database, no network — just math.

### Key management (the boring but important part)

The private key is the one secret we *cannot* lose. If it leaks, anyone can mint license keys for any tenant.

Recommendations:

- Generate the key pair once, store the private key in a password manager (or a hardware security module if you want to be fancy).
- The signing tool (a small script we'll write — covered in doc 11) takes the private key path and the tenant slug, outputs a license key. Run on your laptop, manually, for each new customer.
- The public key goes in source control, baked into the app. It's safe to publish.
- Rotate the key pair every few years by signing license keys with the new pair AND keeping the old public key in the app for backward compatibility. (Edge case; cross that bridge later.)

---

## 5. The activation flow, step by step

Now let's walk through what actually happens when a user runs the app for the first time. We'll cover:

- What the screen looks like
- What gets stored where
- What happens on subsequent launches
- All the failure modes

### 5.1 First launch — the activation screen

The user double-clicks the app icon. Tauri starts, the webview opens. The React app boots and immediately asks Rust: "Am I already activated?"

```ts
// In src/App.tsx — pseudo-code
import { invoke } from '@tauri-apps/api/core';

const tenant = await invoke<string | null>('get_activated_tenant');
if (tenant === null) {
  return <ActivationScreen />;
} else {
  return <Dashboard tenant={tenant} />;
}
```

`get_activated_tenant` is a **Tauri command** (a Rust function exposed to the UI). It looks for a local file we created when activation succeeded, and returns the tenant slug if present.

```rust
// In src-tauri/src/commands.rs — pseudo-code
#[tauri::command]
fn get_activated_tenant(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = app.path().app_data_dir().unwrap().join("activation.json");
    if !path.exists() { return Ok(None); }

    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let activation: Activation = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    // Still good?
    if activation.exp < now() {
        return Ok(None);  // expired; treat as not activated
    }
    Ok(Some(activation.tenant))
}
```

The `app_data_dir` is a Tauri-provided path that resolves to the right OS-specific spot:

- Windows: `C:\Users\<name>\AppData\Roaming\com.yourcompany.dashboard\`
- macOS: `~/Library/Application Support/com.yourcompany.dashboard/`
- Linux: `~/.local/share/com.yourcompany.dashboard/`

If the file doesn't exist (first ever launch) or is expired, `get_activated_tenant` returns `None` and React renders the activation screen:

```tsx
// In src/ActivationScreen.tsx — pseudo-code
function ActivationScreen() {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      const tenant = await invoke<string>('activate', { license: key.trim() });
      // Activation saved a file. Reload the app.
      window.location.reload();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div>
      <h1>Welcome — enter your license key</h1>
      <p>Your IT person should have given you this. It looks like a long string of letters and numbers.</p>
      <textarea value={key} onChange={e => setKey(e.target.value)} rows={4} />
      <button onClick={submit} disabled={!key}>Activate</button>
      {error && <p style={{color: 'red'}}>{error}</p>}
    </div>
  );
}
```

### 5.2 The `activate` command

When the user clicks "Activate," React calls the Rust `activate` command:

```rust
// In src-tauri/src/commands.rs — pseudo-code
use ed25519_dalek::{Verifier, VerifyingKey, Signature};

// The public key — baked in at compile time. Generated once, never changes.
const PUBLIC_KEY_BYTES: &[u8] = include_bytes!("../keys/public.bin");

#[derive(serde::Deserialize)]
struct Claims {
    tenant: String,
    gateway_url: String,
    exp: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Activation {
    tenant: String,
    gateway_url: String,
    exp: u64,
    activated_at: u64,
}

#[tauri::command]
fn activate(app: tauri::AppHandle, license: String) -> Result<String, String> {
    // 1. Split "header.payload.signature"
    let parts: Vec<&str> = license.split('.').collect();
    if parts.len() != 3 { return Err("Not a license key.".into()); }

    let header_b64 = parts[0];
    let payload_b64 = parts[1];
    let signature_b64 = parts[2];

    // 2. Decode the signature.
    let signature_bytes = base64_url_decode(signature_b64)?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|e| e.to_string())?;

    // 3. Verify the signature against (header + "." + payload).
    let pubkey = VerifyingKey::from_bytes(PUBLIC_KEY_BYTES.try_into().unwrap())
        .map_err(|e| e.to_string())?;
    let signed_message = format!("{}.{}", header_b64, payload_b64);
    pubkey.verify(signed_message.as_bytes(), &signature)
        .map_err(|_| "License key signature is not valid. Did you copy the whole thing?")?;

    // 4. Decode and parse the payload.
    let payload_json = base64_url_decode(payload_b64)?;
    let claims: Claims = serde_json::from_slice(&payload_json)
        .map_err(|_| "License key payload is malformed.")?;

    // 5. Check expiry.
    if claims.exp < now_seconds() {
        return Err("This license key has expired. Contact support.".into());
    }

    // 6. Save activation.json.
    let activation = Activation {
        tenant: claims.tenant.clone(),
        gateway_url: claims.gateway_url,
        exp: claims.exp,
        activated_at: now_seconds(),
    };
    let path = app.path().app_data_dir().unwrap().join("activation.json");
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&path, serde_json::to_string_pretty(&activation).unwrap())
        .map_err(|e| e.to_string())?;

    // 7. Return the tenant slug so the UI can immediately continue.
    Ok(claims.tenant)
}
```

That's a chunk of code, so let me explain each step in beginner terms.

- **Step 1.** A JWT is "three things joined by dots." We split it and check we got three pieces. If not, the user pasted half a key or some random text.
- **Step 2.** The signature part is base64-encoded; we decode it into raw bytes. The `Signature::from_slice` call wraps those bytes in a type the crypto library understands.
- **Step 3.** We construct a `VerifyingKey` from the public key bytes (which were embedded at compile time via `include_bytes!`). Then we ask: "does this signature match `header.payload`, using this public key?" If yes, the key was signed by whoever holds our private key — which is only us. If no, someone tampered with the token, or the user pasted garbage.
- **Step 4.** We decode the payload (which is base64) and parse the JSON inside. `serde_json` is Rust's JSON parser. The `Claims` struct says "the JSON has these fields."
- **Step 5.** We check the expiry. The `exp` field is a Unix timestamp — seconds since 1970-01-01. If it's in the past, the key is expired.
- **Step 6.** We save everything we need from the key (plus when we activated, for logging) into `activation.json` under the OS-specific app-data directory. Next launch we just read this file.
- **Step 7.** Return the tenant slug. The UI was awaiting this; now it can reload and show the dashboard.

### 5.3 Subsequent launches

Now the app already has `activation.json`. On every subsequent launch, `get_activated_tenant` reads that file, optionally re-checks expiry, and returns the tenant slug immediately. No prompt, no key entry. The user just sees the dashboard.

If the activation has expired, we drop back to the activation screen and tell them to get a fresh key.

### 5.4 Failure modes and what to show

A short table because the user-facing messages matter:

| Failure | What to show |
|---|---|
| Garbage in the textbox (no dots) | "That doesn't look like a license key. It should be a long string starting with a few letters and containing dots." |
| Right shape but signature bad | "License key is invalid. Make sure you copied the whole thing, including the dots." |
| Right shape, signature good, expired | "Your license key expired on <date>. Contact your IT person or our support to get a new one." |
| Right shape, signature good, missing fields | "License key is malformed. (This shouldn't happen — please contact support.)" |
| `activation.json` exists but is corrupted | Delete the file, drop to activation screen. |
| `activation.json` exists but expired | Same as 'expired' above — drop to activation screen with the expired message. |

Plain, friendly error messages. Most of the failure modes here are "user mispasted the key." Make it easy to fix.

---

## 6. Local development — how do you test without real keys?

In dev mode, asking yourself to issue a real license key every time you `npm run tauri dev` is annoying. Two patterns help:

### 6.1 Dev license keys

We generate a separate dev key pair (different from production). The dev public key is baked into debug builds; the dev private key sits in your repo (gitignored or stored locally). You write a small script — `tools/sign-license.ts` — that signs a key with the dev private key for any tenant you want:

```bash
$ npx tsx tools/sign-license.ts --tenant acme --days 30
eyJhbGciOiJFZERTQSJ9.eyJ0ZW5h...
```

Paste the output into your running dev app and you're activated as Acme.

### 6.2 `DEV_TENANT` environment variable

For "I want to start as Acme without going through the activation screen," support an env var:

```bash
$ DEV_TENANT=acme npm run tauri dev
```

In Rust, on startup, if `cfg!(debug_assertions)` (i.e., debug build) and `DEV_TENANT` is set, write a fake `activation.json` with that tenant and a far-future expiry. Skip the activation screen entirely. Only works in debug builds — release builds ignore this.

This is the equivalent of "load a fake config in local dev because localhost has no subdomain" from the old web plan.

---

## 7. Issuing license keys (the operations side)

For each new customer:

1. Pick a tenant slug. `acme`, `bigshop`, `briansbeams`. Lowercase, no spaces, stable. Once chosen, don't change it. It'll appear in filenames and logs forever.

2. Pick a gateway URL. This is the address where the customer's data gateway lives inside their network. Could be `http://10.0.5.20:8080` (LAN IP) or `http://gateway.acme.local:8080` (local DNS). We get this from the customer during onboarding.

3. Pick an expiry. We recommend 12-month expiries for paying customers. (Renewal is just "issue a new key.")

4. Run the signing tool:

   ```bash
   $ npx tsx tools/sign-license.ts \
       --tenant acme \
       --gateway-url http://10.0.5.20:8080 \
       --days 365
   eyJhbGciOiJFZERTQSJ9.eyJ0ZW5h...
   ```

5. Email/Slack/whatever the key to the customer's IT person.

The full tenant-onboarding process is covered in doc 11. This is just the "issue a key" piece.

---

## 8. Why this is better than the old subdomain approach

The original plan used `acme.app.example.com` to identify the tenant. That worked because the browser puts the host in every HTTP request — the server can read it and know who's asking. We've replaced that with a license key. A few notes on why this is actually nicer for our use case:

- **Subdomains require DNS, certificates, and a wildcard hosting setup.** Tedious. License keys require none of that — just a key pair we manage once.

- **Subdomains require the user to type the right URL.** A fab shop employee has to know "go to `acme.app.example.com`, not `acme.com`." With a desktop app, they just open the icon on their desktop.

- **License keys carry per-tenant config.** The gateway URL travels with the key, so we don't need a central directory mapping `acme` → "your gateway is at 10.0.5.20." It's all in the token.

- **Offline.** Subdomain-based identification needs DNS to resolve and HTTPS to terminate. License-key activation works on a laptop with no internet.

The tradeoff: subdomains support unauthenticated users showing up out of the blue and being correctly routed. License keys require the customer to have a key before they can use the app at all. For our case — a paid product with a known customer list — that's fine. We *want* "no key, no entry."

---

## 9. By the end of this doc you should know

- What tenant resolution means and why the desktop version is different from the web version.
- The six broad approaches to tenant identity on the desktop (A through F) and their tradeoffs.
- Why we're starting with Option C: offline-signed license keys.
- What a JWT is, mechanically: header + payload + signature.
- The role of the private and public keys (sign vs. verify).
- The first-launch activation flow end-to-end: activation screen → `activate` command → write `activation.json` → reload to dashboard.
- How subsequent launches skip the activation screen by reading the cached file.
- How to test in local dev without juggling real license keys.
- How we'll issue keys to a new customer in practice.

If any of that is fuzzy, the JWT section (§4) is the single most important piece — re-read it until "sign on our side, verify on theirs" feels obvious.

---

**Next:** [`02-config.md`](./02-config.md) — once we know we're Acme, what does Acme's config look like, and where does it live?
