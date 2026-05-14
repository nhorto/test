# 05 — The Tauri Architecture: What Each Piece Does and How They Fit Together

> **Note on the filename.** This file is still called `05-cloudflare-architecture.md` for historical reasons — the contents used to describe a Cloudflare-hosted web app. We rewrote it for the Tauri desktop world but left the filename alone so existing links don't break.

> **Prerequisites:** read `00-start-here.md`, `01-tenant-resolution.md`, and `02-config.md` in order. They establish the vocabulary (tenant, license key, gateway, webview) and the request flow this doc fleshes out.

> **By the end of this doc you will know:** every component in the new architecture, what each one is, what it costs, where it physically lives, and how they all fit together. You'll see the **big architectural tradeoff** — where the database credentials live and how the desktop apps reach the data — laid out with three options and a recommendation. You'll also know the four anti-patterns to avoid and a rough cost picture at 10 vs. 200 tenants.

This doc is reference-shaped. Read it once cover to cover, then skim it later when you need the role or the cost of a specific piece.

---

## 1. Why this doc exists

You have a bunch of architectural decisions to make, and they don't fit on the back of a napkin:

- Where does the React UI run? (inside Tauri's webview, on the user's laptop)
- Where does the Rust side run? (in the same Tauri process)
- Where does the customer's data live? (in *their* database, on *their* server)
- Where do the database credentials live? **(the real question)**
- How do the desktop apps reach the database? Directly? Through a local gateway? Through us in the cloud?
- Where do app updates come from? Where does the license signing key live?

Most of the answers are short ("on the user's laptop"), but the gateway question is genuinely consequential and deserves a careful look (§4). The point of this doc is so you can hold the whole picture in your head — not just what each piece is, but **why it's where it is**.

A note on naming: I'll say "Tauri" to mean the framework, "the app" to mean the compiled Tauri binary the customer installs, "the gateway" for the small data service we'll discuss in §4, and "the database" for the customer's own ERP database.

---

## 2. The big picture first

Before defining anything, here is the recommended architecture in one diagram. Every piece is defined in the next section. Skim the diagram, then come back to it after the vocabulary primer.

```
                              YOUR (DEV) MACHINE
                  +----------------------------------------+
                  |  - Source code (Git)                   |
                  |  - License signing tool                |
                  |  - Private key (in password manager)   |
                  |  - CI/CD that builds installers        |
                  +-----------------+----------------------+
                                    |
                                    | (publish: installers + update manifest)
                                    v
                  +----------------------------------------+
                  |        OUR UPDATE / DOWNLOAD SERVER    |
                  |   (small static hosting: S3, R2, or    |
                  |    GitHub Releases — your call)        |
                  |                                        |
                  |  - dashboard-1.2.3-x64.msi (Windows)   |
                  |  - dashboard-1.2.3-arm64.dmg (Mac)     |
                  |  - latest.json (update manifest)       |
                  +-----------------+----------------------+
                                    |
                                    | initial download +
                                    | periodic update checks
                                    v
   =======================================================================
                       INSIDE ACME'S FAB SHOP (the customer)
   =======================================================================

   +---------------------------+        +---------------------------+
   |  Employee laptop #1       |        |  Employee laptop #N       |
   |  +----------------------+ |        |  +----------------------+ |
   |  |   TAURI APP          | |  ...   |  |   TAURI APP          | |
   |  |  +----------------+  | |        |  |  +----------------+  | |
   |  |  | Webview        |  | |        |  |  | Webview        |  | |
   |  |  |  React UI      |  | |        |  |  |  React UI      |  | |
   |  |  +-------+--------+  | |        |  |  +-------+--------+  | |
   |  |          | invoke    | |        |  |          | invoke    | |
   |  |          v           | |        |  |          v           | |
   |  |  +----------------+  | |        |  |  +----------------+  | |
   |  |  | Rust backend   |  | |        |  |  | Rust backend   |  | |
   |  |  | - activation   |  | |        |  |  | - activation   |  | |
   |  |  | - HTTP client  |  | |        |  |  | - HTTP client  |  | |
   |  |  +-------+--------+  | |        |  |  +-------+--------+  | |
   |  +----------|-----------+ |        |  +----------|-----------+ |
   +-------------|-------------+        +-------------|-------------+
                 |                                    |
                 |   HTTP (LAN)                       |   HTTP (LAN)
                 |   GET /metrics/...                 |   GET /metrics/...
                 +-----------------+------------------+
                                   v
                  +----------------------------------------+
                  |     ACME'S DATA GATEWAY                |
                  |   (one machine on Acme's LAN)          |
                  |                                        |
                  |  - Holds the DB credentials            |
                  |  - HTTP API: /metrics/<module>/<id>    |
                  |  - Runs the metric logic (Python +     |
                  |    optionally the C# binary)           |
                  |  - Bearer-token auth on every call     |
                  +-----------------+----------------------+
                                    |
                                    | SQL over the LAN
                                    v
                  +----------------------------------------+
                  |     ACME'S ERP DATABASE                |
                  |   (their own server / SQL Server /     |
                  |    Postgres / whatever — we read       |
                  |    only, never write)                  |
                  +----------------------------------------+
```

