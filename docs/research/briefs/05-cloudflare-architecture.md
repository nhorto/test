# Cloudflare Architecture Research Brief — PowerFab Dashboard (May 2026)

This brief covers each Cloudflare product Nick will likely touch, with 2026 numbers, beginner gotchas, and a synthesis for the PowerFab Dashboard hosting picture.

---

## 1. Cloudflare Pages

**What it is.** A git-connected static-site host with optional server functions, sitting on the same edge network as Workers.

**Use in PowerFab.** Hosts the React 19 / Vite static bundle (the dashboard SPA). Push to GitHub, Pages builds and deploys globally.

**2026 limits and pricing.**
- Free tier: unlimited sites, unlimited bandwidth, 500 builds/month, 20-minute build timeout, up to 20,000 files per deployment, 25 MiB per file.
- Pro: $20/month — more concurrent builds, longer build times, more preview deploys.
- Pages Functions (server-side routes inside a Pages project) bill on the Workers pricing model: free tier 100,000 requests/day, paid $5/month minimum.

**Gotchas.**
- The 500 builds/month free cap is per account, not per project. Auto-build-on-every-PR can burn through it fast.
- Pages Functions are Workers under the hood, but with a thinner feature set — no Cron Triggers, weaker observability, fewer bindings.
- Cloudflare's official guidance in 2026 is "for new projects, skip Pages and deploy to Workers Static Assets instead." Pages is still supported but not the strategic direction.

**Avoid when.** You need cron, queues, or full Worker bindings. In that case, use Workers with the Static Assets feature.

---

## 2. Cloudflare Workers

**What it is.** Serverless functions running on V8 isolates (not containers, not Lambdas) at every Cloudflare edge POP.

**Use in PowerFab.** The API layer — auth, tenant routing, dashboard data fetches from KV/R2/D1, wiring the nightly pipeline together. Hono is the conventional router framework.

**2026 limits and pricing.**
- Free: 100,000 requests/day, 10 ms CPU/invocation cap, 3 MB bundle size.
- Paid (Workers Standard, $5/month minimum): 10 M requests/month included, 30 M CPU-ms/month included, then $0.30 per additional million requests and $0.02 per additional million CPU-ms.
- Default per-request CPU cap: 30 seconds (raised from earlier 50 ms billing model). Configurable up to 5 minutes (300,000 ms) on paid.
- Request body limit: 100 MB on Free/Pro/Business plans (zone-level setting, not Worker-level).
- No egress/bandwidth charges. Ever.

**Hono's role.** Hono is the de facto routing framework for Workers — Express-like API, ~20 KB, written for V8 isolates. Replaces hand-rolled `fetch` switch statements. Watch its default `bodyLimit` middleware: it caps at 100 KB unless raised.

**Pages Functions vs standalone Worker.** Pages Functions = a Worker that ships with Pages assets in one deploy, fewer features. A standalone Worker in front of Pages = more flexible (cron, queues, etc.) but two deploys to manage. For PowerFab (multi-tenant, scheduled jobs), use a standalone Worker for the API and either Pages or Workers Static Assets for the SPA.

**Gotchas.**
- V8 isolates mean no Node.js standard library by default — `node_compat` flag exists but adds overhead.
- "CPU time" is wall-clock CPU, not wall-clock total. Awaiting I/O does NOT count against your 30-second budget under the new pricing model (since the 2024 "scale to zero" pricing change).
- Cold starts are roughly 5 ms. Effectively a non-issue.

