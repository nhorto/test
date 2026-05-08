# Research Brief: Wrangler Local Dev & Deployment — PowerFab Dashboard

> Intermediate research feeding the writing agent for `12-local-dev-and-deploy.md`. May contain URL-shaped examples; the writing agent is instructed to rewrite without them.

---

## 1. What Wrangler Is

Wrangler is Cloudflare's official CLI tool for developing, testing, and deploying Cloudflare Workers and Pages projects. It is the single pane of glass between a developer's machine and Cloudflare's edge infrastructure. Every operation that could otherwise require clicking around the Cloudflare dashboard — creating KV namespaces, uploading secrets, deploying a Worker bundle — can be done through Wrangler.

Under the hood, Wrangler calls the Cloudflare REST API on the developer's behalf. When running locally, it wraps a JavaScript runtime called Miniflare (discussed in §6) to simulate the edge environment on localhost.

**Install:**
```bash
npm install -g wrangler
```

**Login:**
```bash
wrangler login
```
This opens a browser OAuth flow. After authorization, Wrangler writes a token to `~/.wrangler/config/default.toml`. This file holds the OAuth token and account ID. It is never committed to source control — treat it like an SSH private key. If working across multiple Cloudflare accounts (e.g., personal vs. PowerFab production), `CLOUDFLARE_API_TOKEN` can override the stored credential per-command without touching `~/.wrangler`.

---

## 2. wrangler.toml Structure

`wrangler.toml` lives at the project root and is the source of truth for a Worker's identity and runtime configuration.

```toml
name            = "powerfab-api"
main            = "src/worker/index.ts"
compatibility_date  = "2025-04-01"
compatibility_flags = ["nodejs_compat"]
```

**`name`** — The Worker's name in Cloudflare's system. Determines the default Workers subdomain and is used to identify the correct Worker when running `wrangler deploy`. If two Workers share a name, the newer deploy overwrites the older one.

**`main`** — Entry point TypeScript/JavaScript file. Wrangler's bundler (esbuild under the hood) starts here and tree-shakes everything it finds imported. If this path is wrong, the deploy fails immediately with a "could not resolve entry point" error.

**`compatibility_date`** — A date string that pins which version of the Workers runtime is used. Cloudflare ships breaking runtime changes behind date gates — incrementing this date opts into new behavior. Setting it too old means missing newer APIs; setting it to a future date will error at deploy time. Update it once, verify tests pass, commit the change. Do not leave it at the project-creation default forever.

**`compatibility_flags`** — Array of feature flags that toggle specific runtime behaviors independent of `compatibility_date`. `"nodejs_compat"` is the most important for TypeScript projects — it polyfills Node.js built-ins (Buffer, EventEmitter, etc.) that Workers do not natively expose. Without it, any npm package that does `require('events')` will throw at runtime.

---

## 3. Bindings in wrangler.toml

A "binding" is a named handle that Cloudflare injects into the Worker's execution context at startup. The Worker never holds credentials or connection strings — it just receives the handle and calls methods on it. Bindings are declared in `wrangler.toml` and surface as properties on the `env` object passed to every fetch handler.

### KV Namespace
```toml
[[kv_namespaces]]
binding  = "TENANT_CONFIG"
id       = "abc123def456..."          # production namespace ID
preview_id = "xyz789..."              # used by `wrangler dev`
```
Inside the Worker:
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = await env.TENANT_CONFIG.get("acme");
    return new Response(config);
  }
}
```
`env.TENANT_CONFIG` is a `KVNamespace` object with methods: `get`, `put`, `delete`, `list`.

### R2 Bucket
```toml
[[r2_buckets]]
binding    = "SNAPSHOTS"
bucket_name = "powerfab-snapshots"
```
Inside the Worker: `env.SNAPSHOTS` is an `R2Bucket` — methods include `get`, `put`, `list`, `delete`. R2 objects are retrieved as `ReadableStream` bodies, not strings.

### D1 Database
```toml
[[d1_databases]]
binding      = "AUTH_DB"
database_name = "powerfab-auth"
database_id  = "11111111-2222-3333-4444-555555555555"
```
Inside the Worker: `env.AUTH_DB` is a `D1Database` — the primary method is `prepare(sql).bind(...args).run()` or `.all()` for SELECT queries.

### Service Binding (Worker-to-Worker)
```toml
[[services]]
binding = "CONTAINER_RUNNER"
service = "powerfab-container-worker"
```
Allows one Worker to call another over Cloudflare's internal network without going through the public internet.

### Plain Environment Variables
```toml
[vars]
ENVIRONMENT  = "production"
MAX_TENANTS  = "50"
```
Inside the Worker: `env.ENVIRONMENT` is a plain string. All `[vars]` values are strings — cast numbers explicitly. These are committed to source control and are appropriate for non-secret configuration.

### Secrets (covered more in §5)
Secrets do NOT appear in `wrangler.toml`. They are set via `wrangler secret put` and surface on `env` identically to `[vars]` at runtime — the only difference is that Cloudflare encrypts them at rest and never exposes them in the dashboard.

---

## 4. Environments

Wrangler supports environment overrides for preview, staging, and production tiers within a single `wrangler.toml`.

```toml
name             = "powerfab-api"
main             = "src/worker/index.ts"
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

