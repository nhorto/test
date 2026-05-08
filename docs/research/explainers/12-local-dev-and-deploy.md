# 12 — Local Dev and Deploy: Wrangler, Miniflare, and the Path from `git push` to Live

> **Pre-reqs:** Read 00, 05, and 11 first. 00 establishes vocabulary. 05 maps the Cloudflare product surface. 11 covers tenant lifecycle and the 3-tenant rule for dev — this doc tells you how to *run* those tenants on your laptop.
>
> **What you'll know by the end:** What Wrangler is and why it's the only CLI you need. `wrangler.toml` line by line. What bindings are and why your Worker code never holds connection strings. How environments work, and the gotcha where production silently has different bindings than dev. How secrets split between Cloudflare's vault and `.dev.vars`. What Miniflare emulates and what it doesn't (Containers — read this twice). How `wrangler dev` and Vite cooperate. How to run three tenants on `*.localhost` without editing `/etc/hosts`. What `wrangler deploy` actually does — bundle, propagate, live in 15 seconds. How rollback works. How wildcard DNS routes `*.app.example.com` to either Pages or the Worker. Seven specific bugs and their fixes.

This doc is the bridge between *what we're building* (05–11) and *how you build it on your laptop today*. If 11 is the operational manual for tenants, this is the operational manual for the dev loop.

---

## 1. Vocabulary primer (the new terms in this doc)

00 already defined Worker, Pages, KV, R2, D1, slug, subdomain. Here are the new operational terms.

- **Wrangler** — Cloudflare's official CLI. The single tool to develop, test, and deploy everything Cloudflare-related. Replaces clicking in the dashboard.
- **Miniflare** — a Node.js program that pretends to be the Workers runtime on your laptop. `wrangler dev` runs Miniflare under the hood. Emulates KV, R2, D1, secrets, the Cache API — but not Containers, and Durable Objects only imperfectly.
- **`wrangler.toml`** — a TOML file at the project root that names your Worker, points at its entry file, and lists every binding.
- **Binding** — a named handle Cloudflare injects into your Worker at startup. `env.TENANT_CONFIG` is a binding to a KV namespace. Your code never holds a connection string — it just calls methods on the handle.
- **Environment** — a named override block in `wrangler.toml` (`[env.production]`, `[env.preview]`). Different environments can point at different bindings, secrets, and `[vars]`.
- **Secret** — a string stored encrypted in Cloudflare's vault, injected as a property on `env`. Set with `wrangler secret put`. Never appears in `wrangler.toml`. Locally faked via `.dev.vars`.
- **`compatibility_date`** — a date string that pins which version of the Workers runtime your code runs against. Cloudflare ships breaking runtime changes behind date gates.
- **`compatibility_flags`** — feature flags that toggle specific runtime behaviors independent of the date. `"nodejs_compat"` polyfills Node built-ins like `Buffer` and `EventEmitter`.
- **PoP (Point of Presence)** — one of Cloudflare's 300+ edge data centers. A deploy propagates to every PoP. There is no "the server."
- **Isolate** — a V8 sandbox. Each Worker invocation runs in a fresh isolate. Far cheaper than a container.
- **`.dev.vars`** — a file at the project root, `.env` syntax, holds secrets for local dev. Wrangler reads it on startup. Must be in `.gitignore`.
- **Wildcard DNS** — a single DNS record (`*.app.example.com`) that matches every subdomain.
- **Wildcard route** — a Worker route pattern like `*.app.example.com/api/*` that says "every subdomain, on this path prefix, hits this Worker."

These all get re-explained in context. Above is for quick lookup if you skip around.

---

## 2. What Wrangler is, and why it's the only CLI you need

Wrangler is to Cloudflare what `gcloud` is to Google Cloud or `aws` is to AWS — smaller in scope and friendlier. Every operation you might do in the dashboard (create a KV namespace, upload a secret, deploy, roll back) has a Wrangler command. Under the hood it makes REST API calls on your behalf, and locally it wraps Miniflare (§7).

Install globally:

```bash
npm install -g wrangler
```

`-g` puts the binary on your `PATH`. Project-local installs (`pnpm add -D wrangler`, run via `pnpm wrangler`) are better in CI so the version is pinned. Global is simpler when starting.