**Avoid when.** You need >5 min compute, or to run binaries (C#/.NET, Python with native deps, ffmpeg). Use Containers.

---

## 3. Cloudflare KV

**What it is.** Globally-replicated, eventually-consistent key/value store. Optimized for read-heavy workloads.

**Use in PowerFab.** Tenant snapshot JSON. The C# nightly job writes one ~1.6 MB JSON blob per tenant per module to KV; the Worker reads it on dashboard requests.

**2026 limits and pricing.**
- Free: 100,000 reads/day, 1,000 writes/day, 1 GB total storage.
- Paid: $0.50 per million reads, $5.00 per million writes/lists/deletes, $0.50/GB/month stored.
- Value size: 25 MB max (raised from 10 MB).
- Key count: unlimited.
- Key length: 512 bytes; metadata: 1024 bytes.
- **Write rate ceiling: 1 write/second per unique key.** This is the gotcha — KV is not for high-frequency mutation.
- Read latency: sub-10 ms at edge after first read (cached at the POP). Cold read from origin: ~50–200 ms.
- Write propagation: up to 60 seconds globally. Eventually consistent.

**Gotchas.**
- "1 write/sec per key" means you cannot use KV as a counter or session store with frequent updates.
- After a write, a stale read from another POP can persist for up to 60 seconds. For nightly snapshots, this doesn't matter; for real-time data, it does.
- Bulk reads bill per key, not per call.

**Avoid when.** You need transactions, secondary indexes, queries, or sub-second consistency. Use D1 or Durable Objects.

---

## 4. Cloudflare D1

**What it is.** Serverless SQLite, replicated across the edge. Real SQL with ACID transactions.

**Use in PowerFab.** The control-plane database — tenant registry, user accounts, RBAC, billing state, audit logs. Anything relational and small.

**2026 limits and pricing.**
- Free: 5 GB storage, ~150 M rows read/month, ~3 M rows written/month, max 10 databases.
- Paid (with $5 Workers plan): 25 B rows read/month included, 50 M rows written/month included, then $0.001 per million rows read, $1.00 per million rows written, $0.75/GB/month stored.
- Hard ceiling: 10 GB per database. Cannot be raised. Solution = sharding (one D1 per tenant, or per group).
- Up to 50,000 databases per account.

**Gotchas.**
- Single-writer per database. Throughput = 1000/avg-query-ms. A 100 ms query caps at 10 QPS.
- The 10 GB limit is a real ceiling — design for sharding if any tenant could exceed it.
- "Rows read" includes index rows scanned during a query, not just rows returned. A bad query can consume read budget fast.

**Pick D1 over KV when.** You need joins, foreign keys, transactions, ad-hoc filtering, or row-level updates. PowerFab's tenant/user metadata belongs in D1; tenant snapshot blobs belong in KV or R2.

**Avoid when.** Single dataset >10 GB, write-heavy workloads >100 writes/sec sustained, or you need cross-region active-active.

---

## 5. Cloudflare R2

**What it is.** S3-compatible object storage with zero egress fees.

**Use in PowerFab.** Long-term archive of nightly JSON snapshots, raw data dumps, large customer file attachments, anything bigger than KV's 25 MB cap or kept around for audit.

**2026 limits and pricing.**
- Free: 10 GB storage, 1 M Class A ops/month, 10 M Class B ops/month.
- Paid: $0.015/GB/month stored, $4.50 per million Class A operations (writes/lists/multipart), $0.36 per million Class B operations (reads/heads).
- Infrequent Access tier: $0.01/GB/month stored, $9.00/M Class A.
- **Egress: $0.00.** This is the big differentiator vs S3.
- Object size: up to 4.995 TB single object (multipart).
- No bucket count cap of practical concern.

**Gotchas.**
- "Class A vs Class B" is the same model as S3. Listing a bucket is a Class A op — costs 4.5 cents per million calls but 12.5x more than reads.
- R2 is eventually consistent for some operations; strong-read-after-write is supported but cross-region replication is async.
- S3-compatible API is mostly there but a few S3 features (object lock, replication) have caveats.

**Avoid when.** You need frequent small reads from a Worker (KV is faster and has edge caching). R2 is for blobs; KV is for hot-path config and small JSON.

---

## 6. Cloudflare Containers

**What it is.** Real Linux containers running on Cloudflare's edge network, launched on-demand from a Worker. **Generally available as of April 2026.**

**Use in PowerFab.** Critical. This is where Nick's C# .NET 8 nightly binary runs. A Worker (triggered by Cron) starts the container, the container pulls customer data, transforms it, writes JSON to KV/R2, and shuts down.

**2026 limits and pricing.**
- Architecture: linux/amd64 only. .NET 8 is supported (Microsoft publishes amd64 Linux images).
- Cold start: typically 1–3 seconds, depends on image size.
- Billing: per 10 ms of active running time. Scale to zero — you pay nothing while idle.
- Workers Paid plan ($5/month) includes 25 GB-hours of RAM, 375 vCPU-minutes, and 200 GB-hours of disk per month. Overages are pay-as-you-go.
- Instance types (predefined): `lite`, `basic`, `standard-1`, `standard-2`. Custom instance types now available, capped at standard-4 specs (4 vCPU, 12 GiB RAM, 20 GB disk).
- Concurrency (Feb 2026 update, 15x increase): up to 15,000 lite, 6,000 basic, 1,500 standard-1, or 1,000 standard-2 concurrent containers per account.
- Memory pool: up to 6 TiB concurrent across instances (account-wide).
- Image registry: Cloudflare-managed. Push via `wrangler` CLI.
- Networking: containers are invoked from a Worker; outbound HTTP works. They are not a public-facing HTTP server in their own right (the Worker is the front door).

**Gotchas.**
- Cold start matters less for nightly batch jobs but matters a lot for synchronous user requests. PowerFab's nightly use case is fine.
- Disk is ephemeral. Persist to R2/KV/D1.
- No GPUs, no Windows containers, no ARM (yet).
- Image size: large .NET self-contained binaries (~80–150 MB) work but inflate cold starts. Use trimmed publish or a smaller base image.

**Avoid when.** A Worker can do the job in <30 seconds CPU. Containers exist precisely for the cases Workers can't handle.

---

## 7. Cloudflare Cron Triggers

**What it is.** Scheduled invocations of a Worker, defined in `wrangler.toml` with cron syntax.

**Use in PowerFab.** Fires the nightly orchestrator Worker, which then starts a Container per tenant (or enqueues to a Queue).

**2026 limits and pricing.**
- Cron syntax: standard 5-field. Minimum granularity: 1 minute.
- Per account: 5 triggers (Free), 250 triggers (Paid).
- No duration limit on Cron-invoked Workers (unlike fetch handlers — these run as `scheduled` handlers and can take longer).
- Pricing: same as Workers requests/CPU-ms billing.
- Propagation: cron config changes can take up to 15 minutes to take effect globally.

**Gotchas.**
- Triggers are best-effort, not guaranteed-once. Build idempotent jobs.
- Don't confuse the `scheduled` handler (cron) with the `fetch` handler (HTTP) — different code paths.
- 250 triggers/account looks generous, but at 200 tenants you don't want 200 separate cron entries. Use one cron, fan out to a Queue.

**Avoid when.** You need sub-minute scheduling. Use Durable Object alarms or a Queue with delayed messages.

---

## 8. Cloudflare Queues

**What it is.** Managed message queue with batching, retries, and DLQ.

**Use in PowerFab.** The fan-out for the nightly pipeline. Cron Worker enqueues one message per tenant; consumer Worker (or Container launcher) processes them with controlled concurrency. Smooths spikes and gives free retry semantics.

**2026 limits and pricing.**
- Free: now part of Workers Free, 10,000 ops/day, 24-hour max retention.
- Paid: $0.40 per million operations beyond free tier.
- An "operation" = each 64 KB chunk written, read, or deleted.
- Up to 10,000 queues per account.
- Default batch size: 10 messages. Default batch timeout: 5 seconds. Both configurable.
- Message size: up to 128 KB. Batch size up to 256 KB.
- Retention: up to 14 days on paid, 24 hours on free.

**Retry semantics.** Default = whole batch retries on any failure. You can mark individual messages for retry. DLQ catches messages that exceed max retries; each DLQ write counts as a write op.

**Gotchas.**
- Each retry is billed. Misconfigured consumers can burn ops fast.
- "All-or-nothing" batch retry is the default — for PowerFab, mark messages for individual retry, since one failed tenant shouldn't redrive the whole batch.

**Avoid when.** You need strict ordering or sub-second delivery. Queues is async with at-least-once semantics.

---

## 9. Cloudflare for SaaS

**What it is.** The custom-hostname / wildcard-DNS feature that lets `acme.app.example.com`, `widgets.app.example.com`, etc. all resolve to your Worker.

**Use in PowerFab.** Mandatory for the subdomain-per-tenant routing. You own `app.example.com` on Cloudflare; SaaS lets every `*.app.example.com` route to your Worker, with auto-issued TLS.

**2026 limits and pricing.**
- Free: 100 custom hostnames included on Free, Pro, and Business plans.
- Beyond that: $0.10 per custom hostname per month (lowered from $2 in 2024).
- Wildcard SAN supported on the certificate (`*.<custom-hostname>`), with the caveat that you cannot customize per-wildcard TLS settings.
- For PowerFab's pattern (you own `app.example.com`), this is actually simpler than custom-hostnames-for-customer-domains. You just need a wildcard DNS record on your zone — Cloudflare for SaaS is the TLS plumbing if you want unique certs per subdomain. For a single wildcard cert covering `*.app.example.com`, a Pro plan zone gives you that without per-hostname charges.

**Gotchas.**
- "Cloudflare for SaaS" is overloaded — the marketing name covers two cases: (a) routing your customers' own domains to your service, and (b) routing your own subdomains. For (b), wildcard certs on a Pro plan are usually all you need.
- Per-subdomain TLS, custom analytics-per-tenant, and mTLS-per-customer-domain are the cases where SaaS billing per hostname kicks in.

**Avoid when.** You're issuing only a handful of hostnames and a wildcard cert covers them.

---

## 10. Cloudflare Tunnel (cloudflared)

**What it is.** Outbound-only persistent tunnel from a customer's machine to Cloudflare's edge. The customer runs `cloudflared`, no inbound firewall rules, no public IP, no port forwarding.

**Use in PowerFab.** Cleanest way to reach the customer's MySQL (or whatever data source) from the nightly Container. Customer installs `cloudflared` once; you point your Worker/Container at a private hostname and it routes through the tunnel.

**2026 limits and pricing.**
- Free with no usage limits. Bundled with the Cloudflare Free plan.
- Pro/Business unlock advanced features (more granular access policies, longer log retention).
- Install: single binary. macOS, Linux (.deb/.rpm), Windows MSI, Docker.
- Modern setup is "remotely-managed" — the local binary just gets a token; all routing config lives in the Cloudflare Zero Trust dashboard.
- Throughput: not throttled; limited by customer's upstream bandwidth.

**Gotchas.**
- Tunnel is outbound-only on the customer side. If the customer's firewall blocks outbound HTTPS, it won't work — but that's rare.
- Authentication is via service tokens or Cloudflare Access policies. Don't expose a tunnel as a public hostname without an Access policy in front.
- The `cloudflared` process is your dependency on the customer's machine — it needs to stay running. Run as a service (systemd / launchd / Windows service), not as a foreground process.

**Avoid when.** You're already on the customer's LAN. Then there's no boundary to traverse.

---

## 11. Cloudflare Hyperdrive

**What it is.** A connection-pooler-and-cache that sits between a Worker and an external Postgres or MySQL database. Workers get short-lived connection abuse problems on traditional databases; Hyperdrive solves that with a long-lived pool near the origin DB plus optional query result caching.

**Does it apply to PowerFab?** **Yes**, exactly the right direction. Hyperdrive is for "Worker reaches into a remote database" — which is precisely the customer-MySQL case. Hyperdrive supports MySQL (added in 2025) and Postgres. It pools connections regionally close to the customer DB and reuses them across Worker invocations.

**2026 limits and pricing.**
- Included free with all Workers plans.
- Min 5 connections per pool; max varies by plan.
- Supports native drivers (`mysql2`, `postgres`, `pg`, etc.) and ORMs (Drizzle, Prisma).

**Gotchas.**
- Hyperdrive needs a network path TO the customer's DB. Combined with Cloudflare Tunnel, the path is: Worker → Hyperdrive → Tunnel → customer MySQL. Some teams skip Hyperdrive for tunneled connections because the tunnel itself terminates near Cloudflare's edge already; benchmark before assuming you need both.
- Query caching is opt-in and bypassed on writes. Don't cache user-specific queries without keying carefully.
- For PowerFab's nightly Container model (C# binary doing a bulk pull), Hyperdrive is less relevant — the Container already maintains its own connection. Hyperdrive shines for Worker-driven queries during dashboard requests, not for nightly batch pulls.

**Avoid when.** Your Worker doesn't talk to a SQL database. (Workers talking to D1 don't need Hyperdrive — D1 is already edge-local.)

