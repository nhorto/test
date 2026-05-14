# 00 — Start Here: The Big Picture and a Vocabulary Primer

> **Read this first.** This is part 1 of a beginner-friendly series that re-explains the patterns from `02-multi-tenant-config-ui.md` from the ground up, reframed for our new architecture: **a Tauri desktop app, installed on each user's machine, that talks live to the customer's database.** Every term is defined before it's used. By the end of this doc you should have a mental model of what we're trying to build and the words to talk about it.

> **What changed from the old plan.** Earlier drafts assumed we'd host a web app on Cloudflare with subdomains like `acme.app.example.com` and a nightly pipeline writing JSON snapshots to edge storage. We're not doing that anymore. The new plan is: **a desktop app built with Tauri** that the customer's employees install on their own computers; the dashboard pulls fresh data from the customer's database every time you open a module. The "multi-tenant" and "config-driven UI" ideas survive — they're just achieved differently. This doc series replaces every Cloudflare-specific concept with the Tauri-equivalent and explains it from scratch.

---

## 1. What we have today

You have one dashboard. It's a React app — a web app written in JavaScript that renders the UI in a browser. Today, once a night, a pipeline (Python + a C# .NET 8 binary) runs on a Windows machine, hits the customer's database and API, and writes the results to a folder called `app/public/data/`. That folder contains 17 small JSON files — about **1.6 MB total** — and the React app reads those JSONs at runtime to render the 7 panels (Estimating, Production Control, Project Management, Time, Inspections, Purchasing, Inventory).

Important properties of today's setup:

- **One customer.** There is no concept of "which customer is looking at this." There's just *the* dashboard.
- **Static files.** When a user opens the app in their browser, they get the HTML and the JSON files. There's no server doing anything custom for them.
- **Same view for everyone.** All 7 panels and all ~80 metrics show the same way. You can't hide a panel for one customer and show it for another.
- **Data is a day old.** Whatever the nightly pipeline wrote at 2am is what the dashboard shows all day. If something changed in the database at 9am, you won't see it until tomorrow.

That's where you are. Everything below is about getting from that to where you want to be.

---

## 2. What you want

You want this exact app to serve **100–200 different fab shops**, each running their own copy on their own computers. And you want to be able to say things like:

- "Acme doesn't pay for Inspections — hide that whole panel for them."
- "BigShop wants to see the *Monthly Hours* metric instead of *Weekly Hours* in the Time panel — swap it for them."
- "Brian's Beams gets all 7 panels but with one extra Estimating tile we built just for them."

…**without writing a separate copy of the app for each customer.** That's the dream. One codebase, many customers, each seeing their own customized version.

You also want **live data**. When someone opens the Time panel, they should see the *current* numbers from the database, not last night's snapshot. No more 24-hour delay.

And — because every employee at a fab shop is going to install this on their own laptop — you want **one installer** that any of those 100–200 fab shops can run, and the app should "know" which fab shop it belongs to without you building a custom installer per customer.

That dream has three halves (yes, three halves — language is hard), and they're easier to understand if you separate them:

**Half 1 — Multi-tenancy on the desktop:** how do you make ONE installer serve MANY customers, with each install knowing which customer it's for and seeing only that customer's data?

**Half 2 — Config-driven UI:** how do you customize WHAT each customer sees without writing custom code per customer?

**Half 3 — Live data instead of nightly snapshots:** how does the desktop app reach the customer's database from each employee's laptop, safely?

The whole rest of this docs series is about those three things. Part 1 (this doc) gives you the vocabulary. The numbered docs after this build the actual machinery.

---

## 3. What "multi-tenancy" actually means (in a desktop world)

A **tenant** is SaaS-speak for "one of your customers." It comes from the apartment building analogy: one building (your app), many tenants (your customers), each in their own apartment (their data and view).

**Multi-tenancy** traditionally means: your app is built so that *one running instance* of it serves *many tenants at once*, each kept walled off from the others. That's the web version. In a *desktop* world it's a little different. Every customer has their own installs of the same app, but it's still the same binary, the same codebase, the same updates — and the app figures out, at runtime, which customer it's for and behaves accordingly.