Log in once per machine:

```bash
wrangler login
```

This opens a browser OAuth flow and writes a token to `~/.wrangler/config/default.toml`. That file holds an OAuth token plus your account ID. **Treat it like an SSH private key** — never commit, never paste in chat. For multiple Cloudflare accounts (personal vs production), set `CLOUDFLARE_API_TOKEN` as a per-command override.

`wrangler whoami` prints your email and account name when login worked.

---

## 3. `wrangler.toml` line by line — the headline artifact

Every Worker project has one `wrangler.toml` at its root. This is the file you'll edit most often as the dev loop matures, so it earns the longest walk in the doc.

Start with the minimum:

```toml
name                = "powerfab-api"
main                = "src/worker/index.ts"
compatibility_date  = "2025-04-01"
compatibility_flags = ["nodejs_compat"]
```

Walk:

- `name = "powerfab-api"` — the Worker's name in Cloudflare's system. This name shows up in the dashboard, in deploy logs, and in the default Workers-assigned subdomain. If two Workers share a name, the newer deploy *overwrites* the older one. Pick a name that's specific to the project.
- `main = "src/worker/index.ts"` — the entry file. Wrangler's bundler (esbuild) starts here, follows every `import`, and tree-shakes the rest. If this path is wrong, deploy fails immediately with `could not resolve entry point` — almost always a typo.
- `compatibility_date = "2025-04-01"` — pins the runtime version. Cloudflare ships breaking runtime changes behind date gates so old Workers don't break when they upgrade the engine. You opt in by moving this date forward. **Don't leave it at the project-creation default forever.** Update it once every few months: bump the date in a branch, run your tests, deploy to preview, smoke test, merge. Setting it too far in the future errors at deploy time.
- `compatibility_flags = ["nodejs_compat"]` — feature flags independent of the date. `"nodejs_compat"` polyfills Node.js built-ins (`Buffer`, `events`, `crypto`, etc.) that vanilla Workers don't expose. Without this flag, any npm package that does `require('events')` throws at runtime. For a TypeScript project pulling in real npm dependencies, you almost always want this on.

That four-line block is enough to deploy an empty Worker. Now the bindings.

---

## 4. Bindings — the part that throws beginners

A binding is a named handle Cloudflare injects into your Worker's `env` object at startup. The key insight: **your Worker code never holds credentials or connection strings.** It calls methods on the handle. Cloudflare wires it to the right resource at runtime based on `wrangler.toml`.

**Before** (the way most server code in other ecosystems looks):

```ts
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const kv = new RedisClient({ url: process.env.REDIS_URL, token: process.env.REDIS_TOKEN });
```

You're juggling URLs and tokens. Each one might be wrong, leaked, or pointing at the wrong environment.

