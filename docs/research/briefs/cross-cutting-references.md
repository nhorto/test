# PowerFab Dashboard — Cross-Cutting Reference Research

Research brief covering reference repos, templates, and patterns to inform explainer docs 05–09. Project names only; Nick can search for them himself.

---

## 1. Cloudflare Workers + Hono Multi-Tenant Templates

| Project name | What it demonstrates | Maturity | Strengths | Weaknesses for our purpose |
|---|---|---|---|---|
| `honojs/hono` examples directory | `hono` framework idioms; subrouter patterns by hostname; middleware ordering | Very active, ~60k stars | Canonical Hono patterns; clear middleware story | Examples are toy-sized; no real tenant config injection |
| `cloudflare/templates` (worker-router-multitenant) | Host-based routing with `request.headers.get('host')` | Maintained, official | Official patterns Nick can trust | Ships skeleton only; no UI layer |
| `kristianfreeman/multi-tenant-cloudflare` | Subdomain → tenant lookup → KV config fetch → HTML rewrite | Older (2023), ~400 stars, low recent activity | Demonstrates exactly the pattern Nick needs | No tests, no CI, no Pages integration |
| `cloudflare/workers-sdk` (templates/) | Bindings, Wrangler config, Worker-fronts-Pages routing rules | Very active, official | Authoritative on bindings syntax | Multi-tenancy not the focus |
| `Effect-TS/examples` (cloudflare-workers) | Hono + Effect on Workers; service composition | Active, growing | Shows clean separation of services from handlers | Adds Effect cognitive load; probably overkill |

Primary takeaway: there is **no canonical** "Hono + subdomain-per-tenant + Pages-static-frontend" reference. Nick will be assembling this from `honojs/hono` middleware idioms + `cloudflare/templates` Worker-fronts-Pages pattern.

---

## 2. Cloudflare Pages + Workers Full-Stack Starters

| Project name | What it demonstrates | Maturity | Strengths | Weaknesses for our purpose |
|---|---|---|---|---|
| `cloudflare/templates` (vite-react) | Vite + React on Pages with a Worker for API | Active, official | Wrangler config is current; uses `_routes.json` correctly | API is one file; doesn't model tenant injection |
| `Hugos68/vite-plugin-cloudflare-functions` starters | Vite plugin that proxies to Workers locally | Maintained | Solves the dev-loop pain (local Vite + local Worker) | Plugin-specific; not a full architecture |
| `cloudflare/workers-sdk` create-cloudflare CLI templates | Scaffolds React/Vite/Astro/Remix on Workers Static Assets | Active, official | The "Static Assets on Workers" path supersedes Pages for new projects | New enough that ecosystem docs lag |
| `built-with-workers` showcase repos | One-off real apps shipping on Workers | Mixed | Shows what production deployments look like | Wildly varying quality |
| `remix-run/example-cloudflare-pages` (and Astro/Next equivalents) | Framework-on-Pages adapters | Active | Useful for understanding how SSR adapters bind to Workers runtime | Nick is SPA-only; SSR irrelevant |

Note: Cloudflare's "Static Assets on Workers" is now the recommended path over Pages for new projects. The 05 explainer should mention this since "Pages vs Workers Static Assets" is a real fork in the road.

---

## 3. Multi-Tenant SaaS Architecture References (Hosting-Agnostic)

| Project name | What it demonstrates | Maturity | Strengths | Weaknesses for our purpose |
|---|---|---|---|---|
| `nextjs/saas-starter` (Vercel) | Subdomain routing, tenant signup, billing | Very active | Clean tenant-resolution middleware | Vercel-coupled; Next.js, not Vite |
| `vercel/platforms` (formerly `platforms.so`) | Multi-tenant subdomain platform with custom-domain support | Active, ~5k stars | Best public reference for subdomain → tenant config flow | Built around Vercel edge middleware |
| `calcom/cal.com` | Real production multi-tenant SaaS | Very active, ~30k+ stars | Production-grade tenant-org-user model; thoughtful schema | Massive codebase; intimidating to skim |
| `documenso/documenso` | Multi-tenant doc-signing SaaS | Active | Smaller than Cal.com; readable in a weekend | DB-driven tenancy, not config-file-driven |
| `formbricks/formbricks` | Multi-tenant survey SaaS | Active | Clean modular UI registry pattern | Heavier than Nick needs |
| `forge42dev/base-stack` | Opinionated multi-tenant React Router v7 stack | Newer, growing | Tenant resolution patterns in modern React idiom | Not battle-tested |

For "registry-driven UI" specifically, `formbricks` and `cal.com` both have plugin/feature-flag systems worth skimming. There is no public repo I'd point to as "this is exactly the registry pattern Nick is building" — closest analogue below in the gaps section.

---

## 4. Cloudflare R2 + Workers Patterns

