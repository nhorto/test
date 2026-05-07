# Research Brief: Nightly Data Pipeline Orchestration on Cloudflare (2026)

For PowerFab Dashboard's 07-nightly-data-pipeline.md explainer. Scope: Cloudflare Cron Triggers, Queues, Containers, R2, observability, and failure handling for a solo dev moving from 5-10 to 100-200 tenants.

---

## 1. Cloudflare Cron Triggers

### How they work

A Cron Trigger is a binding you attach to a Worker in `wrangler.toml` (or via the dashboard). At the configured time, Cloudflare invokes the Worker's exported `scheduled()` handler instead of the usual `fetch()` handler. The Worker has access to all its normal bindings (KV, R2, D1, Queues, Containers) inside that handler.

The handler receives a `ScheduledEvent` with `scheduledTime` and `cron` fields, plus the standard `env` and `ctx`. You typically use `ctx.waitUntil()` to extend execution past the handler return so async work (like fanning out to a queue) finishes.

### Cron syntax

Standard 5-field cron: `minute hour day-of-month month day-of-week`. Cloudflare also supports the predefined macros (`@hourly`, `@daily`, `@weekly`). Per-minute precision is the floor — you cannot schedule sub-minute. There's no documented hard frequency cap for paid accounts beyond the per-Worker invocation limits, but practically per-minute is the smallest sensible unit.

Examples Nick will use:
- `0 6 * * *` — 6am UTC daily (which is 2am US Eastern in winter, 1am in summer due to DST)
- `0 7 * * *` — 7am UTC daily (a safer "always after midnight Eastern" choice that survives DST)

### Loop-all-tenants vs cron-per-tenant

| Pattern | Scales to 200 tenants? | Verdict |
|---|---|---|
| One Cron Trigger, Worker iterates all tenants in-process | Poor: hits the 30s CPU wall-clock limit on Workers; one tenant's crash kills the rest | No |
| One Cron Trigger, Worker enqueues one Queue message per tenant | Excellent: trivially parallel, per-tenant retries, isolated failures | Yes |
| One Cron Trigger per tenant (200 separate cron entries) | Painful: requires per-tenant `wrangler.toml` mutation or 200 Workers; no shared visibility | No |

The fan-out-via-Queue pattern is the clear winner. The Cron Worker's only job is to read the tenant registry and publish N small messages.

### Time zones

Cron Triggers run in UTC. There is no built-in "tenant local time" support. At MVP with 5-10 customers all in the continental US, a single UTC schedule (e.g., 7am UTC = 2-3am ET) is fine. As customers diversify geographically, options are:

1. Bucket tenants into a few timezone groups, run multiple Cron Triggers (e.g., one for Americas, one for Europe), each fanning out only the tenants whose preferred run window matches.
2. Store a `runHourUTC` per tenant in the registry; have a single hourly cron that only fans out tenants whose hour matches.

Option 2 is the cleanest long-term and worth mentioning even at MVP.

### Pricing

Cron Triggers themselves are free on the Workers Paid plan ($5/month minimum) and included in the Workers Free tier with limits. Each cron firing counts as one Worker invocation against your normal request budget. At 365 firings/year per cron, this is rounding error.

### Failure mode mid-flight

If the Cron Worker errors out while iterating tenants 1-200 and only enqueued through tenant 47, the remaining 153 are silently skipped — Cloudflare will not auto-retry the scheduled invocation. Mitigations:

- Make the Cron Worker do as little as possible: read registry, publish messages, return. Almost no failure surface.
- Wrap the publish loop in try/catch per tenant so one bad registry entry doesn't poison the rest.
- Emit a heartbeat log at the end ("fanned out 200/200") so a missing heartbeat triggers an alert.

---

## 2. Cloudflare Queues (Fan-out Layer)

### Pattern

```
Cron Worker (producer) ──> Queue ──> Consumer Worker / Container (one invocation per message)
```

The Cron Worker calls `env.NIGHTLY_QUEUE.send({ tenantSlug, runDate })` 200 times (or once with `sendBatch`). The consumer Worker is bound to that queue and is invoked once per message (or per small batch).

### Why this beats a tight loop