**After** (with bindings):

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = await env.TENANT_CONFIG.get("acme");
    return new Response(config);
  }
};
```

`env.TENANT_CONFIG` is a `KVNamespace` handle. No URL, no token in your code. Switching environments means *zero code changes* — the binding name stays the same; only the underlying namespace ID differs.

Each binding type has its own TOML block.

### 4.1 KV namespace

```toml
[[kv_namespaces]]
binding    = "TENANT_CONFIG"
id         = "abc123def456..."
preview_id = "xyz789..."
```

Walk:

- `[[kv_namespaces]]` — the double brackets mean "this is one item in an array." You can have multiple `[[kv_namespaces]]` blocks for multiple KV bindings.
- `binding = "TENANT_CONFIG"` — the name your Worker code uses (`env.TENANT_CONFIG`). All caps by convention; not enforced.
- `id = "abc123def456..."` — the production KV namespace's ID, from `wrangler kv:namespace create TENANT_CONFIG`.
- `preview_id = "xyz789..."` — the namespace `wrangler dev` writes to. You created this with `wrangler kv:namespace create TENANT_CONFIG --preview`. Different ID, separate from production.

Methods available on the binding: `get`, `put`, `delete`, `list`. You'll spend most of your KV time on `get` and `put`.

### 4.2 R2 bucket

```toml
[[r2_buckets]]
binding     = "SNAPSHOTS"
bucket_name = "powerfab-snapshots"
```

Walk:

- `binding = "SNAPSHOTS"` — your code accesses this as `env.SNAPSHOTS`.
- `bucket_name = "powerfab-snapshots"` — the actual R2 bucket name in your account.

`env.SNAPSHOTS` is an `R2Bucket`. Methods: `get`, `put`, `list`, `delete`. **Important**: R2 returns objects as `ReadableStream` bodies, not strings. To get a string you `await` the body's `.text()`.

### 4.3 D1 database

```toml
[[d1_databases]]
binding       = "AUTH_DB"
database_name = "powerfab-auth"
database_id   = "11111111-2222-3333-4444-555555555555"
```

Walk:

- `binding = "AUTH_DB"` — accessed as `env.AUTH_DB`.
- `database_name` — the human-readable name; mostly for logs and the dashboard.
- `database_id` — the UUID that uniquely identifies the database.

Methods center on `prepare(sql).bind(...args).run()` for INSERT/UPDATE/DELETE and `.all()` for SELECT.

### 4.4 Service binding (Worker-to-Worker)

```toml
[[services]]
binding = "CONTAINER_RUNNER"
service = "powerfab-container-worker"
```

Walk:

- `binding = "CONTAINER_RUNNER"` — accessed as `env.CONTAINER_RUNNER`.
- `service = "powerfab-container-worker"` — the `name` of another Worker in the same Cloudflare account.

Service bindings let one Worker call another over Cloudflare's internal network. No public internet, no extra latency, no API token to manage. Used when an HTTP-shaped contract between two Workers makes sense.

### 4.5 Plain environment variables

```toml
[vars]
ENVIRONMENT = "production"
MAX_TENANTS = "50"
```

Walk:

- `[vars]` — a single block (not `[[vars]]`) holding string-valued config.
- `ENVIRONMENT = "production"` — accessed as `env.ENVIRONMENT`. Always a string. To get a number, parse it: `Number(env.MAX_TENANTS)`.

`[vars]` values are committed to source control. Use them for non-secret configuration like flags, names, and counts. Never put a password or API key here.

### 4.6 Secrets (the missing entry)

Secrets do **not** appear in `wrangler.toml`. They're set out-of-band with `wrangler secret put`, stored encrypted in Cloudflare's vault, and injected at runtime as plain strings on `env`. The next section walks them in detail.

The pattern: at runtime, your Worker can't tell whether a value on `env` came from `[vars]`, came from a secret, or came from `.dev.vars`. They all surface as plain strings. The split is purely about **how they're stored on disk and who can see them** — secrets get encrypted; `[vars]` are plaintext in your repo.

---

## 5. Secrets and `.dev.vars`

Set a secret for production:

```bash
wrangler secret put STRIPE_SECRET_KEY --env production
```

Wrangler prompts for the value (no terminal echo, no shell history). The value goes to Cloudflare's vault. Your code reads `env.STRIPE_SECRET_KEY` as a plain string.

If you forget `--env production`, Wrangler sets the secret on the *default* untagged Worker, not the one production traffic hits. Your code then reads `undefined` in production. This is BUG #3 in §14 — easy to do, harder to diagnose.

List what's set:

```bash
wrangler secret list --env production
```

Names only, never values. No way to read a secret back. If you forgot what you set, rotate it.

### 5.1 Local dev: `.dev.vars`

Secrets in Cloudflare's vault aren't pulled down locally. Instead create `.dev.vars` at the project root, `.env` syntax:

```
STRIPE_SECRET_KEY=sk_test_thisisntreal
INTERNAL_SIGNING_KEY=dev-only-not-real
```

Walk:

- One `KEY=value` per line. Quotes only if the value has spaces.
- Wrangler reads on startup; no file watcher (BUG #6).
- **Add `.dev.vars` to `.gitignore` immediately**, before you put any value in it. Otherwise the first commit leaks whatever placeholder you typed.

Every key in `.dev.vars` surfaces on `env` as if it were a real secret. Your Worker code is identical between local and prod.

**Before** (per-env switches in code):

```ts
const apiKey = isDev ? "test_key" : process.env.STRIPE_KEY;
```

**After** (`.dev.vars` locally, `wrangler secret put` in production):

```ts
const apiKey = env.STRIPE_SECRET_KEY;
```

Same line, two environments, zero branching. The split is in configuration, not code.

---

## 6. Environments — the part where production disagrees with dev

Wrangler lets you define named environment overrides in a single `wrangler.toml`. The most common pattern is dev (the top-level baseline) plus preview plus production.

```toml
name               = "powerfab-api"
main               = "src/worker/index.ts"
compatibility_date = "2025-04-01"

