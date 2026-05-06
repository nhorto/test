# 04 — Flags vs Config, 10 Anti-Patterns, and a Full Walkthrough

> **Pre-reqs:** Read 00 → 01 → 02 → 03 first. By now you should know what a tenant is, how the Worker resolves them, what's in a config, and how the registry pattern lets the config decide what renders.
>
> **What you'll know by the end:** When a behavior should be a *config field* vs a *feature flag*, why we don't need a flag service yet. The 10 most common mistakes in config-driven UIs and what to do instead. And finally, a complete trace of Acme's config — from JSON file to rendered pixels — with every line of code annotated.

This is the wrap-up doc. After this you should be able to read the original `02-multi-tenant-config-ui.md` without confusion.

---

## 1. Feature flags vs config — the rule

A **feature flag** is a switch in your code that turns a feature on or off based on some rule (per user, per tenant, per percentage, per date). The classic use case: "roll out the new dashboard layout to 10% of users this week and 100% next week if nothing breaks."

A **config** (in the multi-tenant sense we've been building) is a per-tenant settings file that defines what that tenant *is*: which modules they have, which metrics they see, which thresholds apply to them.

They look similar — both are "a setting that varies by some criterion." But they answer different questions:

| Question | Tool |
|---|---|
| "What does Acme's dashboard look like, persistently?" | **Config** |
| "Should we ship this risky new feature to 5% of tenants this week?" | **Flag** |
| "Acme is on our pro tier; show them the advanced report." | **Config** (tier is part of who Acme IS) |
| "Show new chart layout to internal QA users until next Friday." | **Flag** (temporary) |
| "Bob's Beams hides the Inspections module." | **Config** |
| "Toggle the big-red-button experiment ON for a single user." | **Flag** |

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

We don't need any of them yet. A simple `settings.flags` field in `TenantConfig` covers the small cases:

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

**Tldr:** until you actually need to randomize tenants/users into experiments, `settings.flags` in the config is fine. Don't over-build.

---

## 3. The 10 anti-patterns

Each one has bitten teams in the wild. Each is easy to fall into and avoidable if you know the trap.

### 3.1 "Everything is a config"

**The trap:** You start with "modules and metrics are configurable." A customer asks for a custom logo. You add `branding`. A customer asks for different colors. You add `theme`. A customer asks for layout reordering. You add `layout`. Now you have a configuration surface as big as the app itself, and every new feature has to be tested in the cross-product of all configurations.

**What to do instead:** Resist. The brief said branding/colors/layout aren't configurable. The principle is **3-tenant rule**: only make X configurable when at least 3 tenants need different X. Until then, X is hardcoded. You can always make something configurable later; it's much harder to take a knob away.

### 3.2 Turing-complete config

**The trap:** Your config grows a `condition: { if: "tenant.tier === 'pro'", then: ..., else: ... }` field. Then you add expressions, then function calls. Eventually you've reinvented JavaScript, badly, without a debugger.

**What to do instead:** If your config wants to express logic, write code. Configs should be data — JSON values, not JSON-encoded programs. If you find yourself wanting `if/else` in a config, the answer is "add a typed field for the actual decision the config is trying to encode."

### 3.3 Runtime config that should be build-time

**The trap:** You read "which 7 modules exist in this app" from a database every page load. But "what modules exist" never varies per request — only per release. You've made a build-time decision a runtime cost for no benefit.

**What to do instead:** The registry IS the source of truth for "what exists." Configs only SELECT from the registry. Build-time things stay build-time. Runtime things — like "which subset Acme sees" — stay runtime.

### 3.4 No schema, no validation

**The trap:** Configs are JSON, you parse them with `JSON.parse`, you trust the result. A typo in `enabeledModules` (with extra `e`) sails through. Tomorrow's customer email: "Acme's dashboard is blank."

**What to do instead:** Always validate at boundaries. Worker reads from KV → `TenantConfigSchema.parse`. CI reads from repo → `TenantConfigSchema.parse`. Two places, same schema. A typo can't survive both.

### 3.5 Schema with no version

**The trap:** Configs have no `schemaVersion`. You change the shape (split a field, rename one). Now you have to write a one-time migration script that runs over 200 tenants with rollback handling and downtime planning.

**What to do instead:** `schemaVersion: 1` from day one. When you bump to v2, write a tiny migration function (`v1 → v2`) and have the Worker apply it on read. Existing configs keep working without a global migration.

### 3.6 DB-stored IDs not enforced in code

**The trap:** Configs store metric IDs as plain strings, but the code uses TypeScript types from a registry. The two drift over time. A renamed metric in code doesn't update configs in the DB. Some tenants silently lose a metric.

**What to do instead:** Derive the Zod enum from the registry's keys (doc 03 §8 link 3). The same source of truth feeds the TS type AND the runtime validator. A renamed metric is a parse error.

### 3.7 Lazy-loading per metric

**The trap:** "Code-splitting is good" → "let's split every component" → 80 chunks → 80 round trips on first load → slow dashboard.

**What to do instead:** Lazy by **module**, eager by metric within a module. Most apps have a small number of natural lazy boundaries (panel, route, modal). 7 lazy chunks is fine. 80 is not.

### 3.8 DB-storing config before it's needed

**The trap:** You set up D1 + an admin UI for tenant config from day one. You spend two weeks on the admin UI. Meanwhile you have 4 tenants and you've never used it; you onboard them all manually anyway.

**What to do instead:** JSON-in-repo first. Migrate to KV (or D1) when manual onboarding becomes painful. Onboarding 5 tenants by editing JSON files and merging PRs takes 5 minutes per tenant. Onboarding 50 tenants that way is genuinely annoying — that's when you migrate.

### 3.9 Feature-flagging tenant shape

**The trap:** A new customer asks for the Time module hidden. You go into your flag service and add `acme:time:hidden: true`. Now "what does Acme have" is split across config (some things) and flags (other things).

**What to do instead:** Tenant shape goes in config. Period. Flags are for *temporary* deviations. If you flag "Acme hides Time" and forget about it, six months later you have no audit trail of why Acme has a different shape.

### 3.10 Editorless config

**The trap:** Devs hand-edit JSON files. Devs typo. Bad config ships. (Usually right before a long weekend.)

**What to do instead:** Two things. First, validate in CI (`pnpm validate:tenants`) — a typo fails the build. Second, eventually, build a small admin UI that produces correctly-shaped config (or use a JSON schema editor like [react-jsonschema-form](https://github.com/rjsf-team/react-jsonschema-form) feeding from a Zod-derived JSON Schema). The CI validation is the day-one win; the admin UI is a later luxury.

---

## 4. Putting it all together — the full Acme walkthrough

Here's a complete trace of what happens when a user at Acme opens the dashboard. Every step references a doc in the series; if you want to dig in, follow the link.

### Step 0 — The static state

In the repo:

```
powerfab-dashboard/
├── app/                              ← React app
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/MetricSlot.tsx
│   │   ├── registry/
│   │   │   ├── metrics.ts            ← all 80 metric IDs as as-const-satisfies
│   │   │   ├── modules.ts            ← all 7 module IDs
│   │   │   ├── defaults.ts           ← MODULE_DEFAULTS
│   │   │   └── resolve.ts            ← resolveModuleMetrics
│   │   ├── schemas/tenantConfig.ts   ← Zod schema for TenantConfig
│   │   ├── tenant.ts                 ← reads injected config from <script>
│   │   └── main.tsx
│   └── index.html                    ← contains <!--__TENANT__--> placeholder
├── tenants/
│   ├── acme.json                     ← Acme's config
│   ├── bobs-beams.json
│   └── ...
├── worker/
│   └── index.ts                      ← Hono Worker
└── wrangler.toml                     ← Cloudflare deployment config
```

`tenants/acme.json`:

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

### Step 1 — User types `https://acme.app.example.com`

Browser does DNS lookup. The wildcard CNAME on `*.app.example.com` says "this is at Cloudflare." Browser opens an HTTPS connection to Cloudflare and sends:

```
GET / HTTP/1.1
Host: acme.app.example.com
Accept: text/html
```

(Doc 01 §2 covers this part.)

### Step 2 — The Worker runs first

Cloudflare sees the request, sees that we have a Worker bound to this hostname, and runs `worker/index.ts` BEFORE serving any static assets.

```ts
app.use('*', async (c, next) => {
  const host = c.req.header('host') ?? '';     // 'acme.app.example.com'
  const slug = host.split('.')[0];              // 'acme'
  const config = await c.env.TENANTS.get(`tenants:${slug}`, 'json');
  // ...
});
```

(Doc 01 §5 walks through every line.)

In MVP (JSON-in-repo), the lookup is `TENANT_CONFIGS['acme']`. Either way, the result is Acme's config object, exactly the shape from `tenants/acme.json`.

The Worker validates with Zod (doc 02 §5):

```ts
const config = TenantConfigSchema.parse(raw);
```

Acme's config is well-formed, so this returns the typed object. (If a malformed config got into KV somehow, this would throw and the Worker would return a clean error.)

### Step 3 — The Worker fetches index.html and injects the config

```ts
app.get('*', async (c) => {
  const html = await (await c.env.ASSETS.fetch(c.req.raw)).text();
  const injected = html.replace(
    '<!--__TENANT__-->',
    `<script id="__tenant__" type="application/json">${JSON.stringify(c.get('tenantConfig'))}</script>`
  );
  return c.html(injected);
});
```

Pages serves the unmodified `index.html`. The Worker replaces the `<!--__TENANT__-->` comment with a `<script>` tag containing Acme's JSON config. Returns the modified HTML to the browser.

(Doc 01 §5.4 walks through this line by line.)

### Step 4 — Browser parses the HTML

The browser receives:

```html
<!doctype html>
<html lang="en">
  <head>
    ...
    <script id="__tenant__" type="application/json">
      {"schemaVersion":1,"tenantId":"tnt_01HZX3K...","slug":"acme",...}
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/main-abc123.js"></script>
  </body>
</html>
```

The browser sees the `<script type="application/json">` tag with `type="application/json"` — it does NOT execute it as JavaScript; it just makes the contents available via DOM. Then it loads `main-abc123.js` (the React app's entry point).

### Step 5 — React boots, reads the embedded config

`src/main.tsx` runs. Imports trigger `src/tenant.ts`:

```ts
const raw = document.getElementById('__tenant__')?.textContent;
export const tenantConfig: TenantConfig = raw ? JSON.parse(raw) : ...;
```

(Doc 01 §6.) Now `tenantConfig` is in scope, populated, typed.

### Step 6 — App component runs the render loop

```tsx
// src/App.tsx
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

Note `inspections` is absent — Acme doesn't have it. The `.map` never reaches it, so it doesn't render at all.

For each module, the loop:

1. Looks up the module wrapper component and label from `MODULES` (the registry from doc 03 §5).
2. Calls `resolveModuleMetrics` to compute the metric list.
3. Renders the wrapper with each metric as a `<MetricSlot>`.

### Step 7 — `resolveModuleMetrics` for `time`

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

### Step 8 — `resolveModuleMetrics` for `estimating`

Inputs:
- `defaults = ['estimating.win-rate', 'estimating.bid-velocity']`
- `ov = { addMetrics: ['estimating.pipeline-coverage'] }`

Walk:
- removeMetrics? None.
- next = defaults.
- swapMetrics? None.
- addMetrics: append `'estimating.pipeline-coverage'`. next = `['estimating.win-rate', 'estimating.bid-velocity', 'estimating.pipeline-coverage']`.

Returns those three IDs.

### Step 9 — `<MetricSlot>` renders each metric

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
- The browser fetches the JS chunk for the Time module (or the specific metric, if you split that fine).
- Once loaded, React renders the actual `MonthlyHours` component, replacing the skeleton.

### Step 10 — Each metric component fetches its data

This part isn't covered in the multi-tenant docs (it's the same mechanic as today). Each metric component calls something like:

```tsx
function MonthlyHours({ tenantId }) {
  const data = useTenantData(tenantId, 'time');
  return <Chart data={data.monthly} />;
}
```

`useTenantData` fetches `https://acme.app.example.com/data/time.json` (or wherever the per-tenant data is hosted — R2 with a Worker route, or Pages static if you keep that pattern). The data was generated by the nightly pipeline (doc 03 — customer data ingest).

### Step 11 — Acme sees their dashboard

Final result for Acme:

- 6 panels render: Estimating, Production Control, Project Management, Time, Purchasing, Inventory.
- Inspections panel is absent entirely (not rendered, no skeleton, just gone).
- Time panel shows: actual-hours, monthly-hours, coverage.
- Estimating panel shows: win-rate, bid-velocity, pipeline-coverage.
- All other panels show their defaults.

For Bob's Beams (whose config has no overrides), the same React code, same registry, same `<App />` would render: 7 panels with all their default metrics.

For an unknown subdomain (`hacker.app.example.com`), the Worker returns 404 in step 2 and the React app never loads.

That's the whole picture, end to end.

---

## 5. What renaming a metric looks like under this architecture

To put it in concrete terms — the kind of change you'd do as a developer.

**Goal:** rename `time.weekly-hours` to `time.weekly-payroll-hours` (because it's been a payroll-aligned metric all along).

**Steps:**

1. Edit `app/panels/time/WeeklyHours.tsx` if you want, or rename the file too. Doesn't matter to the registry.
2. Edit `src/registry/metrics.ts`:
   ```ts
   // before
   'time.weekly-hours': () => import('../panels/time/WeeklyHours'),
   // after
   'time.weekly-payroll-hours': () => import('../panels/time/WeeklyHours'),
   ```
3. Run `pnpm tsc` (or just save and watch the type-check). Errors:
   - `MODULE_DEFAULTS.time` mentions `'time.weekly-hours'` — TS error.
   - Any tenant config TS files that mention it — TS error.
4. Edit `MODULE_DEFAULTS` to use the new name.
5. Run `pnpm validate:tenants`. Output:
   - `tenants/acme.json` — fails (still has `'time.weekly-hours'` in `swapMetrics.remove`).
   - `tenants/bobs-beams.json` — passes (no override on this metric).
6. Edit `tenants/acme.json` to use the new name.
7. Run `pnpm validate:tenants` again — passes.
8. Commit, push. CI re-runs the validator, passes.
9. Deploy.

The renamed metric is fully migrated. No production tenant ever saw a broken state. Three independent gates (TS compiler, Zod, CI) caught everything.

That's the payoff for the type-safety chain in doc 03 §8.

---

## 6. The maturity model (what to add when)

A useful rough roadmap for "what to build at what tenant count":

| # tenants | What you have | What you add next |
|---|---|---|
| 1 (today) | Static JSON, single dashboard | Decide to go multi-tenant |
| 1–3 | Wildcard subdomain + Worker + JSON-in-repo configs + registry pattern | Polish onboarding |
| 5–10 (MVP) | Above + CI validation + `pnpm validate:tenants` | Auth (multi-user per tenant) |
| 20–50 | Above + auth + audit trail | Move configs to KV, source-of-truth still in repo, CI pushes to KV |
| 50–100 | Above | Build small admin dashboard for support/ops to edit configs |
| 100–200 | Above | Move to D1 if you need cross-tenant queries; keep KV for hot reads |
| 200+ | Above | If experiments are now real: OpenFeature + GrowthBook |

The point of the roadmap: don't build for tier N+2. Build for your current tier and the one above it. Premature infrastructure costs more than it saves.

---

## 7. By the end of this doc you should know

- The rule for **config vs feature flag**: persistent shape vs temporary deviation.
- Why we don't need a flag service yet, and what the upgrade path looks like (`settings.flags` → OpenFeature + GrowthBook later).
- The 10 anti-patterns and the principle behind each one.
- The full Acme walkthrough: subdomain → Worker → injected config → React boot → registry lookup → resolve overrides → `<MetricSlot>` → lazy chunk → rendered metric.
- Concretely what renaming a metric looks like, and which gates catch what.
- A maturity model for what to add at what tenant count.

---

## 8. Going back to the original doc

If you've read 00–04 in order, the original `02-multi-tenant-config-ui.md` should now be readable. It's just a denser version of the same material. Use it as a reference for:

- The exact code snippets in one place (it has the full Worker + registry + schema in one file).
- The reference repos table (annotated bibliography of public projects worth reading).
- The anti-patterns section, which is more terse but covers the same ground as §3 here.

The rest of the research-level docs (`03-customer-data-ingest.md`, the Cloudflare architecture doc when it's rewritten) cover separate topics — they don't depend on understanding the registry pattern, but they ARE about how this whole thing gets deployed and fed with data.

---

## 9. What's not in this series (yet)

Things we deliberately didn't cover:

- **Auth** — multi-user-per-tenant login, sessions, RBAC. Separate concern, comes after multi-tenancy is in place.
- **The data pipeline** — how the nightly per-tenant JSON gets generated and shipped to R2. That's `03-customer-data-ingest.md`.
- **The Cloudflare architecture in detail** — Pages + Workers + KV + R2 + Containers and how they fit together at deploy time, with pricing. That's the `01-cloudflare-architecture.md` to be rewritten.
- **The admin dashboard** — a separate app for support/ops to edit tenant configs, audit changes, onboard customers. We mentioned it in the maturity model. Punt to later.

If any of those need their own beginner-friendly explainer, ask and I'll write them in the same style.

---

> **You're done with the multi-tenant + config-driven UI fundamentals.** When you next read `02-multi-tenant-config-ui.md`, treat it as a reference manual. The pattern itself, the vocabulary, the type-safety chain, the storage tradeoffs, and the anti-patterns should all click. If anything doesn't, point at the section and I'll rewrite that part of one of these docs.