---

## How these fit together for PowerFab

The hosting picture for PowerFab Dashboard, end-to-end:

**The static SPA** (React 19 + Vite + TS + Tailwind 4 build output) lives on **Cloudflare Pages** (or Workers Static Assets on a fresh project). Customers hit `acme.app.example.com`, **Cloudflare for SaaS** with a wildcard cert resolves the subdomain to your zone, and a **Worker** in front of the static assets handles tenant resolution from the subdomain, auth, and API calls. The Worker uses **Hono** as its router. **D1** holds the tenant registry, user accounts, and any small relational state (10 GB cap is fine for the foreseeable future at 200 tenants). Tenant-scoped JSON snapshots — the dashboard's hot data — live in **KV**, keyed by tenant + module, around 1.6 MB per blob; the Worker reads them in a single KV `get` per page load. Long-term archival of every nightly snapshot, plus any large file attachments, goes to **R2**.

**The nightly pipeline** is the interesting part. A **Cron Trigger** fires a "scheduler" Worker once a night. The scheduler enumerates active tenants (D1 query) and pushes one message per tenant onto a **Queue**. A consumer Worker drains the queue with controlled concurrency (say 10 at a time), and for each tenant it launches a **Container** running the C# .NET 8 binary. The container connects to the customer's MySQL via **Cloudflare Tunnel** (`cloudflared` installed on the customer's machine), pulls the data, transforms it, writes the resulting JSON to **KV** (hot path) and **R2** (archive), then exits. **Hyperdrive** is optional here — useful if you also want the dashboard Worker to query the customer DB live for real-time fields, but for pure nightly batch the Container's native MySQL driver is sufficient.

