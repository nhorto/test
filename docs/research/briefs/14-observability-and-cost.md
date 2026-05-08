# Research Brief: Observability and Cost Monitoring for PowerFab Dashboard

> Intermediate research feeding the writing agent for `14-observability-and-cost.md`. Pricing math is intentionally deferred to `05-cloudflare-architecture.md`; this brief focuses on operational signal and ongoing cost monitoring.

---

## 1. What "Observability" Means for a Solo Dev

Observability is the ability to answer three questions without deploying new code:
1. Is the system currently broken?
2. What broke, when, and for which tenant?
3. How much did it cost to run?

For a solo dev with 5–10 tenants, "enough observability" is not full APM (Application Performance Monitoring) with distributed tracing, dashboards per microservice, and alert runbooks. It is: structured logs you can grep, one alert set that pages you before a customer calls, and a billing view you check weekly. Anything beyond that is noise at this scale.

The core constraint for this stack: Cloudflare doesn't surface a single "tenant X is having trouble" view. Every observability strategy here is a workaround for that gap.

---

## 2. Cloudflare Workers Logs

Workers can write to logs using `console.log()`, `console.error()`, and `console.warn()`. These calls do not write to a file or a database — they emit log events attached to the Worker invocation. In the Cloudflare dashboard, these appear under the Worker's "Logs" tab with a short retention window (approximately three days by default, subject to change; verify in the CF dashboard at the time of launch).

**JSON-structured logs are the convention.** A plain string like `"User authenticated"` is searchable only by substring. A JSON object `{ "event": "auth_ok", "tenant_slug": "acme", "user_id": 42 }` is filterable by key. Every log line should include:
- `tenant_slug` — the subdomain identifier, e.g. `"acme"` from `acme.app.example.com`
- `level` — `"info"` | `"warn"` | `"error"`
- `event` — what happened, machine-readable
- Any request-specific fields (route, status code, duration_ms)

**Logger helper sketch — walked line by line:**

```typescript
// src/lib/logger.ts

type LogLevel = "info" | "warn" | "error";

interface LogBase {
  tenant_slug: string;
  request_id?: string;
}

function makeLogger(base: LogBase) {
  // Returns a bound logger; call makeLogger(ctx) once per request handler.
  // 'base' is spread into every log line, so tenant_slug is always present.
  return {
    log(level: LogLevel, event: string, extra?: Record<string, unknown>) {
      // Object.assign order: base fields first, then event, then caller extras.
      // If caller passes tenant_slug in extra, their value wins — intentional.
      const entry = { ...base, level, event, ts: Date.now(), ...extra };
      // console.log serializes to JSON string; Workers capture the raw string.
      console.log(JSON.stringify(entry));
    },
    info:  (event: string, extra?: Record<string, unknown>) => {},
    warn:  (event: string, extra?: Record<string, unknown>) => {},
    error: (event: string, extra?: Record<string, unknown>) => {},
  };
}
```

**Note for the writing agent:** The `info`/`warn`/`error` shorthand bodies are stubs here — the full implementation calls `this.log(level, event, extra)`. Show the full form in the explainer. The key architectural point is that `makeLogger` takes a `base` object at request time (where `tenant_slug` is known from the subdomain parse) and closes over it for all subsequent calls in that handler.

The `request_id` field (a random UUID generated per request) lets you correlate all log lines from a single invocation — critical when a single request makes multiple KV reads and a D1 query.

---

## 3. `wrangler tail` — Real-Time Log Stream

`wrangler tail <worker-name>` opens a live stream of log events from a deployed Worker to your terminal. This is the primary debugging tool during a deploy or an active incident.

**What it shows:** Every `console.log` output, uncaught exceptions, invocation metadata (URL, method, status code, duration).

**CLI usage:**
- `wrangler tail powerfab-api` — streams all invocations
- `wrangler tail powerfab-api --format json` — structured output, pipeable to `jq`
- `wrangler tail powerfab-api --search acme` — filter to lines containing "acme" (useful for tenant triage)

**Limitations:**
- Sampling at scale: at high request volume Cloudflare samples the stream, meaning not every invocation appears. At MVP scale (5–10 tenants, hundreds of requests/day) sampling is not a concern; at 100+ tenants with real traffic it becomes unreliable for counting but still useful for seeing error shapes.
- Ephemeral: `wrangler tail` shows live events only. It does not replay historical logs. If you weren't tailing when the error happened, the only record is whatever Cloudflare retained in the dashboard logs tab.

