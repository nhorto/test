# 05 — Cloudflare Architecture: What Each Product Does and How They Fit Together

> **Pre-reqs:** Read `00-start-here.md`, `01-tenant-resolution.md`, and `02-config.md` in order. They establish the vocabulary (tenant, subdomain, edge, Worker, KV, R2, D1) and the request flow this doc fleshes out.
>
> **What you'll know by the end:** What every Cloudflare product in PowerFab's stack actually does, what each one costs in 2026, what each one's ceilings are, where each one is the wrong tool, and how all of them compose into a single hosting picture from "user types `acme.app.example.com`" to "dashboard renders." You'll also know the honest tradeoff between Cloudflare Pages and Workers Static Assets, the five anti-patterns to avoid, and a cost projection at 10 vs 200 tenants.

This doc is reference-shaped. Read it once cover to cover, then skim it later when you need the cost or the limit for a specific product. Every term is defined the first time it appears, so you don't have to remember anything from doc 00.

---

## 1. Why this doc exists

You have a single Cloudflare account decision to make, and a dozen sub-decisions inside it: where the static React bundle lives, where the API runs, where tenant config lives, where snapshot data lives, how the nightly C# binary runs, how it reaches the customer's database, and how subdomains get routed. Cloudflare publishes a separate marketing page for each product, and the docs are often written for someone who already knows when to reach for which.

Nick: the goal is for you to walk away knowing not just "what is Workers" but **"when do I use Workers, when do I use a Container, when do I use D1 versus KV, and what does each one cost me at 200 tenants."** The brief in `docs/research/briefs/05-cloudflare-architecture.md` has the raw numbers; this doc explains them in plain English with analogies.

A note on naming: Cloudflare prefixes almost every product with "Cloudflare" (Cloudflare Pages, Cloudflare Workers, etc.). After the first mention I'll usually drop the prefix — "Workers" means "Cloudflare Workers." Other vendors (AWS, Azure) are spelled out fully when mentioned for contrast.

---

## 2. The big picture first

Before defining anything, here is the entire PowerFab hosting stack on Cloudflare in one diagram. Every piece is defined in the next section. Skim the diagram, then come back to it after the vocabulary primer.

```
                            INTERNET
                                |
                                v
                    +-----------+-----------+
                    |  CLOUDFLARE'S NETWORK |
                    |   (~300 edge POPs)    |
                    +-----------+-----------+
                                |
                  Cloudflare for SaaS / wildcard DNS
                       *.app.example.com
                                |
                                v
   +------------------------------------------------------+
   |                  EDGE WORKER (Hono)                  |
   |                                                      |
   |   1. Reads Host header  -> "acme"                    |
   |   2. Looks up tenant in D1                           |
   |   3. Reads snapshot JSON from KV                     |
   |   4. Serves static SPA from Pages / Static Assets    |
   |   5. Returns HTML with config injected               |
   +------+----------+--------+--------+--------+---------+
          |          |        |        |        |
          v          v        v        v        v
     +---------+ +------+ +------+ +------+ +-----------+
     | Pages   | |  KV  | |  D1  | |  R2  | | Hyperdrive|
     | (SPA    | |(hot  | |(reg- | |(arch-| |(optional, |
     |  static)| |snap- | | istry| | ive  | |  for live |
     |         | | shot)| |+ RBAC)| | blobs| |  customer |
     +---------+ +------+ +------+ +------+ |   DB)     |
                                            +-----+-----+
                                                  |
                                                  v
                                        +---------+----------+
                                        |  Cloudflare Tunnel |
                                        |   (cloudflared on  |
                                        |   customer's box)  |
                                        +---------+----------+
                                                  |
                                                  v
                                         CUSTOMER'S MySQL DB

   ===========================================================
                  THE NIGHTLY PIPELINE (separate path)
   ===========================================================

   Cron Trigger (1 a.m. UTC)
        |
        v
   Scheduler Worker  --enqueue per-tenant message-->  Queue
                                                        |
                                                        v
                                      Consumer Worker (drains queue)
                                                        |
                                       --launches per tenant-->
                                                        v
                                             +----------+----------+
                                             | Cloudflare Container |
                                             |   .NET 8 binary      |
                                             |   pulls customer DB  |
                                             |   writes JSON to KV  |
                                             |   archives to R2     |
                                             +----------+----------+
                                                        |
                                                        v
                                              Cloudflare Tunnel
                                                        |
                                                        v
                                              CUSTOMER'S MySQL DB
```

Two distinct flows in there. The top half is **a user's request** ("show me my dashboard"). The bottom half is **the nightly pipeline** ("refresh everyone's data"). They share KV, R2, the Tunnel, and the D1 registry. They use different Cloudflare primitives for orchestration (the user request is just a Worker; the nightly pipeline is Cron -> Queue -> Container).

You'll come back to this diagram in §17. For now, just notice that there are exactly **eleven Cloudflare products** in the picture, and we'll cover each one in turn.

---

## 3. Vocabulary primer

Every Cloudflare product the rest of the doc uses, in 1-2 sentences. If you forget what something is later, scroll back here.

### Hosting and routing