### Rough monthly cost estimate

Assumptions: 1.6 MB JSON per tenant per night, modest dashboard traffic (say 1,000 page loads/tenant/month), one nightly Container run per tenant lasting ~60 seconds at `basic` instance size (1 GiB RAM, 1/4 vCPU).

| Component | 10 tenants | 200 tenants |
|---|---|---|
| Workers Paid base | $5.00 | $5.00 |
| Workers requests | included | included |
| KV reads | included | ~$0.05 |
| KV storage | included | ~$0.50 |
| KV writes | included | ~$0.15 |
| R2 storage | ~$0.04 | ~$0.88 |
| R2 Class A ops (writes) | included | ~$0.07 |
| D1 | included | included |
| Containers | included | ~$3–8 over included |
| Queues | included | included |
| Cron Triggers | included | included |
| Cloudflare for SaaS hostnames | $0 | $10/month |
| Cloudflare Tunnel | $0 | $0 |
| Pages | $0 | $0 |
| **Estimated total** | **~$5–7/month** | **~$20–30/month** |

At 10 tenants you're effectively paying the $5 Workers minimum. At 200 tenants you're still under $50/month, dominated by the per-hostname SaaS fee and Container compute. Egress is free at every layer, which is the structural reason this stack is cheap.

The two costs to watch as you scale beyond 200: Container CPU-seconds (if nightly jobs grow past 60 seconds each), and KV write ops if you start updating snapshots more than once per night per module.
