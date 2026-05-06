# 01 — Tenant Resolution: How the URL Becomes "This is Acme"

> **Pre-reqs:** Read `00-start-here.md` first if you haven't. You should already know what a tenant, subdomain, Worker, and KV are.
>
> **What you'll know by the end:** How a request to `acme.app.example.com` ends up with our code knowing "I am serving Acme right now," with the per-tenant config loaded and ready. Every line of code we use is explained.

---

## 1. The problem

Imagine 100 different fab shops have signed up. Each one is at their own URL:

- `acme.app.example.com`
- `bobs-beams.app.example.com`
- `cora-construction.app.example.com`
- … and so on for all 100 …

When a request lands on our infrastructure, we need to answer one question before doing *anything* else:

> **Which tenant is this request for?**

Once we know that, we can:
- Look up that tenant's config (which modules are enabled? which metric overrides?)
- Reject the request if the subdomain is unknown (no `hacker.app.example.com`)
- Pass the tenant info into the React app so it knows what to render
- Pass the tenant info into any data API calls so they return *that tenant's* data

This whole process — figuring out which tenant a request is for and loading their config — is called **tenant resolution**.

---

## 2. Background: how URLs and subdomains actually work

Quick primer because some of this is non-obvious.

### 2.1 What's in a URL

```
https://acme.app.example.com/some/path?foo=bar
└─┬─┘   └─────────────┬───────┘└──┬───┘└──┬──┘
 scheme         host (a.k.a.       path   query string
                "domain name"
                or "hostname")
```

The **host** is the part right after `https://` and before the first `/`. In our example: `acme.app.example.com`.

A host has dots in it. Reading from right to left, the parts get more specific:

```
acme   .   app   .   example   .   com
└──┬─┘     └─┬─┘     └────┬──┘     └─┬─┘
"acme is   "app is the    "example   ".com is
a child    main app at     is the    a top-level
of app"    example.com"    company"   domain"
```

The leftmost label (in our case `acme`) is what we'll use as the tenant identifier. We call it the **slug** because that's the term web devs use for "URL-safe short identifier."

### 2.2 What the browser sends