A few things to notice up front:

- **Everything inside the customer's fab shop never touches us.** Live data flows: laptop → gateway → database. No internet round trip. Even with our update server down, customers can still use the app — they just can't get new versions.
- **The only place our infrastructure appears is the update server.** That's a tiny static-file host. No customer data goes through it. Ever.
- **There is one Tauri app per employee** but **one gateway per fab shop.** That's the asymmetry that makes the gateway architecturally important: it's the one shared piece per customer.

---

## 3. Every component, in plain English

### 3.1 The Tauri app (a single binary the user installs)

A Tauri app is a desktop program that bundles three things together:

1. A **native window** with a title bar, an icon, a "close" button — supplied by the user's operating system.
2. A **webview** inside that window. Same engine the OS already has (Edge's WebView2 on Windows, Safari's WKWebView on Mac, WebKitGTK on Linux). The webview renders HTML, CSS, JavaScript — exactly like a browser tab.
3. A **Rust backend** — a small program that the webview can call into for things the webview can't do safely on its own: read local files, make authenticated HTTP requests, talk to the OS keychain.

The installer is small — typically 5–10 MB — because we're not bundling Chromium (compare Electron at ~80 MB). The OS already has a webview installed.

Everything from doc 03 (the registry pattern, lazy loading, `<MetricSlot>`, etc.) lives in the React UI inside that webview.

### 3.2 The Tauri command bridge

The webview and the Rust backend talk via a mechanism called **Tauri commands**. From the React side:

```ts
import { invoke } from '@tauri-apps/api/core';
const result = await invoke<string>('fetch_metric', { id: 'time.win-rate' });
```

From the Rust side:

```rust
#[tauri::command]
async fn fetch_metric(id: String) -> Result<MetricResponse, String> {
    // make an HTTP call to the gateway, return the JSON
}
```

Every call from React to Rust goes through this bridge. The bridge is **only** for things we explicitly expose — there's no "JS can do whatever it wants" escape hatch. If we don't define `fetch_metric` in Rust, React can't call it. This is good for security: even if a metric component does something unexpected, it can only do what we've allowed.

We use commands for:

- `activate(license)` — verify and save license (doc 01)
- `get_activated_tenant()` — read the cached activation (doc 01)
- `fetch_metric(id)` — proxy a request to the gateway (doc 09)
- `clear_activation()` — for "log out" / "switch tenant" (doc 10)
- `check_for_updates()` — invoke the auto-updater (doc 12)

### 3.3 The data gateway (one per customer)

This is the most important architectural piece, and the one that's new compared to the old plan. The gateway is a small program that:

- Runs on **one machine inside the customer's network** (their existing Windows server, a small Linux box, a Raspberry Pi — anything they can keep running 24/7 that can reach their database).
- **Holds the database credentials.** Credentials live in this one process's config, not on any employee laptop.
- Exposes a small HTTP API (~one endpoint per metric or per module).
- Authenticates incoming requests with a **bearer token** — a shared secret between the gateway and the desktop apps, baked into the license key (or rotated separately, see doc 10).
- Runs the actual data-fetching logic — connect to the DB, run a query, transform the result into the JSON shape the dashboard expects.

A sketch of what calls look like:

```
   Desktop app                          Gateway                     Database
       |                                   |                            |
       |   GET /metrics/time/win-rate      |                            |
       |   Authorization: Bearer <token>   |                            |
       | --------------------------------> |                            |
       |                                   |   SELECT count(*) ...      |
       |                                   | -------------------------> |
       |                                   |                            |
       |                                   |  <----- rows ------------- |
       |                                   |                            |
       |                                   |   compute metric           |
       |                                   |   return JSON              |
       |  <-- 200 OK { "value": 0.73 } --- |                            |
       |                                   |                            |
```

We'll cover the gateway's internals in doc 06 (how it talks to the database) and doc 07 (how the old C# logic fits into it). For now, the architectural points are: **one per customer**, **holds the DB creds**, **inside the customer's network**.

### 3.4 The customer's database

The customer's ERP runs on a database — usually Microsoft SQL Server on a Windows machine, occasionally Postgres or MySQL or something more exotic. They run it. We don't. The gateway connects to it with read-only credentials and reads tables we agree on during onboarding.

We never write. Ever. The dashboard is read-only — the customer types into their ERP and looks at us. (Doc 06 covers the connection details and what "read-only" looks like in practice.)

### 3.5 Our update server (tiny, static)

When you ship a new version of the app, you produce signed installers for Windows, Mac, and Linux, plus a manifest file that says "the latest version is X, here are the download URLs and checksums." Tauri's built-in auto-updater periodically asks the manifest "is there a newer version than mine?" and if yes, downloads + installs.

The update server is just static files. You don't have to write any server code. Realistic options:

- **GitHub Releases.** Free if your repo is public; tiny cost if private. Tauri can read GitHub Releases directly.
- **Cloudflare R2 + a public bucket.** Also basically free at our scale.
- **AWS S3 + CloudFront.** Standard, slightly more expensive.
- **Your own static-file server.** Works, but you have to keep it up.

We'll go deeper on update mechanics in doc 12. For the architecture, the only thing to know is: **it's a static file host. It does not see customer data. It is never in the critical path of "render a metric."**

### 3.6 The license signing tool

A small command-line script that lives in our repo and runs on a trusted machine (yours). Given a tenant slug and an expiry, it produces a JWT signed with our private key. The private key never leaves your password manager (or hardware token, if you go fancy).

Total infrastructure: zero. It's just a script.

### 3.7 What's NOT in the new architecture

Compared to the old Cloudflare plan, here's what's gone:

- ❌ Cloudflare Pages (no static web hosting needed — the React UI is bundled in the installer).
- ❌ Cloudflare Workers (no edge compute — Rust on each laptop does it).
- ❌ Cloudflare KV (no edge key-value store — configs are bundled in the app or fetched from a tiny server).
- ❌ Cloudflare D1 (no edge SQL DB — we don't have any data of our own to store).
- ❌ Cloudflare R2 for tenant data snapshots (no nightly snapshots; live fetch instead).
- ❌ Cloudflare Tunnel + Hyperdrive (no need to expose the customer's DB to the public internet).
- ❌ Wildcard DNS + Cloudflare for SaaS (no per-tenant subdomains).
- ❌ Cron Triggers, Queues, Consumer Workers (no nightly pipeline orchestration — see doc 07).

That's a lot of moving parts that disappear. We're trading them for:

- ✅ A Tauri build pipeline (CI that produces signed installers).
- ✅ A gateway service that runs on each customer's hardware (one shared piece per customer).
- ✅ A static file host for installers and update manifests.
- ✅ A license signing tool.

Net: fewer cloud services, more attention to the gateway's deployment story (covered in doc 11).

---

## 4. The big tradeoff: where do the DB credentials live?

This is the one architectural choice that genuinely has alternatives, and you should understand all three before committing.

### Option 1 — Direct DB access from every laptop

Each desktop app holds the database connection string (host, port, username, password). Rust opens a TCP connection from the user's laptop straight to the customer's database.

```
   Desktop app (laptop)  ---> Customer's DB
   Desktop app (laptop)  ---> Customer's DB
   Desktop app (laptop)  ---> Customer's DB
   ...
```

**Pros.**
- Simpler. No gateway to build or deploy.
- No second service to keep running.

**Cons.**
- DB credentials sit on every employee laptop. If a laptop is stolen or compromised, the attacker has direct DB access.
- Credential rotation requires updating every laptop. Annoying.
- The DB has to allow connections from every laptop on the LAN — broad network exposure.
- Every laptop opens its own connection pool to the DB; bigger shops can exhaust the DB's connection limits.
- The C# / Python logic that computes metrics has to live in Tauri (Rust or as a sidecar) instead of one shared place.

**When it's OK.** Very small fab shops (1–3 users) where there's effectively one laptop and the DB is right there. Not the right pattern for a 30-employee shop.

### Option 2 — A local gateway, one per fab shop (RECOMMENDED)

The pattern in §2's diagram. One small machine in the customer's network holds the creds. All laptops talk to it over the LAN.

**Pros.**
- DB credentials are in exactly one place. Rotate them by updating one process.
- The DB only needs to accept connections from one machine.
- The C#/Python metric logic lives in one place — easy to update.
- The gateway is also where you'd do per-user authorization later (doc 10).
- Caching at the gateway is feasible if traffic gets high.

**Cons.**
- Another piece of software to deploy and keep running per customer.
- Requires the customer to dedicate a machine (or VM, or container) to the gateway.
- If the gateway dies, no employee can use the dashboard until it's restarted.

**When it's right.** Most fab shops. This is the default for our docs.

### Option 3 — A cloud gateway we host

We run a multi-tenant gateway in our cloud. The customer's DB has to be reachable from our cloud (either by exposing it publicly with strong auth, or via a VPN/tunnel back to us).

**Pros.**
- Customer doesn't deploy or maintain anything.
- One gateway codebase for everyone.

**Cons.**
- The customer's DB has to be reachable from the internet — most fab shops will say no.
- We become an operationally-critical dependency for every customer. Our outage = every dashboard down.
- We hold DB credentials for every customer. That's a target.
- Compliance / data-residency conversations get much harder.

**When it's right.** Customers with cloud-hosted ERPs that are already public, or customers who insist we operate everything. Probably not the default; can be an option for specific customers.

### Recommendation

**Go with Option 2 (local gateway).** Reasons:

- Fits the most fab-shop networks (no public DB exposure required).
- Single place to manage DB creds — the security argument is overwhelming once you imagine 30 laptops at one customer.
- The gateway is a natural home for the C# binary or its Python replacement (doc 07).
- Adds one piece of software, not a whole platform.

The rest of these docs assume Option 2 unless explicitly noted.

---

## 5. Where each piece physically lives

Picking the diagram apart and listing every piece by its physical home:

| Piece | Lives on | Who owns the machine |
|---|---|---|
| Tauri app source code | Your laptop / GitHub | You |
| Compiled installers | Update server (S3 / R2 / GitHub Releases) | You |
| Signing certificates (code sign) | Your laptop / a CI secret store | You |
| License-signing private key | Your password manager | You |
| License-signing public key | Source code, baked into the app | You |
| The installed Tauri app | Each employee's laptop | The customer |
| `activation.json` (license cache) | Each laptop's OS app-data folder | The customer |
| Tenant config | Either bundled in the app, or fetched | You (bundle) or you (server) |
| Gateway binary / Python code | The gateway machine inside the customer's network | The customer (their hardware) |
| Gateway config (DB creds, bearer token) | The gateway machine | The customer |
| Customer's database | Their existing ERP server | The customer |

The pattern: **everything in production runs on the customer's hardware**. We only run dev infra (build, sign, publish updates). That's a much smaller operational footprint than running a SaaS.

---

## 6. Costs at our scale

Honest numbers for the new architecture, in 2026 dollars, roughly:

| Item | 10 tenants | 200 tenants | Notes |
|---|---|---|---|
| **Code signing cert (Windows EV)** | ~$300/year | ~$300/year | One cert, signs everything |
| **Apple Developer Program** | $99/year | $99/year | One developer account |
| **Update server bandwidth** | ~$0 | ~$5–20/month | Static files. R2 is essentially free; S3 is a few cents per GB |
| **Update server storage** | ~$0 | ~$1/month | Installers are 5–10 MB; even 20 versions × 3 OSes is tiny |
| **License-signing infra** | $0 | $0 | A script on your laptop |
| **Gateway hardware** | $0 to us | $0 to us | Customer provides |
| **Total to us** | **~$400/year** | **~$500–700/year** | |

Compare with the old plan (Cloudflare Workers paid tier, KV/D1/R2 usage, Containers, Tunnels): the old plan was estimated at low hundreds to low thousands per year, scaling with tenants. The new plan is **mostly flat** because we're not running runtime infrastructure — the customers' machines do.

What we trade:

- **Less operational cost to us.** We're not paying per request or per tenant.
- **More support burden for gateway operations.** If a customer's gateway crashes, we get a support ticket. We have to design good restart / health / monitoring so this is rare.
- **Slower deploys.** Pushing a fix means publishing an installer and waiting for auto-updates to land (minutes to hours of customer machines coming online). Cloudflare workers used to take seconds.

Net: cheaper but slower and with a different operational profile.

---

## 7. The anti-patterns to avoid

These are the four big ones specific to this architecture.

### 7.1 Putting DB credentials in the desktop app

Doc 01 already said this. Saying it again because it's the single most tempting shortcut. If you find yourself thinking "we can ship the password just for now and replace it later," you can't. Every laptop with the app is a copy of those creds. Forever, in version-control history.

### 7.2 Letting the gateway talk to the public internet

The gateway should listen **only** on the customer's LAN. Never expose it to the internet. If a customer wants employees working from home, the right answer is "use a VPN back to the office" not "open the gateway port to the world."

### 7.3 Using the gateway for things other than data

Don't put tenant config there (doc 02). Don't put authentication state there. Don't make it a generic API gateway for arbitrary client features. The gateway has one job: serve metrics from the customer's DB. The more it does, the more critical it becomes — and a critical service inside the customer's network is exactly the kind of thing they'll be touchy about.

### 7.4 Skipping code signing because it's annoying

Code signing is genuinely annoying (Windows EV certs require a hardware token; Apple notarization is fiddly). The temptation is "we'll ship unsigned installers for v0.1 and add signing later." Don't. Unsigned installers trigger SmartScreen warnings on Windows and outright refuse to launch on Mac. Customers will email asking "is this safe to install?" and you'll lose deals. Get signing working before you have any external users. (Doc 12 walks through it step by step.)

---

## 8. How a request flows end-to-end (when everything is working)

Let's trace what happens at 10:32 a.m. when an Acme employee opens the Time module:

1. **User clicks "Time."** React's router renders the lazy-loaded Time module. The webview starts loading the Time JS chunk from the installer assets.

2. **Time module renders.** Each metric component calls `useMetricData('time.<id>')`, which calls Rust via `invoke('fetch_metric', { id })`.

3. **Rust looks up the gateway URL** from `activation.json` (cached from the license key — see doc 01 §5.2). For Acme that's `http://10.0.5.20:8080`.

4. **Rust makes the HTTP call:**
   ```
   GET http://10.0.5.20:8080/metrics/time/monthly-hours
   Authorization: Bearer <token from license>
   ```

5. **The gateway**, running on a machine inside Acme's network, receives the request. Verifies the bearer token. Looks up the SQL query for `time.monthly-hours`. Connects to Acme's DB (a connection from the gateway's pool). Runs the query.

6. **Acme's DB** returns rows. The gateway transforms them into the JSON shape the dashboard expects (sum, group, average, whatever the metric is).

7. **Gateway returns the JSON** to Rust.

8. **Rust returns the JSON to React.** React renders the chart. The skeleton is replaced with real numbers.

End-to-end latency depends on the SQL query but should be under a second for our typical metrics. Doc 09 covers caching, retries, and what to show when things fail.

---

## 9. By the end of this doc you should know

- Every component in the new architecture: Tauri app (webview + Rust), Tauri commands, the data gateway, the customer's DB, our update server, the signing tool.
- Why each piece exists and what would happen if you removed it.
- The big tradeoff for where DB credentials live, the three options (direct, local gateway, cloud gateway), and why we recommend the local gateway.
- Where each piece physically lives — on your hardware vs. on the customer's.
- Rough costs at 10 and 200 tenants (and why they're flat).
- The four anti-patterns specific to this architecture.
- The end-to-end flow of a single metric fetch.

If the gateway is fuzzy, re-read §3.3 and §4. It's the one new piece that didn't exist in the old plan, and it's where most of the operational complexity now lives.

---

**Next:** [`06-customer-data-ingest.md`](./06-customer-data-ingest.md) — what the customer's database actually looks like, what credentials we need, and how the gateway connects to it.