---

## 4. Logpush — Long-Retention Log Export

Logpush is a Cloudflare feature that streams log events from Workers (and other Cloudflare services) to an external destination on a continuous basis. Destinations include R2 (Cloudflare's own object storage), Datadog, Splunk, and others.

**When you need it:** The default log retention in the dashboard is short. If you need to search logs from last week — to investigate a tenant complaint about a job that ran incorrectly five days ago — you need Logpush. Without it, those logs are gone.

**For this stack, R2 is the natural Logpush sink.** Logs land as newline-delimited JSON files in an R2 bucket. You can then query them with Workers, or pull them locally for investigation.

**Cost note:** Logpush is a paid feature available on higher Cloudflare plans. It is not available on the free or basic Workers tiers. Factor this into the production plan decision; it is not a launch-day requirement but should be enabled before the first tenant reports a hard-to-reproduce bug.

---

## 5. Error Handling Strategy

Workers errors fall into two categories:
1. **Caught exceptions** — wrapped in `try/catch`, logged with `console.error`, returned as structured 4xx/5xx responses.
2. **Uncaught exceptions** — surface as 500s; Cloudflare records them in the dashboard "Errors" tab, but the only data available is the error message and stack if the Worker didn't swallow it.

**Structured error logging pattern:** On catch, log an object with `{ level: "error", event: "handler_threw", error: e.message, stack: e.stack, tenant_slug, route }`. Do not log the full error object directly — Workers serialize it inconsistently.

**Sentry vs. Cloudflare-native observability:**
- Sentry on Workers: Sentry's SDK works in the Workers runtime. It captures uncaught exceptions, groups them by fingerprint, and shows stack traces in a UI. It adds ~50ms cold-start risk on first invocation and has its own pricing.
- Cloudflare-native: The dashboard shows error counts and stack traces for uncaught errors. Combined with structured logs shipped via Logpush, it provides the same data — but requires an external query tool (e.g. a log search UI or `jq` on local files) to make sense of it.

**Recommendation for solo dev at MVP scale:** Start with Cloudflare-native logs and the dashboard error tab. The dashboard error tab shows recent uncaught exceptions with stack traces. Structured `console.error` calls cover caught exceptions. Add Sentry only if you find yourself spending more than 30 minutes investigating a single incident because the logs lacked context. Sentry's grouping and "first seen / last seen" are genuinely useful at 50+ tenants; they are overhead before that.

---

## 6. Analytics — Web and Workers

**Cloudflare Web Analytics (free):** A JavaScript snippet added to the Pages site. It reports Real User Monitoring (RUM) data — meaning metrics captured in the actual user's browser, not in your infrastructure. RUM measures: page load time, Largest Contentful Paint (LCP), First Input Delay (FID), Cumulative Layout Shift (CLS), and Time to First Byte (TTFB). These are the Core Web Vitals. Web Analytics does not require cookies; it does not require GDPR consent banners (Cloudflare's own claim, verify per jurisdiction). It shows aggregate charts in the CF dashboard.

**Workers Analytics Engine (paid; custom metrics):** A Workers binding that lets you write arbitrary numeric events from inside a Worker invocation — e.g., "tenant acme ran a snapshot job, 4.2 MB, 12.3 seconds." This is the tool for custom business metrics on Cloudflare. It queries via a SQL-like API. Relevant for later; not an MVP requirement.

---

## 7. Dashboard Analytics Tabs — What to Actually Watch

In the Cloudflare dashboard, each Worker and Pages project has an "Analytics" tab. What matters for a solo dev:

- **Requests over time:** sudden drop means the Worker stopped being invoked (routing broken); sudden spike means a client is looping.
- **Error rate (4xx and 5xx):** 4xx spikes usually mean a route broke or auth middleware is rejecting valid tokens. 5xx spikes mean a Worker is throwing.
- **p50 / p95 / p99 latency:** p50 is the median response time — what a typical request costs. p95 is what 95% of requests finish within. p99 is the tail — one in 100 requests. For Workers, p50 < 50ms is typical. A p99 > 2000ms means something is occasionally very slow (likely a D1 query or KV miss pattern). Watching p95 weekly is sufficient at MVP scale.
- **CPU time:** Cloudflare limits Workers CPU time per invocation. High CPU time is a warning sign for a loop or heavy computation that should be in a Container instead.