| Concern | Tight loop | Queue fan-out |
|---|---|---|
| Parallelism | Sequential, 200x serial | Cloudflare runs many consumer instances concurrently |
| Per-tenant retry | All-or-nothing | Each message retried independently |
| Crash isolation | One panic kills the run | Bad message goes to DLQ, others continue |
| Wall-clock limit | Hard cap per Worker invocation | Each consumer invocation has its own budget |
| Backpressure | None | Queue buffers; consumer concurrency is configurable |

### Knobs

- `max_batch_size`: how many messages a single consumer invocation gets (1-100). For "run the C# binary per tenant" you probably want batch size 1.
- `max_batch_timeout`: max wait to fill a batch (seconds).
- `max_concurrency`: how many consumer invocations Cloudflare will run in parallel. Tune to avoid overwhelming customer firewalls.
- `max_retries`: number of redelivery attempts before a message is moved to the DLQ (default 3).
- `retry_delay`: backoff before redelivery.
- Dead-letter queue (DLQ): a separate queue that catches messages that exceed `max_retries`.

### Pricing in 2026

Cloudflare Queues bills per million operations (writes, reads, deletes count separately). At 200 tenants × ~3 ops per message × 365 nights = under 250k ops/year. Well inside the included tier. Even at 100x scale this is single-digit dollars per month. Storage is metered for unprocessed message backlog, which for nightly bursts that drain in minutes is negligible.

---

## 3. Invoking the C# Container from a Worker

### Container binding pattern

Cloudflare Containers (GA in 2025-2026) lets you ship a Docker image and bind it to a Worker. The Worker calls `env.CONTAINER.fetch(request)` (or a typed RPC method) and Cloudflare spins up the container on-demand near the Worker. The container is essentially a long-running HTTP server you wrote — for the C# binary, you'd wrap `PowerFabDataGen.exe` in a tiny ASP.NET Core endpoint that reads the request body, runs the binary, and writes outputs to R2 (via S3-compatible API or a presigned URL passed in).

### Passing per-tenant config

Two paths:

| Method | When to use |
|---|---|
| Request body (JSON) | Per-run params that change: tenantSlug, runDate, DB host/user, FabSuite endpoint |
| Container env vars | Truly static config: log level, R2 bucket name, version pin |

Secrets (DB passwords, FabSuite tokens) should NOT live in the request body in plaintext logs. Store them in Workers Secrets keyed by tenant slug, fetch in the consumer Worker, and pass them in the request body over the encrypted internal connection. Or — better — give the container its own Workers Secret bindings.

### Run-to-completion vs long-running

Containers can run as on-demand (spin up per request, tear down after idle) or always-on. For nightly batch work, on-demand is cheaper and simpler. The container is "long-running" only during the actual job — typically seconds to a few minutes for 1.6 MB of JSON output.

### What the consumer Worker does while container runs

