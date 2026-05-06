# 00 — Start Here: The Big Picture and a Vocabulary Primer

> **Read this first.** This is part 1 of a 5-part beginner-friendly series that re-explains the patterns from `02-multi-tenant-config-ui.md` from the ground up. Every term is defined before it's used. By the end of this doc you should have a mental model of what we're trying to build and the words to talk about it.

---

## 1. What we have today

You have one dashboard. It's a React app, served as static HTML+JS+CSS files from Vercel. Once a night, a pipeline (Python + a C# .NET 8 binary) runs on a Windows machine, hits the customer's database and API, and writes the results to a folder called `app/public/data/`. That folder contains 17 small JSON files — about **1.6 MB total** — and the React app reads those JSONs at runtime to render the 7 panels (Estimating, Production Control, Project Management, Time, Inspections, Purchasing, Inventory).

Important properties of today's setup:

- **One customer.** There is no concept of "which customer is looking at this." There's just *the* dashboard.
- **Static files.** When a user opens the app in their browser, Vercel just hands them the HTML and the JSON files. There's no server doing anything custom for them.
- **Same view for everyone.** All 7 panels and all ~80 metrics show the same way. You can't hide a panel for one customer and show it for another.

That's where you are. Everything below is about getting from that to where you want to be.

---

## 2. What you want

You want this exact app to serve **100–200 different fab shops**, each at their own URL — `acme.app.example.com`, `bigshop.app.example.com`, and so on. And you want to be able to say things like:

- "Acme doesn't pay for Inspections — hide that whole panel for them."
- "BigShop wants to see the *Monthly Hours* metric instead of *Weekly Hours* in the Time panel — swap it for them."
- "Brian's Beams gets all 7 panels but with one extra Estimating tile we built just for them."

…**without writing a separate copy of the app for each customer.** That's the dream. One codebase, many customers, each seeing their own customized version.

That dream has two halves, and they're easier to understand if you separate them:

**Half 1 — Multi-tenancy:** how do you make ONE deployed app serve MANY customers, with each customer's data kept separate and each customer routed to "their" version?

**Half 2 — Config-driven UI:** how do you customize WHAT each customer sees without writing custom code per customer?

The whole rest of this docs series is about those two things. Part 1 (this doc) gives you the vocabulary. Parts 2–5 build the actual machinery.

---

## 3. What "multi-tenancy" actually means

A **tenant** is SaaS-speak for "one of your customers." It comes from the apartment building analogy: one building (your app), many tenants (your customers), each in their own apartment (their data and view).

**Multi-tenancy** = your app is built so that *one running instance* of it serves *many tenants at once*, with each tenant's data and view kept walled off from the others.

The opposite is called **single-tenancy**: one running instance per customer. If you had 200 customers and a single-tenant model, you'd be running 200 separate copies of the app, each on its own server. Possible, but expensive and painful to update.

Here's the picture:

```
SINGLE-TENANT (don't do this for 200 customers):
┌──────────┐  ┌──────────┐  ┌──────────┐         ┌──────────┐
│ App copy │  │ App copy │  │ App copy │  ...    │ App copy │
│ for Acme │  │ for Bob's│  │ for Cora │         │ for Zeta │
└──────────┘  └──────────┘  └──────────┘         └──────────┘
   Acme        Bob's          Cora                Zeta

MULTI-TENANT (one app, many customers):
                    ┌──────────────────┐
                    │   ONE app, ONE   │
                    │  deployment      │
                    └──────────────────┘
                  ↗     ↑      ↑       ↖
              Acme   Bob's   Cora   ...  Zeta
```

The key skill of multi-tenancy is: **whenever the app does anything, it knows which tenant it's doing it for.** Read data? Read Acme's data, not everyone's. Render the dashboard? Render Acme's modules, not the default. Save settings? Save them under Acme.

That "knowing which tenant" thing is called **tenant resolution**, and it's covered in the next doc (`01-tenant-resolution.md`).

---

## 4. What "config-driven UI" actually means

A **config** is just a fancy word for "a settings file" — usually a chunk of JSON that says how something should behave.

A **config-driven UI** is a UI where the layout and content are decided by reading a config, not by writing custom code per case. Same React app, different config in → different UI out.

Here's the contrast:

```
WITHOUT config-driven UI (the bad way for 200 customers):

  if (tenant === 'acme') {
    render <Estimating />
    render <ProductionControl />
    // skip Inspections — Acme doesn't have it
    render <Time withMonthlyHoursInsteadOfWeekly />
    ...
  }
  else if (tenant === 'bob's-beams') {
    render <Estimating withExtraTile />
    render <ProductionControl />
    render <Inspections />
    ...
  }
  else if (tenant === 'cora-construction') {
    ...
  }
  // 200 of these. Maintain forever. Cry.

WITH config-driven UI (the way we're going):

  const config = loadConfigFor(tenant);  // a JSON file specific to this tenant
  for (const moduleName of config.enabledModules) {
    for (const metric of resolveMetrics(moduleName, config)) {
      render <MetricSlot id={metric} />
    }
  }
  // ONE rendering loop. Configs decide what shows.
```

A config-driven UI moves the *what shows* decisions out of code and into a per-tenant JSON file. To customize Acme, you don't change React code — you change `acme.json`.

The thing that makes this possible is called the **registry pattern**, which is in doc `03-registry-pattern.md`. That's where the most confusion was in the original doc, so we'll spend the most time on that one.

---

## 5. The vocabulary primer

Here's every weird term in the original doc, defined in plain English. Skim now, refer back as you read the other docs.

### Tenancy / hosting

- **Tenant** — one customer. "Acme" is a tenant. "Bob's Beams" is a tenant. We talk about *the tenant* the way you might talk about *the user* in a normal app, except a tenant is usually a company that has many users inside it.

- **Multi-tenant** — one app, many tenants. The opposite of single-tenant.

- **Subdomain** — the part before your main domain. In `acme.app.example.com`, the subdomain is `acme`. The "main domain" is `app.example.com`. The browser sends the full host (`acme.app.example.com`) to the server in every request, so we can read it and figure out which tenant.

- **Wildcard subdomain** — DNS configuration that says "anything matching `*.app.example.com` should route here." Means we don't have to add a DNS record per tenant; we add one wildcard and it handles all of them.

- **Cloudflare Pages** — Cloudflare's product for hosting static frontends like Vite/React/Vue/Next. Like Vercel, but on Cloudflare. Free up to a generous quota.