Key rules:
- Top-level declarations are the baseline. Named environments (`[env.X]`) override or extend the baseline.
- Bindings declared at the top level are NOT automatically inherited into named environments — they must be re-declared or explicitly referenced. This is a frequent source of "binding not found" errors in production despite working locally.
- Deploy to a specific environment with `wrangler deploy --env production`.
- `wrangler dev --env preview` runs locally against the preview environment's binding configuration.

---

## 5. Secrets

```bash
wrangler secret put STRIPE_SECRET_KEY
# prompts for the value — never echoes to terminal
wrangler secret put STRIPE_SECRET_KEY --env production
```

Secrets are stored encrypted in Cloudflare's vault and injected into the Worker at runtime. They never appear in `wrangler.toml` and are never returned by the API after setting.

**Local development** — secrets are not available in `~/.wrangler` for `wrangler dev` to pull down. Instead, create `.dev.vars` at the project root:

```
STRIPE_SECRET_KEY=sk_test_...
INTERNAL_SIGNING_KEY=dev-only-not-real
```

`.dev.vars` follows `.env` syntax. Add it to `.gitignore` immediately. Wrangler reads it automatically when running `wrangler dev`. This file must never be committed.

At runtime the Worker cannot distinguish between a `[vars]` value, a secret, or a `.dev.vars` value — all surface as plain strings on `env`. The separation is purely for security hygiene.

---

## 6. Local Dev: wrangler dev and Miniflare

```bash
wrangler dev
```

This starts a local HTTP server (default port 8787) that emulates the Cloudflare Workers runtime using Miniflare. Miniflare is an in-process Node.js reimplementation of the V8 Isolate environment Workers run in at the edge.

**What Miniflare emulates:**
- KV namespace operations (stored in memory, wiped on restart)
- R2 bucket operations (in-memory blobs)
- D1 database (SQLite file on disk, persisted between restarts if `--persist-to` flag is used)
- Cache API
- Environment variables and secrets (from `.dev.vars`)

**What does NOT work locally:**
- **Containers** — Cloudflare Containers require the actual Cloudflare infrastructure to schedule and run. There is no local equivalent. Workaround: run the .NET 8 extraction job as a standalone process on your machine (`dotnet run` in the container project), expose it on a local port, and in the Worker's dev code replace `env.CONTAINER_RUNNER` calls with a fetch to a localhost URL. Guard this with a `process.env.NODE_ENV === 'development'` branch so the stub never reaches production.
- **Durable Objects** — emulated but with behavioral differences; test these against a deployed preview Worker rather than purely locally.
- **Real KV persistence** — local KV is in-memory. If testing seed data is needed between dev restarts, use `wrangler kv:key put` against the `preview_id` namespace and run `wrangler dev --remote` (which connects to real Cloudflare but costs API calls).

`wrangler dev --remote` is the escape hatch: it runs the Worker code locally but binds to real Cloudflare resources. Useful for Container testing once the Container is deployed to preview.

---

## 7. Pages-Side Local Dev

PowerFab's frontend is a Vite + React 19 app deployed to Cloudflare Pages. The dev stack looks like this:

```
Terminal 1: pnpm dev          → Vite dev server at localhost:5173
Terminal 2: wrangler dev      → Hono Worker at localhost:8787
```

In `vite.config.ts`, proxy API calls to the local Worker:
```typescript
server: {
  proxy: {
    '/api': 'http://localhost:8787'
  }
}
```

For `wrangler pages dev`, Cloudflare provides a unified command that serves both the static build output and calls a local Worker function simultaneously. For a solo dev iterating on frontend-heavy features, `pnpm dev` + proxied Worker is faster. For testing the Pages routing logic itself (redirects, `_headers`, `_redirects`), use `wrangler pages dev ./dist`.

---

## 8. Multi-Tenant Local Testing

PowerFab uses subdomain-per-tenant routing: `acme.app.example.com`. Locally this needs to be `acme.localhost`, `bobsteel.localhost`, etc.

**Good news:** `*.localhost` resolves to `127.0.0.1` automatically in most modern browsers (Chrome, Firefox, Safari) — no `/etc/hosts` changes needed. A request to `acme.localhost:5173` hits the Vite dev server.

**Fallback** (older browsers or Node.js `fetch` calls that bypass the OS resolver): add entries to `/etc/hosts`:
```
127.0.0.1  acme.localhost
127.0.0.1  bobsteel.localhost
127.0.0.1  crucible.localhost
```

**The 3-tenant rule:** Maintain exactly three local test tenants — one representing a "standard" tenant, one representing a "trial/limited" tenant, and one representing a "large/power" tenant. This catches 95% of tenant-isolation bugs without managing a combinatorial test matrix. Fewer than three often misses cross-tenant state leakage; more than three is overhead with diminishing returns.

In Worker code, extract the tenant slug from the Host header:
```typescript
const host = new URL(request.url).hostname;      // "acme.localhost"
const tenant = host.split('.')[0];                // "acme"
```

