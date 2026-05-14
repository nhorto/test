# 02 — The Config: Schema, Validation, and Storage

> **Prerequisites:** read [`00-start-here.md`](./00-start-here.md) and [`01-tenant-resolution.md`](./01-tenant-resolution.md).
>
> **By the end of this doc you will know:** what a tenant config actually contains, field by field. What a "schema" is and why we validate. What Zod is and how to use it. Where the configs physically live in a desktop app — **bundled inside the installer, fetched from a server, or delivered alongside the license key** — each explained in plain English, with a clear migration path.

---

## 1. Quick recap

In doc 01 we built an activation flow: the user pastes a license key, the app verifies it, and writes `activation.json` to the OS app-data folder. From that point on the app knows its tenant slug — e.g., `"acme"`.

But knowing "I am Acme" is only the first half. The second half is: **what does Acme actually want shown?** Which modules? Which metrics? Any per-tenant tweaks? That's what *the config* is for.

Two questions for this doc:

1. **What's IN the config?** (its shape — §2–3)
2. **Where does it LIVE in a desktop world?** (its storage — §6)

We'll also cover **schemas** and **validation** along the way (§4–5) because without them, a typo silently breaks a tenant's dashboard at 9am Monday and you find out from a customer email.

---

## 2. The shape of a tenant config

Here's the whole TypeScript type of a tenant config. It looks like a lot but it's only six fields, and the last two are optional.

```ts
// types/tenantConfig.ts
import type { ModuleId, MetricId } from '../registry';

export const CONFIG_VERSION = 1 as const;

export type ModuleOverride = {
  swapMetrics?: Array<{ remove: MetricId; add: MetricId }>;
  addMetrics?: MetricId[];
  removeMetrics?: MetricId[];
};

export type TenantConfig = {
  schemaVersion: typeof CONFIG_VERSION;
  tenantId: string;
  slug: string;
  enabledModules: ModuleId[];
  moduleOverrides?: Partial<Record<ModuleId, ModuleOverride>>;
  settings?: Record<string, unknown>;
};
```

If `ModuleId` and `MetricId` look unfamiliar — those come from the registry, which we'll build in doc 03. For now treat them as: "`ModuleId` is one of the 7 panel names ('estimating', 'time', etc.), and `MetricId` is one of the ~80 metric names ('estimating.win-rate', 'time.monthly-hours', etc.)."

Now field by field.

### 2.1 `schemaVersion`

```ts
schemaVersion: typeof CONFIG_VERSION;  // currently the literal 1
```

A number that says "this config matches version N of our schema." We start at `1`. If we ever change the shape of the config in a backward-incompatible way (rename a field, restructure something), we bump to `2` and add a migration that upgrades v1 configs to v2 on the fly.

For now, every config has `schemaVersion: 1`. Costs you nothing. Saves you a manual cross-200-tenants migration the first time you change the schema. **Always include a version in any persisted config from day one** — this is one of those things where ignoring the cheap day-one habit costs you a weekend three years later.

We'll cover the migration mechanic in §5.

### 2.2 `tenantId`

```ts
tenantId: string;  // e.g. "tnt_01HZX3K..."
```

A stable, opaque identifier for the tenant. Generated when the tenant is created. Never displayed to end users.

Why have this AND a slug? Because the slug can change. A customer might rebrand and ask to move from `acme` to `acme-steel`. The slug changes, but `tenantId` stays the same — so logs, support tickets, and anything else keyed by the tenant don't have to be renamed.