So "multi-tenant desktop app" in our case means three things at once:

1. **One codebase.** We write the app once. There is not an `acme` branch and a `bigshop` branch.
2. **One installer.** We ship a single `.msi` (Windows) / `.dmg` (Mac) / `.AppImage` (Linux). The same installer goes to every fab shop.
3. **Per-tenant behavior at runtime.** The app, once installed, asks "who am I for?" and then loads that tenant's config — which determines which panels show, which metrics show, and where to fetch the data from.

The opposite of all this is called **single-tenancy**: write a custom build per customer. Possible, but painful — 200 customers means 200 builds to maintain. We're avoiding that.

Here's the picture:

```
SINGLE-TENANT DESKTOP (don't do this for 200 customers):
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│ acme-installer.msi  │  │ bigshop-installer   │  │ cora-installer.msi  │   ...
│ (custom build)      │  │ (custom build)      │  │ (custom build)      │
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘

MULTI-TENANT DESKTOP (one app, many customers):
                    ┌──────────────────────┐
                    │  dashboard-x.y.z.msi │
                    │  (one installer for  │
                    │  everyone)           │
                    └──────────────────────┘
                                ↓ installed by employees at...
                  ↗     ↑      ↑       ↖
              Acme   BigShop   Cora   ...  Zeta
                  ↑      ↑      ↑          ↑
              (each install carries a license key
               that tells it which tenant it's for)
```

The key skill of multi-tenancy is: **whenever the app does anything, it knows which tenant it's doing it for.** Read data? Read Acme's data, not everyone's. Render the dashboard? Render Acme's modules, not the default. Save settings? Save them under Acme.

That "knowing which tenant" thing is called **tenant resolution**, and on the web it's done by reading the URL subdomain. On the desktop, there's no URL — so we do it with a **license key** that the user enters on first launch. It's covered in detail in the next doc (`01-tenant-resolution.md`).

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
  else if (tenant === 'bigshop') {
    render <Estimating withExtraTile />
    render <ProductionControl />
    render <Inspections />
    ...
  }
  // 200 of these. Maintain forever. Cry.

