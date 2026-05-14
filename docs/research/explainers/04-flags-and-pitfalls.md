# 04 — Flags vs Config, 10 Anti-Patterns, and a Full Walkthrough

> **Prerequisites:** read 00 → 01 → 02 → 03 first. By now you should know what a tenant is, how the app activates with a license key, what's in a config, and how the registry pattern lets the config decide what renders.
>
> **By the end of this doc you will know:** when a behavior should be a *config field* vs a *feature flag*, why we don't need a flag service yet. The 10 most common mistakes in config-driven UIs and what to do instead. And finally, a complete trace of Acme's installed app — from launch to rendered pixels — with every line of code annotated.

This is the wrap-up doc for the "config-driven UI" half of the series. After this you'll be ready for docs 05+, which are about the architecture *around* the UI: Tauri internals, the data gateway, the database, deployment, etc.

---

## 1. Feature flags vs config — the rule

A **feature flag** is a switch in your code that turns a feature on or off based on some rule (per user, per tenant, per percentage, per date). The classic use case: "roll out the new dashboard layout to 10% of tenants this week and 100% next week if nothing breaks."

A **config** (in the multi-tenant sense we've been building) is a per-tenant settings file that defines what that tenant *is*: which modules they have, which metrics they see, which thresholds apply to them.

They look similar — both are "a setting that varies by some criterion." But they answer different questions:

| Question | Tool |
|---|---|
| "What does Acme's dashboard look like, persistently?" | **Config** |
| "Should we ship this risky new feature to 5% of tenants this week?" | **Flag** |
| "Acme is on our pro tier; show them the advanced report." | **Config** (tier is part of who Acme IS) |
| "Show new chart layout to internal QA users until next Friday." | **Flag** (temporary) |
| "BigShop hides the Inspections module." | **Config** |
| "Toggle the big-red-button experiment ON for a single tester." | **Flag** |

Rule of thumb:

- **Config** = the tenant's persistent shape. Onboarding-driven. Reviewed. Stable.
- **Flag** = a temporary deviation. Experiment-driven. Often unreviewed. Expected to come and go.

The first is *what they paid for*. The second is *something we're testing*. Conflating them is one of the most common anti-patterns in this space (it's #9 below).

---

## 2. Why we don't need a flag service yet

There are great commercial flag services — [LaunchDarkly](https://launchdarkly.com/), [GrowthBook](https://www.growthbook.io/), [Unleash](https://www.getunleash.io/), and the open-source [OpenFeature SDK](https://openfeature.dev/) is a vendor-neutral abstraction over them.

For 5–200 tenants and a small team:

- LaunchDarkly is the gold standard but starts around $6k/year. Overkill until you have 5+ engineers running parallel experiments.
- GrowthBook and Unleash are open-source. You self-host. Pay only infra cost. Better fit if you actually need experiments.
- OpenFeature is just an interface — you still need a backing provider.

Desktop apps have an extra wrinkle here: a flag service usually wants an HTTP call to check the flag. From a desktop app, that's a network round trip on every launch (or you cache aggressively and accept that flag flips don't propagate instantly). Until you actually have experiments worth that cost, **don't bring in a flag service.**

A simple `settings.flags` field in `TenantConfig` covers the small cases:

```ts
type TenantConfig = {
  // ...everything we already have...
  settings?: {
    flags?: Record<string, boolean>;
    // other ad-hoc settings
  };
};
```

Acme's config might have:

```jsonc
{
  "settings": {
    "flags": {
      "newInspectionsLayout": true,
      "experimentalChartLib": false
    }
  }
}
```

In code:

```ts
const showNewLayout = tenantConfig.settings?.flags?.newInspectionsLayout ?? false;

if (showNewLayout) {
  // render new
} else {
  // render old
}
```

That's a flag. It's enough. When you ever need true experimentation (random %, server-side bucketing, audit trails, kill switches), wire up OpenFeature backed by GrowthBook. The call site in your code shouldn't change much — you swap the source of `showNewLayout` from `tenantConfig.settings?.flags?` to a flag client, and OpenFeature handles the rest.

**TL;DR:** until you actually need to randomize tenants/users into experiments, `settings.flags` in the config is fine. Don't over-build.

---

## 3. The 10 anti-patterns

Each one has bitten teams in the wild. Each is easy to fall into and avoidable if you know the trap.

### 3.1 "Everything is a config"

**The trap.** You start with "modules and metrics are configurable." A customer asks for a custom logo. You add `branding`. A customer asks for different colors. You add `theme`. A customer asks for layout reordering. You add `layout`. Now you have a configuration surface as big as the app itself, and every new feature has to be tested in the cross-product of all configurations.

**What to do instead.** Resist. The brief said branding/colors/layout aren't configurable. The principle is the **3-tenant rule**: only make X configurable when at least 3 tenants need different X. Until then, X is hardcoded. You can always make something configurable later; it's much harder to take a knob away.

### 3.2 Turing-complete config

**The trap.** Your config grows a `condition: { if: "tenant.tier === 'pro'", then: ..., else: ... }` field. Then you add expressions, then function calls. Eventually you've reinvented JavaScript, badly, without a debugger.

**What to do instead.** If your config wants to express logic, write code. Configs should be data — JSON values, not JSON-encoded programs. If you find yourself wanting `if/else` in a config, the answer is "add a typed field for the actual decision the config is trying to encode."

### 3.3 Runtime config that should be build-time

**The trap.** You read "which 7 modules exist in this app" from a server every launch. But "what modules exist" never varies per launch — only per release. You've made a build-time decision a runtime cost for no benefit. Worse: a network outage now means the app doesn't know what modules exist.

**What to do instead.** The registry IS the source of truth for "what exists." It's compiled into the app. Configs only SELECT from the registry. Build-time things stay build-time. Runtime things — like "which subset Acme sees" — stay runtime.

### 3.4 No schema, no validation

**The trap.** Configs are JSON, you parse them with `JSON.parse`, you trust the result. A typo in `enabeledModules` (with extra `e`) sails through. Tomorrow's customer email: "Acme's dashboard is blank."

**What to do instead.** Always validate at boundaries. App loads bundled config → `TenantConfigSchema.parse`. CI reads from repo → `TenantConfigSchema.parse`. Two places, same schema. A typo can't survive both.

### 3.5 Schema with no version

**The trap.** Configs have no `schemaVersion`. You change the shape (split a field, rename one). Now you have to write a one-time migration script that runs over 200 tenants — except every tenant is on their own laptop running their own version of the app. You can't run a migration "everywhere" because there is no everywhere.

**What to do instead.** `schemaVersion: 1` from day one. When you bump to v2, write a tiny migration function (`v1 → v2`) and have the app apply it on load. Existing bundled configs keep working without a global migration. (This anti-pattern is *worse* on desktop than web — there is no central database to migrate.)

### 3.6 DB-stored IDs not enforced in code

**The trap.** Configs store metric IDs as plain strings, but the code uses TypeScript types from a registry. The two drift over time. A renamed metric in code doesn't update configs in long-running deployments. Some tenants silently lose a metric.

**What to do instead.** Derive the Zod enum from the registry's keys (doc 03 §8 link 3). The same source of truth feeds the TS type AND the runtime validator. A renamed metric is a parse error on app startup.

### 3.7 Lazy-loading per metric

**The trap.** "Code-splitting is good" → "let's split every component" → 80 chunks → 80 parse/eval cycles on first dashboard view → slow open.

**What to do instead.** Lazy by **module**, eager by metric within a module. Most apps have a small number of natural lazy boundaries (panel, route, modal). 7 lazy chunks is fine. 80 is not.

### 3.8 Building infrastructure before it's needed

**The trap.** You set up a config server, an admin UI, a database, and CI publishing from day one. You spend two weeks on it. Meanwhile you have 4 tenants and you've never used the admin UI; you onboard them all manually anyway.

**What to do instead.** Bundle configs in the app first. Migrate to a config server when manual onboarding becomes painful. Onboarding 5 tenants by editing JSON files and merging PRs takes 5 minutes per tenant. Onboarding 50 tenants that way is genuinely annoying — that's when you migrate (doc 02 §6.2).

### 3.9 Feature-flagging tenant shape

**The trap.** A new customer asks for the Time module hidden. You go into your flag service and add `acme:time:hidden: true`. Now "what does Acme have" is split across config (some things) and flags (other things).

**What to do instead.** Tenant shape goes in config. Period. Flags are for *temporary* deviations. If you flag "Acme hides Time" and forget about it, six months later you have no audit trail of why Acme has a different shape.

### 3.10 Editorless config

**The trap.** Devs hand-edit JSON files. Devs typo. Bad config ships in the installer. Customers reinstall, problem persists. (Usually right before a long weekend.)

**What to do instead.** Two things. First, validate in CI (`npm run validate:tenants`) — a typo fails the build, so the installer never gets produced. Second, eventually, build a small admin UI that produces correctly-shaped config (or use a JSON schema editor like [react-jsonschema-form](https://github.com/rjsf-team/react-jsonschema-form) feeding from a Zod-derived JSON Schema). The CI validation is the day-one win; the admin UI is a later luxury.

---

## 4. Putting it all together — the full Acme walkthrough

Here's a complete trace of what happens when an employee at Acme opens the dashboard. Every step references a doc in the series; if you want to dig in, follow the link.

### Step 0 — The static state (the repo)

```
dashboard/
├── src/                              ← React app
│   ├── App.tsx
│   ├── ActivationScreen.tsx
│   ├── components/MetricSlot.tsx
│   ├── registry/
│   │   ├── metrics.ts                ← all 80 metric IDs as as-const-satisfies
│   │   ├── modules.ts                ← all 7 module IDs
│   │   ├── defaults.ts               ← MODULE_DEFAULTS
│   │   └── resolve.ts                ← resolveModuleMetrics
│   ├── schemas/tenantConfig.ts       ← Zod schema for TenantConfig
│   ├── tenants/
│   │   ├── acme.json                 ← Acme's bundled config
│   │   ├── bigshop.json
│   │   └── ...
│   └── main.tsx
├── src-tauri/                        ← Rust / Tauri side
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands.rs               ← Tauri commands (activate, fetch_metric, ...)
│   │   └── keys/
│   │       └── public.bin            ← our public key, baked in
│   └── tauri.conf.json
└── tools/
    └── sign-license.ts               ← script we run to mint license keys
```

`src/tenants/acme.json`:

```jsonc
{
  "schemaVersion": 1,
  "tenantId": "tnt_01HZX3K2A8N1B...",
  "slug": "acme",
  "enabledModules": [
    "estimating", "productionControl", "projectManagement",
    "time", "purchasing", "inventory"
  ],
  "moduleOverrides": {
    "time": {
      "swapMetrics": [
        { "remove": "time.weekly-hours", "add": "time.monthly-hours" }
      ]
    },
    "estimating": {
      "addMetrics": ["estimating.pipeline-coverage"]
    }
  }
}
```

`MODULE_DEFAULTS.time` is `['time.actual-hours', 'time.weekly-hours', 'time.coverage']`.

`MODULE_DEFAULTS.estimating` is `['estimating.win-rate', 'estimating.bid-velocity']`.

### Step 1 — Acme employee installs the app and runs it for the first time

IT emails them a download link for `dashboard-1.2.3-x64.msi` and the license key `eyJhbGciOi…`. They double-click the installer. Tauri installs. App icon appears on the desktop. They open it.

(Doc 12 covers installer build and distribution; doc 01 covers what they see now.)

### Step 2 — First-launch activation screen

`src/main.tsx` mounts `<App />`. `App.tsx` asks Rust: "Am I already activated?"

```ts
const tenant = await invoke<string | null>('get_activated_tenant');
```

No `activation.json` on disk yet, so Rust returns `null`. React renders `<ActivationScreen />`. The user pastes the JWT and clicks Activate.

(Doc 01 §5.1.)

### Step 3 — Rust verifies the license key

`activate` (Rust) splits the JWT into header/payload/signature, verifies the signature using the public key baked into the binary, parses the payload as JSON:

```json
{
  "tenant": "acme",
  "gateway_url": "http://10.0.5.20:8080",
  "exp": 1799999999
}
```

Checks `exp` > now. Writes `activation.json` to the OS app-data directory. Returns the tenant slug to React.

(Doc 01 §5.2.)

React calls `window.location.reload()` so the app restarts cleanly with the activated state.

### Step 4 — Boot: tenant slug + bundled config

After reload, `get_activated_tenant` now returns `"acme"`. React calls `loadTenantConfig` which:

1. Imports `src/tenants/acme.json` from the bundled assets (the file lives inside the app's webview assets, since we picked Option A in doc 02 §6).
2. Validates it with `TenantConfigSchema.parse(raw)` — passes.
3. Returns the typed config.

(Doc 02 §7.)

If `acme.json` had been malformed (e.g., a typo from the developer), this is where the app would hard-fail with a clear error message. CI should have caught it before the installer was ever built (doc 02 §8), but the parse is a belt-and-suspenders second gate.

### Step 5 — App renders, registry takes over

```tsx
// src/App.tsx (simplified)
export default function App() {
  return (
    <Shell tenant={tenantConfig}>
      {tenantConfig.enabledModules.map((moduleId) => {
        const ModuleComponent = MODULES[moduleId].Component;
        const metricIds = resolveModuleMetrics(moduleId, tenantConfig);
        return (
          <Panel key={moduleId} title={MODULES[moduleId].label}>
            <ModuleComponent>
              {metricIds.map(id => (
                <MetricSlot key={id} id={id} tenantId={tenantConfig.tenantId} />
              ))}
            </ModuleComponent>
          </Panel>
        );
      })}
    </Shell>
  );
}
```

`tenantConfig.enabledModules` for Acme is:

```
['estimating', 'productionControl', 'projectManagement', 'time', 'purchasing', 'inventory']
```

Note `inspections` is absent — Acme doesn't have it. The `.map` never reaches it, so it doesn't render at all. (Doc 03 §5.)

### Step 6 — `resolveModuleMetrics` for `time`

(Doc 03 §5.2.)

Inputs:
- `module = 'time'`
- `cfg.enabledModules` includes `'time'` ✓ (proceed)
- `defaults = ['time.actual-hours', 'time.weekly-hours', 'time.coverage']`
- `ov = { swapMetrics: [{ remove: 'time.weekly-hours', add: 'time.monthly-hours' }] }`

Walk:
- removeMetrics? None.
- next = defaults = `['time.actual-hours', 'time.weekly-hours', 'time.coverage']`.
- swapMetrics loop: find `time.weekly-hours` at index 1, replace with `time.monthly-hours`. next = `['time.actual-hours', 'time.monthly-hours', 'time.coverage']`.
- addMetrics? None.

Returns: `['time.actual-hours', 'time.monthly-hours', 'time.coverage']`.

### Step 7 — `resolveModuleMetrics` for `estimating`

Inputs:
- `defaults = ['estimating.win-rate', 'estimating.bid-velocity']`
- `ov = { addMetrics: ['estimating.pipeline-coverage'] }`

Walk:
- removeMetrics? None.
- next = defaults.
- swapMetrics? None.
- addMetrics: append `'estimating.pipeline-coverage'`. next = `['estimating.win-rate', 'estimating.bid-velocity', 'estimating.pipeline-coverage']`.

Returns those three IDs.

### Step 8 — `<MetricSlot>` renders each metric

For each metric ID, `<MetricSlot>` looks up the lazy import in the registry and renders it inside `<Suspense>`:

```tsx
export function MetricSlot({ id, ...rest }: { id: MetricId } & MetricProps) {
  const Cmp = useMemo(() => getLazy(id), [id]);
  return (
    <Suspense fallback={<div className="metric-skeleton" />}>
      <Cmp {...rest} />
    </Suspense>
  );
}
```

(Doc 03 §7.6.)

For `time.monthly-hours`:
- `getLazy('time.monthly-hours')` returns a `React.lazy(() => import(...))` wrapper, cached so subsequent renders reuse it.
- Suspense shows a skeleton.
- The webview loads the JS chunk for the Time module from the installer's embedded assets.
- Once parsed and evaluated, React renders the actual `MonthlyHours` component, replacing the skeleton.

### Step 9 — Each metric component fetches live data

This is the part that changed the most from the old plan. Instead of reading a static JSON file written by a nightly pipeline, each metric component asks Rust to fetch live data from the customer's data gateway:

```tsx
function MonthlyHours({ tenantId }) {
  const { data, isLoading, error } = useMetricData('time.monthly-hours');
  if (isLoading) return <Skeleton />;
  if (error) return <ErrorTile message={String(error)} />;
  return <Chart data={data.monthly} />;
}
```

`useMetricData` is a hook that calls a Tauri command:

```ts
// useMetricData (simplified)
const data = await invoke<MetricResponse>('fetch_metric', {
  id: 'time.monthly-hours',
});
```

In Rust, `fetch_metric`:
1. Reads `gateway_url` from `activation.json` (Acme's is `http://10.0.5.20:8080`).
2. HTTP GETs `http://10.0.5.20:8080/metrics/time/monthly-hours`.
3. The gateway, running on a small machine inside Acme's network, queries Acme's database, runs the metric computation, returns JSON.
4. Rust passes the JSON back to React, which renders the chart.

(Doc 09 walks through `fetch_metric` end to end; doc 05 explains why the gateway lives inside the customer's network.)

### Step 10 — Acme sees their dashboard

Final result for Acme:

- 6 panels render: Estimating, Production Control, Project Management, Time, Purchasing, Inventory.
- Inspections panel is absent entirely (not rendered, no skeleton, just gone).
- Time panel shows: actual-hours, monthly-hours, coverage.
- Estimating panel shows: win-rate, bid-velocity, pipeline-coverage.
- All other panels show their defaults.
- Every number on screen reflects the database **right now** — not last night's snapshot.

For BigShop (whose config has no overrides), the same React code, same registry, same `<App />` would render: 7 panels with all their default metrics.

For someone with no license key (or an expired one), the app sits on the activation screen and never loads the dashboard.

That's the whole picture, end to end.

---

## 5. What renaming a metric looks like under this architecture

To put it in concrete terms — the kind of change you'd do as a developer.

**Goal:** rename `time.weekly-hours` to `time.weekly-payroll-hours` (because it's been a payroll-aligned metric all along).

**Steps:**

1. Edit `src/panels/time/WeeklyHours.tsx` if you want, or rename the file too. Doesn't matter to the registry.
2. Edit `src/registry/metrics.ts`:
   ```ts
   // before
   'time.weekly-hours': () => import('../panels/time/WeeklyHours'),
   // after
   'time.weekly-payroll-hours': () => import('../panels/time/WeeklyHours'),
   ```
3. Run `npx tsc` (or just save and watch the type-check). Errors:
   - `MODULE_DEFAULTS.time` mentions `'time.weekly-hours'` — TS error.
   - Any TS files that mention it — TS error.
4. Edit `MODULE_DEFAULTS` to use the new name.
5. Run `npm run validate:tenants`. Output:
   - `src/tenants/acme.json` — fails (still has `'time.weekly-hours'` in `swapMetrics.remove`).
   - `src/tenants/bigshop.json` — passes (no override on this metric).
6. Edit `src/tenants/acme.json` to use the new name.
7. Run `npm run validate:tenants` again — passes.
8. Update the gateway too: the metric ID `time.weekly-hours` was a path in the gateway's HTTP routes. Rename `/metrics/time/weekly-hours` to `/metrics/time/weekly-payroll-hours` and deploy the new gateway to every customer (doc 11 covers gateway updates).
9. Commit, push. CI re-runs the validator, builds installers, signs them, publishes update manifests.
10. Customers' auto-updaters pick up the new version on next launch.

The renamed metric is fully migrated. No tenant ever saw a broken state (the gateway transition is the one to coordinate carefully — see doc 11). Three independent gates (TS compiler, Zod, CI) caught everything in the app; the gateway change is a separate but parallel step.

That's the payoff for the type-safety chain in doc 03 §8.

---

## 6. The maturity model (what to add when)

A useful rough roadmap for "what to build at what tenant count":

| # tenants | What you have | What you add next |
|---|---|---|
| 1 (today) | Static JSON, single dashboard, nightly pipeline | Decide to go Tauri + multi-tenant |
| 1–3 | Tauri app + activation flow + bundled configs + registry pattern + gateway | Polish onboarding, write the signing tool |
| 5–10 (MVP) | Above + CI validation + signed installers + auto-updater | First few real customers; iterate on gateway |
| 20–50 | Above + (optional) per-user auth + audit logging on the gateway | Move configs to a small config server, repo still source of truth |
| 50–100 | Above | Build small admin tool for support/ops (issue/revoke keys, edit configs, push gateway updates) |
| 100–200 | Above | Add telemetry + error reporting (doc 14); consider a managed update channel per customer (canary, stable) |
| 200+ | Above | If experiments are now real: OpenFeature + GrowthBook |

The point of the roadmap: don't build for tier N+2. Build for your current tier and the one above it. Premature infrastructure costs more than it saves.

---

## 7. By the end of this doc you should know

- The rule for **config vs feature flag**: persistent shape vs temporary deviation.
- Why we don't need a flag service yet, and what the upgrade path looks like (`settings.flags` → OpenFeature + GrowthBook later).
- The 10 anti-patterns and the principle behind each one.
- The full Acme walkthrough: install → activate → bundled config → registry lookup → resolve overrides → `<MetricSlot>` → lazy chunk → live gateway fetch → rendered metric.
- Concretely what renaming a metric looks like, and which gates catch what.
- A maturity model for what to add at what tenant count.

---

## 8. What's not in this series (yet)

You're now done with the **config-driven UI** half of the docs. The next docs (05–14) cover the **architecture around the UI**:

- **Doc 05 — Tauri architecture.** Webview, Rust backend, sidecars, the gateway, how the pieces fit together.
- **Doc 06 — Customer data ingest.** What the customer's database looks like, how the gateway connects.
- **Doc 07 — The old pipeline goes away.** Why we're killing the nightly batch and what happens to the C# .NET binary.
- **Doc 08 — Data isolation.** What still needs care even though each install is single-tenant.
- **Doc 09 — Data fetching.** The React → Tauri → gateway → database call path.
- **Doc 10 — Auth.** License keys + optional per-user.
- **Doc 11 — Tenant lifecycle.** Onboarding, updating, offboarding a customer.
- **Doc 12 — Local dev and deploy.** Tauri dev mode, building installers, signing them.
- **Doc 13 — CI/CD.** Automated builds for Windows/Mac/Linux.
- **Doc 14 — Observability and cost.** What you pay for, what to monitor.

If everything from docs 00–04 made sense, the rest should be straightforward — they describe a single piece of infrastructure each.

---

> **You're done with the multi-tenant + config-driven UI fundamentals.** When you read code touching `TenantConfig`, the registry, or `<MetricSlot>`, the pattern itself, the vocabulary, the type-safety chain, the storage tradeoffs, and the anti-patterns should all click. If anything doesn't, point at the section and I'll rewrite it.

---

**Next:** [`05-cloudflare-architecture.md`](./05-cloudflare-architecture.md) — the Tauri architecture in detail (yes, the filename still says "cloudflare-architecture" for now — the contents have been replaced with the new world).
