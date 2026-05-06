# Multi-Tenant Config-Driven Dashboard UI: Research & Recommendations

**Project:** PowerFab Dashboard (React 19 + Vite + TypeScript, Cloudflare-bound)
**Scope:** 7 panels, ~80 metrics, 5–10 → 100–200 tenants, subdomain-per-tenant.
**Author / date:** Research compiled 2026-05-05.

This document covers tenant resolution, config schema, storage, the React module/metric registry pattern, feature-flag tradeoffs, type-safety strategy, reference repos, and anti-patterns — ending with a concrete recommendation and a worked example.

---

## 1. Tenant Resolution Patterns

### 1.1 Where to extract the subdomain

Three plausible places to extract `acme` from `acme.app.example.com`:

| Layer | Pros | Cons |
|---|---|---|
| **Edge (Cloudflare Worker)** | Single source of truth; rejects unknown tenants before serving HTML | Worker in front of Pages |
| **Client-only (`window.location.hostname`)** | Zero extra infra | Unknown tenants still get the SPA shell; no server gate |
| **Both (Worker injects header / inline JSON, React reads it)** | Authoritative at edge, ergonomic in React; SSR-ready | A bit more wiring |

The canonical reference is [`vercel/platforms`](https://github.com/vercel/platforms) (6.7k ⭐, last push 2025-12-06), which uses [Next.js middleware to rewrite by host](https://vercel.com/guides/nextjs-multi-tenant-application). Cloudflare's analog: [Routes & Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/), [Cloudflare for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/), and the [Workers KV routing example](https://developers.cloudflare.com/kv/examples/routing-with-workers-kv/). See also [How I use Cloudflare to build multi-domain SaaS apps with React SPAs](https://medium.com/codex/how-i-use-cloudflare-to-build-multi-domain-saas-applications-with-react-single-page-applications-527e1a742401) — a Worker assembles `index.html` per tenant.

### 1.2 Recommended pattern (both)

A small Worker ([Hono](https://hono.dev/docs/getting-started/cloudflare-workers)) sits in front of Pages assets. Per request:

1. Parse the host; take the leading label as tenant slug.
2. Look up `tenants:<slug>` in KV. On miss, return 404.
3. Inject the config as `<script id="__tenant__" type="application/json">…</script>` into `index.html` before serving.

React reads the embedded tag at boot — no second round-trip, edge-cacheable.

Worker sketch with Hono:

```ts
// worker/index.ts
import { Hono } from 'hono'

type Env = { TENANTS: KVNamespace; ASSETS: Fetcher }
const app = new Hono<{ Bindings: Env }>()

app.use('*', async (c, next) => {
  const host = c.req.header('host') ?? ''
  const slug = host.split('.')[0] // acme.app.example.com -> 'acme'
  const config = await c.env.TENANTS.get(`tenants:${slug}`, 'json')
  if (!config) return c.text('Unknown tenant', 404)
  c.set('tenantConfig', config)
  await next()
})

app.get('*', async (c) => {
  const html = await (await c.env.ASSETS.fetch(c.req.raw)).text()
  const injected = html.replace(
    '<!--__TENANT__-->',
    `<script id="__tenant__" type="application/json">${JSON.stringify(c.get('tenantConfig'))}</script>`,
  )
  return c.html(injected)
})

export default app
```

React side:

```ts
// src/tenant.ts
const raw = document.getElementById('__tenant__')?.textContent
export const tenantConfig: TenantConfig =
  raw ? JSON.parse(raw) : (import.meta.env.DEV ? import.meta.env.VITE_DEV_TENANT : null)
```

### 1.3 Local dev (`localhost:5173`)

Three options, increasing effort:

1. **Env var fallback** — `VITE_DEV_TENANT_SLUG=acme` resolves from `app/tenants/acme.json`. Matches today's static-JSON workflow.
2. **`*.localhost`** — `127.0.0.1 acme.localhost` (browsers resolve `*.localhost` natively on macOS/Linux). Add `?tenant=acme` override for tests.
3. **Wrangler** (`wrangler pages dev`) — full Worker chain end-to-end.

Ship #1 day one, add #2 for designers, only do #3 once Worker logic grows.

---

## 2. Config Schema Design

### 2.1 Core shape

```ts
// types/tenantConfig.ts
import type { ModuleId, MetricId } from './registry'

export const CONFIG_VERSION = 1 as const

export type ModuleOverride = {
  /** Replace a default metric in this slot with another. */
  swapMetrics?: Array<{ remove: MetricId; add: MetricId }>
  /** Append metrics not in the default list. */
  addMetrics?: MetricId[]
  /** Hide metrics from the default list without replacement. */
  removeMetrics?: MetricId[]
}

export type TenantConfig = {
  schemaVersion: typeof CONFIG_VERSION
  tenantId: string
  slug: string
  enabledModules: ModuleId[]
  moduleOverrides?: Partial<Record<ModuleId, ModuleOverride>>
  /** Reserved for later: per-tenant numeric thresholds, currency, etc. */
  settings?: Record<string, unknown>
}
```

Note that there is no `branding`, no `roles`, no `layout` field — per the brief these are not configurable today, and YAGNI ([anti-pattern §8](#8-anti-patterns)).

### 2.2 Validation: pick **Zod 4**

Candidates: [Zod](https://github.com/colinhacks/zod) (42.6k ⭐), [Valibot](https://github.com/fabian-hiller/valibot) (8.6k ⭐), [ArkType](https://github.com/arktypeio/arktype) (7.8k ⭐). 2026 benchmarks ([PkgPulse](https://www.pkgpulse.com/guides/valibot-vs-zod-v4-typescript-validator-2026), [Pockit](https://pockit.tools/blog/zod-valibot-arktype-comparison-2026/), [Valibot comparison](https://valibot.dev/guides/comparison/)):

| Library | Tree-shaken | Throughput | API |
|---|---|---|---|
| Valibot 1.0 | **~1.4 KB** | fast | functional/pipe |
| Zod 4 | ~12 KB | 1M+ ops/s | method-chaining |
| ArkType 2 | ~40 KB | **fastest** | TS-literal syntax |

Config is parsed **once at app boot**, so runtime perf is irrelevant and 10 KB bundle delta is noise. Decide on ecosystem/DX: Zod has tRPC, React Hook Form, OpenAPI generators, and is the API new hires already know ([teardown](https://dev.to/gabrielanhaia/zod-4-vs-valibot-vs-arktype-a-type-system-teardown-4lha)). **Recommendation: Zod 4.** Switch to Valibot only if config validation moves into the Worker hot path.

### 2.3 Schema versioning

`schemaVersion: 1` from day one, with a tiny migration table — same shape as [Backstage's extension migrations](https://backstage.io/docs/frontend-system/architecture/migrations/):

```ts
const migrations: Record<number, (cfg: any) => any> = { 1: (c) => c }
export function migrate(raw: any): TenantConfig {
  let cur = raw
  for (let v = (raw.schemaVersion ?? 1); v < CONFIG_VERSION; v++) cur = migrations[v + 1](cur)
  return TenantConfigSchema.parse(cur)
}
```

### 2.4 Default + override merging

Pure, unit-tested, single file:

```ts
import { MODULE_DEFAULTS } from './registry'

export function resolveModuleMetrics(
  module: ModuleId, cfg: TenantConfig,
): MetricId[] {
  if (!cfg.enabledModules.includes(module)) return []
  const defaults = MODULE_DEFAULTS[module]
  const ov = cfg.moduleOverrides?.[module]
  if (!ov) return defaults
  let next = defaults.filter((m) => !ov.removeMetrics?.includes(m))
  for (const { remove, add } of ov.swapMetrics ?? []) {
    const idx = next.indexOf(remove)
    if (idx >= 0) next[idx] = add
  }
  if (ov.addMetrics?.length) next = [...next, ...ov.addMetrics]
  return next
}
```

`swapMetrics` keeps slot order — important when "the same slot" matters visually. `addMetrics` always appends.

---

## 3. Config Storage

For "rarely changes, must load fast on every render, 200 tenants":

| Option | Read latency | Write model | Consistency | Fits us? |
|---|---|---|---|---|
| **Cloudflare KV** ([docs](https://developers.cloudflare.com/kv/)) | 500 µs–10 ms hot, ~30% direct edge-cache hit | 1 write/s/key | eventual (~60 s) | **Yes** |
| **D1** ([docs](https://developers.cloudflare.com/d1/)) | ~5–30 ms read | strong | strong | overkill for this |
| **R2** | ~30–100 ms blob fetch | unbounded | strong | wrong tool |
| **JSON in repo** | 0 ms after build | requires deploy | n/a | **Yes (MVP)** |
| **KV + edge cache wrapper** | ≤ 1 ms hot | same | same | **Yes (graduate to)** |

Refs: [storage chooser](https://developers.cloudflare.com/workers/platform/storage-options/), [Edge Databases Compared](https://inventivehq.com/blog/cloudflare-d1-kv-vs-dynamodb-vs-cosmos-db-vs-firestore-edge-databases), [Workers KV in practice](https://eastondev.com/blog/en/posts/dev/20260422-cloudflare-workers-kv-guide/).

**MVP (5–10 tenants):** commit JSON at `app/tenants/<slug>.json`. The Worker imports a generated map at build time. Zero infra, edits via PR — same workflow as today's `app/public/data/`.

**Graduating (50+ tenants):** move to KV under `tenants:<slug>` with `cacheTtl: 300` so ~99% of reads never leave edge cache. Admin updates via `wrangler kv:key put`.

Skip D1 until cross-tenant queries are needed faster than a KV scan. At 200 tenants a nightly cron scan into a sheet is plenty.

---

## 4. React Module / Metric Registry Pattern

This is the most consequential decision and what most "config-driven UI" prior art is about.

### 4.1 The pattern

A **registry** is a typed, build-time-known map from a stable string ID to a component. The rendered set of components is decided at runtime by config. The two excellent treatments of this exact pattern in React:

- [How to Design a Type-Safe, Lazy, and Secure Plugin Architecture in React](https://www.freecodecamp.org/news/how-to-design-a-type-safe-lazy-and-secure-plugin-architecture-in-react/) — covers lifecycle, type safety, and lazy loading.
- [From If-Else Hell to Clean Architecture with Function Registry Pattern](https://techhub.iodigital.com/articles/function-registry-pattern-react) — the simplest correct version.
- [Building a Component Registry in React](https://medium.com/front-end-weekly/building-a-component-registry-in-react-4504ca271e56) — the "switch component" framing.
- [Strongly Typed Lazy Loading (Total TypeScript)](https://www.totaltypescript.com/workshops/advanced-react-with-typescript/advanced-patterns/strongly-typed-lazy-loading) — how to keep types when wrapping `React.lazy`.

### 4.2 How the giants do it

- **[Backstage](https://github.com/backstage/backstage)** (33.3k ⭐) is the most rigorous: each [Frontend Extension](https://backstage.io/docs/frontend-system/architecture/extensions/) is `createExtension({ id, attachTo, output, factory })` and [extensions communicate via typed `ExtensionDataRef`s](https://backstage.io/docs/frontend-system/architecture/extension-blueprints/). Heavy, but the unique-ID + typed-output idea is what we want, scaled down.
- **[Grafana](https://github.com/grafana/grafana)** (73.6k ⭐) registers panel plugins via `plugin.json` + a `module.ts` entrypoint, loaded with SystemJS ([plugin system](https://deepwiki.com/grafana/grafana/11-plugin-system), [build a panel plugin](https://grafana.com/developers/plugin-tools/tutorials/build-a-panel-plugin)). Overkill for us, but the reference for "config picks which panel renders."
- **[Refine](https://github.com/refinedev/refine)** (34.6k ⭐) ships [multitenancyProvider](https://refine.dev/core/docs/guides-concepts/multitenancy/) — closest framework analog.
- **[Tremor](https://github.com/tremorlabs/tremor)** (3.4k ⭐) is just primitives, but a good composition reference for 80 tiles.

### 4.3 Code-splitting: by module, not by metric

For 80 small metric tiles under ~100 KB, per-metric `React.lazy` is a net loss — each chunk costs a round-trip and Suspense flicker ([React.lazy docs](https://react.dev/reference/react/lazy), [web.dev code-splitting](https://web.dev/articles/code-splitting-suspense)). Lazy-load each of the 7 panels as one chunk; eager-bundle metrics within a panel.

### 4.4 The registry, made type-safe

```ts
// src/registry/metrics.ts
import type { ComponentType } from 'react'
export type MetricProps = { tenantId: string; data: unknown }

export const METRICS = {
  'estimating.win-rate':     () => import('../panels/estimating/WinRate'),
  'estimating.bid-velocity': () => import('../panels/estimating/BidVelocity'),
  'time.monthly-hours':      () => import('../panels/time/MonthlyHours'),
  // ... ~80 entries
} as const satisfies Record<string, () => Promise<{ default: ComponentType<MetricProps> }>>

export type MetricId = keyof typeof METRICS
```

`MetricId` is a derived union of every key. Two compile-time guarantees:

1. Delete a metric from `METRICS` → every config naming it fails to type-check.
2. Change a metric's props → `satisfies` flags it instantly.

Relies on `as const` + `keyof typeof` ([TS handbook](https://www.typescriptlang.org/docs/handbook/2/types-from-types.html), [const assertions](https://www.benmvp.com/blog/use-cases-typescript-const-assertions/)). Same trick TanStack Router uses for file-based routes.

### 4.5 Module registry

```ts
// src/registry/modules.ts
export const MODULES = {
  estimating:        { label: 'Estimating',         load: () => import('../panels/estimating') },
  productionControl: { label: 'Production Control', load: () => import('../panels/production') },
  projectManagement: { label: 'Project Management', load: () => import('../panels/pm') },
  time:              { label: 'Time',               load: () => import('../panels/time') },
  inspections:       { label: 'Inspections',        load: () => import('../panels/inspections') },
  purchasing:        { label: 'Purchasing',         load: () => import('../panels/purchasing') },
  inventory:         { label: 'Inventory',          load: () => import('../panels/inventory') },
} as const

export type ModuleId = keyof typeof MODULES

export const MODULE_DEFAULTS: Record<ModuleId, MetricId[]> = {
  estimating:        ['estimating.win-rate', 'estimating.bid-velocity', /* ... */],
  // ...
}
```

### 4.6 `<MetricSlot>`

```tsx
import { lazy, Suspense, useMemo } from 'react'
import { METRICS, type MetricId, type MetricProps } from './registry/metrics'

const cache = new Map<MetricId, ReturnType<typeof lazy>>()
const getLazy = (id: MetricId) => cache.get(id) ?? cache.set(id, lazy(METRICS[id])).get(id)!

export function MetricSlot({ id, ...rest }: { id: MetricId } & MetricProps) {
  const Cmp = useMemo(() => getLazy(id), [id])
  return <Suspense fallback={<div className="metric-skeleton" />}><Cmp {...rest} /></Suspense>
}
```

If 80 eager metrics ever become too much JS, only this file changes.

---

## 5. Feature Flags vs Config

Rule of thumb:

- **Config** = a tenant's *persistent shape*. Onboarding-driven, reviewed.
- **Feature flag** = a *temporary deviation*. Experiment/rollout-driven, often unreviewed.

"Acme has Time enabled" = config. "10% of users see new Inspections layout" = flag. Conflating them is the [most common anti-pattern in this space](https://medium.com/hackernoon/configuration-management-is-an-antipattern-e677e34be64c). For 5–200 tenants and a small team, a flag *service* is overkill:

| Option | Cost | Fit |
|---|---|---|
| [LaunchDarkly](https://launchdarkly.com/) | $6k–60k/yr | Overkill until 5+ engineers ship in parallel |
| [GrowthBook](https://github.com/growthbook/growthbook) (7.7k ⭐, OSS) | infra only | Best if you need experiments — [tenant-consistent bucketing](https://blog.growthbook.io/growthbook-vs-launchdarkly-why-developers-choose-growthbook-for-feature-flagging/) on `company_id` is built in |
| [Unleash](https://github.com/Unleash/unleash) (13.4k ⭐) | infra only | Mature, heavyweight |
| [OpenFeature SDK](https://openfeature.dev/) ([js-sdk](https://github.com/open-feature/js-sdk)) | free | Vendor-neutral abstraction |
| **`settings.flags` in TenantConfig** | free | **Right for MVP** |

**Recommendation:** add `settings.flags?: Record<string, boolean>` to `TenantConfig`. When a real experiment arrives, swap to OpenFeature backed by GrowthBook ([provider list](https://blog.devcycle.com/comparing-top-openfeature-providers/)) — the API at the call site doesn't change.

---

## 6. Type-Safety Across Config + UI

Goal: renaming a metric is a TS error until configs and registry agree. The chain:

1. `as const satisfies` on the registry → `MetricId` / `ModuleId` are derived unions (§4.4).
2. `TenantConfig` types use those unions. TS-authored configs get red squigglies on stale IDs.
3. JSON configs (KV, repo) are parsed by Zod schemas built from the same enums:

```ts
import { z } from 'zod'
import { MODULES, METRICS, type ModuleId, type MetricId } from './registry'

const ModuleIdSchema = z.enum(Object.keys(MODULES) as [ModuleId, ...ModuleId[]])
const MetricIdSchema = z.enum(Object.keys(METRICS) as [MetricId, ...MetricId[]])

export const TenantConfigSchema = z.object({
  schemaVersion: z.literal(1),
  tenantId: z.string(),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  enabledModules: z.array(ModuleIdSchema),
  moduleOverrides: z.record(ModuleIdSchema, z.object({
    swapMetrics: z.array(z.object({ remove: MetricIdSchema, add: MetricIdSchema })).optional(),
    addMetrics: z.array(MetricIdSchema).optional(),
    removeMetrics: z.array(MetricIdSchema).optional(),
  })).optional(),
  settings: z.record(z.unknown()).optional(),
})
```

4. CI runs `validate:tenants`, parsing every tenant JSON. A renamed metric breaks the build at deploy time even though configs live in KV.

**Registry as source of truth → types derived → schema derived from types → deploy-time validation.** Same shape Backstage uses for [`ExtensionDataRef`s](https://backstage.io/docs/frontend-system/architecture/extensions/).

---

## 7. Reference Repositories

All star counts and `pushed_at` dates pulled live from the GitHub API on **2026-05-05** so they're real, not hallucinated.

### (a) Multi-tenant React/Next/Vite SaaS w/ subdomain routing

| Repo | ⭐ | Last push | Read |
|---|---|---|---|
| [vercel/platforms](https://github.com/vercel/platforms) | 6,672 | 2025-12-06 | Canonical Next.js subdomain template. Quiet ~5mo, still the reference. [`middleware.ts`](https://github.com/vercel/platforms/blob/main/middleware.ts). |
| [calcom/cal.com](https://github.com/calcom/cal.com) | 42,360 | 2026-05-05 | Production multi-tenant. `apps/web/middleware.ts` + tenant lookups. |
| [refinedev/refine](https://github.com/refinedev/refine) | 34,602 | 2026-05-05 | First-class [`multitenancyProvider`](https://refine.dev/core/docs/guides-concepts/multitenancy/). |
| [ixartz/SaaS-Boilerplate](https://github.com/ixartz/SaaS-Boilerplate) | 7,039 | 2026-02-20 | Next.js + Shadcn + multi-tenancy + RBAC. |
| [janhesters/react-router-saas-template](https://github.com/janhesters/react-router-saas-template) | 47 | 2026-04-12 | Niche but the only fresh **React Router 7** (non-Next) B2B template. Route-loader tenant resolution. |
| [saas-js/saas-ui](https://github.com/saas-js/saas-ui) | 1,629 | 2026-03-06 | Companion to the [Vite + TanStack Router multi-tenant blog series](https://saas-ui.dev/blog/building-a-multi-tenant-b2b-saas-with-vite-tanstack-router) — closest stack match. |

### (b) Config-driven dashboard / widget registry

| Repo | ⭐ | Last push | Read |
|---|---|---|---|
| [grafana/grafana](https://github.com/grafana/grafana) | 73,593 | 2026-05-06 | `public/app/features/plugins/`, `plugin.json` schema, `module.ts` loader. Gold standard. |
| [backstage/backstage](https://github.com/backstage/backstage) | 33,273 | 2026-05-05 | `packages/frontend-plugin-api`: `createExtension`, `ExtensionDataRef`. |
| [appsmithorg/appsmith](https://github.com/appsmithorg/appsmith) | 39,744 | 2026-05-05 | Pure config-driven; every widget is JSON. `app/client/src/widgets/`. |
| [ToolJet/ToolJet](https://github.com/ToolJet/ToolJet) | 37,867 | 2026-05-05 | Cleaner React than Appsmith. `frontend/src/Editor/Components/`. |
| [lowdefy/lowdefy](https://github.com/lowdefy/lowdefy) | 2,965 | 2026-05-05 | YAML/JSON-defined apps. Clearest small implementation of "config → React tree." |
| [tremorlabs/tremor](https://github.com/tremorlabs/tremor) | 3,403 | 2025-10-10 | Tile primitives for composing 80 metrics. |
| [react-grid-layout/react-grid-layout](https://github.com/react-grid-layout/react-grid-layout) | 22,236 | 2026-04-15 | Only if tenants ever drag-arrange tiles. Not MVP. |

### (c) Plugin-architecture frontends

- Backstage and Grafana (above).
- [rjsf-team/react-jsonschema-form](https://github.com/rjsf-team/react-jsonschema-form) (15.7k ⭐, 2026-05-01) — JSON-Schema → React via a widget registry mapping `schema.format` to components. Same pattern as our metric registry, battle-tested.

### Stale / skip

- [remorses/vercel-platforms](https://github.com/remorses/vercel-platforms) — 0 ⭐, last push **2023-06-30**. Use the canonical.
- [chunlea/vercel-platforms-starter-kit](https://github.com/chunlea/vercel-platforms-starter-kit) — third-party fork; skip.

---

## 8. Anti-Patterns

Synthesized from [Configuration Management is an Antipattern](https://medium.com/hackernoon/configuration-management-is-an-antipattern-e677e34be64c), [Don't Rely on Configuration in Your DB](https://medium.com/@connercharlebois/why-you-shouldnt-rely-on-configuration-in-your-database-bcab3c4bb614), [Config-Driven vs Static](https://medium.com/@itskishankumar98/config-driven-vs-static-systems-mostly-in-the-context-of-ui-f72081c95a22), [Mastering Config-Driven UI](https://dev.to/lovishduggal/mastering-config-driven-ui-a-beginners-guide-to-flexible-and-scalable-interfaces-3l91):

1. **"Everything is a config."** Each new configurable field expands your test matrix. Brief says branding/layout/roles are *not* configurable — resist scope creep.
2. **Turing-complete config.** JSON-encoded `if/else` is a language without a debugger. If logic is needed, write code and ship.
3. **Runtime config that should be build-time.** "Which 7 modules exist" is build-time; "which Acme sees" is runtime. The registry is the source of truth — config can only *select from* it.
4. **No schema, no validation.** Without Zod parse on load, a typo silently disables a metric. Catch it at CI, not 9am Monday.
5. **Schema with no version.** `schemaVersion: 1` costs 0 today; absence costs a manual migration over 200 tenants later.
6. **DB-stored IDs not enforced in code.** `as const satisfies` + `z.enum` closes the loop.
7. **Lazy-loading per metric.** 80 chunks = 80 round-trips. Lazy by module ([web.dev](https://web.dev/articles/code-splitting-suspense)).
8. **DB-storing config before needed.** JSON-in-repo for 5–10 tenants is faster, more auditable, PR-reviewable. Move to KV when onboarding pain demands it.
9. **Feature-flagging tenant shape.** Acme having Time isn't a flag — it's a `git diff` ([when flags help vs hurt](https://blog.croct.com/post/feature-flags)).
10. **Editorless config.** If devs hand-edit JSON, devs will misedit. Mitigation: `pnpm validate:tenants` Zod-parses every file in CI.

---

## Concrete Recommendation

- **Tenant resolution:** Cloudflare Worker (Hono) extracts the leading subdomain, looks it up in KV (MVP: imported JSON map), injects config into `index.html` as a `<script type="application/json">` tag. React reads it at boot via one accessor.
- **Schema:** Zod 4, derived from registry `as const` keys. `schemaVersion: 1` from day one. Tiny: `enabledModules`, `moduleOverrides`, `settings`. No branding/roles/layout fields.
- **Storage:** **JSON-in-repo** at `app/tenants/<slug>.json` for MVP. CI-validated. Migrate to **KV with `cacheTtl: 300`** at ~50 tenants. Skip D1 until cross-tenant queries demand it.
- **Registry:** `as const satisfies` for both `MODULES` and `METRICS`. Lazy modules, eager metrics. One `<MetricSlot id />` does the lookup.
- **Type-safety:** registry → derived `MetricId`/`ModuleId` → Zod enums from same keys → `validate:tenants` in CI.
- **Flags:** `settings.flags?: Record<string, boolean>` for now. OpenFeature + GrowthBook later if experiments arrive. No paid flag service.
- **Guard:** when someone asks "can we make X configurable?", answer "yes, after ≥3 tenants need different X." Otherwise: code change + deploy.

### Worked example

Tenant `acme` hides Inspections, swaps a Time metric, adds one to Estimating.

```jsonc
// app/tenants/acme.json
{
  "schemaVersion": 1,
  "tenantId": "tnt_01HZ...",
  "slug": "acme",
  "enabledModules": [
    "estimating", "productionControl", "projectManagement",
    "time", "purchasing", "inventory"
    // "inspections" deliberately omitted
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

Render path:

```tsx
// src/App.tsx
import { tenantConfig } from './tenant'
import { MODULES, type ModuleId } from './registry/modules'
import { resolveModuleMetrics } from './registry/resolve'
import { MetricSlot } from './components/MetricSlot'

export default function App() {
  return (
    <Shell tenant={tenantConfig}>
      {tenantConfig.enabledModules.map((mod) => {
        const metrics = resolveModuleMetrics(mod, tenantConfig)
        return (
          <Panel key={mod} title={MODULES[mod].label}>
            {metrics.map((m) => (
              <MetricSlot key={m} id={m} tenantId={tenantConfig.tenantId} />
            ))}
          </Panel>
        )
      })}
    </Shell>
  )
}
```

Result for `acme`:

- Inspections — not rendered (filtered by `enabledModules`).
- Time — defaults minus `time.weekly-hours`, plus `time.monthly-hours` in same slot.
- Estimating — defaults plus `estimating.pipeline-coverage` appended.
- Others — defaults untouched.

If someone later renames `time.monthly-hours` without updating `acme.json`, three independent gates fail before production: (1) `MetricId` type no longer contains the old key; (2) `validate:tenants` Zod-parse fails in CI; (3) `resolveModuleMetrics` never returns it. That redundancy is the point — configurability is cheap when the type system enforces it, catastrophic when it doesn't.

---

## TL;DR

> Worker reads subdomain → KV (or imported JSON) → injects per-tenant config into `index.html`. React parses config at boot. Modules and metrics live in `as const satisfies` registries, types derived from them, Zod schema derived from the types. CI parses every tenant config. Module-level lazy-loading, eager metrics within a module. JSON-in-repo until 50+ tenants, then KV. No flag service until you actually need experiments. Resist every request to make branding/layout/roles configurable.