[vars]
ENVIRONMENT = "development"

[env.preview]
name = "powerfab-api-preview"
[env.preview.vars]
ENVIRONMENT = "preview"
FEATURE_FLAGS = "new-dashboard"

[env.production]
name = "powerfab-api-production"
[env.production.vars]
ENVIRONMENT = "production"

[[env.production.kv_namespaces]]
binding    = "TENANT_CONFIG"
id         = "abc123..."
```

Walk:

- The first four lines are the baseline. They apply to everything unless overridden.
- `[env.preview]` and `[env.production]` declare two named environments. Each can override `name`, `[vars]`, bindings, secrets — anything.
- `[env.preview.vars]` is a sub-block: "the `[vars]` table inside the `preview` environment." TOML uses dotted paths to nest.
- `[[env.production.kv_namespaces]]` declares a KV binding *for the production environment only*.

Run a specific environment locally:

```bash
wrangler dev --env preview
```

Deploy a specific environment:

```bash
wrangler deploy --env production
```

### 6.1 The non-inheritance gotcha

Here's the trap. Bindings declared at the top level are **not** automatically inherited into named environments. If your top level has `[[kv_namespaces]]` with `binding = "TENANT_CONFIG"`, and you run `wrangler deploy --env production`, the production Worker gets *no* KV bindings at all unless you also declare `[[env.production.kv_namespaces]]`.

This is the single most common "works in dev, broken in prod" bug Cloudflare beginners hit. Local `wrangler dev` (no `--env` flag) reads top-level bindings. Production `wrangler deploy --env production` reads only `[env.production.*]` bindings. They diverge silently.

**Before** (looks fine, breaks in prod):

```toml
# top-level — used by wrangler dev
[[kv_namespaces]]
binding = "TENANT_CONFIG"
id      = "abc123..."

[env.production]
name = "powerfab-api-production"
# no kv_namespaces block — production has NO bindings
```

**After** (re-declare for every environment):

```toml
[[kv_namespaces]]
binding = "TENANT_CONFIG"
id      = "abc123..."
preview_id = "xyz789..."

[env.production]
name = "powerfab-api-production"