Format note: the example uses a [ULID](https://github.com/ulid/spec) (`tnt_` prefix + base32). Could also be a UUID. Either works. Pick one and stick with it.

### 2.3 `slug`

```ts
slug: string;  // e.g. "acme"
```

The short, human-friendly identifier for the tenant. Lowercase, alphanumeric, hyphens-only. This is the same string that lives inside the license key's payload (see doc 01, §4).

Why is the slug in the config too, when the license key already has it? Because the config has to be physically *paired* with a specific tenant. When the app loads `acme.json`, the first thing the parser should verify is "the slug inside this file matches the slug we just activated as." If they don't match, something went very wrong (wrong file bundled, wrong file downloaded, corrupted activation) and we should refuse to start.

The validator (when we build it) will enforce the slug's format with a regex like `/^[a-z0-9-]+$/`. That prevents anyone from creating a tenant slug like `Acme!?` that breaks filenames or log lines.

### 2.4 `enabledModules`

```ts
enabledModules: ModuleId[];
// e.g. ["estimating", "productionControl", "time", "purchasing", "inventory"]
```

The list of modules (panels) this tenant gets to see. The order in this array is the order they render in the dashboard.

If a `ModuleId` is **not** in this array, that whole panel doesn't render for this tenant. They never see it. There's no "this module is hidden but coming soon" — just absent.

For Acme, who doesn't have Inspections, the array would be the 6 they DO have, with `inspections` simply omitted.

### 2.5 `moduleOverrides` (optional)

```ts
moduleOverrides?: Partial<Record<ModuleId, ModuleOverride>>;
```

This is where you customize what's INSIDE a module for this tenant. If you don't include this field at all, every enabled module shows its defaults.

`Partial<Record<ModuleId, ModuleOverride>>` reads as: "an object where keys are `ModuleId`s and values are `ModuleOverride`s, but you don't have to include every key — just the ones you want to override."

So a config might have:

```ts
moduleOverrides: {
  time: { swapMetrics: [...] }
  // estimating, productionControl, etc. all use defaults
}
```

`ModuleOverride` itself has three optional sub-fields:

```ts
type ModuleOverride = {
  swapMetrics?: Array<{ remove: MetricId; add: MetricId }>;
  addMetrics?: MetricId[];
  removeMetrics?: MetricId[];
};
```

- **`swapMetrics`** — replace a default metric with a different one in the same slot. Order is preserved. Example: in the Time panel's default list, `time.weekly-hours` is in slot 3. Acme wants `time.monthly-hours` instead. Putting `{ remove: 'time.weekly-hours', add: 'time.monthly-hours' }` in `swapMetrics` puts `time.monthly-hours` in slot 3.

- **`addMetrics`** — add metrics that aren't in the default list. Always appended to the end. Useful when you build a new metric specifically for one tenant and don't want it on by default.

- **`removeMetrics`** — hide a metric without replacing it. The slot is just gone.

You can use any combination. None of them are required.

### 2.6 `settings` (optional)

```ts
settings?: Record<string, unknown>;
```

A loose grab-bag for things that aren't worth having a dedicated field for yet. `Record<string, unknown>` means "an object whose keys are strings and whose values can be anything."

Examples of what might end up here:
- `settings.flags` — feature flags (covered in doc 04)
- `settings.fiscalYearStart` — tenant-specific date math
- `settings.currency` — when we eventually go international
- `settings.refreshIntervalSeconds` — how often live data auto-refreshes for this tenant

Why a grab-bag instead of typed fields? Because adding a typed field everywhere it's referenced is real work. Putting one-off settings under `settings` lets you experiment without that work, and graduate to a typed field once a setting earns its keep (used by 3+ tenants, hits 3+ places in code).

Don't abuse it. Anything that's *core* to the schema gets its own typed field.

---

## 3. A concrete example

Here's Acme's full config:

```jsonc
{
  "schemaVersion": 1,
  "tenantId": "tnt_01HZX3K2A8N1B...",
  "slug": "acme",
  "enabledModules": [
    "estimating",
    "productionControl",
    "projectManagement",
    "time",
    "purchasing",
    "inventory"
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

What this says, in plain English:

- This config is version 1.
- The tenant's stable ID is `tnt_01HZX3K...`.
- Their slug is `acme`.
- Acme sees 6 modules (`inspections` is omitted, so it doesn't render).
- In the Time panel: replace `weekly-hours` with `monthly-hours` in the same slot. Other Time metrics use defaults.
- In the Estimating panel: append `pipeline-coverage` to whatever the default Estimating metrics are.
- All other panels use defaults entirely.

That's the config. Six fields. Now we need to make sure no one writes a bad one.

---

## 4. Why validate? (And what's a "schema"?)

Imagine a developer typos `enabeledModules` (extra `e`) instead of `enabledModules` while editing `acme.json`. Without validation, here's what happens:

1. The config is saved (committed or uploaded — depends on storage).
2. The desktop app loads the file on next launch — gets back an object with `enabeledModules` as a key.
3. React reads `config.enabledModules` — it's `undefined` because of the typo.
4. The dashboard tries to iterate `undefined.map(...)` — boom, JavaScript error.
5. The user sees a blank screen with an error in the console at best, a white-screen-of-death at worst.
6. You find out from a customer email that "Acme's dashboard is broken."

The cost of a typo is hours of debugging plus a customer relations hit. The fix is to **validate** the config — check it matches the expected shape — before storing or using it.

A **schema** is just a description of what shape data must have. "An object with `schemaVersion: 1` and a string `slug` and a string `tenantId` and an array of allowed `ModuleId`s under `enabledModules`..." That description, written down in code, is the schema.

A schema lets us write code that says: "Here's a JSON blob someone wrote — match it against the schema. If it doesn't match, throw an error and tell me exactly which field is wrong." Now a typo gets caught immediately, with a useful error message, instead of silently breaking the dashboard.

There are several libraries for writing schemas in TypeScript. We're using **Zod** because it's the most popular, has the best ecosystem, and the API is approachable.

---

## 5. Zod, the basics

[Zod](https://zod.dev/) is a TypeScript library where you define schemas using a chained method API. The two things every Zod call does:

1. **Defines a schema** (a description of valid data).
2. **Gives you a `.parse(data)` function** that throws if `data` doesn't match.

The simplest example:

```ts
import { z } from 'zod';

const PersonSchema = z.object({
  name: z.string(),
  age: z.number(),
});

const valid = PersonSchema.parse({ name: 'Alice', age: 30 });
// valid is now typed as { name: string; age: number }

const invalid = PersonSchema.parse({ name: 'Bob' });
// throws ZodError: "age: Required"
```

`z.object`, `z.string`, `z.number` are Zod's building blocks. There are many more — `z.array(...)`, `z.literal(1)`, `z.enum([...])`, `z.optional(...)`, `z.union([...])`, etc. — and you compose them like Lego.

### 5.1 The TenantConfig schema

Now we build a Zod schema for our `TenantConfig`. Since the type uses `ModuleId` and `MetricId` (which come from the registry, doc 03), we need a way to plug those in. Zod has `z.enum(...)` for "this string must be one of this finite list":

```ts
// schemas/tenantConfig.ts
import { z } from 'zod';
import { MODULES, METRICS, type ModuleId, type MetricId } from '../registry';

// The full list of module IDs and metric IDs becomes a Zod enum.
// Object.keys(MODULES) is something like ['estimating', 'productionControl', ...].
// We assert that to a tuple type because z.enum needs at least one element.
const ModuleIdSchema = z.enum(Object.keys(MODULES) as [ModuleId, ...ModuleId[]]);
const MetricIdSchema = z.enum(Object.keys(METRICS) as [MetricId, ...MetricId[]]);

const ModuleOverrideSchema = z.object({
  swapMetrics: z.array(z.object({
    remove: MetricIdSchema,
    add: MetricIdSchema,
  })).optional(),
  addMetrics: z.array(MetricIdSchema).optional(),
  removeMetrics: z.array(MetricIdSchema).optional(),
});

export const TenantConfigSchema = z.object({
  schemaVersion: z.literal(1),
  tenantId: z.string(),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  enabledModules: z.array(ModuleIdSchema),
  moduleOverrides: z.record(ModuleIdSchema, ModuleOverrideSchema).optional(),
  settings: z.record(z.unknown()).optional(),
});

export type TenantConfig = z.infer<typeof TenantConfigSchema>;
```

A few notes:

- **`z.literal(1)`** — must be exactly the number `1`, not "any number." This is the schema-version pin.
- **`z.string().regex(/^[a-z0-9-]+$/)`** — string AND must match the regex. Catches `Acme!?` slug typos.
- **`z.record(ModuleIdSchema, ModuleOverrideSchema)`** — an object whose keys must be valid `ModuleId`s. So `moduleOverrides: { wrong_module: ... }` would fail.
- **`z.infer<typeof TenantConfigSchema>`** — Zod's TypeScript magic. Computes the TS type from the schema. Means you write the schema once and the TS type comes for free, with no risk of the two drifting apart.

Now, parsing a config blob:

```ts
import { TenantConfigSchema } from './schemas/tenantConfig';
import rawAcmeConfig from '../tenants/acme.json';

const acmeConfig = TenantConfigSchema.parse(rawAcmeConfig);
// If valid, acmeConfig is fully typed.
// If invalid, parse throws a ZodError with a clear message.
```

We'll call this from two places:
- The desktop app, when it loads a config (so a corrupted local file doesn't poison the dashboard).
- A CI script, when we commit a config change to the repo (so a typo fails the build, not production).

### 5.2 Schema versioning, in practice

Earlier we said `schemaVersion: 1` from day one, with a migration step. Concretely:

```ts
// schemas/tenantConfig.ts (continued)

const migrations: Record<number, (cfg: any) => any> = {
  1: (c) => c,  // identity — no migration needed yet
  // 2: (c) => ({ ...c, newField: 'default' }),  // future
};

const CONFIG_VERSION = 1;

export function loadTenantConfig(raw: unknown): TenantConfig {
  // Walk migrations from whatever version `raw` is at, up to current.
  let cur: any = raw;
  const fromVersion = cur?.schemaVersion ?? 1;
  for (let v = fromVersion; v < CONFIG_VERSION; v++) {
    cur = migrations[v + 1](cur);
  }
  return TenantConfigSchema.parse(cur);
}
```

When you ever bump to v2, you add `2: (c) => ...` that takes a v1-shaped object and returns a v2-shaped one. Configs at rest stay at their existing version; they're upgraded on read. Means you don't need to "migrate every config in storage" simultaneously — old configs continue to work and get upgraded as they're loaded.

---

## 6. Where does the config actually live? (Desktop version)

This is the section that changed the most from the old plan. On the web it was Cloudflare KV / D1 / R2. On the desktop the options are different. There are **four** candidates worth considering:

### 6.1 Option A — Bundled inside the app (the MVP path)

Put each tenant's config in a JSON file in your repo, and bundle them all into the app at build time:

```
dashboard/
├── src/
│   └── tenants/
│       ├── acme.json
│       ├── bigshop.json
│       └── cora.json
```

In your code:

```ts
// generated at build time
import acme from './tenants/acme.json';
import bigshop from './tenants/bigshop.json';
import cora from './tenants/cora.json';

export const TENANT_CONFIGS: Record<string, unknown> = {
  acme, bigshop, cora,
};
```

When the app activates as `acme`, it just looks up `TENANT_CONFIGS['acme']`, runs Zod parse on it, and uses the result.

**Pros.**
- Zero new infrastructure. No server, no API.
- Configs are version-controlled — you see every change as a Git diff.
- PR reviews on config changes. Hard to silently break a tenant.
- Easy to validate in CI — your build runs `TenantConfigSchema.parse` on every JSON file and fails the build if anything's wrong.
- Works offline. The user's app doesn't need to phone home to know what to render.

**Cons.**
- Every config change requires shipping a new app version through the auto-updater. Not "deploy in 30 seconds" like a web app — closer to "wait for the user to be online for the next auto-update poll, plus their restart." Acceptable, but slow.
- The set of all 200 tenant configs ends up bundled in every install, so every customer can technically see what other customers' configs look like (they're inside their install's `.exe` if they dig). Usually not a real problem, but worth noting.

**Verdict: this is the MVP path.** Use it until you have so many config changes that "wait for the next release" starts hurting.

### 6.2 Option B — Fetched from a tiny config server we run

Same `acme.json`, but instead of bundling it, the app fetches it on startup from a small HTTPS endpoint we host:

```
GET https://config.dashboard.example.com/tenants/acme.json
```

The app caches the response locally so it works offline after the first fetch. On every launch it tries to fetch a fresh copy; if the network fails, it falls back to the cache.

**Pros.**
- Update a tenant's config without shipping a new app version. Push a JSON file, customers see the change on their next launch.
- Smaller installer (only the active tenant's config travels with the user, not all 200).
- Other customers' configs are not on every user's machine.

**Cons.**
- We have to host and monitor a tiny server. Could be as simple as static files in S3/R2 + CloudFront, but it's still a thing to keep up.
- Requires network on first launch (to fetch the initial config). Subsequent launches use the cache.
- A bad config push instantly affects everyone. (Mitigate with the same CI validation as Option A.)

**Verdict.** Graduate to this when bundled config gets painful. Pattern: keep `tenants/*.json` in the repo as the source of truth, have CI publish them to the config server on merge. Same Git-based workflow, just different delivery.

### 6.3 Option C — Delivered alongside the license key

Embed the entire config in the JWT payload that the user pastes during activation:

```jsonc
// JWT payload
{
  "tenant": "acme",
  "gateway_url": "http://10.0.5.20:8080",
  "exp": 1799999999,
  "config": { /* the full TenantConfig here */ }
}
```

The activation flow extracts `config`, validates it with Zod, saves it to `activation.json`. No bundled configs, no config server.

**Pros.**
- The user only ever sees their own config — even on disk inside the app.
- No bundled configs to ship; the installer is smaller and cleaner.
- Single source of truth: the JWT carries identity AND config together. To update either, reissue the key.

**Cons.**
- JWTs get **long**. The full `acme.json` example above plus encoding overhead is ~1.5 KB. JWTs of that size are awkward to email — they wrap weirdly, users copy them wrong, paste fails. Tolerable up to ~500 bytes; painful past 1 KB.
- A config change means reissuing the user's license key. For 30 employees per shop, that's annoying.
- You can't tweak a config quickly. Have to mint a new key, send it, ask user to re-enter.

**Verdict.** Cute trick. Works only if your configs are very small. Not the default — but useful for tiny tenants or for delivering just the parts of the config that vary per-tenant (with the rest bundled).

### 6.4 Option D — Delivered by the gateway

Since every tenant has their own data gateway running inside their network (see doc 05), the gateway can serve the config too:

```
GET http://10.0.5.20:8080/config
```

The desktop app, after activation, hits the gateway for its config.

**Pros.**
- One service to talk to. The app already calls the gateway for data; it can call the same gateway for config.
- The customer can theoretically tweak their own config locally without our involvement (advanced, opinionated, possibly bad — depends on whether you want them to).
- Configs travel with the data network they belong to.

**Cons.**
- Couples the config to the gateway being up. If the gateway is down, the app can't even render the right modules — it has nothing to fall back to.
- Customers editing their own configs sounds nice and ends up being a support nightmare. ("Why doesn't this metric exist anymore? Oh, you removed it last week.")
- Doesn't help offline.

**Verdict.** Avoid unless you have a strong reason. The gateway should serve *data*, not configuration. Keep configs separate.

### 6.5 The recommendation, summarized

| Stage | Storage | Reason |
|---|---|---|
| MVP (5–20 tenants) | Bundled in the app | Zero infra. PR-reviewable. Validate in CI. Works offline. |
| Growing (20+ tenants) | Fetched from a config server (repo as source of truth, CI publishes) | Edits without shipping a new app version, but Git history preserved. |
| Tiny config + few tenants | Delivered in the license key | Single source of truth, but limited to ~500 bytes of config. |
| Avoid | Gateway-served config | Couples config to data infrastructure. |

For our case, **start with bundled (A) and migrate to fetched (B) when you outgrow it.**

---

## 7. Loading the config in the app

For the bundled MVP, the React side looks something like this:

```ts
// src/loadTenantConfig.ts
import { invoke } from '@tauri-apps/api/core';
import { TenantConfigSchema, type TenantConfig } from './schemas/tenantConfig';
import acme from './tenants/acme.json';
import bigshop from './tenants/bigshop.json';