WITH config-driven UI (the way we're going):

  const config = loadConfigForThisTenant();  // a JSON file specific to this tenant
  for (const moduleName of config.enabledModules) {
    for (const metric of resolveMetrics(moduleName, config)) {
      render <MetricSlot id={metric} />
    }
  }
  // ONE rendering loop. Configs decide what shows.
```

A config-driven UI moves the *what shows* decisions out of code and into a per-tenant JSON file. To customize Acme, you don't change React code — you change `acme.json`.

In the desktop world, where does this JSON come from? Two options, both fine, and we'll cover both:

- **Shipped with the app.** The codebase contains a `tenants/` folder with `acme.json`, `bigshop.json`, etc. When the app runs, it looks up "I'm Acme" → loads `tenants/acme.json` from inside its own bundle.
- **Fetched at startup.** The app phones home to a small server we run, says "I'm Acme, give me my config," and gets back JSON. Slightly more flexible (you can change a config without shipping an update) but adds a server dependency.

We'll start with "shipped with the app" because it's simpler and works offline. Doc 02 explains when and how to migrate.

The thing that makes any of this possible — the trick that lets the React code render different metrics for different tenants without an `if` ladder — is called the **registry pattern**, which is in doc `03-registry-pattern.md`. That's where the most confusion was in the original doc, so we'll spend the most time on that one.

---

## 5. The vocabulary primer

Here's every weird term you'll see in the rest of these docs, defined in plain English. Skim now, refer back as you read the other docs.

### Desktop / Tauri

- **Tauri** — a framework for building desktop apps using web technology (HTML, CSS, JavaScript/TypeScript) for the UI, and Rust for the "native" stuff (file access, OS-level features, talking to the operating system). Think of it as: "take my React app, wrap it in a real desktop window, give it the ability to read local files and call the OS." It's like Electron, but uses the operating system's built-in browser engine instead of bundling Chromium — which makes the installer **tiny** (a few MB instead of 80+ MB).

- **Webview** — the native browser engine that displays the UI inside a desktop app. On Windows it's WebView2 (Microsoft Edge's engine, comes pre-installed on Windows 10/11). On Mac it's WKWebView (Safari's engine). On Linux it's WebKitGTK. From your perspective, the webview is "the thing that runs the React app inside the desktop window."

- **Rust** — a programming language. You don't need to learn it deeply. Tauri's "native" side (the part that's not React) is written in Rust. We will write a small amount of Rust to handle things like reading the license key, calling the data gateway, and exposing those capabilities to the React UI.

- **Tauri command** — a Rust function the React UI can call. Example: from React, `await invoke('get_tenant_id')` calls a Rust function named `get_tenant_id`, which returns whatever it wants. This is how the UI safely asks the native side to do things it can't do on its own (read files, make HTTP requests to authenticated endpoints, etc.).

- **Sidecar** — a separate program that Tauri ships alongside the main app and can start, stop, and talk to. Example: if we keep the C# .NET binary, Tauri can launch it as a sidecar and call into it. Or a Python script. Or anything. Tauri just spawns the process and pipes commands and data in and out.

- **Installer** — the `.msi` file (Windows), `.dmg` file (Mac), or `.AppImage`/`.deb`/`.rpm` (Linux) that the user double-clicks to install your app. Tauri builds one per target platform.

- **Code signing** — a cryptographic stamp on your installer that proves it came from you and hasn't been tampered with. Without it, Windows pops up a scary "this app is from an unknown publisher" warning, and Mac flat-out refuses to run it. You buy a "code signing certificate" (Windows: ~$200/year; Mac: $99/year as part of Apple Developer Program) and use it during the build. Covered in doc 12.

- **Auto-updater** — a Tauri feature that, on launch, checks "is there a newer version available?" and if so downloads and installs it (the user gets a "restart to update" prompt). The new version is hosted on a small static endpoint we run. Means you don't have to ask every user to manually re-download installers when you ship a new version.

### Tenants and identity

- **Tenant** — one customer. "Acme" is a tenant. "BigShop" is a tenant. We talk about *the tenant* the way you might talk about *the user* in a normal app, except a tenant is usually a company that has many users inside it.

- **Multi-tenant** — one app, many tenants. The opposite of single-tenant.

- **Tenant slug** — a short, lowercase, no-spaces identifier for a tenant. "acme" not "Acme Corporation". Used as a key everywhere: filenames (`tenants/acme.json`), in the license key, in log lines. Like a username for a company.

- **License key** — a long string the user enters on first launch that proves they're allowed to use the app and tells the app *which tenant they are*. Looks like `ACME-J5N7-8K2P-Q4F9-X1Z3` or, more technically, a **JWT** (see below). The license key is the thing that makes "one installer, many customers" work.

- **JWT** (JSON Web Token) — a format for a signed message. It looks like a long random string but it's actually three base64-encoded chunks separated by dots: `header.payload.signature`. The payload is plain JSON (e.g., `{"tenant": "acme", "expires": "2027-01-01"}`). The signature proves we issued it. The app verifies the signature with a public key baked into the build. If the signature is bad → reject. If it's good → trust the payload. Doc 01 walks through this.

- **Public key / private key** — a pair of cryptographic keys that work together. We keep the private key secret (it lives on one machine you control). We bake the public key into the app's source code. The private key *signs* license keys; the public key *verifies* them. Anyone with the public key can verify, but only someone with the private key can sign. This is how we issue license keys offline without needing a server.

- **Activation** — the first-launch flow where the user pastes their license key, the app verifies it, extracts the tenant slug, loads that tenant's config, and writes everything to a local file so it doesn't have to ask again next launch.

### Data (live, not nightly)

- **Live data** — the new model. Every time a module loads, the app makes a fresh HTTP call to fetch the latest numbers from the customer's database. Compare to the old model: "read a JSON file the pipeline wrote last night."

- **Customer database** — the database that holds the customer's actual business data. Most of our customers run an ERP system (something like a manufacturing-shop accounting/inventory system) on a Windows server in their office. The database is usually SQL Server or similar. They run it, not us; we just read from it.

- **Data gateway** — a small program that runs on **one machine inside the customer's network**, holds the database credentials, knows how to query the customer's database, and exposes some HTTP endpoints like `GET /metrics/estimating/win-rate`. All the employee desktop apps in the fab shop call the gateway; the gateway calls the database. We do this because we don't want database passwords on every employee's laptop. The gateway is also where the C# .NET binary (or its Python replacement) lives — it's the "smart" piece that knows how to compute each metric.

- **ERP** — Enterprise Resource Planning. A category of business software. Manufacturing shops use ERPs to track jobs, parts, time, purchasing, etc. The ERP usually has a database underneath it. Our app reads from that database (via the gateway) to compute the metrics. We don't write to the ERP — we just read.

- **Localhost** — the machine you're sitting at. The address `http://localhost:8080` means "talk to a program running on this same machine, on port 8080." On the desktop, the React app inside Tauri often talks to a service on localhost (when developing). In production, it'll talk to the gateway at the gateway's address on the LAN (e.g., `http://gateway.acme.local:8080` or `http://192.168.1.50:8080`).

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

- **Lazy loading** — loading code only when it's actually needed. By default, when a user opens your app, the webview loads ALL the JavaScript in one big file. Lazy loading splits it: the webview only loads the JS for the Time panel when the user opens the Time panel. Less to read off disk, faster startup.

- **Code splitting** — basically a synonym for lazy loading. The build tool (Vite) splits your one big JS file into smaller "chunks" that can be loaded on demand.

- **`React.lazy`** — React's built-in API for lazy loading a component. Looks like: `const Time = React.lazy(() => import('./Time'))`. This says "don't bundle Time with the main app; load it the first time we render `<Time />`."

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

Here's what we're building. Imagine an employee at Acme just got the installer link from their IT person. Let's walk through every step from "download" to "live dashboard."

```
   ┌──────────────────────────────────────────────────┐
   │  STEP 1 — First-time install                     │
   │                                                  │
   │  Employee downloads dashboard-1.2.3.msi from     │
   │  our update server (the same .msi everyone uses).│
   │  Double-clicks it. Tauri installs the app.       │
   └──────────────────────────────────────────────────┘
                            │
                            ▼
   ┌──────────────────────────────────────────────────┐
   │  STEP 2 — First launch / activation              │
   │                                                  │
   │  App opens to an "Enter your license key" screen.│
   │  Employee pastes: ACME-J5N7-8K2P-Q4F9-X1Z3       │
   │  (which IT sent them, originally issued by us).  │
   │                                                  │
   │  ┌────────────────────────────────────────────┐  │
   │  │ Rust side (Tauri command verify_license):  │  │
   │  │  - Decode the JWT                          │  │
   │  │  - Verify signature with baked-in public   │  │
   │  │    key                                     │  │
   │  │  - Extract payload: { tenant: "acme",      │  │
   │  │      gateway_url: "http://10.0.5.20:8080" }│  │
   │  │  - Save license + tenant slug to a local   │  │
   │  │    config file under the OS app-data       │  │
   │  │    directory.                              │  │
   │  └────────────────────────────────────────────┘  │
   └──────────────────────────────────────────────────┘
                            │
                            ▼
   ┌──────────────────────────────────────────────────┐
   │  STEP 3 — Load the tenant config                 │
   │                                                  │
   │  Rust reads `tenants/acme.json` from inside the  │
   │  app bundle. (Or, optionally, fetches it from a  │
   │  server.) Hands it to the React UI.              │
   │                                                  │
   │  Acme's config (simplified) says:                │
   │   {                                              │
   │     "enabledModules": ["estimating",             │
   │                        "production-control",     │
   │                        "time", "purchasing"],    │
   │     "metricOverrides": { ... }                   │
   │   }                                              │
   └──────────────────────────────────────────────────┘
                            │
                            ▼
   ┌──────────────────────────────────────────────────┐
   │  STEP 4 — Render the dashboard                   │
   │                                                  │
   │  React app boots inside Tauri's webview.         │
   │   - For each module in config.enabledModules:    │
   │      - Lazy-load that module's code              │
   │      - Compute the metrics to show (defaults +   │
   │        overrides from config)                    │
   │      - For each metric, render <MetricSlot>      │
   │   - <MetricSlot> looks up the component in the   │
   │     registry by ID and renders it.               │
   └──────────────────────────────────────────────────┘
                            │
                            ▼
   ┌──────────────────────────────────────────────────┐
   │  STEP 5 — Live data fetch (per metric)           │
   │                                                  │
   │  Each metric component fetches its own data:     │
   │                                                  │
   │   React: await invoke('fetch_metric',            │
   │           { id: 'estimating.win-rate' })         │
   │                                                  │
   │   Rust:  HTTP GET                                │
   │           http://10.0.5.20:8080/metrics/         │
   │           estimating/win-rate                    │
   │                                                  │
   │   Gateway: queries Acme's database, runs the     │
   │           computation, returns JSON.             │
   │                                                  │
   │   Rust → React → renders the number. Done.       │
   └──────────────────────────────────────────────────┘
```

A few things worth highlighting in that diagram:

- **There is no "our server" in the request path for data.** Every data fetch goes from the employee's laptop to a gateway running inside Acme's own network. We don't see their data. We don't hold their database password. (This is good for compliance and for them trusting us.)

- **The license key is the one place we centrally control anything.** It's signed by us, and it carries the tenant slug and the gateway URL. If we revoke a customer (they stop paying), we don't have to flip a switch — their existing key keeps working until expiry, and they can't install new copies because no new keys.

- **Updates flow through us.** When we ship a new version of the app, the auto-updater downloads it from our update server. The update server is small — it just hosts signed binaries. It does NOT see customer data; it only ever sees "give me the latest installer."

Re-read the diagram now that you have the vocabulary. Step 2 is "tenant resolution" (doc 01). Steps 3–4 are "config-driven UI" (docs 02 + 03). Step 5 is "live data fetch" (doc 09), and the gateway it talks to is the subject of docs 06 and 07.

---

## 7. Why we're doing it this way (and not other ways)

A few obvious-sounding alternatives, and why they're worse:

- **"Just build a separate installer per tenant."** That's single-tenant. We have to compile, sign, and ship a different binary per customer. New release = 200 builds. New customer = a build before they can install. We avoid all of that by making the same installer ask "who am I?" at runtime via the license key.

- **"Just check a config file inside React and decide what to show."** You could put `tenant.json` next to the app and have React read it. Fine for one or two tenants, but then anyone can edit `tenant.json` on their laptop and pretend to be a different tenant. The license-key + signature pattern stops that: the *signed* token proves the tenant, and only we can sign one.

- **"Put DB credentials directly in the desktop app."** Tempting because then you skip the gateway. Don't do it. If 30 employees at Acme have the app, that's 30 copies of Acme's database password sitting on 30 laptops. One stolen laptop = compromised credentials. The gateway holds creds in *one* place, and the laptops only get to call HTTP endpoints — they never see the database directly.

- **"Run a cloud gateway we host for all customers."** Means each customer's database has to be reachable from the public internet, or via VPN/tunnel back to us. Most fab shops won't open that hole. A local gateway inside *their* network has none of that problem.

- **"Keep the nightly pipeline; just port it to write to each tenant's machine."** You can, but then everything is still 24 hours stale, and you're managing a big pipeline that you mostly don't need. Live fetch from the gateway is simpler operationally for small data volumes (which is what dashboards are).

- **"Make every layout decision a config option."** The classic trap. Adding `branding`, `colors`, `roles`, `layout grid` to config quadruples your testing surface for benefits zero customers asked for. The principle: **you only make X configurable when at least 3 tenants actually need different X.** Until then, it's hardcoded. Doc 04's anti-patterns section goes deeper.

---

## 8. What's in the rest of the series

| Doc | What it explains |
|---|---|
| **00 (this doc)** | Big picture + vocabulary. You're here. |
| **01 — Tenant resolution** | How the app figures out "I am for Acme." License keys, JWTs, signing, first-launch activation, and what happens if the user enters a bad/expired key. |
| **02 — Config: schema and storage** | What's in a tenant config. What Zod is and why it's there. Where the configs live (shipped with the app vs. fetched from a server, when to graduate). Schema versioning. |
| **03 — The registry pattern** | The big one. The pattern that makes config-driven UI work. Modules registry, metric registry, every TypeScript trick (`as const`, `satisfies`, derived unions) explained with examples. The `<MetricSlot>` component walked through line by line. Lazy loading and Suspense. |
| **04 — Flags, anti-patterns, full walkthrough** | When config and when feature flag. The 10 anti-patterns to avoid, each in plain language. Then a complete worked example: take Acme's config and trace exactly what renders. |
| **05 — Tauri architecture** | Tauri's parts (webview, Rust backend, sidecars), how the React UI talks to Rust, the gateway design with tradeoffs (direct DB / local gateway / cloud gateway), where each piece lives, and how data flows end to end. |
| **06 — Customer data: how it gets in (live)** | The customer's database, the ERP shape, what credentials look like, how the gateway connects, and what "live fetch" means in practice. |
| **07 — The pipeline (and why it goes away)** | What the old nightly pipeline did, why we're killing it, where its logic moves to in the new world, and a careful discussion of what to do with the C# .NET binary (rewrite in Python? keep as a Tauri or gateway sidecar? rewrite in Rust? pros and cons). |
| **08 — Data isolation** | In the new world, each install is single-tenant, so most cross-tenant leak risks disappear. But not all. We cover what *can* still leak (license keys, gateway URLs, cached data) and how to prevent it. |
| **09 — Data fetching** | The data fetch path from React → Tauri command → Rust HTTP client → gateway → database → back. Caching, retries, offline behavior, and what to show in the UI while waiting. |
| **10 — Auth** | How license keys authenticate "this install belongs to this tenant," and (optional) how to add per-user auth on top for individual employees. |
| **11 — Tenant lifecycle** | Onboarding a new fab shop: issuing their license key, deploying their gateway, shipping them their config. Updating an existing tenant. Offboarding. |
| **12 — Local dev and deploy** | How to run Tauri in dev mode. Building installers for Windows/Mac/Linux. Code signing (the painful part). Distributing installers. Setting up the auto-updater. |
| **13 — CI/CD** | Automated builds for the three OSes, signing in CI, publishing update manifests. |
| **14 — Observability and cost** | What you actually pay for in the new world (mostly: signing certs, update hosting). How to know if a deployed app is failing without seeing customer data. Error reporting patterns. |

---

## 9. How to read these docs

Read in order: 00 → 01 → 02 → 03 → 04 → 05 → … They build on each other. Doc 03 will be confusing if you skipped 02 because we'll be referring to the config schema we defined there. Doc 09 references the gateway from doc 05.

Each doc starts with a "what you'll know by the end" summary. If you find yourself thinking "wait, what's a webview?" — flip back here to §5 vocabulary. Don't push through confusion; the docs aren't going anywhere.

If something is still unclear after reading slowly, that's a signal to me that the doc isn't beginner-friendly enough — flag it and I'll rewrite that section.

---

## 10. By the end of this doc you should know

- What a **tenant** is and what **multi-tenancy on the desktop** means.
- Why we're using **Tauri** (small installer, real native app, can talk to local services and the OS).
- What a **webview** is and where it fits.
- What a **license key** is and why it's how we identify the tenant on the desktop.
- What **live data** means and why we're killing the nightly pipeline.
- What a **data gateway** is and why it sits inside the customer's network.
- What **module** and **metric** mean in our app.
- What a **registry** is, conceptually (a phonebook).
- What **lazy loading** means.
- What **Zod** does (validate that JSON matches a shape).
- What a **config-driven UI** is and why we want one.
- The end-to-end flow from "download installer" to "live Acme dashboard."

If any of those are still fuzzy, re-read §5 and §6 before moving to doc 01.

---

**Next:** [`01-tenant-resolution.md`](./01-tenant-resolution.md) — how a license key becomes "this is Acme."