| Project name | What it demonstrates | Maturity | Strengths | Weaknesses for our purpose |
|---|---|---|---|---|
| `cloudflare/workers-sdk` r2 examples | Bucket bindings; `put`/`get`/`list` syntax | Active, official | Authoritative API surface | Doesn't show atomic-manifest patterns |
| `kotx/render` | R2-backed static hosting Worker | Maintained | Solid `list` + `head` + `get` patterns; conditional requests | Read-only; no manifest-write concerns |
| `cloudflare/r2-migrator` | Bulk R2 writes from a Worker | Official-ish | Useful for understanding throughput limits | Migration tool, not nightly-pipeline shape |
| `Cherry/r2-tools` and similar utilities | Small CLI/Worker combos hitting R2 | Mixed maturity | Shows write-then-read consistency notes | None demonstrate the "manifest.json swap" atomic pattern Nick needs |

The "atomic manifest" pattern (write data files, then write manifest last) is folklore — Nick will need to invent it and document it. The closest precedent is how static-site generators write to S3 (write all assets, then update `index.html` last), which `kotx/render` reads but doesn't write.

---

## 5. Cron Triggers + Queues + Containers Orchestration

| Project name | What it demonstrates | Maturity | Strengths | Weaknesses for our purpose |
|---|---|---|---|---|
| `cloudflare/workers-sdk` cron examples | Scheduled handler basics | Official | Correct `scheduled()` signature | Cron only; no Queues |
| `cloudflare/queues-demo` | Producer/consumer with Queues | Maintained | DLQ patterns; batch sizing | Queues only; no Containers |
| `cloudflare/containers-template` | Cloudflare Containers (still newish) | Active, official, evolving | The official starting point | API still stabilizing — patterns may shift |
| `terraform-provider-cloudflare` examples | Cron + Queues bound to Workers via IaC | Active | Shows binding configuration | Not an end-to-end app |

**No public repo composes all three (Cron → Queue → Container).** This is genuinely cutting-edge territory. The right reference is to study each primitive in isolation, then read Cloudflare's blog posts on the Containers GA announcement.

---

## 6. C# .NET 8 Container-as-Job Patterns

| Project name | What it demonstrates | Maturity | Strengths | Weaknesses for our purpose |
|---|---|---|---|---|
| `dotnet/dotnet-docker` samples | Minimal runtime images; `aot` and `chiseled` variants | Very active, official | Smallest production images | Not job-shaped |
| `Azure-Samples/container-apps-jobs` | .NET 8 short-lived jobs reading DB → writing storage | Active | The closest match to Nick's nightly pipeline | Azure-coupled, but the Dockerfile and `Program.cs` shape transfer cleanly |
| `dotnet/eShop` (event-driven services) | Worker services in containers | Very active | Modern .NET 8 hosting idioms | Long-running, not job-shaped |
| `aws-samples/dotnet-fargate-batch` | Fargate-run .NET batch jobs | Maintained | Read-DB → transform → upload-S3 is structurally identical to Nick's plan | AWS-specific bindings |
| `fly-apps/dotnet-job-runner` (community) | Fly Machines running .NET on cron | Mixed | Shorter-lived than Container Apps; closer to Cloudflare Containers' execution model | Less mature |

**The Azure Container Apps Jobs sample is the highest-value read** — its Dockerfile, `IHostedService` shutdown semantics, and "exit cleanly with code 0" patterns will translate one-for-one to Cloudflare Containers when Nick gets there.

---

## 7. Cloudflare Tunnel as Customer-Premises Agent

| Project name | What it demonstrates | Maturity | Strengths | Weaknesses for our purpose |
|---|---|---|---|---|
| `cloudflare/cloudflared` | The daemon itself; Windows service install | Very active, official | Authoritative on install/upgrade flow | Not a tutorial |
| `cloudflare/argo-tunnel-examples` | Hello-world tunnels for various backends | Older but valid | MySQL/Postgres examples exist | Examples are minimal |
| Cloudflare Zero Trust reference architectures (whitepapers) | Tunnel for private database access | Active | Industry vocabulary Nick will need when talking to customer IT | PDFs, not code |

There is **no clean, well-known repo** showing "Worker → Tunnel → on-prem MySQL" end-to-end with auth and connection pooling. This is the single biggest gap. Closest analogues: Tailscale's documentation patterns (different VPN model but same mental shape), and `planetscale/database-js` (HTTP-fronting a MySQL-compatible DB, which is structurally what Nick will end up doing through a Tunnel-fronted HTTP shim).

---

## 8. TanStack Query + Cloudflare Workers Patterns

| Project name | What it demonstrates | Maturity | Strengths | Weaknesses for our purpose |
|---|---|---|---|---|
| `TanStack/query` examples directory | Query keys, Suspense, prefetching | Very active, official | Canonical patterns | Backend-agnostic; no Worker specifics |
| `t3-oss/create-t3-app` | tRPC + TanStack Query end-to-end | Very active | Shows query-key conventions in production-shaped app | Not on Cloudflare; Next.js |
| `honojs/hono` + `hono/client` (`hc`) examples | Type-safe RPC client pattern | Active | Pairs naturally with TanStack Query | Sparse query-cache examples |
| `jasonkuhrt/graffle` and similar | Edge-friendly fetch wrappers | Mixed | Auth-header injection patterns | Niche |