const TENANT_CONFIGS: Record<string, unknown> = { acme, bigshop };

export async function loadTenantConfig(): Promise<TenantConfig> {
  // Doc 01 stored the activated tenant slug; ask Rust for it.
  const tenantSlug = await invoke<string>('get_activated_tenant');

  const raw = TENANT_CONFIGS[tenantSlug];
  if (!raw) {
    throw new Error(`No bundled config for tenant "${tenantSlug}". Reinstall the app.`);
  }
  return TenantConfigSchema.parse(raw);
}
```

Notice the `TenantConfigSchema.parse(raw)` line — that's the validation. If a config file has a typo, the app hard-fails at this line with a useful error.

When you graduate to fetched configs (Option B), you swap the lookup but keep the parse:

```ts
const tenantSlug = await invoke<string>('get_activated_tenant');
const response = await fetch(`https://config.dashboard.example.com/tenants/${tenantSlug}.json`);
const raw = await response.json();
return TenantConfigSchema.parse(raw);
```

Add caching on top (write the fetched config to disk via a Tauri command, fall back to it on network failure). Same shape, just a different source. The validation step is the constant.

---

## 8. CI validation: catching typos before they ship

The other half of the validation story is at build/release time. A simple Node script that walks every JSON file in `src/tenants/` and parses each:

```ts
// scripts/validate-tenants.ts
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { TenantConfigSchema } from '../src/schemas/tenantConfig';