- **Edge / edge POP** — short for "point of presence." Cloudflare runs ~300 small data centers around the world; an "edge POP" is one of them. When you "deploy to the edge," your code runs in every POP, so a user in Texas hits a Texas POP rather than your origin server in Virginia.
- **Cloudflare Pages** — Cloudflare's git-connected static-site host (HTML, JS, CSS). Push to GitHub, Pages builds and serves. Free for huge amounts of traffic. Like Vercel, but on Cloudflare.
- **Workers Static Assets** — the newer option for serving static files. Instead of a Pages project you have a Worker project, and the Worker can also serve files from its bundle. Cloudflare's 2026 guidance is "for new projects, prefer Workers Static Assets over Pages." Same files served, different deploy model.
- **Cloudflare Worker** — a small piece of TypeScript or JavaScript that runs at the edge on every matching request. Think of it as a programmable gatekeeper that sits between the user and your static files (or your data). Workers are how you do "anything dynamic" on Cloudflare.
- **Hono** — a small open-source router framework written for Workers. Like Express on Node, but ~20 KB and built for V8 isolates. We'll use it inside our Worker so we don't write a giant `if (url.pathname === ...)` chain.
- **V8 isolate** — the runtime container Cloudflare uses for Workers. Same V8 engine that's inside Chrome and Node.js, but lighter weight than a Node process. You don't get the full Node.js standard library by default. Cold start is ~5 ms, which is fast enough that you don't think about it.

### Data stores

- **Cloudflare KV** — a globally-replicated key/value store. You write `KV.put('tenants:acme', json)` from your Worker and `KV.get('tenants:acme')` returns it. Reads are fast (sub-10 ms once cached at a POP). Writes propagate slowly (up to ~60 seconds globally). Good for "rarely changes, read all the time." Bad for counters or session state.
- **Cloudflare D1** — Cloudflare's serverless SQL database (SQLite under the hood, replicated to the edge). Real SQL — `SELECT * WHERE x = ?`, joins, transactions. Stronger consistency than KV. Capped at 10 GB per database, which is fine for small relational data and not fine for storing customer transactional data.
- **Cloudflare R2** — Cloudflare's object storage. The same shape as Amazon S3 (you put a file in a bucket, get a URL back), but with **zero egress fees** — Amazon charges 9 cents per GB you read out; R2 charges nothing. For storing nightly snapshot archives or large file attachments, this is what you want.
- **Hyperdrive** — a connection pooler and cache that sits between your Worker and an external Postgres or MySQL database. Workers create new database connections constantly (each invocation is fresh); Hyperdrive holds long-lived connections and reuses them. Optional in PowerFab; useful only if a Worker (not a Container) needs to query a customer's DB live.

### Compute beyond Workers

