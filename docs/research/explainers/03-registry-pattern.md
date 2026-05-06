# 03 — The Registry Pattern: How Config Decides What to Render

> **Pre-reqs:** Read `00-start-here.md`, `01-tenant-resolution.md`, `02-config.md` in order.
>
> **What you'll know by the end:** What a "registry" actually IS in code. How a JSON config picks which React components render. Every TypeScript trick (`as const`, `satisfies`, `keyof typeof`, derived unions) explained from scratch with examples. What lazy loading and Suspense are and how they keep the bundle small. The full type-safety chain — registry → types → schema → CI — that catches a renamed metric in three places.

This is the most important doc in the series. Take your time.

---

## 1. The problem we're trying to solve

We have a tenant config that says (paraphrased):

> Acme has these enabled modules: estimating, time, ... and in Time, swap weekly-hours for monthly-hours.

We need to turn that into rendered React components. The naive way looks like this:

```tsx
function App({ config }) {
  const modules = [];
  for (const moduleId of config.enabledModules) {
    if (moduleId === 'estimating') {
      modules.push(<Estimating />);
    } else if (moduleId === 'productionControl') {
      modules.push(<ProductionControl />);
    } else if (moduleId === 'time') {
      // ... and inside Time, render different metrics based on overrides ...
      modules.push(
        <Time>
          <WinRate />
          <MonthlyHours />  {/* or WeeklyHours, depending on tenant */}
        </Time>
      );
    } else if (moduleId === 'projectManagement') {
      ...
    }
    // ... 7 of these ...
  }
  return modules;
}
```

For 7 modules and 80 metrics, that's a giant tangle of if-else statements. Every new tenant requirement adds another branch. Every renamed metric requires hunting through every branch. This doesn't scale. It's also exactly the [if-else hell from the linked article](https://techhub.iodigital.com/articles/function-registry-pattern-react).

The **registry pattern** replaces all that with one lookup table.

---

## 2. What a registry IS, in three sentences

A **registry** is a JavaScript/TypeScript object whose keys are stable string IDs and whose values are the things you'd otherwise hardcode in a switch statement. The values are usually React components, but they can be anything — functions, configs, classes. To "render the metric whose ID is X," you do `Registry[X]` and get the component.

That's it. That's the pattern. Everything else in this doc is making it type-safe and lazy.

Phonebook analogy: a phonebook is a registry mapping `name` → `phone number`. Look up a name, get a number. Same idea here: look up `'time.monthly-hours'`, get the `MonthlyHours` component.

---

## 3. The dumbest possible version

Let's start with the least clever version, then add type safety, then add lazy loading. Each layer is a self-contained idea.

```ts
// src/registry/metrics.ts (v0 — the dumb version)
import WinRate from '../panels/estimating/WinRate';
import MonthlyHours from '../panels/time/MonthlyHours';
import WeeklyHours from '../panels/time/WeeklyHours';
// ... 80 imports ...

export const METRICS = {
  'estimating.win-rate': WinRate,
  'time.monthly-hours': MonthlyHours,
  'time.weekly-hours': WeeklyHours,
  // ... 80 entries ...
};
```

Now to render a metric by ID:

```tsx
// src/components/MetricSlot.tsx (v0)
import { METRICS } from '../registry/metrics';

export function MetricSlot({ id }: { id: string }) {
  const Component = METRICS[id];
  if (!Component) return null;
  return <Component />;
}
```

And the App becomes:

```tsx
function App({ config }) {
  return config.enabledModules.map(moduleId => (
    <Panel key={moduleId} title={moduleId}>
      {getMetricsFor(moduleId, config).map(metricId => (
        <MetricSlot key={metricId} id={metricId} />
      ))}
    </Panel>
  ));
}
```

That's the whole registry pattern, in 20 lines. The if-else hell is gone. New tenant wants a different metric? Change their config JSON. Adding a new metric to the system? Add one entry to `METRICS`. Renaming a metric? Change one line.

Now we'll add three improvements:

1. **Type safety** — make `MetricSlot id="bogus"` a TypeScript error instead of a silent runtime bug. (§4–5)
2. **Lazy loading** — don't bundle all 80 metrics into one big JS file. (§7)
3. **Module-level structure** — apply the same pattern to the 7 modules, with a per-module default metric list. (§6)

Each of those is a discrete idea you can layer on independently.

---

## 4. The TypeScript magic, one trick at a time

This section explains four TypeScript features that go into the typed registry. Read them slowly. Each one is small.

### 4.1 `as const`: telling TypeScript "exactly this, not just any string"

By default, when you write an object literal, TypeScript is generous with the types:

```ts
const a = { color: 'red' };
// TypeScript infers: { color: string }
```

That `string` is wider than what we wrote. We wrote `'red'`, but TypeScript said "this could be any string later." Sometimes that's fine, but for a registry it's terrible — we want the type to be EXACTLY the keys we wrote, not "could be any string."

`as const` flips that:

```ts
const b = { color: 'red' } as const;
// TypeScript infers: { readonly color: 'red' }
```

Now the type is the literal `'red'`, not `string`. And the object is `readonly` (you can't reassign properties on it).

For our registry:

```ts
const METRICS = {
  'estimating.win-rate': WinRate,
  'time.monthly-hours': MonthlyHours,
} as const;
// Type: { readonly 'estimating.win-rate': typeof WinRate; readonly 'time.monthly-hours': typeof MonthlyHours }
```

Without `as const`, the keys would be widened to `string` and we'd lose the precise IDs.

### 4.2 `keyof typeof X`: getting the union of keys

Once an object has narrow types (thanks to `as const`), we can extract its keys as a TypeScript type:

```ts
type Keys = keyof typeof METRICS;
// Keys is the type: 'estimating.win-rate' | 'time.monthly-hours'
```

Read that left-to-right:

- `typeof METRICS` is the TypeScript type of the `METRICS` object (already narrow because of `as const`).
- `keyof X` for an object type X is the union of X's keys.
- So `keyof typeof METRICS` is the union of all the keys of `METRICS`.

We name this `MetricId`:

```ts
export type MetricId = keyof typeof METRICS;
// MetricId is: 'estimating.win-rate' | 'time.monthly-hours' | ... 80 of them
```

Now `MetricId` is a **derived union** — its set of values is computed FROM the registry. Add a metric to `METRICS`, and `MetricId` automatically grows. Remove one, and `MetricId` shrinks. There's no separate list of metric IDs to keep in sync. The registry is the single source of truth.

### 4.3 `satisfies`: shape-check without losing literal types

There's still one problem. We want to assert that every value in `METRICS` is a valid React component (something that takes specific props). But if we annotate the type, TypeScript widens our object back to its annotation:

```ts
// THE BAD WAY:
const METRICS: Record<string, ComponentType> = {
  'estimating.win-rate': WinRate,
  'time.monthly-hours': MonthlyHours,
} as const;
// Now keyof typeof METRICS is just `string` again — we lost the precise keys!
```

Annotating with `Record<string, ComponentType>` says "the keys are any string." We threw away the precision we got from `as const`.

`satisfies` solves this. It says "check that this value matches this type, but don't widen the type":

```ts
const METRICS = {
  'estimating.win-rate': WinRate,
  'time.monthly-hours': MonthlyHours,
} as const satisfies Record<string, ComponentType>;
```

What this does:

- `as const` keeps the literal types.
- `satisfies Record<string, ComponentType>` checks that every value really is a `ComponentType`. If you accidentally added `'broken': 42` (a number, not a component), `satisfies` would catch it with a TS error.
- `keyof typeof METRICS` still returns the literal union, not `string`.

You get both: the type-checking benefit AND the precision of literal keys. This is the killer combo for a registry.

### 4.4 Putting them together

```ts
// src/registry/metrics.ts (v1 — type-safe version)
import type { ComponentType } from 'react';
import WinRate from '../panels/estimating/WinRate';
import MonthlyHours from '../panels/time/MonthlyHours';
import WeeklyHours from '../panels/time/WeeklyHours';

export type MetricProps = { tenantId: string };

export const METRICS = {
  'estimating.win-rate': WinRate,
  'time.monthly-hours': MonthlyHours,
  'time.weekly-hours': WeeklyHours,
} as const satisfies Record<string, ComponentType<MetricProps>>;

export type MetricId = keyof typeof METRICS;
```

Now:

```tsx
export function MetricSlot({ id, tenantId }: { id: MetricId; tenantId: string }) {
  const Component = METRICS[id];
  return <Component tenantId={tenantId} />;
}

// Usage:
<MetricSlot id="time.monthly-hours" tenantId="..." />  // ✓ ok
<MetricSlot id="bogus" tenantId="..." />               // ✗ TS error: not assignable to MetricId
```

If you delete `'time.monthly-hours'` from the registry, every place that uses `id="time.monthly-hours"` becomes a compile error. The TypeScript compiler is now an enforcer.

That's the type-safe registry. Three TypeScript features (`as const`, `satisfies`, `keyof typeof`) combine to give us a lookup table where the compiler keeps the keys honest.

---

## 5. The full module registry

Same pattern, but for modules instead of metrics. The values are richer — each module has metadata (label, icon, etc.) plus the actual component:

```ts
// src/registry/modules.ts
import Estimating from '../panels/estimating';
import ProductionControl from '../panels/production';
import ProjectManagement from '../panels/pm';
import Time from '../panels/time';
import Inspections from '../panels/inspections';
import Purchasing from '../panels/purchasing';
import Inventory from '../panels/inventory';

export const MODULES = {
  estimating:        { label: 'Estimating',         Component: Estimating },
  productionControl: { label: 'Production Control', Component: ProductionControl },
  projectManagement: { label: 'Project Management', Component: ProjectManagement },
  time:              { label: 'Time',               Component: Time },
  inspections:       { label: 'Inspections',        Component: Inspections },
  purchasing:        { label: 'Purchasing',         Component: Purchasing },
  inventory:         { label: 'Inventory',          Component: Inventory },
} as const;

export type ModuleId = keyof typeof MODULES;
```

`ModuleId` is now `'estimating' | 'productionControl' | ... | 'inventory'`. Same pattern — keys are typed precisely, values have metadata.

### 5.1 Default metric list per module

Each module also has a default list of which metrics show. That's separate from the module registry because it changes more often:

```ts
// src/registry/defaults.ts
import type { ModuleId } from './modules';
import type { MetricId } from './metrics';

export const MODULE_DEFAULTS: Record<ModuleId, MetricId[]> = {
  estimating: [
    'estimating.win-rate',
    'estimating.bid-velocity',
    // ...
  ],
  productionControl: [
    'production.tons-shipped',
    'production.percent-complete',
    // ...
  ],
  // ... all 7 ...
};
```

`Record<ModuleId, MetricId[]>` typed both sides — every key must be a valid `ModuleId`, every value must be an array of valid `MetricId`s. Add a new module, TS fails until you add its defaults. Rename a metric, TS fails until you update every default that references it.

### 5.2 Resolving metrics per module per tenant

Now the function that takes a `ModuleId` and the tenant config and returns the metrics to render for THIS tenant:

```ts
// src/registry/resolve.ts
import type { TenantConfig } from '../types/tenantConfig';
import type { ModuleId, MetricId } from '../registry';
import { MODULE_DEFAULTS } from './defaults';

export function resolveModuleMetrics(
  module: ModuleId,
  cfg: TenantConfig,
): MetricId[] {
  // Module isn't enabled for this tenant — render nothing.
  if (!cfg.enabledModules.includes(module)) return [];

  const defaults = MODULE_DEFAULTS[module];
  const ov = cfg.moduleOverrides?.[module];

  // No overrides? Just return defaults.
  if (!ov) return defaults;

  // Apply removeMetrics first.
  let next = defaults.filter(m => !ov.removeMetrics?.includes(m));

  // Apply swapMetrics next (preserves slot order).
  for (const { remove, add } of ov.swapMetrics ?? []) {
    const idx = next.indexOf(remove);
    if (idx >= 0) next[idx] = add;
  }

  // Append addMetrics last.
  if (ov.addMetrics?.length) {
    next = [...next, ...ov.addMetrics];
  }

  return next;
}
```

Let's walk through it once with Acme as input.

Acme's config (from doc 02):

```jsonc
{
  "enabledModules": ["estimating", "productionControl", "projectManagement", "time", "purchasing", "inventory"],
  "moduleOverrides": {
    "time": { "swapMetrics": [{ "remove": "time.weekly-hours", "add": "time.monthly-hours" }] },
    "estimating": { "addMetrics": ["estimating.pipeline-coverage"] }
  }
}
```

Suppose `MODULE_DEFAULTS.time` is `['time.actual-hours', 'time.weekly-hours', 'time.coverage']`.

Calling `resolveModuleMetrics('time', acmeConfig)`:

1. Is `time` in enabledModules? Yes — continue.
2. defaults = `['time.actual-hours', 'time.weekly-hours', 'time.coverage']`.
3. ov = `{ swapMetrics: [{ remove: 'time.weekly-hours', add: 'time.monthly-hours' }] }`.
4. removeMetrics? None.
5. next = defaults (nothing removed) = `['time.actual-hours', 'time.weekly-hours', 'time.coverage']`.
6. swapMetrics loop: find 'time.weekly-hours' at index 1, replace with 'time.monthly-hours'. next becomes `['time.actual-hours', 'time.monthly-hours', 'time.coverage']`.
7. addMetrics? None.
8. Return `['time.actual-hours', 'time.monthly-hours', 'time.coverage']`.

For `inspections`, `enabledModules` doesn't include it — we return `[]` immediately. The Inspections panel renders nothing.

For `estimating`, defaults plus `'estimating.pipeline-coverage'` appended.

That's the resolution logic. Pure function. Trivially unit-testable.

---

## 6. The render loop, top to bottom

Putting it all together:

```tsx
// src/App.tsx
import { tenantConfig } from './tenant';
import { MODULES } from './registry/modules';
import { resolveModuleMetrics } from './registry/resolve';
import { MetricSlot } from './components/MetricSlot';

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

For each enabled module:
- Look up the module's wrapper component and label from `MODULES`.
- Compute the metric list with `resolveModuleMetrics`.
- Render the module's wrapper with each metric as a child.

If you wanted to handle disabled modules differently (show a "not available" tile, etc.), you'd put that logic here. We just skip them.

---

## 7. Lazy loading, explained

Up to now we've been importing all 80 metric components at the top of the registry file. That works, but it means the user's browser downloads code for all 80 metrics on first page load — even if they're only seeing 12. Wasteful.

**Lazy loading** = only download the code for a component when it's actually about to render.

### 7.1 What's a "bundle"?

When you build your Vite app (`pnpm build`), Vite runs through your imports and produces a few output files:

- `index-abc123.html`
- `assets/main-def456.js` — your app's code
- `assets/main-def456.css` — your styles

The browser downloads `main-def456.js` on first page load. If you imported every metric component at the top, ALL their code is in there. Hundreds of KB of "you might need this" before the user sees anything.

### 7.2 Code splitting — the fix

Vite (and any modern bundler) will **code-split** any `import()` that's a *function call* instead of a top-of-file static import.

```ts
// Static import — eagerly bundled into main JS:
import WinRate from '../panels/estimating/WinRate';

// Dynamic import — code-split into a separate chunk:
() => import('../panels/estimating/WinRate')
```

The dynamic version doesn't run at build time. It runs at runtime, when JavaScript executes the function. At that moment, the browser fetches `WinRate-xyz789.js` from the server.

The build creates a separate JS file per chunk:

- `main-def456.js` (small — just the shell)
- `WinRate-xyz789.js` (only fetched when needed)
- `MonthlyHours-uvw234.js` (only fetched when needed)
- ... 80 of these ...

### 7.3 `React.lazy` — making React aware

Wrapping a dynamic import in `React.lazy` creates a component you can render normally. React handles the loading dance:

```ts
import { lazy } from 'react';

const WinRate = lazy(() => import('../panels/estimating/WinRate'));

// Usage:
<WinRate />
```

When `<WinRate />` first appears on screen, React kicks off the dynamic import, shows a fallback (next section), and replaces the fallback with the real component once it loads.

### 7.4 Suspense — the fallback

Wrapping a lazy component in `<Suspense>` tells React what to show while loading:

```tsx
import { Suspense } from 'react';

<Suspense fallback={<div>Loading...</div>}>
  <WinRate />
</Suspense>
```

Until `WinRate` finishes loading, the user sees `Loading...`. Then it swaps in.

### 7.5 The lazy registry

Instead of storing eagerly-imported components, the registry stores `() => import(...)` functions:

```ts
// src/registry/metrics.ts (v2 — lazy)
import type { ComponentType } from 'react';

export type MetricProps = { tenantId: string };

export const METRICS = {
  'estimating.win-rate':     () => import('../panels/estimating/WinRate'),
  'time.monthly-hours':      () => import('../panels/time/MonthlyHours'),
  'time.weekly-hours':       () => import('../panels/time/WeeklyHours'),
  // ... 80 entries ...
} as const satisfies Record<
  string,
  () => Promise<{ default: ComponentType<MetricProps> }>
>;

export type MetricId = keyof typeof METRICS;
```

The values are now functions that return promises that resolve to `{ default: ComponentType }` (the shape `import(...)` returns).

### 7.6 The lazy `<MetricSlot>`

```tsx
// src/components/MetricSlot.tsx (v2 — lazy + memoized)
import { lazy, Suspense, useMemo } from 'react';
import { METRICS, type MetricId, type MetricProps } from '../registry/metrics';

const cache = new Map<MetricId, ReturnType<typeof lazy>>();

function getLazy(id: MetricId) {
  if (!cache.has(id)) {
    cache.set(id, lazy(METRICS[id]));
  }
  return cache.get(id)!;
}

export function MetricSlot({ id, ...rest }: { id: MetricId } & MetricProps) {
  const Cmp = useMemo(() => getLazy(id), [id]);
  return (
    <Suspense fallback={<div className="metric-skeleton" />}>
      <Cmp {...rest} />
    </Suspense>
  );
}
```

Walking through:

- `cache` ensures each metric is wrapped in `React.lazy` exactly once. If we wrapped on every render, React would treat each as a "new" lazy component and refetch. Storing in a Map prevents that.
- `getLazy(id)` looks up or creates the lazy version of the metric.
- `useMemo` ensures `Cmp` is stable across renders.
- `<Suspense>` shows a placeholder until the chunk loads.

### 7.7 Module-level lazy is usually better than metric-level

For our app specifically: 80 metrics, each ~5–20 KB after gzip = ~1 MB if everything were in one bundle. But:

- Splitting per-metric = 80 chunks = 80 round trips on first dashboard view = slower.
- Splitting per-module = 7 chunks = 7 round trips = faster, and you don't fetch the Time chunk until the user opens Time.

If your dashboard renders all 7 modules on one screen (like we do), per-module is the right granularity. If your app had a side nav and only loaded one module at a time, per-module would still be right.

You'd lazy-load the **module** wrappers in `MODULES`, eagerly bundle the metrics within each module:

```ts
// src/registry/modules.ts (lazy)
import { lazy } from 'react';

const Estimating = lazy(() => import('../panels/estimating'));
const ProductionControl = lazy(() => import('../panels/production'));
// ...

export const MODULES = {
  estimating:        { label: 'Estimating',         Component: Estimating },
  productionControl: { label: 'Production Control', Component: ProductionControl },
  // ...
} as const;
```

And inside each panel file (e.g. `panels/estimating/index.tsx`), just import its metrics statically. They get bundled with the panel. Only the panels you render get downloaded.

The metric-level lazy logic from §7.6 is still useful — keep it around for any specific metric that's heavy enough to deserve its own chunk (a giant chart library, a data-heavy table). For most metrics, per-panel is sufficient.

### 7.8 The hard rule

If 80 chunks ever feels like the right answer, you've over-split. The bundler is your friend, not an adversary. Default to fewer chunks; split a specific metric only when measurement (not intuition) shows it's a problem.

---

## 8. The full type-safety chain

Here's the chain we've been building. Each link catches a different kind of mistake.

```
┌─────────────────────────────────────────────────────────────┐
│  Link 1: registry — `as const satisfies`                    │
│   METRICS = { 'time.monthly-hours': WinRate } as const ...  │
│   Catches: typo in registry value (not a component)         │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Link 2: derived types — `keyof typeof`                     │
│   type MetricId = keyof typeof METRICS                      │
│   Catches: typo in any TS code that uses MetricId           │
│   "<MetricSlot id='bogus'>" → compile error                 │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Link 3: Zod schema — `z.enum(Object.keys(METRICS))`        │
│   const MetricIdSchema = z.enum(Object.keys(METRICS) as ...)│
│   Catches: typo in JSON config files at runtime             │
│   tenant config with "time.monthlyhours" → parse error      │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Link 4: CI validation — `pnpm validate:tenants`            │
│   Runs the Zod parser against every tenants/*.json          │
│   Catches: bad config in repo before deploy                 │
│   PR with broken config → CI fails → can't merge            │
└─────────────────────────────────────────────────────────────┘
```

What happens when you rename `time.weekly-hours` to `time.weekly-payroll-hours`?

1. **Link 1 fires:** the registry now has `time.weekly-payroll-hours` instead. `MetricId` no longer includes `time.weekly-hours`.
2. **Link 2 fires:** every TS file that referenced `time.weekly-hours` (e.g. in `MODULE_DEFAULTS`) becomes a compile error. Build fails.
3. **Link 3 fires:** if you somehow ship anyway, the Zod parse on each tenant config that still mentions `time.weekly-hours` fails at Worker load time. The Worker returns a clean error.
4. **Link 4 fires:** the rename PR's CI catches every JSON config that still mentions the old ID. Build fails BEFORE deploy.

Three independent gates. The redundancy is the point. Configurability is cheap when the type system enforces it; catastrophic when it doesn't.

---

## 9. Why not a runtime registry from the database?

A natural question: why not store `MetricId` values in a database, look them up at runtime, and have admins add new metrics without touching code?

Because you can't render a React component from a database. The component itself is code — it has imports, JSX, hooks, state, props. You'd have to ship a runtime-evaluated DSL, which is a [Turing-complete config](https://medium.com/hackernoon/configuration-management-is-an-antipattern-e677e34be64c) and a maintenance disaster.

The right line:

- **What metrics EXIST** — code (the registry). Build-time.
- **What metrics each TENANT sees** — data (the config). Runtime.

The registry is closed; the config selects from it. New metric? Code change + deploy. New tenant configuration? Just data.

---

## 10. By the end of this doc you should know

- What a registry IS — a typed lookup table from string ID to component.
- The dumb version of the pattern (one if-else replaced by `Registry[id]`).
- `as const` — keeps literal types narrow.
- `satisfies` — type-checks the shape without widening.
- `keyof typeof X` — derives a union of an object's keys as a TS type.
- Why all three combined are the killer combo for a registry.
- The module registry, defaults map, and `resolveModuleMetrics` function.
- What lazy loading is, what code splitting is, what `React.lazy` and Suspense do.
- Why module-level lazy beats per-metric lazy for our use case.
- The four-link type-safety chain — registry, derived types, Zod schema, CI validation.
- Why the registry must be code, not data.

If `as const satisfies` still feels mysterious, [Total TypeScript's "satisfies" deep-dive](https://www.totaltypescript.com/satisfies-vs-as-vs-as-const) and [Strongly Typed Lazy Loading](https://www.totaltypescript.com/workshops/advanced-react-with-typescript/advanced-patterns/strongly-typed-lazy-loading) walk through them with more examples.

---

**Next:** `04-flags-and-pitfalls.md` — feature flags vs config (when to reach for which), the 10 common mistakes to avoid, and a complete worked example tracing Acme's config from JSON to rendered pixels.