const tenantsDir = path.join(__dirname, '..', 'src', 'tenants');
const files = readdirSync(tenantsDir).filter(f => f.endsWith('.json'));

let failed = false;
for (const file of files) {
  const raw = JSON.parse(readFileSync(path.join(tenantsDir, file), 'utf8'));
  const result = TenantConfigSchema.safeParse(raw);
  if (!result.success) {
    failed = true;
    console.error(`X ${file}:`);
    console.error(result.error.format());
  } else {
    console.log(`OK ${file}`);
  }
}

if (failed) process.exit(1);
```

In `package.json`:

```json
{
  "scripts": {
    "validate:tenants": "tsx scripts/validate-tenants.ts"
  }
}
```

In your CI workflow, run `npm run validate:tenants` before building installers. A bad config fails the build. No customer ever installs an app with a broken config.

`safeParse` (instead of `parse`) returns a result object with `success: boolean` rather than throwing — useful when you want to validate all files before bailing, instead of stopping at the first failure.

---

## 9. By the end of this doc you should know

- What's in a `TenantConfig` — every field, what it does.
- The difference between `swapMetrics`, `addMetrics`, `removeMetrics` — and when to use each.
- What a **schema** is, conceptually.
- What **Zod** does — define a schema, get a TS type for free, validate JSON at runtime.
- Why we have a `schemaVersion` from day one and what migrations look like.
- The four storage options in the desktop world — bundled, server-fetched, license-key-delivered, gateway-served — and which is right when.
- The MVP path: bundle configs in the app, validate at boundaries (load time + CI).
- The migration path: introduce a config server when "ship a new release for every config change" stops scaling.

If `z.record`, `z.literal`, or `z.infer` still feel mysterious, the [Zod basic usage docs](https://zod.dev/?id=basic-usage) are short and worth a 10-minute read. The mental model: Zod schemas are just JavaScript objects you build with chained methods, and they double as runtime validators and TypeScript types.

---

**Next:** [`03-registry-pattern.md`](./03-registry-pattern.md) — the registry pattern, in detail. The most TypeScript-heavy doc in the series.