When the user types `https://acme.app.example.com/dashboard` and hits Enter, the browser opens a connection to whatever server `acme.app.example.com` resolves to (we'll set that up to be Cloudflare). It sends an HTTP request that looks roughly like this:

```
GET /dashboard HTTP/1.1
Host: acme.app.example.com
Accept: text/html
... other headers ...
```

The **`Host` header** is the critical bit. It's how the browser tells the server "I want the version of the site at `acme.app.example.com`" — even though the server might be hosting many different sites.

This is the whole foundation. **Every request includes the host. We extract the leftmost label from the host. That's our tenant slug.** Everything else in this doc is plumbing around that one idea.

### 2.3 Wildcard DNS

Normally to point `acme.app.example.com` at a server, you'd add a DNS record. With 100 tenants, you do not want to add 100 DNS records by hand.

The fix: a **wildcard DNS record**. You add ONE record that says "anything matching `*.app.example.com` should go to Cloudflare" and DNS handles all 100 tenants automatically. New customer? They just work — no DNS change.

Cloudflare lets you do this through their dashboard. It's a single CNAME record. We won't go deeper here; the [Cloudflare docs on wildcard DNS](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/) explain the setup.

---

## 3. Where to extract the subdomain — three options

Once a request has landed somewhere, we need to grab `"acme"` out of the host. There are three plausible places to do that, and they have different tradeoffs.

### Option A — In the browser (React reads `window.location.hostname`)

The simplest version. The React app boots, reads `window.location.hostname` (a built-in browser property that gives you the host), and grabs the first label.

```ts
// somewhere in main.tsx
const slug = window.location.hostname.split('.')[0];
// slug === 'acme' for acme.app.example.com
```

**Pros:** Zero infrastructure. Just JavaScript.

**Cons:**
- The unknown-tenant case is bad. If someone hits `hacker.app.example.com`, the server hands them the full React app, and only THEN does the React app realize "wait, who's hacker?" The user sees the app shell flash before getting an error. We've also wasted bandwidth shipping the whole app.
- The config still has to be fetched somehow after boot — that's a second round trip before anything renders.
- Server-side rendering (if we ever add it) doesn't have access to `window`.

This pattern is fine for prototypes. We're not using it for production.

### Option B — At the edge (Worker rewrites or rejects)

Cloudflare Workers run *before* Pages serves the static files. We put a Worker in front, it reads the `Host` header, looks up the tenant, and either passes the request through (with config attached) or returns a 404.

```ts
// pseudocode
function handle(request) {
  const host = request.headers.get('host');
  const slug = host.split('.')[0];
  const config = lookupTenant(slug);
  if (!config) return new Response('Unknown tenant', { status: 404 });
  // pass through to Pages
  return fetch(request);
}
```

**Pros:**
- Authoritative gate at the edge. Unknown tenants get a clean 404 before any app code is shipped.
- Fast. Workers run in the same Cloudflare data center the user is talking to.
- The Worker can attach the config to the response, eliminating the second round trip.

**Cons:**
- Adds a piece of infrastructure (the Worker) we have to deploy and maintain.

### Option C — Both: Worker reads + injects, React reads what's injected

This is the recommended pattern, and it's just A + B working together.

The Worker runs first. It reads the host, looks up the config, and **injects the config into the HTML it sends back** as a small `<script>` tag. The React app boots, reads that `<script>` tag, and uses it.

```
Browser → Worker (reads host → looks up config in KV → injects into HTML) → Pages serves the static React app → Browser parses HTML, reads injected config, boots React with it
```

This is what `vercel/platforms` does (the canonical multi-tenant Next.js template), what the [Cloudflare guide for multi-domain SaaS](https://medium.com/codex/how-i-use-cloudflare-to-build-multi-domain-saas-applications-with-react-single-page-applications-527e1a742401) does, and what [Cloudflare for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/) is built around.

We're going with Option C. The rest of this doc walks through it.

---

## 4. Picking the Worker framework: why Hono

You can write a Cloudflare Worker as a single function — the [Workers docs](https://developers.cloudflare.com/workers/) call this the "module syntax." Or you can use a tiny framework on top to handle routing, middleware, and TypeScript ergonomics.

For Workers, the framework most teams use is **[Hono](https://hono.dev/)**. It's:
- Tiny (~12 KB)
- Designed for edge runtimes
- Has a very Express-like API
- First-class TypeScript types
- [Officially supported by Cloudflare](https://hono.dev/docs/getting-started/cloudflare-workers)

If you've written any Express or Koa or Fastify, Hono will feel familiar. We'll use it because the alternative — raw `addEventListener('fetch', ...)` — gets ugly fast.

---

## 5. The Worker code, line by line

Here's the full Worker. Every line explained immediately after.

```ts
// worker/index.ts
import { Hono } from 'hono';

type Env = {
  TENANTS: KVNamespace;
  ASSETS: Fetcher;
};

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const host = c.req.header('host') ?? '';
  const slug = host.split('.')[0];
  const config = await c.env.TENANTS.get(`tenants:${slug}`, 'json');
  if (!config) return c.text('Unknown tenant', 404);
  c.set('tenantConfig', config);
  await next();
});

app.get('*', async (c) => {
  const html = await (await c.env.ASSETS.fetch(c.req.raw)).text();
  const injected = html.replace(
    '<!--__TENANT__-->',
    `<script id="__tenant__" type="application/json">${JSON.stringify(c.get('tenantConfig'))}</script>`,
  );
  return c.html(injected);
});

export default app;
```

That's the whole Worker. ~20 lines. Now let's walk through it.

### 5.1 The imports and types

```ts
import { Hono } from 'hono';
```

Imports the Hono framework.

```ts
type Env = {
  TENANTS: KVNamespace;
  ASSETS: Fetcher;
};
```

This declares the **bindings** the Worker uses. A "binding" in Cloudflare-speak is something the Worker can access at runtime — a KV namespace, an R2 bucket, a D1 database, or a connection to your Pages assets. Bindings are configured in `wrangler.toml` (Cloudflare's deployment config file). At runtime they appear on `c.env`.

- `TENANTS: KVNamespace` — this is a KV namespace called `TENANTS`. We'll use it to store per-tenant configs under keys like `tenants:acme`, `tenants:bobs-beams`, etc.
- `ASSETS: Fetcher` — this is the binding to Cloudflare Pages, where our React app's static files live. Calling `ASSETS.fetch(request)` says "ask Pages to serve this request as if the Worker weren't here." That's how we hand off to the static React app while still being able to modify the response.

### 5.2 Creating the app

```ts
const app = new Hono<{ Bindings: Env }>();
```

Creates a Hono app, telling TypeScript "the bindings will match the `Env` type I just defined." This is what makes `c.env.TENANTS` properly typed later.

### 5.3 The middleware that does tenant resolution

```ts
app.use('*', async (c, next) => {
  ...
});
```

`app.use('*', ...)` registers **middleware** — a function that runs on EVERY request (`*` = all paths). Middleware can do work, then call `next()` to pass the request along to the actual handler.

The first argument to the middleware function is `c`, Hono's "context" object. It has helpers for reading the request, setting response headers, accessing bindings, etc.

```ts
  const host = c.req.header('host') ?? '';
```

Reads the `Host` header from the request. If for some weird reason it's missing, fall back to empty string. (`??` is JavaScript's "nullish coalescing operator" — it means "use the right side if the left side is null or undefined.")

```ts
  const slug = host.split('.')[0];
```

Splits the host on `.` and takes the first piece. So `acme.app.example.com` → `['acme', 'app', 'example', 'com']` → `'acme'`.

```ts
  const config = await c.env.TENANTS.get(`tenants:${slug}`, 'json');
```

Looks up the tenant config in KV.
- `c.env.TENANTS` is the KV namespace binding (from §5.1).
- `.get(key, 'json')` reads the value at that key and parses it as JSON.
- The key is `tenants:acme` (or whatever the slug is). Using a prefix like `tenants:` is good practice — KV is shared across uses, and a prefix prevents collisions if you later store other things in the same namespace.

If the key doesn't exist, `.get` returns `null`.

```ts
  if (!config) return c.text('Unknown tenant', 404);
```

If we didn't find a config for this slug, return 404. This is the gate that protects against `hacker.app.example.com`. The user gets a clean error and zero app code is shipped.

```ts
  c.set('tenantConfig', config);
  await next();
});
```

`c.set` stores something in the request-scoped context — like attaching it to the request as it flows through. Later handlers can call `c.get('tenantConfig')` to retrieve it.

`await next()` hands the request off to the next handler in the chain (which will be the GET handler below). After that handler runs, we'd come back here if there were code after `next()`, but there isn't — the middleware is done.

### 5.4 The GET handler that serves the modified HTML

```ts
app.get('*', async (c) => {
  ...
});
```

Registers a handler for GET requests on all paths. Hono runs this AFTER the middleware (because the middleware called `next()`).

```ts
  const html = await (await c.env.ASSETS.fetch(c.req.raw)).text();
```

This is the dense line. Read it inside-out:

1. `c.req.raw` is the raw `Request` object (the standard Web API one).
2. `c.env.ASSETS.fetch(c.req.raw)` says "send this request to Pages and let it serve the static asset." For a request to `/`, Pages returns `index.html`. For `/assets/main-abc123.js`, it returns that JS file.
3. `await ...` — `fetch` returns a Promise that resolves to a `Response`.
4. `.text()` reads the response body as text. Returns another Promise.
5. `await ...` — wait for that.
6. `const html = ...` — now we have the HTML as a string.

So this line says: "fetch what Pages would normally serve, get its body as text, save into `html`." For a request to `/`, that's `index.html`.

```ts
  const injected = html.replace(
    '<!--__TENANT__-->',
    `<script id="__tenant__" type="application/json">${JSON.stringify(c.get('tenantConfig'))}</script>`,
  );
```

Find the placeholder `<!--__TENANT__-->` in the HTML and replace it with a `<script>` tag containing the tenant's config as JSON.

The placeholder needs to be in our `index.html` template. Open `app/index.html` and add it where you want the config injected — usually right before the closing `</head>`:

```html
<!doctype html>
<html lang="en">
  <head>
    ...
    <!--__TENANT__-->
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

When the Worker runs, it replaces that comment with:

```html
<script id="__tenant__" type="application/json">
  {"tenantId":"tnt_01H...","slug":"acme","enabledModules":[...]}
</script>
```

Two important details:

1. **`type="application/json"`** — this is critical. By default, the browser would try to *execute* a `<script>` tag as JavaScript. Setting `type="application/json"` makes it inert — the browser just stores the contents as text, and we'll parse it ourselves in React.

2. **`JSON.stringify(...)`** — escapes any characters that would otherwise break out of the string. Important if config strings contain quotes or `<` characters. (For really paranoid escaping you'd want to additionally replace `</script>` to prevent the script tag from closing early, but `JSON.stringify` handles the common cases.)

```ts
  return c.html(injected);
});
```

Return the modified HTML to the browser. `c.html` sets the `Content-Type` to `text/html` automatically.

```ts
export default app;
```

Cloudflare Workers expect a default export of the app. Hono's `app` is the right shape — Cloudflare calls its `fetch` method on every incoming request.

---

## 6. The React side, line by line

The React app boots normally. Just before any rendering, we read the injected config.

```ts
// src/tenant.ts
import type { TenantConfig } from './types/tenantConfig';

const raw = document.getElementById('__tenant__')?.textContent;

export const tenantConfig: TenantConfig = raw
  ? JSON.parse(raw)
  : (import.meta.env.DEV ? import.meta.env.VITE_DEV_TENANT : null);

if (!tenantConfig) throw new Error('No tenant config available');
```

Walking through:

```ts
const raw = document.getElementById('__tenant__')?.textContent;
```

Find the `<script id="__tenant__">` we injected. The `?.` is "optional chaining" — if `getElementById` returns null (no such element), the whole expression is `undefined` instead of crashing.

`.textContent` is the text inside the tag — our JSON string.

```ts
export const tenantConfig: TenantConfig = raw
  ? JSON.parse(raw)
  : (import.meta.env.DEV ? import.meta.env.VITE_DEV_TENANT : null);
```

If we got the JSON, parse it. If we didn't (because `<script id="__tenant__">` wasn't there), check if we're in dev mode (`import.meta.env.DEV` is Vite's flag for "we're running `vite dev`"). In dev, fall back to a config from an environment variable.

```ts
if (!tenantConfig) throw new Error('No tenant config available');
```

If neither worked, crash loud and clear. Better than silently rendering a half-broken UI.

Then anywhere else in the app that needs the config, you import it:

```ts
import { tenantConfig } from './tenant';
console.log(tenantConfig.enabledModules);
```

That's it. The React side is genuinely tiny. All the magic is in the Worker injecting the config and the `<script>` tag pattern.

---

## 7. Local dev — the localhost problem

There's one annoying problem. When you run `vite dev` locally, your app is at `http://localhost:5173`. There's no subdomain. The Worker isn't running. So:

```ts
const slug = window.location.hostname.split('.')[0];
// 'localhost' — uh oh
```

Three ways to fix this, in increasing order of effort:

### 7.1 Option 1 — Env var fallback (do this on day one)

In your `.env.development`:

```
VITE_DEV_TENANT_SLUG=acme
```

In `vite.config.ts`, expose it (Vite's `import.meta.env.VITE_*` is automatic — anything starting with `VITE_` is available in the app at build time).

In `tenant.ts`, fall back to reading the env var and loading from a local file:

```ts
const raw = document.getElementById('__tenant__')?.textContent;

let tenantConfig: TenantConfig | null = null;

if (raw) {
  tenantConfig = JSON.parse(raw);
} else if (import.meta.env.DEV) {
  const slug = import.meta.env.VITE_DEV_TENANT_SLUG;
  // Vite's import.meta.glob loads JSON files at build time
  const tenantConfigs = import.meta.glob('../tenants/*.json', { eager: true });
  tenantConfig = tenantConfigs[`../tenants/${slug}.json`]?.default ?? null;
}

if (!tenantConfig) throw new Error('No tenant config available');
export { tenantConfig };
```

In `app/tenants/acme.json` you put Acme's config. When you run `vite dev`, you're dev-ing as Acme. Change the env var to dev as a different tenant.

Easy, fast, no setup beyond an env var. **Use this.**

### 7.2 Option 2 — `*.localhost` subdomains

macOS, Linux, and modern Windows browsers natively resolve any `*.localhost` name to `127.0.0.1`. So `http://acme.localhost:5173` actually works in a browser, no `/etc/hosts` editing needed.

You point Vite at the same port, then in your code, the same `host.split('.')[0]` logic gives you `'acme'` from `acme.localhost`.

Useful when you have designers or PMs poking at the dev server and want a more realistic URL.

### 7.3 Option 3 — Run the actual Worker locally

`wrangler pages dev` runs your Pages site AND your Worker in front of it, locally. You get the full production-shaped flow. But it's slower than `vite dev` and you have to deal with KV emulation. Use this only when the Worker logic itself gets complicated enough that you need to debug it locally.

**Recommendation:** ship with Option 1 from day one. Add Option 2 if you want nicer URLs for non-developers. Only do Option 3 when the Worker logic grows beyond the ~20 lines we have now.

---

## 8. What the Worker file structure looks like

Concretely, your repo will grow a `worker/` folder alongside `app/`:

```
powerfab-dashboard/
├── app/                    ← React/Vite app (existing)
│   ├── src/
│   ├── index.html          ← Add <!--__TENANT__--> here
│   └── ...
├── worker/                 ← NEW: the Worker
│   ├── index.ts            ← The code from §5
│   ├── package.json
│   └── tsconfig.json
├── tenants/                ← NEW: per-tenant config JSON files
│   ├── acme.json
│   ├── bobs-beams.json
│   └── ...
├── wrangler.toml           ← NEW: Cloudflare deployment config
└── ...
```

`wrangler.toml` is where you wire up bindings. Roughly:

```toml
name = "powerfab-dashboard"
main = "worker/index.ts"
compatibility_date = "2026-05-01"

[assets]
directory = "app/dist"
binding = "ASSETS"

[[kv_namespaces]]
binding = "TENANTS"
id = "<your-kv-namespace-id-from-cloudflare>"
```

The exact wrangler.toml setup is in the Cloudflare docs ([Workers + Pages Assets](https://developers.cloudflare.com/workers/static-assets/), [KV bindings](https://developers.cloudflare.com/kv/api/workers-api-bindings/)). We'll wire it up for real when we actually deploy.

---

## 9. What about new tenant onboarding?

Now you can answer "what does it take to onboard Acme?" — concretely:

1. **DNS:** none — wildcard subdomain handles it.
2. **Config:** create `tenants/acme.json` (in MVP) or write `tenants:acme` to KV (later).
3. **Data:** kick off the nightly pipeline for Acme so their JSON snapshots land in R2 (covered in `03-customer-data-ingest.md`, the data ingest doc).
4. **Auth:** create their first user account (covered in a future doc).

That's it. No code change. No deploy. New tenant goes live the moment their config and data are present.

This is the payoff of the architecture. It's what makes 200 tenants feasible.

---

## 10. What if a tenant wants their own custom domain?

Some bigger customers will say "we don't want our dashboard at `acme.app.example.com` — we want it at `dashboard.acme.com`." You can do that with [Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/) (formerly "Custom Hostnames"). They add a CNAME, you add their hostname to your account, Cloudflare handles SSL automatically.

In the Worker, you'd map `dashboard.acme.com` → `acme` slug via a lookup table in KV (`hostnames:dashboard.acme.com` → `acme`). Same flow otherwise.

This is a Phase 2 thing. Skip for now.

---

## 11. By the end of this doc you should know

- What a `Host` header is and why it's how the browser tells the server which subdomain.
- What a **wildcard DNS record** is and why we want one.
- The three places to extract the subdomain (browser / Worker / both) and why we picked the third.
- What every line of the Worker does — host extraction, KV lookup, 404 on unknown, HTML rewrite to inject config.
- What the React side does to read the injected config.
- How to dev locally without a real subdomain.
- What it takes to onboard a new tenant once this is set up.

If `c.env.TENANTS.get(...)` or `c.req.header(...)` still feels mysterious, the [Hono docs](https://hono.dev/docs/api/context) have a great reference. The key intuition: Hono's `c` is just a request-scoped object that bundles the request, response helpers, and Cloudflare bindings. That's all.

---

**Next:** `02-config.md` — what's actually in a tenant config, what Zod is, and where the configs live (KV vs JSON-in-repo vs D1, plain English).

> If you got this far and the level felt right, tell me and I'll write 02 / 03 / 04 next. If anything was confusing or moved too fast, tell me which section — I'll rewrite it before writing the rest.