Synchronous wait is fine here: the consumer Worker awaits `container.fetch()` and reports success/failure based on the response. Workers can run for several minutes when waiting on subrequests (the 30-second CPU limit is CPU time, not wall-clock — I/O wait doesn't count). Fire-and-forget is tempting but loses the success signal — avoid unless you're logging completion from inside the container itself.

A pragmatic split: the container writes the JSON to R2 itself (it has direct S3 API access), and returns just a small status payload `{ success: true, files: [...], bytes: 1640000 }`. The Worker then writes the manifest and updates the run-status table.

---

## 4. R2 Write Patterns

### Path structure

```
tenants/<slug>/snapshots/<YYYY-MM-DD>/<module>.json
tenants/<slug>/snapshots/<YYYY-MM-DD>/manifest.json
tenants/<slug>/snapshots/current.json   <-- pointer to latest good date
```

| Alternative | Pros | Cons |
|---|---|---|
| Single big JSON per night | Atomic by definition; one read | Frontend must download all even for one module; 1.6 MB cold-cache cost on every page load |
| Per-module files (recommended) | Selective fetching, smaller payloads | Need atomicity discipline |
| Per-module + manifest | Selective + atomic-feeling | Slight extra complexity |

### Atomic writes

R2 has no multi-object transactions. Naive sequence: write 10 module files; if dashboard fetches at file 6, it sees stale module 7-10. The manifest pattern fixes this:

1. Write all `<module>.json` files for `<date>`.
2. Last, write `manifest.json` listing the modules and their checksums/byte sizes.
3. Update `current.json` (a tiny pointer file: `{ "currentDate": "2026-05-07" }`) only after the manifest write succeeds.
4. Frontend: read `current.json` first, then `manifest.json` for that date, then individual modules. Never read modules without going through the manifest.

If anything fails between steps 1 and 3, `current.json` still points at yesterday — the dashboard renders stale-but-consistent data, which is the right failure mode.

### Versioning and lifecycle

Keep N days of history (30-90 days is reasonable for a steel-fab dashboard). R2 supports lifecycle rules to auto-delete objects older than X days based on prefix. Set a rule on `tenants/*/snapshots/*` to expire after 90 days. R2 also supports object versioning if you want recovery from accidental overwrites — for write-once-per-night dated paths, you don't really need it.

### Pricing implications

R2 charges per Class A operation (writes), per Class B (reads), and per GB-month storage. Egress is free. At 200 tenants × ~10 files × 365 nights = 730k writes/year. That's well inside the free tier on writes (10M/month). Storage: 200 × 1.6 MB × 90 days ≈ 29 GB, at ~$0.015/GB/month = under $0.50/month. Reads from the dashboard are the dominant cost, but Class B is cheap — even at heavy read traffic this is single-digit dollars.

---

## 5. Failure Handling and Retries

### Per-tenant retries

Queue's built-in retry handles transient failures (FabSuite API hiccup, momentary container cold-start failure). Configure 3 retries with exponential backoff (e.g., 1min, 5min, 15min). Most transient issues self-heal in this window.

### Permanent failures and the DLQ

If retries exhaust, the message lands in the DLQ. Set up a tiny separate consumer Worker on the DLQ that:

1. Logs the failure with full context.
2. Updates the run-status table (D1) with status=failed.
3. Sends Nick a notification.

### Notifying Nick (solo dev)

| Channel | Setup effort | Reliability |
|---|---|---|
| Email via SMTP relay or transactional service from a Worker | Low | High, but watch deliverability |
| Slack incoming webhook | Trivially low (one fetch POST) | Very high; Slack mobile push for free |
| Discord webhook | Same as Slack | Same |
| Cloudflare Notifications (built-in) | Configurable for some events but not custom app errors | Limited |

For a solo dev, Slack/Discord webhook is the simplest reliable path. One environment variable, one `fetch()` call from the DLQ consumer.

### Idempotency

The job MUST be idempotent. Design rules:

- Output paths are date-keyed (`/snapshots/2026-05-07/`), so re-running overwrites cleanly.
- The `current.json` pointer flips only at the end, so a partial second run doesn't corrupt the first run's good output until it succeeds.
- If two runs overlap, the second one will simply re-overwrite. Optional: a per-tenant "run lock" in KV with a TTL to prevent concurrent runs.

---

## 6. Observability

### What you want to see

| Field | Why |
|---|---|
| tenant_slug | Which customer |
| run_date | Which night |
| status (success/failed/running) | Health |
| started_at, ended_at, duration_ms | Performance trend |
| bytes_written, file_count | Sanity check on output |
| error_message, error_class | Debugging |
| attempt_number | Was retry needed |

### Where to put it

| Option | Best for |
|---|---|
| Workers Logs (built-in tail/search) | Real-time debugging, free-text logs |
| Logpush to R2 / external sink | Long-term archival, complex querying |
| D1 table `nightly_runs` | Structured "last 90 nights per tenant" views, status page queries |
| KV `lastRun:<slug>` | Quick "what's the latest status" lookups, single-key reads |
| Workers Analytics Engine | High-cardinality metrics over time, dashboards |

A reasonable starting stack: write structured logs (Workers Logs auto-captures), insert a row in D1 `nightly_runs` for every attempt, update a KV `lastRun:<slug>` for the dashboard's "freshness indicator." Build a tiny `/admin/status` page in the dashboard that reads from D1.

### Cloudflare's built-in tooling in 2026

Workers Observability provides invocation logs, metrics (CPU time, errors, requests), and tail sessions out of the box. Workers Analytics Engine is the high-cardinality time-series store for custom metrics. Logpush exports to R2/S3/Datadog/etc. for retention beyond the rolling window.

---

## 7. End-to-End Diagram (Boxes for the Writer)

The ASCII diagram should include, top to bottom:

- **Cron Trigger** (clock icon, "07:00 UTC daily")
- arrow down to **Producer Worker** ("read tenant registry from KV, fan out")
- arrow to **KV: tenants** (side box, registry source)
- arrow down to **Queue: nightly-runs** (one message per tenant)
- arrow down (with multiple parallel arrows) to **Consumer Worker** (one invocation per message)
- arrow right to **Container: PowerFabDataGen** (per-invocation spinup)
- two arrows from Container: one down to **Customer on-prem MySQL + FabSuite XML** (over the customer's tunnel/firewall hole), one right to **R2: tenants/<slug>/snapshots/<date>/**
- arrow from Consumer Worker to **D1: nightly_runs** (status row)
- arrow from Consumer Worker to **KV: lastRun:<slug>** (freshness pointer)
- side path: Queue's failed messages to **DLQ** to **DLQ Consumer** to **Slack webhook to Nick**
- bottom: **React Dashboard** reading from R2 (`current.json` to `manifest.json` to module files) plus D1 for status page

---

## 8. State Management Between Runs

| State | Recommended store | Why |
|---|---|---|
| Last successful run timestamp per tenant | KV (`lastRun:<slug>`) | Cheap single-key reads from the dashboard for freshness banner |
| Full run history (90 days) | D1 (`nightly_runs` table) | Structured queries for status page, alerting |
| Last credential rotation date per tenant | D1 (`tenant_credentials` table, NOT actual secrets) | Auditable, query-able for "rotate any older than 90 days" |
| Actual secrets (DB passwords, tokens) | Workers Secrets, keyed by tenant slug | Encrypted at rest, never logged |
| Schema version of latest snapshot | Inside `manifest.json` itself (`{ "schemaVersion": 3, ... }`) | Travels with the data |

### Schema migrations

When the C# binary's output schema changes:

1. Bump `schemaVersion` in the manifest.
2. Frontend reads `schemaVersion` first and either uses a migration shim or refuses to render old-format snapshots with a clear message.
3. Never break old snapshots silently.
4. For additive changes (new fields), old frontends ignoring unknown fields is fine. For breaking changes, version the path itself: `/snapshots/<date>/v2/<module>.json`.

---

## 9. Common Pitfalls for a Beginner

1. **Reading the dashboard before the manifest pattern is in place.** The dashboard fetches modules directly while the C# job is mid-write, so users see half the modules updated and half stale. Symptoms: "the inspections panel updated but jobs didn't" complaints. Fix: always go through `current.json` to `manifest.json` to modules; never let the dashboard list R2 prefixes directly.

2. **Doing the work in the Cron Worker itself instead of fanning out.** Works fine at 5 tenants, hits the wall-clock limit at 50, silently drops tenants past whatever fits in 30 seconds. The fix (Queue fan-out) is much harder to retrofit under pressure than to design in.

3. **Putting secrets in the Queue message body.** Queue messages get logged in observability tools. Pass tenant slug, look up secrets in the consumer.

4. **Forgetting DST when picking a UTC cron time.** "2am Eastern" is 7am UTC in winter and 6am UTC in summer. Pick a UTC time that's safely after midnight in all customer time zones year-round.

5. **No DLQ, no notifications.** First failed run goes unnoticed for days. Set up the Slack/email webhook before the first real customer onboards, even if it's spammy at first.

6. **Non-idempotent writes that corrupt on retry.** Appending instead of overwriting, or writing to a path that doesn't include the run date, means a retry produces a Frankenstein snapshot mixing two runs' data. Date-key everything and overwrite.

7. **Skipping the run-status table.** Without `nightly_runs` in D1, "did tenant X run last night?" requires log archaeology. Even a 10-column table written from the consumer Worker pays for itself the first time a customer asks.

8. **Trusting the customer's network.** The on-prem MySQL or FabSuite endpoint can be down, slow, or returning malformed XML. Wrap fetches with timeouts, log the raw response sizes, and fail fast with clear error messages rather than letting the C# binary hang for 25 minutes and time out the consumer.

9. **No schema version in the manifest.** Six months later you change the C# output and the dashboard breaks for tenants whose latest snapshot is from before the change. Version everything that crosses a process boundary.

10. **Running 200 containers at maximum concurrency.** If they all hit a shared customer-side resource, you DDoS your own customers. Tune `max_concurrency` on the queue consumer to a polite ceiling (e.g., 10-20) and let it take a few minutes longer.