[[env.production.kv_namespaces]]
binding = "TENANT_CONFIG"
id      = "prod_id_here"
```

The `binding` name (`TENANT_CONFIG`) must match exactly — that's the name your code uses. The `id` is the new bit, pointing at production's separate KV namespace. Same story for R2, D1, services, and secrets: re-declare per environment.

Once you've been bitten once you'll never forget. The first time, you'll burn an evening.

---

## 7. Local dev: `wrangler dev` and Miniflare

`wrangler dev` starts a local HTTP server (default port 8787) running your Worker under Miniflare — an in-process Node.js reimplementation of the V8 isolate environment Workers run in at the edge.

```bash
wrangler dev
```

Open `localhost:8787`, your Worker responds. Edits hot-reload.

What Miniflare emulates well:

- **KV** — operations work; data is in-memory and wipes on restart. Use `--persist-to <dir>` to write to disk.
- **R2** — in-memory blobs, restart wipes.
- **D1** — real SQLite file on disk, persisted between restarts.
- **Cache API** — local cache, scoped to the dev session.
- **`[vars]` and secrets** — from `wrangler.toml` and `.dev.vars`.
- **The fetch and request/response plumbing** — close enough that you'll rarely notice.

What Miniflare does NOT emulate:

- **Containers.** Cloudflare Containers (the .NET 8 nightly job — 06, 07) require the real Cloudflare infrastructure. No local runtime. Workaround in §10.
- **Durable Objects.** Emulated with subtle behavioral differences. PowerFab's MVP doesn't use them.
- **Real KV persistence by default.** Use `--persist-to ./.wrangler-state` or `wrangler dev --remote` (real Cloudflare resources from local code — slower, not free, but accurate).

---

## 8. Pages-side dev: Vite alongside Wrangler

PowerFab's frontend is a Vite + React 19 app deployed to Cloudflare Pages. The dev stack is two terminals:

```
Terminal 1: pnpm dev          → Vite dev server at localhost:5173
Terminal 2: wrangler dev      → Hono Worker at localhost:8787
```

Vite serves the React SPA with hot module reload. Wrangler serves the API. They cooperate via a Vite proxy so your frontend code can call `/api/...` and have it reach the Worker without CORS gymnastics.

In `vite.config.ts`:

```ts
server: {
  proxy: {
    '/api': 'http://localhost:8787'
  }
}
```

Walk:

- `server.proxy` — Vite dev-server config. Only applies in dev.
- `'/api': 'http://localhost:8787'` — every request to a path starting with `/api` gets forwarded to the local Worker.

The browser thinks it's calling `localhost:5173/api/tenants`. Vite forwards it to `localhost:8787/api/tenants`. The Worker responds. The browser sees a same-origin response and is happy.

**Why two servers instead of one?** Cloudflare offers `wrangler pages dev ./dist`, which serves the built static output and runs the Worker function side. It's closer to production but slower for frontend iteration — every change requires a Vite build. For a solo dev iterating on UI, the two-terminal setup with `pnpm dev` and proxy is faster. Reach for `wrangler pages dev` only when testing the Pages-specific routing layer (`_redirects`, `_headers` files, custom 404 pages).

---

## 9. Multi-tenant local testing — `*.localhost` and the 3-tenant rule

PowerFab routes by subdomain in production: `acme.app.example.com`. Locally you want the same shape: `acme.localhost`, `bobsteel.localhost`, `crucible.localhost`.

**Good news**: modern browsers (Chrome, Firefox, Safari) automatically resolve `*.localhost` to `127.0.0.1` without any `/etc/hosts` edits. Open `acme.localhost:5173` and the request hits your local Vite server with `Host: acme.localhost`. Your Worker can extract the tenant slug from that header.

**Fallback** for older browsers, command-line `curl`, or Node.js `fetch` calls that bypass the OS resolver: add explicit entries to `/etc/hosts`:

```
127.0.0.1  acme.localhost
127.0.0.1  bobsteel.localhost
127.0.0.1  crucible.localhost
```

One line per tenant. Save the file. No restart needed. Your Mac's resolver picks them up immediately.

### 9.1 Extracting the tenant slug from the Host header

The same code runs locally and in production. In your Worker:

```ts
const host = new URL(request.url).hostname;   // "acme.localhost" or "acme.app.example.com"
const tenant = host.split('.')[0];             // "acme"
```

Walk:

- `new URL(request.url).hostname` — gives you just the hostname, no port, no path. `acme.localhost:5173/api/tenants` becomes `acme.localhost`.
- `host.split('.')[0]` — splits on dots and takes the first segment. Works for both `acme.localhost` and `acme.app.example.com` because the slug is always the leftmost label.

This is the production code path. There's no dev-only branch. The same line works in three environments because the slug is always in the same position.

### 9.2 The 3-tenant rule

11 covers the operational reasoning; here's the dev-loop version. Run **three** local tenants, not one or two:

- One tenant catches zero isolation bugs. Hardcoded slugs and global caches all look fine.
- Two tenants catches *some* isolation bugs but can't distinguish "Acme leaks to Bob" from "Bob leaks to Acme."
- Three tenants triangulates. If logged in as Crucible you see Bob's data, the bug is in request handling, not a swapped pair.

Set up `tenants/acme.json`, `tenants/bobsteel.json`, `tenants/crucible.json` with deliberately *different* fixture data. Acme has all modules; Bob has only `inspections`; Crucible has `time` plus `production`. If a single screenshot can't tell you which tenant you're looking at, your test data is too similar.

This is one of those rules that costs nothing to follow on day one and is annoying to retrofit at tenant 20.

---

## 10. The Container local-dev workaround

PowerFab's nightly job runs as a .NET 8 Container, scheduled by a Worker. Containers don't run in Miniflare. Two options:

**Option A: stub the Container call.** Run the .NET project standalone:

```bash
cd container
dotnet run
```

The .NET app starts an HTTP server on `http://localhost:5000`. In your Worker, behind a dev guard, replace the service-binding call with a fetch to that local URL:

```ts
const isDev = (env.ENVIRONMENT ?? 'development') === 'development';
const containerResponse = isDev
  ? await fetch('http://localhost:5000/run', { method: 'POST', body: JSON.stringify(payload) })
  : await invokeRunner(env.CONTAINER_RUNNER, payload);
```

Walk:

- `env.ENVIRONMENT` is the `[vars]` value — `"development"` locally, `"production"` in prod.
- Dev branch: hits the .NET process running under `dotnet run` in your other terminal — `localhost:5000` is the *only* full-URL shape we use in code, allowed here because that's where the local server listens.
- Prod branch: delegates to a small `invokeRunner` helper that wraps `env.CONTAINER_RUNNER.fetch(...)` — the service-binding API needs a `Request`-shaped input, and the helper hides that ceremony so the snippet stays focused on the dev/prod split. The Worker-to-Container call never leaves Cloudflare's network.

**The `isDev` guard is critical.** Without it, a localhost URL ends up in production code and every request times out. Code-review this branch every PR.

**Option B: deploy a preview Container, use `wrangler dev --remote`.** Slower, more accurate. Reach for it when you suspect a service-binding contract bug.

Day-to-day: Option A. Final pre-merge on a Container change: Option B once.

---

## 11. The deploy flow — what `wrangler deploy` actually does

```bash
wrangler deploy --env production
```

That command kicks off this:

```
Local machine                Cloudflare API              Edge PoPs (300+)
     |                              |                            |
     |-- bundle (V8 bytecode) ----> |                            |
     |                              |-- version stored --------> |
     |                              |-- propagate to PoPs -----> |
     |<-- deploy ID returned ----   |                            |
     |                              |                         (live ~15s)
```

Step by step:

1. **Bundle.** Wrangler runs esbuild on `main` — single bundled JS file plus source maps.
2. **Upload.** Bundle gzipped, POSTed to Cloudflare's API along with `wrangler.toml` metadata.
3. **Version stored.** Cloudflare assigns a version ID. The previous version stays around for rollback (§12).
4. **Propagate.** Cloudflare pushes the version to every edge PoP. Within 15–30 seconds every PoP has it.
5. **First request to a PoP** with the new version cold-starts a fresh isolate. No "restart" — old isolates finish in-flight requests naturally; new requests get new code.
6. **Deploy ID returned.** Wrangler prints the version ID. Save it — you'll use it for rollback.

For Pages:

```bash
wrangler pages deploy ./dist --project-name powerfab-dashboard
```

Walk:

- `pages deploy` — Pages-specific deploy command.
- `./dist` — your Vite build output directory. Run `pnpm build` first.
- `--project-name powerfab-dashboard` — must match an existing Pages project.

Pages keeps every uploaded build. Deploys are essentially "upload static files; tag this build as production."

---

## 12. Rollback — instant, painless, do it without panicking

Every deploy keeps the previous version. Rolling back is a metadata flip, not a re-upload.

```bash
wrangler rollback                # to the previous deployment
wrangler rollback <version-id>   # to a specific named version
```

List recent deployments with `wrangler deployments list`. The dashboard equivalent: Workers and Pages → the Worker → Deployments tab → "Rollback" next to any prior version. For Pages, dashboard is primary: pick the project, find the build, click Rollback. Pages doesn't rebuild — it re-routes traffic to the prior artifact.

Time to rollback live: the same 15–30 second window as a forward deploy. No extra cost, no extra risk. **If a deploy is breaking production, hit rollback first, debug second.** "Fix-forward" is fine for senior teams; for a solo dev, rollback gets you back to known-good in under a minute.

---

## 13. Custom domain wiring — wildcard DNS plus wildcard routes

PowerFab uses `*.app.example.com`. Two things need to be configured for `acme.app.example.com` to actually serve a request: DNS and Worker routes.

### 13.1 The DNS record

In Cloudflare DNS, add one wildcard CNAME:

```
*.app.example.com  →  CNAME  →  the Pages project's assigned subdomain  (proxied)
```

