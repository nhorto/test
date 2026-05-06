# 02 — The Config: Schema, Validation, and Storage

> **Pre-reqs:** Read `00-start-here.md` and `01-tenant-resolution.md`.
>
> **What you'll know by the end:** What a tenant config actually contains, field by field. What a "schema" is and why we validate. What Zod is and how to use it for the basics. Where the configs physically live — JSON in our repo, vs Cloudflare KV, vs D1, vs R2 — each explained in plain English, with a clear migration path.

---

## 1. Quick recap

In doc 01 we built a Cloudflare Worker that reads the subdomain (`acme`) from the URL, looks up that tenant's config in some storage, and injects the config into the HTML so React can read it.

We waved our hands a bit at "the config." That's what this doc unpacks. Two questions:

1. **What's IN the config?** (its shape — covered in §2–3)
2. **Where does it LIVE?** (its storage — covered in §6)

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

Why have this AND a slug? Because the slug can change. A customer might rebrand and ask to move from `acme.app.example.com` to `acme-steel.app.example.com`. The slug changes, but `tenantId` stays the same — so all the data linked to them in your databases doesn't have to be renamed.

Format note: the example uses a [ULID](https://github.com/ulid/spec) (`tnt_` prefix + base32). Could also be a UUID. Either works. The point: it's not a UUID with a dash that someone might typo, and it's not the slug. Pick one and stick with it.

### 2.3 `slug`

```ts
slug: string;  // e.g. "acme"
```

The leftmost label of their subdomain. Lowercase, alphanumeric, hyphens-only. This is what the Worker extracted in doc 01.

The validator (when we build it) will enforce the format with a regex like `/^[a-z0-9-]+$/`. That prevents anyone from creating a tenant slug like `Acme!?` that breaks DNS or URLs.

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
- Their URL slug is `acme`.
- Acme sees 6 modules (`inspections` is omitted, so it doesn't render).
- In the Time panel: replace `weekly-hours` with `monthly-hours` in the same slot. Other Time metrics use defaults.
- In the Estimating panel: append `pipeline-coverage` to whatever the default Estimating metrics are.
- All other panels use defaults entirely.

That's the config. Six fields. Now we need to make sure no one writes a bad one.

---

## 4. Why validate? (And what's a "schema"?)

Imagine a developer typos `enabeledModules` (extra `e`) instead of `enabledModules` while editing `acme.json`. Without validation, here's what happens:

1. The config is saved.
2. The Worker reads it on the next request — gets back an object with `enabeledModules` as a key.
3. The Worker passes the config to React.
4. React reads `config.enabledModules` — it's `undefined` because of the typo.
5. The dashboard tries to iterate `undefined.map(...)` — boom, JavaScript error.
6. The user sees a blank screen with a stack trace in the console at best, a white-screen-of-death at worst.
7. You find out from a customer email that "Acme's dashboard is broken."

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

Now we build a Zod schema for our `TenantConfig`. Since the type uses `ModuleId` and `MetricId` (which come from the registry, doc 03), we need a way to plug those in later. Zod has `z.enum(...)` for "this string must be one of this finite list":

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
- The Worker, when it loads a config from KV (so a corrupted KV write doesn't poison the dashboard).
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

When you ever bump to v2, you add `2: (c) => ...` that takes a v1-shaped object and returns a v2-shaped one. Configs at rest stay at their existing version; they're upgraded on read. You only have to "migrate every config in storage" if you want to retire the old migration code, which you almost never need to do urgently.

---

## 6. Where does the config actually live?

Now the storage question. We have a config; where do we put it so the Worker can read it?

There are four candidates. We'll cover each one in plain English, then conclude with what to do.

### 6.1 Option A — JSON in your Git repo (the MVP path)

Put each tenant's config in a JSON file, in your repo:

```
powerfab-dashboard/
├── tenants/
│   ├── acme.json
│   ├── bobs-beams.json
│   └── cora.json
```

At build time, you bundle them all into a single import like:

```ts
// generated at build time
export const TENANT_CONFIGS = {
  acme: import('../tenants/acme.json'),
  'bobs-beams': import('../tenants/bobs-beams.json'),
  cora: import('../tenants/cora.json'),
} as const;
```

The Worker imports this map and looks up the slug there.

**Pros:**
- Zero new infrastructure.
- Configs are version-controlled — you see every change as a Git diff. Auditable.
- PR reviews on config changes. Hard to silently break a tenant.
- Easy to validate in CI — your build runs `TenantConfigSchema.parse` on every JSON file and fails the build if anything's wrong.

**Cons:**
- Every config change requires a deploy. For 5–10 tenants where you (the dev) are also the one onboarding, that's fine — you're already deploying frequently. For 200 tenants where customer-success people might want to tweak settings, it's painful.
- Configs are public-ish. Anyone with read access to the repo can see all tenants' configs. Usually fine, but not if the configs ever contain secrets.

**Verdict: this is the MVP path.** Use it for the first 5–50 tenants. Migrate when the deploy-per-config-change feels heavy.

### 6.2 Option B — Cloudflare KV

KV is a key-value store at the edge. You write `tenants:acme` → JSON blob, you read it back fast. We covered the basics in doc 00.

```ts
// Worker
const config = await c.env.TENANTS.get(`tenants:${slug}`, 'json');
```

**Pros:**
- Reads are very fast (~1ms cached, ~10ms cold).
- Updates without a deploy. Run `wrangler kv:key put tenants:acme '{...}'` from a CLI, or build a small admin dashboard later.
- Free tier is generous (100k reads/day on the free Workers plan, more on paid).

**Cons:**
- **Eventually consistent.** A write to `tenants:acme` takes up to ~60 seconds to propagate to every Cloudflare data center. For "config that changes during onboarding," fine. For "user just clicked Save, refresh page" — bad. (We'd never use KV for the latter.)
- No history. If you overwrite acme's config and want to roll back, you need your own audit log. (Pair with Git: keep `tenants/acme.json` in the repo as the source of truth and push to KV from CI on merge. Best of both worlds.)
- One write per second per key. Not a problem for tenant configs but worth knowing.

**Verdict:** graduate to this when JSON-in-repo gets painful. Common pattern: keep the source of truth in your repo (`tenants/acme.json`), have CI push it to KV on merge. Edits still go through PRs but writes happen via wrangler instead of via redeploy.

### 6.3 Option C — Cloudflare D1

D1 is a SQL database (SQLite under the hood) at the edge. Strongly consistent. Slower than KV per query but you can run real SQL.

```sql
CREATE TABLE tenants (
  slug TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  config_json TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

```ts
// Worker
const row = await c.env.DB.prepare(
  'SELECT config_json FROM tenants WHERE slug = ?'
).bind(slug).first();
const config = JSON.parse(row.config_json);
```

**Pros:**
- Strongly consistent — writes visible immediately on next read.
- Real SQL queries — useful when you want to ask "list all tenants who have Inspections enabled" without scanning 200 keys.
- Built-in change history (you can keep an `_old_configs` table, or use D1's [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) for free.)

**Cons:**
- More infrastructure than KV. You manage schemas, migrations, queries.
- Slower per read than KV (~5–30ms).
- Multi-tenant strategy decision required: shared DB with `tenant_id` column (simple, scales fine to 1000s of tenants) vs DB-per-tenant (overkill for our scale; D1 has [account-level limits on number of databases](https://developers.cloudflare.com/d1/platform/limits/)).

**Verdict:** **skip until you actually need queries.** "Look up one config by slug" is exactly what KV is for. D1 earns its place when you need things like "for the admin dashboard, paginate through tenants sorted by created_at." We're not there yet.

### 6.4 Option D — Cloudflare R2

R2 is object storage — like Amazon S3. You upload a file, you get a URL, you fetch it.

**Pros:**
- Cheap to store huge things.
- Direct downloads from a URL (good for the daily JSON snapshots — see the data ingest doc).

**Cons:**
- Not optimized for tiny per-key reads. Each fetch is an HTTP call of ~30–100ms.
- No automatic JSON parsing.
- No edge caching by default (you'd add it).

**Verdict:** **wrong tool for tenant configs.** R2 is for the per-tenant nightly JSON data snapshots (1.6 MB blobs). Configs (a few KB) belong in KV or in-repo.

### 6.5 The recommendation, summarized

| Stage | Storage | Reason |
|---|---|---|
| MVP (5–10 tenants) | JSON in repo | Zero infra. PR-reviewable. Validate in CI. |
| Growing (50+ tenants) | KV (with repo as source of truth, CI-pushed) | Edits without deploy, but Git history preserved. |
| If queries needed | Add D1 alongside KV | KV for hot reads, D1 for "admin dashboard" reporting queries. |
| Never | R2 | Wrong tool. R2 is for big blobs, not key lookups. |

For the daily data JSONs (1.6 MB per tenant per night), R2 is the right fit. We'll cover that in the data ingest plan.

---

## 7. Loading the config in the Worker

We showed the KV version in doc 01:

```ts
const config = await c.env.TENANTS.get(`tenants:${slug}`, 'json');
```

For the JSON-in-repo MVP, you'd do something like:

```ts
// At Worker build time, generate this object from tenants/*.json
import acme from '../tenants/acme.json' with { type: 'json' };
import bobs from '../tenants/bobs-beams.json' with { type: 'json' };
// ... etc

const TENANT_CONFIGS: Record<string, unknown> = {
  acme,
  'bobs-beams': bobs,
  // ...
};

// In the Worker middleware:
const raw = TENANT_CONFIGS[slug];
if (!raw) return c.text('Unknown tenant', 404);
const config = TenantConfigSchema.parse(raw);  // validate at the boundary
c.set('tenantConfig', config);
```

Notice the `TenantConfigSchema.parse(raw)` line — that's the validation. If a config file has a typo, the Worker hard-fails at this line with a useful error, instead of letting the bad config through to React.

When you graduate to KV, you swap the lookup but keep the parse:

```ts
const raw = await c.env.TENANTS.get(`tenants:${slug}`, 'json');
if (!raw) return c.text('Unknown tenant', 404);
const config = TenantConfigSchema.parse(raw);
```

Same shape, just different source. The validation step is the constant.

---

## 8. CI validation: catching typos before they ship

The other half of the validation story is at deploy time. A simple Node script that walks every JSON file in `tenants/` and parses each:

```ts
// scripts/validate-tenants.ts
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { TenantConfigSchema } from '../app/schemas/tenantConfig';

const tenantsDir = path.join(__dirname, '..', 'tenants');
const files = readdirSync(tenantsDir).filter(f => f.endsWith('.json'));

let failed = false;
for (const file of files) {
  const raw = JSON.parse(readFileSync(path.join(tenantsDir, file), 'utf8'));
  const result = TenantConfigSchema.safeParse(raw);
  if (!result.success) {
    failed = true;
    console.error(`✗ ${file}:`);
    console.error(result.error.format());
  } else {
    console.log(`✓ ${file}`);
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

In your CI workflow, run `pnpm validate:tenants` before deploying. A bad config fails the build. Production never sees it.

`safeParse` (instead of `parse`) returns a result object with `success: boolean` rather than throwing — useful when you want to validate all files before bailing, instead of stopping at the first failure.

---

## 9. By the end of this doc you should know

- What's in a `TenantConfig` — every field, what it does.
- The difference between `swapMetrics`, `addMetrics`, `removeMetrics` — and when to use each.
- What a **schema** is, conceptually.
- What **Zod** does — define a schema, get a TS type for free, validate JSON at runtime.
- Why we have a `schemaVersion` from day one and what migrations look like.
- The four storage options — JSON-in-repo, KV, D1, R2 — and which is right when.
- The MVP path: JSON-in-repo, validated at boundaries (Worker load + CI).
- The migration path: keep the repo as source-of-truth, push to KV from CI when you outgrow deploy-per-change.

If `z.record`, `z.literal`, or `z.infer` still feel mysterious, the [Zod basic usage docs](https://zod.dev/?id=basic-usage) are short and worth a 10-minute read. The mental model: Zod schemas are just JavaScript objects you build with chained methods, and they double as runtime validators and TypeScript types.

---

**Next:** `03-registry-pattern.md` — the registry pattern. The big one. The part that confused you most in the original doc, written from scratch with every TypeScript trick explained.