- **Cloudflare Worker** — a small bit of JavaScript or TypeScript that runs *at the edge*. ("Edge" = on Cloudflare's network, near the user, not on a server in some specific region.) When a user requests a URL, you can intercept the request with a Worker, do something (read a header, look up a config, transform the response), and either pass it through or respond yourself. We're going to use a Worker to figure out which tenant a request is for and inject their config.

- **The edge** — short for "edge of the network." When a user in Texas requests your app, it hits a Cloudflare data center in Texas (not your origin server in Virginia or wherever). Workers run in those edge data centers — that's why they're fast.

- **Cloudflare KV** — a tiny database designed to live at the edge. Think of it as a giant key-value store: `KV.get('tenants:acme')` returns whatever JSON you stored under that key. Reads are very fast. Writes are slow and *eventually consistent* (more on that below).

- **Eventually consistent** — when you write to KV, the new value isn't visible *everywhere* immediately. It takes up to ~60 seconds to propagate to every Cloudflare edge location. For "tenant config that rarely changes," this is fine. For "user just added a comment, refresh the page" it's bad. Different tools for different jobs.

- **Cloudflare D1** — a real SQL database (SQLite under the hood) that lives at the edge. Stronger consistency than KV (writes are visible immediately on the next read). Slower per-query than KV but you can run real SQL like `SELECT * WHERE x = ?`. Use D1 when you need queries; use KV when you just need fast key lookups.

- **Cloudflare R2** — Cloudflare's object storage. Like Amazon S3 but cheaper to read out of. You upload a file, you get a URL, you can download it. We'll use R2 to store the per-tenant JSON snapshots that the nightly pipeline produces.

### React / TypeScript

- **Module** (in our app) — one of the 7 panels: Estimating, Production Control, Project Management, Time, Inspections, Purchasing, Inventory. Naming gets confusing because "module" also means "JS file" in JavaScript-land. In our docs, "module" almost always means "panel," and we'll call out the other meaning when we mean it.

- **Metric** (in our app) — one tile inside a panel. "Win rate" is a metric. "Monthly hours" is a metric. We have ~80 of them across 7 modules.

- **Component** (in React) — a piece of UI written as a function that returns JSX. `function WinRate() { return <div>...</div> }` is a component. Each metric will be a component.

- **Registry** — a phonebook. Pure and simple. A registry is a TypeScript object that maps a string ID to a thing — usually a component. Like:

  ```ts
  const METRICS = {
    'estimating.win-rate': WinRateComponent,
    'time.monthly-hours': MonthlyHoursComponent,
  }
  ```

  Then if your config says "show metric `estimating.win-rate`" you can do `METRICS['estimating.win-rate']` and get the component. The registry pattern is the heart of config-driven UI, and we'll cover it in detail in doc 03.

- **Lazy loading** — loading code only when it's actually needed. By default, when a user opens your app, the browser downloads ALL the JavaScript in one big file. Lazy loading splits it: the browser only downloads the JS for the Time panel when the user opens the Time panel. Saves bandwidth and makes the initial load faster.

- **Code splitting** — basically a synonym for lazy loading. The build tool (Vite) splits your one big JS file into smaller "chunks" that can be loaded on demand.

- **`React.lazy`** — React's built-in API for lazy loading a component. Looks like: `const Time = React.lazy(() => import('./Time'))`. This says "don't bundle Time with the main app; download it the first time we render `<Time />`."

- **Suspense** — React's tool for showing a fallback (like a spinner) while a lazy component is loading. Wrap a `<React.lazy>` component in `<Suspense fallback={<Spinner />}>` and React handles "show spinner, then swap to the real thing when it's loaded."

- **Schema** — a description of what shape a piece of data must have. "An object with a `name` (string) and `age` (number)" is a schema. Schemas exist so you can VALIDATE that incoming data is shaped correctly.

- **Zod** — a popular TypeScript library for defining schemas in code. You write `z.object({ name: z.string(), age: z.number() })` and Zod gives you (a) a TypeScript type matching that shape, and (b) a `.parse(data)` function that throws if `data` doesn't match. Good first line of defense against bad config.

- **Feature flag** — a switch in your code that turns a feature on or off based on some rule. "Show new dashboard layout to 10% of users" is a feature flag use case. Different from config — config defines what a tenant *is*, flags define a *temporary* deviation. We'll cover the difference in doc 04.

### TypeScript magic terms (the scary ones)

- **`as const`** — a TypeScript directive that tells the compiler: "treat this value as the literal value, not as a wider type." Example:

  ```ts
  const a = { foo: 'bar' };           // type is { foo: string }
  const b = { foo: 'bar' } as const;  // type is { readonly foo: 'bar' }
  ```

  We use `as const` on the registry so the compiler knows the *exact* set of metric IDs, not just "some strings."

- **`satisfies`** — TypeScript's way of saying "this value must satisfy this type, but don't widen it." Lets you check that an object has all the right shape WITHOUT losing the literal types of its keys. We use it to make sure every entry in the metric registry has a valid component, while still keeping the exact key names typed.

- **`keyof typeof X`** — TypeScript shorthand for "the type that is the union of all keys of X." If `X = { foo: 1, bar: 2 } as const`, then `keyof typeof X` is the type `'foo' | 'bar'`. We use this to derive the `MetricId` type FROM the registry — so adding/removing a metric in the registry automatically adds/removes it from the `MetricId` type.

- **Derived union** — a TypeScript type that's computed from another value. `MetricId = keyof typeof METRICS` is a derived union. If you change the registry, the type changes automatically — no separate list to keep in sync.

If those don't sink in yet, that's totally fine. We'll work through them with examples in doc 03.

---

## 6. The whole picture, end to end

Here's what we're building. Imagine a user at Acme types `acme.app.example.com` into their browser. Here's everything that happens:

```
   ┌──────────────┐
   │  User at Acme│
   │              │
   │  Browser →   │  https://acme.app.example.com
   └──────┬───────┘
          │
          │ 1. DNS lookup says "*.app.example.com lives at Cloudflare"
          ▼
   ┌──────────────────────────────────────────────────┐
   │              CLOUDFLARE EDGE                     │
   │                                                  │
   │  2. Cloudflare receives the request.             │
   │     A "Worker" we deployed runs first.           │
   │                                                  │
   │  ┌────────────────────────────────────────────┐  │
   │  │ Worker code (TypeScript):                  │  │
   │  │  - Read the host: "acme.app.example.com"   │  │
   │  │  - Extract the slug: "acme"                │  │
   │  │  - Look up "tenants:acme" in KV            │  │
   │  │     → returns acme's config JSON           │  │
   │  │  - Fetch index.html from Pages             │  │
   │  │  - Inject the config into the HTML as      │  │
   │  │    <script id="__tenant__"                 │  │
   │  │            type="application/json">…</…>   │  │
   │  │  - Return the modified HTML                │  │
   │  └────────────────────────────────────────────┘  │
   │                                                  │
   │  3. Cloudflare Pages serves the React app's      │
   │     static files (HTML, JS, CSS) — including     │
   │     the Worker-modified HTML from step 2.        │
   └──────────────────────────────────────────────────┘
          │
          │ 4. Browser receives HTML with config baked in
          ▼
   ┌──────────────────────────────────────────────────┐
   │              USER'S BROWSER                      │
   │                                                  │
   │  5. React app boots.                             │
   │     - Reads the embedded <script> tag            │
   │     - Parses the JSON → that's Acme's config     │
   │     - Looks at config.enabledModules             │
   │     - For each enabled module:                   │
   │        - Loads the module's code (lazy chunk)    │
   │        - Computes the list of metrics to show    │
   │          (defaults + overrides from config)      │
   │        - For each metric, renders <MetricSlot>   │
   │     - <MetricSlot> looks up the component in     │
   │       the registry by ID and renders it.         │
   │                                                  │
   │  6. Each metric component fetches its data:      │
   │     - GET /tenants/acme/data/estimating.json     │
   │       (served from R2 via Worker, or from        │
   │        Pages if we keep static)                  │
   │     - Renders the chart/table/whatever           │
   │                                                  │
   │  7. User sees Acme's customized dashboard.       │
   └──────────────────────────────────────────────────┘
```

Re-read the diagram now that you have the vocabulary. Steps 2–3 are "tenant resolution" (doc 01). Steps 4–5 are "config-driven UI" (docs 02 + 03). Step 6 is data fetch and is the same as today, just per-tenant.

---

## 7. Why we're doing it this way (and not other ways)

A few obvious-sounding alternatives, and why they're worse:

- **"Just check the URL inside React and decide what to show."** You'd skip the Worker. Problem: an unknown tenant (`hacker.app.example.com`) would still get the full app shell loaded, just with nothing to render. Tiny security/UX issue, but a real one. With the Worker pattern, an unknown tenant gets a clean 404 before any code is shipped to the browser.

- **"Build a separate copy of the app per tenant."** That's single-tenant. We covered why it doesn't scale.

- **"Put all the configurability in a database, no JSON in the repo."** Tempting, but at 5–10 tenants, hand-editing JSON in a Git PR is faster and gives you free version control. We'll graduate to KV at ~50 tenants. Doc 02 explains the migration path.

- **"Make every layout decision a config option."** The trap. Adding `branding`, `colors`, `roles`, `layout grid` to config quadruples your testing surface for benefits zero customers asked for. The principle: **you only make X configurable when at least 3 tenants actually need different X.** Until then, it's hardcoded. Doc 04's anti-patterns section goes deeper.

---

## 8. What's in the rest of the series

| Doc | What it explains |
|---|---|
| **00 (this doc)** | Big picture + vocabulary. You're here. |
| **01 — Tenant resolution** | How `acme.app.example.com` becomes "I am serving Acme." Worker code line by line. Local dev (since `localhost` has no subdomain). |
| **02 — Config: schema and storage** | What's in a tenant config. What Zod is and why it's there. Where the configs live (JSON file? KV? D1? R2? — explained one by one in plain English). Schema versioning. |
| **03 — The registry pattern** | The big one. The pattern that makes config-driven UI work. Modules registry, metric registry, every TypeScript trick (`as const`, `satisfies`, derived unions) explained with examples. The `<MetricSlot>` component walked through line by line. Lazy loading and Suspense. |
| **04 — Flags, anti-patterns, full walkthrough** | When config and when feature flag. The 10 anti-patterns to avoid, each in plain language. Then a complete worked example: take Acme's config and trace exactly what renders, with every line of code annotated. |

---

## 9. How to read these docs

Read in order: 00 → 01 → 02 → 03 → 04. They build on each other. Doc 03 will be confusing if you skipped 02 because we'll be referring to the config schema we defined there.

Each doc starts with a "what you'll know by the end" summary. If you find yourself thinking "wait, what's a Worker?" — flip back here to §5 vocabulary. Don't push through confusion; the docs aren't going anywhere.

If something is still unclear after reading slowly, that's a signal to me that the doc isn't beginner-friendly enough — flag it and I'll rewrite that section.

---

## 10. By the end of this doc you should know

- What a **tenant** is and what **multi-tenancy** means.
- What a **subdomain** is and why we use one per tenant.
- What a **Cloudflare Worker** is and where it sits in the request flow.
- The difference between **KV**, **D1**, and **R2** at a high level.
- What **module** and **metric** mean in our app.
- What a **registry** is, conceptually (a phonebook).
- What **lazy loading** means.
- What **Zod** does (validate that JSON matches a shape).
- What a **config-driven UI** is and why we want one.
- The end-to-end flow from `acme.app.example.com` to a rendered Acme dashboard.

If any of those are still fuzzy, re-read §5 and §6 before moving to doc 01.

---

**Next:** [`01-tenant-resolution.md`](./01-tenant-resolution.md) — how the URL becomes "this is Acme."