---

## 8. Cloudflare Notifications — Starter Alert Set

Cloudflare Notifications (in the CF dashboard under "Notifications") lets you configure alerts triggered by platform events. Destinations: email or webhook URL (Slack has a webhook endpoint feature that accepts POST requests, so "send to Slack" = "send to Slack incoming webhook URL").

**Trigger types available:**
- HTTP error rate threshold (5xx rate over a rolling window)
- Billing threshold ($X spend on the account)
- Security events (WAF, DDoS detected)
- Worker script health events

**Recommended starter set:**

| Alert | Trigger | Destination |
|---|---|---|
| 5xx error spike | >5% of requests over 10 min | Email + Slack |
| Daily request anomaly | >3x rolling 7-day avg | Email |
| R2 storage threshold | >20 GB stored | Email (weekly digest) |
| Billing threshold | >$50 account spend | Email |
| Container job overrun | Container minutes > 2x expected/day | Webhook to Slack |

The Container job overrun alert is not a native CF notification type — implement it as a Worker that checks Container invocation logs nightly and fires a Slack webhook if the sum exceeds threshold.

---

## 9. Per-Tenant Observability — The Gap and the Workaround

Cloudflare has no native per-tenant metric split. The Workers analytics tab shows aggregate numbers across all invocations. This is the core gap for a multi-tenant system.

**Workaround: structured logs + external filter**

Every log line includes `tenant_slug`. Ship logs via Logpush to R2. Query with `jq` or a lightweight log UI that reads from R2.

```
ASCII — Log Flow

Worker invocation
      |
      | console.log(JSON.stringify({ tenant_slug, event, ... }))
      |
      v
[Cloudflare Logs] -- default ~3-day retention, dashboard view
      |
      | Logpush (paid, streaming)
      |
      v
[R2 Bucket: logs/YYYY/MM/DD/HH/worker-*.ndjson]
      |
      +-- wrangler tail (real-time, ephemeral, sampled at scale)
      |
      +-- local jq / grep: filter by tenant_slug, time range, event
      |
      +-- (future) log UI: Grafana Loki, Logtail, or custom Worker query
```

At <50 tenants, `jq` on downloaded R2 log files is sufficient for incident investigation. At >50 tenants, a proper log search tool becomes worthwhile.

---

## 10. Ongoing Cost Monitoring

**Where to find the bill:** Cloudflare dashboard > Billing. Line items appear per product: Workers (requests, CPU ms), R2 (storage GB, Class A operations, Class B operations, egress), D1 (rows read, rows written), Pages (builds), Containers (compute minutes).

**R2 is the trap.** R2 storage grows monotonically — every nightly snapshot adds 1.6 MB per tenant and nothing removes it unless you build a retention job. At 100 tenants running nightly for 12 months: 100 tenants × 1.6 MB × 365 days = ~58 GB. Set a billing alert at 20 GB (a canary), and implement a 90-day retention deletion job (tied to the tenant lifecycle grace-period logic in `11-tenant-lifecycle.md`) before storage becomes meaningful.

**Class A vs. Class B operations:** R2 charges separately for write operations (Class A, more expensive) and read operations (Class B, cheaper). Nightly writes are Class A. Reads for the dashboard are Class B. A loop that reads the same snapshot repeatedly is a Class B cost anomaly.

**D1 row read cost:** D1 charges per row read. An N+1 query pattern — loading a list of 50 jobs then querying details for each individually — turns 1 query into 51. At low tenant count this is invisible; at 100 tenants it can 50x the expected D1 bill. Batch queries.

---

## 11. Cost Anomaly Examples

**BUG:** Client-side polling loop calls the API every 2 seconds instead of every 30 seconds (off-by-one in `setInterval`). Worker request count spikes 15x.
**FIX:** Alert on request count >3x rolling avg fires within hours. Trace via `wrangler tail`, find the client route in logs, fix the polling interval, deploy.

**BUG:** Offboarded tenant's R2 snapshots never deleted. 12 months later they account for 30% of storage.
**FIX:** Tenant offboarding checklist (`11-tenant-lifecycle.md`) includes "schedule R2 prefix deletion at end of grace period." Tie to the per-tenant R2 prefix `snapshots/{tenant_slug}/`.