Walk:

- `*.app.example.com` — wildcard pattern. Matches every subdomain at that depth: `acme.app.example.com`, `bobsteel.app.example.com`, etc.
- The target is the subdomain Cloudflare assigned your Pages project when you created it.
- `proxied` (the orange cloud in Cloudflare's DNS UI) means Cloudflare's edge intercepts the request. Without this, traffic goes directly to the Pages backend without passing through your Workers — defeats the whole architecture.

One DNS record. Every new tenant subdomain works without a DNS change.

### 13.2 The Worker route

In `wrangler.toml`, declare which paths go to the Worker:

```toml
[[env.production.routes]]
pattern   = "*.app.example.com/api/*"
zone_name = "app.example.com"
```

Walk:

- `[[env.production.routes]]` — array entry, scoped to production environment.
- `pattern = "*.app.example.com/api/*"` — match any subdomain under `app.example.com`, but only paths starting with `/api/`. This is the load-bearing detail (see BUG #7 below).
- `zone_name = "app.example.com"` — the Cloudflare zone this route belongs to. Must be an active zone in the same account.

### 13.3 The full request flow

```
Browser → acme.app.example.com/api/tenants
         → wildcard CNAME resolves, edge intercepts
         → Route match /api/* → powerfab-api Worker
         → Worker reads "acme" from Host header → tenant-scoped data

Browser → acme.app.example.com/  (no /api/)
         → wildcard CNAME resolves, edge intercepts
         → No Worker route matches → Pages serves React SPA
```

Two routes, one domain. Worker handles API; Pages handles the SPA. Both see `Host: acme.app.example.com` and extract the slug from it.

---

## 14. Pitfalls — the seven bugs you'll hit, and the fix for each

Each has bitten real Cloudflare beginners. The fix is rarely complicated; the diagnosis is.

**BUG #1: "binding not found" in production, works fine in `wrangler dev`.**
**FIX:** Named environments don't inherit top-level bindings. Re-declare every `[[kv_namespaces]]`, `[[r2_buckets]]`, `[[d1_databases]]`, and `[[services]]` block under the matching `[[env.production.*]]` path. The `binding` names must match the strings your code reads. See §6.1.

**BUG #2: `compatibility_date` is stale; a new npm package fails at runtime with `X is not a function`.**
**FIX:** Update `compatibility_date` to within the last 6 months. Many runtime fixes are date-gated. Update in a branch, deploy to preview, smoke-test, merge. Don't jump forward by years at once — increments of a few months catch any single breaking change in isolation.

**BUG #3: A secret set via `wrangler secret put` reads as `undefined` in the Worker.**
**FIX:** Confirm you set it for the right environment. `wrangler secret put NAME` without `--env` sets it on the default, untagged Worker. For production, run `wrangler secret put NAME --env production`. Verify with `wrangler secret list --env production`.

**BUG #4: `wrangler deploy` exits with `Not logged in` or `403 Forbidden`.**
**FIX:** Run `wrangler login` again — tokens expire after inactivity. For CI/CD, set `CLOUDFLARE_API_TOKEN` to a token with `Workers Scripts: Edit` permission. Generate it in the Cloudflare dashboard's API tokens page; store as a CI secret.

**BUG #5: Local KV reads return `null` for keys that exist in production.**
**FIX:** Local KV is in-memory and starts empty. Either seed it via `wrangler kv:key put --namespace-id=<preview_id> <key> <value>`, or use `wrangler dev --remote` to bind against the real preview namespace.

**BUG #6: `.dev.vars` changes don't take effect after editing.**
**FIX:** `.dev.vars` is read on `wrangler dev` startup only — there's no file watcher. Stop dev (Ctrl-C) and restart. Same diagnosis if a teammate added a var and you pulled but didn't restart.

**BUG #7: The wildcard route catches static assets and breaks the Pages site.**
**FIX:** Scope the route pattern to `*.app.example.com/api/*`, not `*.app.example.com/*`. A catch-all intercepts every request, including SPA HTML and JS bundles, routing them to a Worker that doesn't serve them. See §13.

Honorable mention: `wrangler dev` (local Miniflare) vs `wrangler dev --remote` (local code against real Cloudflare). They differ for KV, R2, D1. If local data acts strangely, try `--remote` to compare.

---

## 15. What this means for PowerFab specifically

The doc above is general Cloudflare knowledge. Here's the project-specific glue.

**Subdomain-per-tenant lines up with the wildcard pattern.** The architecture from 05 and 11 falls out of one wildcard CNAME plus one `/api/*`-scoped wildcard route. When you onboard tenant N (per 11's checklist), step 2 is "verify DNS" — the wildcard already absorbs it. Set it up once, file it under "infrastructure that runs itself."

**The 3-tenant rule from 11 needs `*.localhost` from §9 to be ergonomic.** Without auto-resolving `*.localhost`, every dev session starts with `/etc/hosts` edits. With it, `acme.localhost:5173`, `bobsteel.localhost:5173`, `crucible.localhost:5173` all just work. The slug-extraction line `host.split('.')[0]` is identical between local and production — it gets exercised every dev session, which is exactly the load-bearing code path you want hammered.

**The Container local-dev workaround (§10) is for the .NET 8 nightly extraction job.** PowerFab's nightly job (07) is the one piece you literally cannot run inside `wrangler dev`. Run `dotnet run` in one terminal, `wrangler dev` in another, use the `isDev`-guarded fetch to bridge. Code-review the `isDev` branch every PR — this is the kind of thing that ships to prod and stays broken until 2 a.m. cron fails.

**Vercel is dev-only; production is Cloudflare.** Locked in per project decisions. Vercel hosts early-days PR previews where iteration speed beats hosting fidelity. The `wrangler deploy --env production` flow in §11 — V8 bytecode, propagate to 300+ PoPs, live in 15 seconds — is the only deploy that matters. If you catch yourself depending on Vercel-specific behavior (Edge Functions, Vercel KV, `VERCEL_URL`), back it out before it spreads.

**Two environments: `preview` and `production`.** No `staging`. For a solo dev that's overhead — `preview` is your validation tier (deploy a feature branch, smoke-test, merge). Production deploys land on `main`. Once there's a team, revisit.

**Where multi-tenant ops and deploy converge:** every `tenants/<slug>.json` edit is a git commit. CI runs the Zod validator (11). On merge, GitHub Actions runs `wrangler deploy --env production` and `wrangler pages deploy ./dist --project-name powerfab-dashboard`. Within 30 seconds the new config is live everywhere. The deploy *is* the provisioning. Per-tenant work for tenant #2 through #50: edit JSON, `wrangler secret put TENANT_<SLUG>_DB_PASSWORD --env production`, push.

---

## 16. By the end of this doc you should know

- What Wrangler is and where the auth token lives.
- The four mandatory keys in `wrangler.toml`: `name`, `main`, `compatibility_date`, `compatibility_flags`.
- What a binding is, and why your Worker never has connection strings in it.
- How to declare KV, R2, D1, service, `[vars]`, and secret bindings — and which are committed.
- Why production bindings don't auto-inherit, and how to re-declare them.
- How `.dev.vars` works locally and why it must be in `.gitignore` from day one.
- What Miniflare emulates (KV, R2, D1, secrets, fetch) and what it doesn't (Containers, Durable Objects).
- The two-terminal Vite + Wrangler setup and why it beats `wrangler pages dev` for frontend iteration.
- The `*.localhost` trick and the 3-tenant rule from 11.
- The Container workaround: `dotnet run` plus `isDev`-guarded fetch.
- What `wrangler deploy` does — bundle, upload, version, propagate, live in 15 seconds.
- How to roll back instantly.
- How wildcard DNS plus a `/api/*`-scoped wildcard route splits traffic between Pages and the Worker.
- The seven bugs in §14, especially BUG #1 (re-declare bindings per env) and BUG #7 (scope the route).
- The PowerFab-specific pieces in §15: Vercel is dev-only, two environments suffice, every onboard is commit-and-deploy.

If any feel hazy, scroll back. The two sections that earn rereading are §4 (bindings) and §6 (environments) — the difference between "I can deploy a Worker" and "I can deploy a Worker that doesn't surprise me in production."

---

**Next:** 13 (TBD) — likely CI/CD wiring (GitHub Actions to `wrangler deploy`) and observability.