For "per-tenant cache scoping" specifically: there is no canonical reference. The pattern Nick wants — query keys prefixed with `tenantId`, plus a `QueryClient` reset on tenant switch — is community-known but not in any starter. He'll write the doc himself; the closest analogue is multi-workspace patterns in `cal.com`.

---

## 9. Tenant-Config-as-JSON-in-Repo Patterns

| Project name | What it demonstrates | Maturity | Strengths | Weaknesses for our purpose |
|---|---|---|---|---|
| `vercel/turborepo` workspace configs | JSON-with-schema, validated in CI via Zod/JSON Schema | Very active | Excellent schema-evolution discipline | Not tenant-shaped |
| `kubernetes/kubernetes` `OWNERS` files + config | Per-directory JSON/YAML validated in CI | Very active | Battle-tested pattern for "config files own a slice of the system" | YAML, not JSON; conventions verbose |
| `withastro/astro` `astro.config` ecosystem | Schema-validated config with TS types | Very active | Beautiful Zod-driven config validation | Single-tenant |
| `stripe/stripe-cli` fixtures | JSON fixtures validated against API schema | Active | Good "fixture-as-source-of-truth" pattern | Not tenant config |

**Good config schema traits to emulate:** required `version` field; explicit `$schema` pointer; closed unions for enum-like fields; never-allow-extra-keys (`additionalProperties: false`); separate "stable" and "experimental" sections.

**Bad traits to avoid:** free-form `metadata: {}` blobs; implicit defaults that change between releases; nested config that varies in shape based on a sibling field's value.

---

## 10. Multi-Tenant Data Isolation Testing

| Project name | What it demonstrates | Maturity | Strengths | Weaknesses for our purpose |
|---|---|---|---|---|
| `cal.com` test suite (e2e) | Cross-org access denial tests | Active | Real, readable assertions like "user A cannot read org B's bookings" | Buried in a huge test tree |
| `supabase/supabase` RLS test suites | Postgres row-level-security smoke tests | Very active | Best-in-class for DB-layer isolation | Postgres-specific; Nick is read-only on customer DBs |
| `pomerium/pomerium` policy tests | Per-tenant policy decisions | Active | Clean fuzz-style tenant-mixing tests | Auth-proxy domain, not data |
| `osohq/oso` examples | Authorization tests with explicit tenant fixtures | Maintained | Readable "given tenant X, deny access to Y" assertions | Library, not full app |

The `supabase` RLS tests are the gold standard for "prove tenant A cannot see tenant B's data." Nick should read these even though his isolation model is different (subdomain + Worker binding rather than DB row-level security) — the *test shape* transfers.

---

## What to Read First (Prioritized)

1. **`vercel/platforms`** — clearest public example of subdomain-per-tenant routing end-to-end. Read it for the *shape* of tenant resolution; ignore the Vercel-specifics. ~1 hour.
2. **`honojs/hono` examples directory** — internalize Hono middleware ordering before writing 05. ~30 min.
3. **`cloudflare/templates` vite-react template** — the actual scaffolding Nick will start from. Clone it, run it, deploy a hello-world. ~1 hour hands-on.
4. **Azure Container Apps Jobs .NET 8 sample** — the structural template for the C# nightly binary. Read the Dockerfile and `Program.cs`. ~45 min.
5. **`cal.com` tenant-resolution middleware + a couple of e2e isolation tests** — production-grade patterns at scale. Skim, don't read fully. ~1 hour.
6. **`supabase` RLS test suite** — to inform 08 (isolation testing). Read 3–4 test files. ~30 min.
7. **`kotx/render`** — for R2 read patterns before writing 07. ~20 min.
8. **`TanStack/query` Suspense + prefetch examples** — to inform 09. ~30 min.

Total: roughly one focused weekend of reading.

---

## What Doesn't Exist That I Wish Did

1. **"Cloudflare Worker fronting Pages with per-subdomain config injection"** — no canonical repo. Nick is on the frontier. Closest analogue: `vercel/platforms` (wrong host, right shape).
2. **"Cron → Queue → Container nightly pipeline on Cloudflare"** — Cloudflare Containers is too new for a public end-to-end reference. Closest analogue: any AWS Step Functions + Fargate + EventBridge tutorial; ignore AWS specifics, keep the orchestration mental model.
3. **"Cloudflare Tunnel from Worker to on-prem MySQL with connection pooling"** — genuinely no good reference. Nick will document this himself for 06. Closest analogue: PlanetScale's HTTP-over-MySQL driver as a *concept*.
4. **"Per-tenant TanStack Query cache with auth-context-aware invalidation"** — pattern exists in scattered blog posts only. Nick should write the canonical version in 09.
5. **"Validate-tenant-JSON-in-CI for a SaaS"** — every team invents this; no shared reference. Closest analogue: Astro's Zod-driven config validation.
6. **"Registry-driven module UI for SaaS"** — `formbricks` plugin system is the closest, but it's heavier than what Nick wants. He's inventing the lightweight version.

The pattern: Nick is integrating well-known primitives in a configuration the open-source world hasn't documented end-to-end yet. Each individual primitive has a canonical reference; the *composition* is his to write down.