---

## 9. Deploy

**Deploy a Worker:**
```bash
wrangler deploy --env production
```

**Deploy Pages:**
```bash
wrangler pages deploy ./dist --project-name powerfab-dashboard
```

What happens when Cloudflare receives a deploy:

```
Local machine                 Cloudflare API              Edge PoPs (300+)
     |                              |                            |
     |-- bundle upload -----------> |                            |
     |                              |-- version stored in KV --> |
     |                              |-- propagate to PoPs -----> |
     |<-- deploy ID returned ---    |                            |
     |                              |                         (live ~15s)
```

The bundle is uploaded as a gzip'd V8 bytecode artifact. Cloudflare assigns it a version ID. Within approximately 15–30 seconds, all edge PoPs (Points of Presence) have the new version. There is no "restart" — each incoming request to a PoP instantiates a fresh isolate from the new bundle. In-flight requests on old isolates complete naturally.

---

## 10. Rollback

**Via CLI:**
```bash
wrangler rollback               # rolls back to the previous deployment
wrangler rollback <version-id>  # rolls back to a specific version
```

**Via dashboard:** Navigate to Workers & Pages → the Worker → Deployments tab → click "Rollback" next to any listed deployment. This is equivalent to the CLI path.

**Pages rollback:** In the Pages project, each build is retained. "Rollback" in the dashboard re-promotes a prior build to production instantly — it doesn't rebuild, it re-routes traffic to the previously uploaded artifact.

Rollback propagates to edge PoPs in the same ~15–30 second window as a new deploy.

---

## 11. Custom Domain Wiring

**Wildcard DNS:** In Cloudflare DNS, add a CNAME record:
```
*.app.example.com  →  CNAME  →  the Pages project's assigned subdomain  (proxied)
```

Cloudflare's proxy intercepts all `*.app.example.com` requests and routes them to the Pages project.

**Worker routes** in `wrangler.toml` direct API traffic from the same domain to the Worker instead of Pages:
```toml
[[env.production.routes]]
pattern = "*.app.example.com/api/*"
zone_name = "app.example.com"
```

Request flow:
```
Browser → acme.app.example.com/api/tenants
         → Cloudflare DNS (wildcard CNAME resolves)
         → Route match: /api/* → powerfab-api Worker
         → Worker reads tenant slug from Host header
         → Responds with tenant-scoped data

Browser → acme.app.example.com/ (no /api/)
         → Route: no Worker match
         → Falls through to Pages project
         → Serves React SPA
```

The `zone_name` must match an active zone in the same Cloudflare account. The zone must be on a paid plan to use wildcard routes.

---

## 12. Pitfalls / BUG-FIX Pairs

**BUG: "binding not found" at runtime in production, works fine in `wrangler dev`**
FIX: Named environments (`[env.production]`) do not inherit top-level bindings. Re-declare every `[[kv_namespaces]]`, `[[r2_buckets]]`, and `[[d1_databases]]` block under `[[env.production.kv_namespaces]]` etc. The binding name must match exactly.

**BUG: `compatibility_date` is 2+ years old, new npm package fails at runtime with "X is not a function"**
FIX: Update `compatibility_date` to within the last 6 months. Many Workers API surface changes (including `nodejs_compat` fixes) are date-gated. Update in a branch, run `wrangler deploy --env preview`, smoke test, then merge.

**BUG: Secret set via `wrangler secret put` is `undefined` in the Worker**
FIX: Confirm the secret was set for the correct environment. `wrangler secret put NAME` sets it on the default (untagged) Worker. For production, use `wrangler secret put NAME --env production`. Verify with `wrangler secret list --env production`.

**BUG: `wrangler deploy` exits with "Not logged in" or 403**
FIX: Run `wrangler login` again. Tokens expire. Alternatively, set `CLOUDFLARE_API_TOKEN` as an environment variable with a token that has "Workers Scripts: Edit" permission. This is required for CI/CD pipelines — GitHub Actions cannot use interactive browser login.

**BUG: Local `wrangler dev` KV reads return `null` for keys known to exist in production**
FIX: Local KV is in-memory and starts empty. Either seed it via `wrangler kv:key put --namespace-id=<preview_id>` before dev, or use `wrangler dev --remote` to bind against the real preview namespace.

**BUG: `.dev.vars` secrets are not available after `wrangler dev` restart**
FIX: `.dev.vars` is read on startup only. Stop and restart `wrangler dev` after modifying the file.

**BUG: Container binding exists in `wrangler.toml` but `wrangler dev` errors out**
FIX: Containers cannot run locally. Comment out the Container binding for local dev, run the .NET service standalone, and stub the calls in the Worker behind an `isDev` guard. Use a service binding or direct Worker-to-Worker call only in deployed environments.

**BUG: `*.app.example.com` wildcard route matches static assets and breaks the Pages project**
FIX: Make the Worker route pattern specific to `/api/*`. A catch-all `*.app.example.com/*` will intercept all requests including the React SPA. The Worker must explicitly `return fetch(request)` for non-API paths, or the route pattern must be scoped.