**BUG:** Container nightly job hangs on a malformed ERP export file and runs for 4 hours instead of 20 minutes.
**FIX:** Container job has a timeout enforced by the orchestrating Worker. Job emits a `job_start` and `job_end` log event with duration_ms; a post-job check Worker compares against expected duration and fires a Slack alert if over 2x.

**BUG:** N+1 in a Worker route: loading all jobs for a tenant runs 1 D1 query per job for status detail instead of a single JOIN.
**FIX:** Instrument D1 calls with a count per request (log `db_queries: N` on every response). Alert or log warning if N > 10 per request.

---

## 12. Per-Tenant Cost Attribution

Exact attribution is not possible natively on Cloudflare. Approximate it:

- **Worker requests per tenant:** count from structured logs (`tenant_slug` field, aggregate over a period)
- **R2 storage per tenant:** use the R2 API to list objects under `snapshots/{tenant_slug}/` and sum sizes — run as a nightly Worker, write result to KV
- **Container minutes per tenant:** each nightly Container invocation is per-tenant by definition; log `job_start`, `job_end`, `tenant_slug`; sum durations from logs

**Why it matters:** At <50 tenants, even if one tenant uses 10x the resources, the absolute dollar amount is small enough that it's not worth pricing them out or throttling them. At >50 tenants, you need cost attribution to identify tenants whose usage economics don't match their plan tier — and to defend pricing decisions. Build the logging infrastructure now (it's free), build the attribution query later.

---

## 13. Pitfalls (BUG / FIX Pairs)

**BUG: Alert fatigue.** You set 15 alerts including one for every 4xx response. The 4xx alert fires 200 times a day (normal auth retries). You start ignoring all alerts.
**FIX:** Alerts should fire on rates and anomalies, not raw events. "4xx rate > 20% of requests" fires rarely. "Any 4xx" fires constantly.

**BUG: No log retention plan.** A tenant reports incorrect data from last Tuesday. You go to investigate. Cloudflare's default log retention window has expired. There is nothing to look at.
**FIX:** Enable Logpush to R2 on day one of production, before you have a tenant who needs it. R2 storage for logs is cheap. The missing-retention moment always comes at the worst time.

**BUG: Forgot to add `tenant_slug` to logs.** Logs show errors but you can't tell which tenant is affected. You have to check all tenants manually.
**FIX:** The `makeLogger(base)` pattern enforced at the framework level — the Hono middleware that parses the subdomain calls `makeLogger({ tenant_slug })` and attaches it to the request context. No handler can log without going through it.

**BUG: Surprise egress cost.** An external analytics tool is configured to pull data from R2 via public URL continuously. R2 egress to the public internet is billed. Internal reads (Worker reading from R2) are free.
**FIX:** R2 reads from Workers are free. Keep all R2 access internal (Worker → R2). If an external tool needs logs, push (Logpush) rather than pull.

**BUG: Workers free-tier daily reset confusion.** The Workers free tier includes 100,000 requests per day, resetting at midnight UTC. A tenant in a different timezone assumes this is their midnight. Usage after their 6 PM (UTC midnight) gets billed at paid rates unexpectedly.
**FIX:** Once on a paid plan for any Workers feature, the free-tier daily request allowance still applies account-wide. Understand that the reset is UTC-anchored. Monitor the billing dashboard for unexpected charges in the first week of production.

---

## Key Terms Glossary (for writing agent reference)

- **RUM (Real User Monitoring):** performance metrics captured in the end user's browser, not in the server
- **p95 latency:** the response time that 95% of requests complete within; one in 20 requests is slower
- **Logpush:** Cloudflare's streaming log export feature; paid; routes log events to external storage
- **N+1 query:** a loop that issues one database query per item in a list, instead of one query for all items
- **Class A / Class B operations:** R2's billing distinction between writes (A) and reads (B)
- **APM (Application Performance Monitoring):** full-stack tracing and metrics; deliberately out of scope here
- **ndjson:** newline-delimited JSON; one JSON object per line; standard format for log files
- **cold start:** the extra time a Worker takes on its first invocation after being idle; typically 5–50ms on Cloudflare