- **Cloudflare Containers** — real Linux containers that run on Cloudflare's edge, launched on demand from a Worker. **Generally available since April 2026.** This is where you run the C# .NET 8 binary that Workers can't host (Workers don't run .NET; Containers do). You pay only while the container is running.
- **Cron Triggers** — scheduled invocations of a Worker. You define a cron expression in `wrangler.toml` and Cloudflare runs your Worker's `scheduled()` handler at that time. Same syntax as Unix cron, minimum granularity one minute.
- **Cloudflare Queues** — a managed message queue. Producer Worker drops messages in; consumer Worker pulls them out in batches with retries. Used to fan out work — e.g. "one message per tenant" so we don't run all 200 nightly jobs at once.

### Networking

- **Cloudflare for SaaS** — the feature that lets `acme.app.example.com`, `bigshop.app.example.com`, and so on all resolve to your Worker, with TLS certificates auto-issued. We need this for subdomain-per-tenant routing.
- **Wildcard DNS / wildcard cert** — DNS configuration that says "any subdomain matching `*.app.example.com` routes here," and a TLS certificate that covers all of them in one cert. Cheaper than per-hostname routing for small numbers of tenants.
- **Cloudflare Tunnel / cloudflared** — an outbound-only tunnel from a customer's machine to Cloudflare's network. The customer installs a small daemon (`cloudflared`); your Worker can then reach into the customer's environment without the customer opening any inbound firewall ports. This is how the nightly Container reaches the customer's MySQL.

That's the full set. Now we'll go product by product, with what it costs and where you'd avoid using it.

---

## 4. Cloudflare Pages

**What it is.** A static-file host wired up to your GitHub repo. You push to `main`, Pages runs `pnpm build`, takes the `dist/` output, and serves it from every edge POP.

**What it's for in PowerFab.** Hosts the React 19 + Vite + Tailwind 4 build output — the dashboard SPA. Whatever HTML/JS/CSS comes out of `pnpm build` ends up on Pages.

**What it costs in 2026.**
- **Free tier:** unlimited sites, unlimited bandwidth, 500 builds per month, 20-minute build timeout, 20,000 files per deployment, 25 MiB per file.
- **Pro:** $20/month for more concurrent builds, longer build times, and more preview deploys.
- **Pages Functions** (server-side routes inside a Pages project) bill on the Workers pricing model: 100,000 requests/day free, $5/month minimum on paid.

**What the limits are.** The 500-builds-per-month cap is the one you'll feel first — that's at the **account** level, not the project level, and "auto-deploy on every PR" can burn through it during a busy week. 20,000 files per deployment is fine for any normal SPA. 25 MiB per file is fine unless you're shipping pre-rendered video.

**What you'd avoid using it for.** Anything that needs cron, queues, or full Worker bindings. Pages Functions exist, but they're a stripped-down Worker — no Cron Triggers, weaker observability, fewer bindings. If you need real Worker features, run a standalone Worker in front of Pages instead.

**Beginner gotchas.**
- "Pages Functions" sounds like a Pages feature; mentally, it's "a thinner Worker bundled with your Pages deploy." If you start adding cron and queues, you'll outgrow Pages Functions and want a standalone Worker anyway.
- Cloudflare's official 2026 guidance is "skip Pages for new projects, use Workers Static Assets instead." Pages still works, still gets bug fixes, but it's not the strategic direction. We'll cover the tradeoff in §15.
- The build minutes counter resets monthly. If you set up a noisy bot that pushes commits, you can blow through 500 builds in a weekend. Throttle preview builds.

---

## 5. Cloudflare Workers

**What it is.** A serverless function that runs at every edge POP, built on V8 isolates instead of containers. When a request comes in, Cloudflare routes it to the nearest POP, spins up an isolate (cold start ~5 ms), and runs your code. When your code finishes, the isolate goes back to a pool. Think of a Worker as a tollbooth that runs your code on every request before it reaches static files.

**What it's for in PowerFab.** The API layer plus tenant routing. Specifically:
- Read the request's Host header, figure out which tenant.
- Look up the tenant in D1.
- Read the tenant's snapshot JSON from KV.
- Pass the request to Pages (or Workers Static Assets) for static files.
- Inject the tenant config into the HTML before returning it.
- Handle authentication.
- Handle any small dashboard API endpoints that aren't just-static-data.

The Worker uses **Hono** as its router, which gives you Express-like syntax for `app.get('/api/tenants/:slug', ...)` instead of writing a hand-rolled `fetch` switch.

**What it costs in 2026.**
- **Free:** 100,000 requests/day, 10 ms CPU per invocation, 3 MB bundle size.
- **Paid (Workers Standard, $5/month minimum):** 10 million requests/month included, 30 million CPU-ms/month included; then $0.30 per additional million requests, $0.02 per additional million CPU-ms.
- **No egress charges, ever.** This is one of the structural reasons Cloudflare comes out cheaper than AWS for content-heavy apps.

**What the limits are.**
- **CPU time** is wall-clock CPU, not wall-clock total. Awaiting I/O (a fetch to KV, a fetch to your origin) does **not** count against your CPU budget under the 2024 "scale to zero" pricing model. The default per-request CPU cap is 30 seconds, configurable up to 5 minutes (300,000 ms) on paid.
- **Request body limit:** 100 MB (zone-level setting, not per-Worker).
- **Bundle size:** 3 MB on Free, larger on paid.

**What you'd avoid using it for.** Anything that needs more than 5 minutes of CPU, or any binary that isn't TypeScript/JavaScript. Workers don't run .NET, Python with native dependencies, ffmpeg, Pandoc, or anything you'd put in a Dockerfile. For those, use Cloudflare Containers (§8).

**Beginner gotchas.**
- V8 isolates are not Node.js. There's a `node_compat` flag that adds shims for some Node APIs, but it adds overhead and isn't a full Node runtime. If you're used to grabbing `fs` or `child_process`, those don't exist here. Plan around `fetch`, `crypto`, and `caches`.
- "CPU time" vs "wall time" trips everyone up. If your Worker spends 28 seconds awaiting a slow fetch, that fetch's wall time isn't your problem — only the milliseconds you actually run JavaScript count. You can do long async waits cheaply.
- Cold starts are ~5 ms. You don't need to "warm up" Workers the way you would Lambdas.
- Hono has a default `bodyLimit` middleware capped at 100 KB. If you're accepting bigger payloads, raise it explicitly. This bites people who try to upload images and get a silent 413.

---

## 6. Cloudflare KV

**What it is.** A globally-replicated key/value store optimized for read-heavy workloads. You write a key once, and the value gets pushed to every Cloudflare POP. Reads are very fast (under 10 ms once cached at a POP). Writes are slow to propagate — up to about 60 seconds globally. In plain English: **after you write, the new value isn't visible everywhere immediately; it takes up to a minute for every edge POP to see it.** That's "eventually consistent."

**What it's for in PowerFab.** The hot-path tenant snapshot JSON. Each tenant has roughly 1.6 MB of JSON (the 17 module files concatenated, conceptually). The nightly C# job writes one JSON blob per tenant per module to KV; the Worker reads it on every dashboard request. Reads dominate writes by 1000x or more, which is exactly KV's sweet spot.

**What it costs in 2026.**
- **Free:** 100,000 reads/day, 1,000 writes/day, 1 GB total storage.
- **Paid:** $0.50 per million reads, $5.00 per million writes/lists/deletes, $0.50/GB/month stored.
- Value size: 25 MB max (raised from 10 MB earlier).
- Key length: 512 bytes. Metadata: 1024 bytes.

**What the limits are.**
- **Write rate ceiling: 1 write per second per unique key.** This is the gotcha. You cannot use KV as a counter, a session store, or anything that mutates the same key faster than once per second.
- After a write, a stale read from another POP can persist for up to 60 seconds. For nightly snapshots this doesn't matter; for real-time data it absolutely does.
- Bulk reads bill per key, not per call. If you fetch 50 keys with `Promise.all`, that's 50 reads.

**What you'd avoid using it for.** Counters, sessions, anything with high write frequency on the same key, anything where reading "data from 30 seconds ago" is a problem. Use D1 for relational data, Durable Objects for fast-mutating shared state.

**Beginner gotchas.**
- Eventually consistent really does mean up to a minute. If you're testing locally and a write doesn't show up immediately on another machine, that's not a bug — that's KV.
- The 1 write/sec/key ceiling silently throttles you; you don't get a clean error, you get rate-limited. Design around it from the start: don't make a single key that everything writes to.
- "Stored" is the value plus metadata, not just the value. Adding a fat metadata blob to every key inflates your storage bill.

---

## 7. Cloudflare D1

**What it is.** Cloudflare's serverless SQL database. SQLite under the hood, replicated across the edge, with real ACID transactions and SQL queries. You bind a D1 database to a Worker and run `db.prepare("SELECT * FROM tenants WHERE slug = ?").bind(slug).first()`.

**What it's for in PowerFab.** The control-plane database. Specifically:
- Tenant registry (one row per tenant: slug, name, billing tier, status).
- User accounts and which tenant each user belongs to.
- Role-based access control (which user has which role inside their tenant).
- Audit logs.
- Anything else that's small, relational, and needs queries.

This is where "is the user logged in, and which tenant are they?" lives. It is **not** where the dashboard data lives — that's KV.

**What it costs in 2026.**
- **Free:** 5 GB storage, ~150 million rows read per month, ~3 million rows written per month, max 10 databases.
- **Paid (with the $5 Workers plan):** 25 billion rows read/month included, 50 million rows written/month included; then $0.001 per million rows read, $1.00 per million rows written, $0.75/GB/month stored.
- Up to 50,000 databases per account.

**What the limits are.**
- **Hard ceiling: 10 GB per database.** Cannot be raised. If a single dataset could exceed this, you have to shard — one database per tenant, or one per group of tenants. For PowerFab control-plane data, 10 GB is plenty for the foreseeable future.
- **Single writer per database.** Throughput is roughly 1000 divided by your average query time in milliseconds. A 100 ms query caps the database at 10 writes/sec. A 5 ms query gets you ~200 writes/sec.

**What you'd avoid using it for.** Storing customer transactional data (the row count from a real ERP would dwarf 10 GB). Any single dataset bigger than 10 GB. Write-heavy workloads above ~100 sustained writes/sec. Anything where you need cross-region active-active writes.

**Beginner gotchas.**
- "Rows read" includes index rows scanned during a query, not just rows returned. A query that uses a bad index can consume your read budget surprisingly fast — `EXPLAIN QUERY PLAN` is your friend.
- The 10 GB ceiling is real and silent until you hit it. You might think "we'll get there in five years." Plan a sharding story now anyway, before any tenant could individually exceed it.
- D1 has stronger consistency than KV but it's still distributed; cross-region writes have replication lag measured in milliseconds, not seconds.

---

## 8. Cloudflare R2

**What it is.** Cloudflare's object storage. Same shape as Amazon S3 (buckets, keys, files). Different pricing — **R2 charges $0.00 for reading data out**, where S3 charges 9 cents per GB. For an app that ships a lot of bytes to users, that's a structural cost difference.

**What it's for in PowerFab.** Long-term archive of nightly JSON snapshots, raw data dumps from the customer DB, large file attachments, anything bigger than KV's 25 MB cap, and anything you want to keep around for audit. The nightly Container writes:
- Hot path: latest snapshot JSON to KV (under 1 MB per module).
- Archive: the same snapshot to R2 with a date-stamped key (`tenants/acme/2026-05-07/estimating.json`), forever.

**What it costs in 2026.**
- **Free:** 10 GB storage, 1 million Class A operations/month, 10 million Class B operations/month.
- **Paid:** $0.015/GB/month stored, $4.50 per million Class A operations (writes/lists/multipart), $0.36 per million Class B operations (reads/heads).
- **Infrequent Access** tier: $0.01/GB/month stored, $9.00 per million Class A. For data you keep but rarely read.
- **Egress: $0.00.** Always.
- Single-object size limit: ~5 TB (multipart uploads).

**What the limits are.** Practically none for our use. The bucket count cap is in the thousands; we'll have one or two buckets total.

**What you'd avoid using it for.** Frequent small reads from a Worker. R2 is for blobs you serve to users or archive long-term; KV is faster (sub-10 ms cached) and edge-cached automatically. R2 reads are still fast, but they're not the same hot-path-friendly thing KV is.

**Beginner gotchas.**
- "Class A vs Class B" is the same model as S3. Listing a bucket is a Class A op, which is 12.5x the cost of a read. If your code lists the bucket on every request, that adds up fast.
- R2 is eventually consistent for some operations; strong-read-after-write works, but cross-region replication (within R2 itself, if you enable it) is async.
- The S3-compatible API is mostly there, but a few S3 features (object lock, replication policies) have caveats. If you're porting from S3, double-check the specific API calls you depend on.

---

## 9. Cloudflare Containers

**What it is.** Real Linux containers running on Cloudflare's edge network, launched on demand from a Worker. **Generally available since April 2026.** This is the product that makes "run a .NET binary on Cloudflare" possible.

**What it's for in PowerFab.** Critical. This is where the C# .NET 8 nightly binary runs. The flow:

1. Cron Trigger fires the scheduler Worker.
2. Scheduler enqueues one message per tenant onto a Queue.
3. Consumer Worker drains the queue with controlled concurrency (say 10 at a time).
4. For each message, the Worker launches a Container.
5. Container runs the C# binary, which connects to the customer's MySQL via Tunnel, pulls data, transforms it, and writes JSON to KV (hot) and R2 (archive).
6. Container exits cleanly. Cloudflare bills you only for the seconds it ran.

**What it costs in 2026.**
- **Free with the Workers Paid plan ($5/month minimum):** 25 GB-hours of RAM, 375 vCPU-minutes, 200 GB-hours of disk per month included.
- **Overages:** pay-as-you-go, billed per 10 ms of active running time. Scale to zero — nothing while idle.
- **Instance types:** predefined `lite`, `basic`, `standard-1`, `standard-2`. Custom types now available, capped at standard-4 specs (4 vCPU, 12 GiB RAM, 20 GB disk).
- **Concurrency** (after February 2026's 15x increase): up to 15,000 lite, 6,000 basic, 1,500 standard-1, or 1,000 standard-2 concurrent containers per account.

**What the limits are.**
- **Architecture:** linux/amd64 only. .NET 8 supports this fine (Microsoft publishes amd64 Linux images).
- **No GPUs, no Windows containers, no ARM** (yet).
- **Disk is ephemeral.** Anything you want to keep, write to KV/R2/D1.
- **Cold start:** typically 1-3 seconds, depends on image size. Fine for nightly batch; would be painful for synchronous user requests.
- **Image size:** large self-contained .NET binaries (80-150 MB) work but inflate cold starts. Use trimmed publish or a smaller base image (`mcr.microsoft.com/dotnet/runtime:8.0-alpine` or the `chiseled` variants).

**What you'd avoid using it for.** A workload a Worker can do in under 30 seconds of CPU. Containers exist precisely for the cases Workers can't handle (binaries, native deps, long-running CPU). Don't reach for a Container when a Worker fits — Workers are cheaper and have no cold start to speak of.

**Beginner gotchas.**
- "Per 10 ms of active running time" is precise: you pay nothing while the container is asleep waiting for the next nightly run. Scale-to-zero is real.
- The image registry is Cloudflare-managed. You push images via `wrangler` CLI, not Docker Hub or GHCR. Same idea, different store.
- Containers are invoked **from a Worker** — they're not a public-facing HTTP server in their own right. Architecturally: Worker is the front door; the Container is a private worker bee the Worker invokes.
- Image size matters a lot for cold start. A 200 MB image with a 5-second pull is fine for nightly batch; for anything user-facing, get the image under 50 MB.

---

## 10. Cron Triggers

**What it is.** Scheduled invocations of a Worker. You add a `[triggers]` block to `wrangler.toml` with a cron expression, and Cloudflare calls your Worker's `scheduled()` handler at that time. Same syntax as Unix cron, minimum granularity one minute.

**What it's for in PowerFab.** Fires the nightly orchestrator Worker, which then enumerates tenants and pushes work onto the Queue.

**What it costs in 2026.** No separate price — Cron Triggers bill on the regular Workers requests/CPU-ms model. You get 5 triggers per account on Free, 250 on Paid.

**What the limits are.**
- **No duration limit on Cron-invoked Workers.** Unlike `fetch` handlers (which face the per-request CPU cap), `scheduled` handlers can run longer. Useful for the orchestration step.
- **Propagation:** cron config changes can take up to 15 minutes to take effect globally. Don't tweak the schedule and expect it to fire immediately.

**What you'd avoid using it for.** Sub-minute scheduling. Use Durable Object alarms or a Queue with delayed messages for that. Also avoid one cron per tenant — at 200 tenants you'd burn most of your trigger budget. Instead, have one cron that fans out via a Queue.

**Beginner gotchas.**
- Triggers are best-effort, not guaranteed-once. Cloudflare can in theory miss a fire or fire twice during regional incidents. **Build idempotent jobs** — running the nightly twice should produce the same result, not duplicate data.
- Don't confuse the `scheduled` handler with the `fetch` handler. They live in the same Worker file but they're different exported functions. A request handler signature is `fetch(request, env, ctx)`; a cron handler is `scheduled(event, env, ctx)`. Mixing them up is a common first-week bug.

---

## 11. Cloudflare Queues

**What it is.** A managed message queue with batching, retries, and dead-letter queues. Producer Worker writes messages; consumer Worker reads them in batches.

**What it's for in PowerFab.** The fan-out for the nightly pipeline. The cron Worker enqueues one message per tenant; the consumer Worker pulls messages off in controlled batches and launches a Container per message. This smooths spikes (200 tenants don't all start at once) and gives you free retry semantics if a Container fails.

**What it costs in 2026.**
- **Free:** part of Workers Free, 10,000 ops/day, 24-hour message retention.
- **Paid:** $0.40 per million operations beyond the free tier. An "operation" is each 64 KB chunk written, read, or deleted. Most messages count as one op each.
- Up to 10,000 queues per account.
- Default batch size: 10 messages. Default batch timeout: 5 seconds. Both configurable.
- Message size: up to 128 KB. Batch size up to 256 KB.
- Retention: up to 14 days on paid, 24 hours on free.

**What the limits are.** The defaults are reasonable; you'll likely never tune them. The thing to watch is retry count — each retry is billed.

**What you'd avoid using it for.** Strict ordering or sub-second delivery. Queues is async with at-least-once semantics. If you absolutely need "in order, exactly once," you need a different tool (or careful idempotency design on top of Queues).

**Beginner gotchas.**
- The default retry semantics are **all-or-nothing per batch**. If one tenant's container fails, the default behavior is to retry the *whole batch*, redoing the 9 successful tenants too. For PowerFab, mark messages for individual retry instead. The Cloudflare docs cover the API; the default just isn't what you want.
- DLQs (dead-letter queues) catch messages that exceed max retries. Each DLQ write counts as a write op. Misconfigured consumers (e.g. always failing) can burn ops fast.
- "Each 64 KB chunk" matters for big payloads. A 200 KB message is 4 ops, not 1.

---

## 12. Cloudflare for SaaS

**What it is.** The custom-hostname / wildcard-DNS feature that lets `acme.app.example.com`, `widgets.app.example.com`, and so on all resolve to your Worker, with TLS auto-issued. This is the plumbing for subdomain-per-tenant routing.

**What it's for in PowerFab.** Mandatory. You own `app.example.com` on Cloudflare; SaaS lets every `*.app.example.com` route to your Worker.

**What it costs in 2026.**
- **Free:** 100 custom hostnames included on Free, Pro, and Business plans.
- **Beyond that:** $0.10 per custom hostname per month (down from $2 in 2024). At 200 tenants that's $20/month. At 100 tenants it's free.
- Wildcard SAN supported on the certificate (`*.<custom-hostname>`), with the caveat that you cannot customize per-wildcard TLS settings.

**What the limits are.** None that you'll feel for a long time. The 100 free hostnames covers the early customer base.

**What you'd avoid using it for.** Issuing only a handful of hostnames where a single wildcard cert covers them. In that case you don't need the per-hostname SaaS billing at all — a wildcard cert on a Pro zone gives you `*.app.example.com` without per-hostname charges.

**Beginner gotchas.**
- "Cloudflare for SaaS" is overloaded. The marketing name covers two distinct cases: (a) routing your customers' own domains (`dashboard.acme.com`) to your service, and (b) routing your own subdomains (`acme.app.example.com`) to your service. For (b), wildcard certs on a Pro plan are usually all you need; the per-hostname SaaS billing is only relevant when you want unique certs per subdomain.
- You might be wondering "do I need Cloudflare for SaaS, or just a wildcard cert?" — the reason both come up: a wildcard cert is enough when every subdomain shares one TLS cert. Per-subdomain TLS, custom analytics-per-tenant, and customer-domain (mTLS-per-customer) cases are when SaaS billing per hostname kicks in. For PowerFab's `*.app.example.com` shape, a wildcard cert is plenty until you offer customer-domain support.

---

## 13. Cloudflare Tunnel (cloudflared)

**What it is.** An outbound-only persistent tunnel from a customer's machine to Cloudflare's edge. The customer runs a small daemon called `cloudflared`. **No inbound firewall rules. No public IP. No port forwarding.** The customer's IT team will love this — it's the reason corporate customers tolerate "let some external service reach our database."

Think of it as: the customer's machine dials *out* to Cloudflare and keeps the line open. Your Worker dials *in* to Cloudflare and uses that open line. The customer's firewall sees only outbound HTTPS, which it would already allow.

**What it's for in PowerFab.** The cleanest way to reach the customer's MySQL (or whatever data source they're running) from the nightly Container. Customer installs `cloudflared` once; you point the Container at a private hostname and it routes through the tunnel.

**What it costs in 2026.**
- **Free** with no usage limits. Bundled with the Cloudflare Free plan.
- Pro/Business unlock advanced features (more granular access policies, longer log retention).

**What the limits are.**
- **Throughput** is not throttled by Cloudflare; it's limited by the customer's upstream bandwidth.
- **Install:** single binary. macOS, Linux (`.deb`/`.rpm`), Windows MSI, Docker.
- **Modern setup is "remotely-managed"** — the local binary just gets a token; all routing config lives in the Cloudflare Zero Trust dashboard.

**What you'd avoid using it for.** When you're already on the customer's LAN, there's no boundary to traverse. A tunnel adds complexity without value in that case.

**Beginner gotchas.**
- The tunnel is outbound-only on the customer side. **If the customer's firewall blocks outbound HTTPS, it won't work** — but that's rare in practice; corporate firewalls almost always allow outbound 443.
- Authentication is via service tokens or Cloudflare Access policies. **Don't expose a tunnel as a public hostname without an Access policy in front.** Otherwise anyone on the internet who guesses the hostname can hit the customer's MySQL.
- The `cloudflared` process is now a dependency on the customer's machine. **Run it as a service** (systemd / launchd / Windows service), not as a foreground process. If it dies, the next nightly run fails. Configure auto-restart.

---

## 14. Hyperdrive

**What it is.** A connection pooler and query cache that sits between a Worker and an external Postgres or MySQL database. Workers create new database connections constantly (each invocation is a fresh isolate), and traditional databases hate that — connection setup is expensive. Hyperdrive holds long-lived pooled connections near your origin DB and reuses them across Worker invocations. It also optionally caches query results.

**What it's for in PowerFab.** **Optional, and probably skip for now.** The nightly Container maintains its own connection (it's a long-lived process); it doesn't need Hyperdrive. Hyperdrive shines when a Worker (not a Container) needs to query a remote SQL database during a user-facing request — for instance, if you wanted the dashboard Worker to fetch a live count from the customer's MySQL on every page load. We're not doing that today.

**What it costs in 2026.**
- **Free** with all Workers plans.
- Min 5 connections per pool; max varies by plan.
- Supports native drivers (`mysql2`, `postgres`, `pg`, etc.) and ORMs (Drizzle, Prisma).

**What the limits are.** No meaningful ceilings for our scale.

**What you'd avoid using it for.** Workers talking to D1. D1 is already edge-local, with no connection-setup pain to solve. Hyperdrive is for **external** databases.

**Beginner gotchas.**
- Hyperdrive needs a network path TO the customer's database. Combined with Cloudflare Tunnel, the path becomes: Worker -> Hyperdrive -> Tunnel -> customer MySQL. Some teams skip Hyperdrive for tunneled connections because the tunnel itself terminates near Cloudflare's edge. **Benchmark before assuming you need both.**
- Query caching is opt-in and bypassed on writes. Don't cache user-specific queries without keying on tenant carefully — you could leak data across tenants if your cache key isn't tenant-scoped.
- For PowerFab specifically, the nightly Container handles its own DB connection; Hyperdrive is Worker-shaped, not Container-shaped.

---

## 15. Pages vs Workers Static Assets — the honest tradeoff

In 2026 Cloudflare's official guidance is "for new projects, prefer Workers Static Assets over Pages." That's a real fork in the road, so here's the honest comparison.

**Pages (the old way):**
- Git-connected. Push to `main`, build runs, deploy happens.
- Built-in preview deploys per PR.
- Mature ecosystem, lots of tutorials.
- Pages Functions are thinner Workers (no cron, fewer bindings).
- "Strategic direction" no longer.

**Workers Static Assets (the new way):**
- Static files ship as part of a Worker bundle.
- Single deploy: your API code and your static files in one project.
- Full Worker bindings on every request — cron, queues, KV, D1, R2, all of it.
- Newer, fewer tutorials, ecosystem still catching up.

For PowerFab specifically:
- **Argument for Pages:** the workflow Nick already has from Vercel transfers cleanly. Build, deploy, preview-per-PR — Pages is a drop-in mental model. Less to learn while you're also learning Workers, KV, D1, etc.
- **Argument for Workers Static Assets:** if you're going to put a Worker in front of static files anyway (for tenant resolution and config injection), having one bundle instead of two is simpler. No "Worker on subdomain X, Pages on subdomain Y, glue them with routes."

**The honest recommendation:** start with Pages. Standalone Worker in front. You already know how Pages works (it's basically Vercel-but-Cloudflare). When you've shipped to a few tenants and the ecosystem has another year to mature on Workers Static Assets, migrate. The migration is mostly mechanical — same files, different deploy target — and you'll do it once. Don't optimize for the long-term recommendation while you're still learning the platform.

The "skip Pages" guidance is real, but you trade ecosystem maturity for it. At 5 tenants, the maturity is worth more than the strategic alignment.

---

## 16. Sample request, walked end to end

Pull up the diagram in §2 again. Here's exactly what happens when a user types `acme.app.example.com` into their browser. Every Cloudflare product is labeled.

**Step 1.** The user's browser does a DNS lookup for `acme.app.example.com`. Your zone has a wildcard DNS record (`*.app.example.com`) pointing to Cloudflare. The lookup returns a Cloudflare anycast IP. **Products touched: Cloudflare for SaaS / wildcard DNS.**

**Step 2.** The browser opens an HTTPS connection to that IP. TLS is negotiated using the wildcard cert covering `*.app.example.com`. **Products touched: wildcard cert (issued and managed by Cloudflare).**

**Step 3.** Cloudflare's edge POP nearest the user receives the request. The Worker is bound to the route `*.app.example.com/*`, so Cloudflare invokes it. A V8 isolate spins up (~5 ms cold start) and runs the Worker code. **Products touched: Cloudflare Workers.**

**Step 4.** The Worker (using Hono) reads the `Host` header: `acme.app.example.com`. It strips the suffix and gets the slug `acme`. It then queries D1: `SELECT * FROM tenants WHERE slug = ?`. D1 returns the tenant record (or 404s the request if the slug is unknown). **Products touched: D1.**

**Step 5.** The Worker reads the snapshot JSON from KV: `KV.get('tenants:acme:dashboard')`. This is sub-10 ms because KV is edge-cached after the first read at this POP. The result is the ~1.6 MB tenant config / metric data blob. **Products touched: KV.**

**Step 6.** The Worker fetches the static `index.html` from Pages (or Workers Static Assets, if you migrated). It rewrites the HTML to inject the tenant config as a `<script id="__tenant__" type="application/json">...</script>` tag. It returns the modified HTML to the browser. **Products touched: Pages (or Workers Static Assets), Workers (HTML rewrite).**

**Step 7.** Browser receives the HTML. It parses the embedded config, boots the React app, and starts rendering. As the React app renders, it fetches additional static JS chunks (lazy-loaded modules) directly from Pages — those don't go through the Worker again, they're served straight from the static assets. **Products touched: Pages.**

**Step 8.** When the dashboard needs additional API data (e.g. a metric refresh), it hits `/api/...` paths on the same domain. The Worker handles those, doing fresh KV/D1/R2 reads as needed. R2 only enters the picture if the user requests a historical snapshot or a file attachment. **Products touched: Workers, KV, D1, optionally R2.**

That's the full path from URL to rendered dashboard. **Eight steps, six Cloudflare products.** No backend server, no virtual machines, no Kubernetes.

The nightly pipeline (Cron -> Queue -> Container -> Tunnel -> customer MySQL -> KV -> R2) runs on a separate schedule and never touches the user-request path.

---

## 17. Cost projection at 10 vs 200 tenants

Pulled directly from the brief. Assumptions: 1.6 MB JSON per tenant per night, modest dashboard traffic (~1,000 page loads per tenant per month), one nightly Container run per tenant lasting ~60 seconds at the `basic` instance size (1 GiB RAM, 1/4 vCPU).

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
| Containers | included | ~$3-8 over included |
| Queues | included | included |
| Cron Triggers | included | included |
| Cloudflare for SaaS hostnames | $0 | $10/month |
| Cloudflare Tunnel | $0 | $0 |
| Pages | $0 | $0 |
| **Estimated total** | **~$5-7/month** | **~$20-30/month** |

At 10 tenants you're effectively paying the $5 Workers minimum. At 200 tenants you're still under $50/month, dominated by the per-hostname SaaS fee and Container compute. **Egress is free at every layer**, which is the structural reason this stack stays cheap.

The two costs to watch as you scale beyond 200: **Container CPU-seconds** (if nightly jobs grow past ~60 seconds each) and **KV write ops** (if you start updating snapshots more than once per night per module).

For honest comparison: the same workload on AWS — Lambda, S3, RDS — would cost more, mostly because every byte you ship to a user out of S3 costs egress. At 200 tenants and 1,000 page loads each, even with caching, the egress savings alone often dominate the bill.

---

## 18. Five anti-patterns to avoid

These are specific things you'll be tempted to do and shouldn't.

**1. Putting fast-mutating state in KV.** The 1-write/sec/key ceiling is the trap. KV is for "read-mostly, change-rarely." Sessions, counters, real-time scores — those go to Durable Objects (a different Cloudflare product we're not using), not KV. If your write rate per key exceeds one per second, you've picked the wrong tool.

**2. One cron trigger per tenant.** At 200 tenants you'd burn most of your 250-trigger budget and gain nothing. Use **one cron** that fires the scheduler Worker, which then fans out to **one queue message per tenant**. The queue gives you concurrency control and retries for free; per-tenant crons give you neither.

**3. Using D1 for snapshot blobs.** D1 is great for relational metadata; it's wrong for ~1.6 MB JSON blobs. The 10 GB hard ceiling will bite you, the read cost (rows-scanned) is opaque, and KV is genuinely faster for "give me one big blob by key." Snapshots go in KV, with archives in R2. Tenants and users go in D1.

**4. Reading R2 on every page load when KV would do.** R2 is fine but it's not as edge-cached as KV. If the data fits within KV's 25 MB-per-value limit and changes nightly, KV is faster and cheaper for the hot path. Use R2 for archives, large attachments, anything historical or rarely-read.

**5. Exposing Cloudflare Tunnel without an Access policy.** The tunnel is just a network pipe. If you make a public hostname like `acme-mysql.app.example.com` that routes through the tunnel and you don't put a Cloudflare Access policy in front, **anyone on the internet who guesses the hostname can reach the customer's database.** Always pair tunnel hostnames with an Access policy (service token, mTLS, or SSO). The tunnel is private *because* of the policy, not by itself.

---

## 19. By the end of this doc you should know

- What Cloudflare Pages, Workers, KV, D1, R2, Containers, Cron Triggers, Queues, Cloudflare for SaaS, Cloudflare Tunnel, and Hyperdrive each do, in plain English.
- Which one to reach for in PowerFab for: the static SPA, the API layer, tenant config storage, snapshot data, historical archives, the C# nightly binary, the schedule, the fan-out, subdomain routing, customer-DB access, and (optionally) live customer-DB queries.
- What each one costs in 2026 — both the included tier and the overage rate.
- The hard limits that bite first: KV's 1-write/sec/key, D1's 10 GB ceiling, the 100-free-hostname SaaS limit, R2's Class A vs Class B op pricing, Containers' linux/amd64-only, Workers' 30-second-CPU cap.
- The full request flow for `acme.app.example.com` from DNS lookup to rendered dashboard, with every Cloudflare product labeled.
- The Pages vs Workers Static Assets tradeoff, and why we'd start with Pages despite the official 2026 recommendation.
- Why total cost stays under $50/month at 200 tenants.
- The five anti-patterns: fast-mutating state in KV, one cron per tenant, D1 for snapshot blobs, R2 on the hot path, unguarded tunnels.

If any of those still feel hazy, scroll back to the relevant section and re-read with the diagram in §2 in front of you.

---

**Next:** `06-customer-data-ingest.md` — how the nightly C# binary reaches the customer's MySQL through Cloudflare Tunnel, what the customer's IT team has to install, and the atomic-manifest write pattern that makes nightly snapshots safe.
