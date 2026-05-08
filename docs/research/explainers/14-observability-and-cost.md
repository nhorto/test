# 14 — Observability and Cost Monitoring: Knowing What's Happening and What It's Costing You

> **Pre-reqs:** Read 05 first for the Cloudflare product map (Pages, Workers, KV, R2, D1, Containers) and the end-to-end pricing tour. 07 for the nightly Container job. 11 for the tenant lifecycle and the 30-day grace period — that one matters more than it sounds for the cost section.
>
> **What you'll know by the end:** What "observability" actually means for a solo dev with 5–10 tenants (and what it deliberately is not). The structured-logger pattern that makes per-tenant grep possible — written out in full, walked line by line. The full log flow from a Worker invocation through to a queryable file in R2. A starter alert set you can copy into the Cloudflare dashboard on launch day. The four cost traps that bite multi-tenant systems on Cloudflare and how the alerts above catch them. How all of this ties back to the tenant lifecycle: per-tenant filtering, R2 cleanup at offboarding, and the .NET nightly job's runtime alarm.

This is the operational counterpart to 05. 05 told you how much each Cloudflare product costs at 5, 50, and 200 tenants. This doc tells you — once production is live — how to know whether things are working, whether one tenant is suffering while the others are fine, and whether your bill is about to do something embarrassing. It also tells you what to ignore: at 5–10 tenants the easy mistake is over-instrumenting and drowning in alerts.

The most valuable artifact is the `makeLogger` helper in §4. Everything else works because every log line carries a `tenant_slug` field. If you skim, read §4 and §9.

---

## 1. Vocabulary primer

A few terms are about to show up repeatedly. Define them once here so the rest reads cleanly.

- **RUM (Real User Monitoring)** — performance metrics captured in the actual user's browser, not on your server. Page load time, click-to-paint delay, layout shift. The browser does the measuring; a small script ships the numbers back. Cloudflare Web Analytics is RUM.
- **p95 / p99 latency** — instead of "average response time" (which lies — one slow request hides behind ninety-nine fast ones), you sort all response times and look at the 95th or 99th percentile. p95 of 200ms means "95% of requests finished within 200ms; the slowest 5% were worse." p99 is the tail — one in 100 requests. Watching p95 catches "things are degrading"; watching p99 catches "something is occasionally very slow."
- **Logpush** — Cloudflare's feature for streaming log events out to long-term storage on a continuous basis. Paid; not on the free tier. It's how you get logs older than ~3 days.
- **N+1 query** — a database anti-pattern. You load a list of 50 jobs (1 query), then loop over them and load each job's status individually (50 queries). One query becomes 51. Invisible at 1 tenant; expensive at 100.
- **Class A / Class B operations** — R2's two billing buckets. Class A is writes (uploads, deletes), more expensive per call. Class B is reads, cheaper per call. A loop that re-reads the same file 10,000 times is a Class B cost spike.
- **APM (Application Performance Monitoring)** — the deluxe-tier monitoring world: distributed tracing, per-request flame graphs, dashboards per microservice. Datadog, New Relic, Honeycomb. Deliberately out of scope here — they're worth real money once you have a real team and real traffic, and they're noise before that.
- **ndjson (newline-delimited JSON)** — a file format where each line is one complete JSON object. Standard for log files because you can append a line without re-parsing the whole file, and tools like `jq` can stream over it.
- **Cold start** — the extra time a Worker takes on its very first invocation after being idle. On Cloudflare it's typically 5–50ms. Matters for latency-sensitive paths; doesn't matter much for nightly batch jobs.
- **Structured logs** — log lines that are JSON objects with named fields, instead of plain strings. `{"level":"error","tenant_slug":"acme","event":"db_timeout"}` is structured. `"acme had a database problem"` is not. The structured form is filterable; the string form is grep-only.
- **Alert fatigue** — the failure mode where you set 15 alerts, twelve of them fire constantly for normal stuff, and within a week you've muted the channel and you no longer notice the three real ones. The fix is fewer alerts, on rates and anomalies, not raw events.

00 has the broader vocab list (tenant, slug, KV, R2, Worker). Add the terms above to your mental index.

---

## 2. What "observability" actually means here

Observability is a fancy word for "can you figure out what's going on without deploying new code?" Three concrete questions:

1. **Is the system currently broken?**
2. **What broke, when, and for which tenant?**
3. **How much did it cost to run?**

For a solo dev at 5–10 tenants, "enough observability" is three things, and only three things:

- **Structured logs you can grep**, ideally per tenant.
- **One alert set** that pages you before a customer calls.
- **A billing view you check weekly** so you're not surprised at month end.

Anything beyond that, at this scale, is noise. Setting up Honeycomb traces for an app with 200 requests a day is a way to feel productive without producing anything.

The single most important architectural fact: **Cloudflare does not give you a "tenant X is having trouble" view out of the box.** The Workers analytics tab shows aggregates across every invocation, regardless of subdomain. Every technique here is a workaround for that gap. The workaround is to make sure every log line carries a `tenant_slug` field, so you can filter externally.

That's the whole strategy. The rest is mechanics.

---

## 3. Where logs live on Cloudflare

Workers write logs using the globals you already know: `console.log()`, `console.warn()`, `console.error()`. These calls don't write to a file or a database. They emit a log event Cloudflare attaches to the Worker invocation. In the dashboard, those appear under the Worker's "Logs" tab.

Two things to know:

- **Retention is short** — roughly three days by default (this drifts; verify in the dashboard). Older logs are gone unless you've enabled Logpush (§6).
- **It's not a real log search tool.** You can filter by time and look at recent events, but you can't do "all errors for tenant acme in the last 24 hours."

So the dashboard logs tab is good for "what happened in the last hour." For anything older or anything per-tenant, you need `wrangler tail` (live streaming) and Logpush (archival). And none of these tools work well unless your log lines are structured. That's the helper in §4.

---

## 4. The structured-logger helper, walked line by line

This is the headline code artifact for the doc. It's a small function that returns a logger object bound to a specific tenant. Every Worker request handler calls `makeLogger` once at the top, and from then on every log line carries `tenant_slug` automatically.

**Before** (no helper): every `console.log` call has to remember to include `tenant_slug` itself. Three files in, somebody forgets, and now you have a log line saying "kv_miss" with no idea which tenant it belongs to.

**After** (with helper): you call `makeLogger({ tenant_slug })` once. The function returns shorthands (`info`, `warn`, `error`) that already know the tenant. You can't accidentally drop the field.

Here's the full implementation:

```typescript
// src/lib/logger.ts

type LogLevel = "info" | "warn" | "error";

interface LogBase {
  tenant_slug: string;
  request_id?: string;
}

export function makeLogger(base: LogBase) {
  function log(
    level: LogLevel,
    event: string,
    extra?: Record<string, unknown>,
  ) {
    const entry = { ...base, level, event, ts: Date.now(), ...extra };
    console.log(JSON.stringify(entry));
  }

  return {
    log,
    info:  (event: string, extra?: Record<string, unknown>) => log("info",  event, extra),
    warn:  (event: string, extra?: Record<string, unknown>) => log("warn",  event, extra),
    error: (event: string, extra?: Record<string, unknown>) => log("error", event, extra),
  };
}
```

Walk:

- `type LogLevel = "info" | "warn" | "error";` — three log levels and only three. Plain English: info is "this happened, normal," warn is "this happened, suspicious," error is "this happened, broken." A new reader doesn't need debug or trace levels at MVP scale; they create noise.
- `interface LogBase { tenant_slug: string; request_id?: string; }` — the shape of the "always-included" fields. `tenant_slug` is required (you cannot create a logger without a tenant). `request_id` is optional — a UUID generated per request that lets you correlate every log line from one invocation. You might be wondering why it's optional and not enforced — the answer is that batch jobs (the nightly Container) don't have a request, so making it required would force a fake value there.
- `export function makeLogger(base: LogBase) {` — exported because every Hono handler imports it. The argument is the base object that gets folded into every line.
- `function log(level, event, extra?) { ... }` — the underlying `log` method. This is where the actual work happens.
- `const entry = { ...base, level, event, ts: Date.now(), ...extra };` — Object.assign order matters here. `base` first, so `tenant_slug` and `request_id` are present. Then `level`, `event`, and a millisecond timestamp `ts`. Then `...extra` spread last — meaning if a caller passes `tenant_slug` in their extras, **their value wins.** That's intentional: 99% of the time the bound `tenant_slug` is right, but if a Worker is processing one tenant and needs to log about another (cross-tenant audit), explicit override is allowed.
- `console.log(JSON.stringify(entry));` — turn the object into a JSON string and emit it. Cloudflare captures the raw string. On the receiving side (dashboard, Logpush), it stays a string but one that any JSON parser can read. **Do not** be tempted to call `console.log(entry)` directly — Cloudflare's serialization of objects is inconsistent across runtime versions, and `JSON.stringify` gives you exactly what you wrote.
- `return { log, info, warn, error };` — return four functions. `log` is the underlying form (you'd use it if you needed a level computed at runtime). `info`/`warn`/`error` are the shorthand callers will actually use 99% of the time. Each one calls `log` with its level baked in.

How you use it inside a Hono middleware:

```ts
app.use("*", async (c, next) => {
  const host = c.req.header("host") ?? "";
  const tenant_slug = host.split(".")[0];
  const request_id = crypto.randomUUID();
  const logger = makeLogger({ tenant_slug, request_id });
  c.set("logger", logger);
  logger.info("request_start", { method: c.req.method, path: c.req.path });
  await next();
  logger.info("request_end", { status: c.res.status });
});
```

Walk:

- `host.split(".")[0]` — `acme.app.example.com` → `acme`. The slug. (Doc 01 covers this in detail.)
- `crypto.randomUUID()` — built-in to the Workers runtime; generates a fresh UUID per request.
- `makeLogger({ tenant_slug, request_id })` — bind the logger to this request.
- `c.set("logger", logger)` — attach to Hono's context. Downstream handlers do `const logger = c.get("logger")` and never have to think about it.
- The bracketing `request_start` / `request_end` log lines mean every request leaves a footprint, even if the handler never logs anything else.

That's the whole pattern. Once it's in place, every log line in your system has the same JSON shape, and `tenant_slug` is impossible to forget.

A note on errors: when you `console.error`, do not pass the raw `Error` object. Cloudflare's error serialization is inconsistent. Instead:

```ts
try {
  // ...
} catch (e) {
  const err = e as Error;
  logger.error("handler_threw", {
    message: err.message,
    stack: err.stack,
    route: c.req.path,
  });
  return c.json({ error: "internal" }, 500);
}
```

The `message` and `stack` come out as plain strings, every time, on every Worker version.

---

## 5. `wrangler tail` — the live stream

`wrangler tail <worker-name>` opens a live stream of log events from a deployed Worker to your terminal. Use it during a deploy, during an incident, or when a tenant just emailed "the dashboard is broken right now."

Three commands worth memorizing:

- `wrangler tail powerfab-api` — stream every invocation, pretty-printed.
- `wrangler tail powerfab-api --format json` — raw JSON. Pipe to `jq`: `wrangler tail powerfab-api --format json | jq 'select(.tenant_slug == "acme")'`.
- `wrangler tail powerfab-api --search acme` — server-side filter to lines containing the literal string "acme." Saves bandwidth at scale.

Two limits:

- **Ephemeral.** Live events only. If the bug already happened and you weren't watching, you won't see it. The dashboard logs tab keeps the last few days; Logpush keeps the rest.
- **Sampling at scale.** At 5–10 tenants you see every invocation. At 100+ with real traffic, Cloudflare samples — you stop seeing every line. Unreliable for counting; still fine for seeing what an error looks like.

In practice you'll have `wrangler tail` running during deploys and the first hour after any release. After that, the alerts in §8 do the watching.

---

## 6. Logpush — keeping logs longer than three days

Logpush streams log events from Workers (and other CF services) to an external destination, continuously. Destinations include R2, Datadog, Splunk, Better Stack. R2 is the natural choice — you're already paying for it.

**When you need it.** Tenant emails Friday: "the report on Tuesday looked wrong, can you check?" Six days ago. Without Logpush, the logs are gone. With it, they're in an R2 bucket waiting.

**What it looks like.** Logpush writes ndjson files to `logs/YYYY/MM/DD/HH/worker-<id>.ndjson`, partitioned by hour. Each line is one Worker invocation's structured log output — and every line has your `tenant_slug` because of §4. Querying:

```bash
cat logs/2026/05/07/*/worker-*.ndjson | jq 'select(.tenant_slug == "acme" and .level == "error")'
```

That — across all of last Tuesday's logs, filter to acme's errors — is the per-tenant grep Cloudflare doesn't give you natively.

**Cost.** Logpush is paid; not on the free or basic Workers tiers. Not a launch-day requirement, but turn it on before the first tenant reports a hard-to-reproduce bug.

Pitfall — **no log retention plan.** Tenant reports incorrect data from last Tuesday. You go to investigate. Dashboard retention has expired. Nothing to look at. Fix: enable Logpush to R2 on day one of production, before you have a tenant who needs it. R2 storage for logs is cheap. The missing-retention moment always comes at the worst time.

---

## 7. The full log flow

Here's the picture, end to end, of what happens to one log line. This is the headline visual for the doc.

```
ASCII — Log Flow

  Worker invocation (one request from acme.app.example.com)
        |
        |  logger.info("request_start", { method, path })
        |  -> console.log(JSON.stringify({
        |       tenant_slug: "acme",
        |       request_id: "...",
        |       level: "info",
        |       event: "request_start",
        |       ts: 1746619200000,
        |       method: "GET",
        |       path: "/api/jobs"
        |     }))
        v
  +---------------------------+
  |   Cloudflare Logs         |  <-- ~3-day retention
  |   (dashboard "Logs" tab)  |      view recent only, no real query
  +-------+---------+---------+
          |         |
          |         +--- wrangler tail (real-time)
          |              ephemeral, sampled at scale
          |              good for "what's happening RIGHT NOW"
          |
          | Logpush (paid, streaming, continuous)
          v
  +---------------------------------------------+
  |  R2 bucket: logs/YYYY/MM/DD/HH/worker-*.ndjson |
  +-------+-------------------------------------+
          |
          +--- local jq / grep
          |    download the relevant hour's files,
          |    filter by tenant_slug, time range, event
          |
          +--- (future) log search UI
               Grafana Loki, Logtail, Better Stack,
               or a small Worker that reads R2 on demand
```

A few notes on the diagram:

- The Worker itself does nothing special. It just calls `console.log` with a JSON string. Everything downstream is configuration in the Cloudflare dashboard, not code.
- The dashboard logs tab and `wrangler tail` are *parallel* views into the same recent stream. Same data, different UIs, both short-lived.
- Logpush forks the same stream off to R2, where it persists.
- At <50 tenants, downloaded ndjson + `jq` is enough. At >50, a proper log UI starts being worth it. Not a launch-day decision.

---

## 8. The starter alert set

Cloudflare Notifications (in the dashboard under "Notifications") triggers alerts on platform events and sends them to email or to a webhook URL configured in your Slack workspace. The trigger types include:

- HTTP error rate threshold (5xx rate over a rolling window).
- Billing threshold ($X spend on the account).
- Security events (WAF blocks, DDoS detected).
- Worker script health events.

For a solo dev at MVP scale, you want **five alerts**, not fifteen. Here's the starter set:

| Alert | Trigger | Destination | Why |
|---|---|---|---|
| 5xx error spike | >5% of requests over a 10-minute window | Email + Slack | Pages you when something is genuinely on fire |
| Daily request anomaly | Total requests >3x rolling 7-day average | Email | Catches client-side polling loops and runaway scripts before the bill |
| R2 storage threshold | Total stored >20 GB | Email (weekly digest) | The R2 trap — see §10 |
| Billing threshold | Account spend >$50 | Email | Last-line cost defense; if this fires, something is very wrong |
| Container job overrun | Sum of nightly Container minutes >2x expected | Slack via webhook | Catches the .NET nightly job hanging on a malformed export |

Two things about this list:

**The Container job overrun alert is not a native Cloudflare notification.** Cloudflare doesn't know what "expected" means for your batch job. You implement it as a tiny Worker that runs after the nightly batch (or as a step at the end of the orchestrator from 07): it sums the duration_ms values from the `job_start`/`job_end` log events, compares against the expected total, and posts to a webhook URL configured in your Slack workspace if the sum is over the threshold. The whole thing is maybe twenty lines of code; the value is that the nightly job hanging at 3am no longer goes unnoticed until 9am the next day.

**Resist adding a sixth alert.** Pitfall — **alert fatigue.** You set 15 alerts including one for "any 4xx response." The 4xx alert fires 200 times a day (normal — auth retries, expired tokens, robots probing your URLs). Within a week you've muted the channel. The 5xx alert that actually mattered is muted with everything else. Fix: alerts fire on **rates and anomalies**, not raw events. "4xx rate >20% of requests" fires rarely and meaningfully. "Any 4xx" fires constantly and meaninglessly. Five alerts you trust beat fifteen alerts you ignore.

---

## 9. Per-tenant observability — the gap and the workaround

Here's the gap, said plainly: **Cloudflare does not have a per-tenant view.** The Workers analytics tab shows aggregate request counts, error rates, and latencies across every invocation, regardless of subdomain. If acme is having a bad day and the other nine tenants are fine, the aggregate numbers look... fine.

The workaround is what the whole logger pattern was for. Every log line has `tenant_slug`. Logs go to R2 via Logpush. To answer "how is acme doing this week?" you run a `jq` filter on R2 files:

```bash
# All of acme's errors yesterday
aws s3 cp --recursive s3://your-r2-bucket/logs/2026/05/06/ ./logs-may-6/
cat ./logs-may-6/*/worker-*.ndjson \
  | jq 'select(.tenant_slug == "acme" and .level == "error")'
```

(Use the R2 S3-compatible API or `wrangler r2 object` — the exact CLI doesn't matter; the structure does.)

Or in `wrangler tail` for live debugging:

```
wrangler tail powerfab-api --search acme
```

That's the per-tenant view, manually, by string-matching the slug. It's not pretty. It's not a dashboard. But at 5–10 tenants it works, and at 50+ tenants you upgrade to a log UI (Loki, Logtail, Better Stack) that reads from the same R2 bucket — and the logs are already in the right shape because every line had `tenant_slug` from day one.

The decision to make all log lines structured at MVP, before you needed it, is what makes the future upgrade boring instead of a rewrite.

Pitfall — **forgot to add `tenant_slug` to logs.** Logs show errors but you can't tell which tenant is affected, so you have to check all tenants manually, which means you don't, which means a tenant complains for a week before you notice. Fix: the `makeLogger(base)` pattern, enforced at the framework level. The Hono middleware that parses the subdomain calls `makeLogger({ tenant_slug })` and attaches it to the request context. No handler can log without going through it. The compiler can't enforce this on its own — but the convention can, and code review catches the rest.

---

## 10. The R2 storage trap

R2 is where the cost surprises live. Two facts that combine badly:

1. **R2 storage grows monotonically.** Every nightly snapshot adds ~1.6 MB per tenant. Nothing removes anything unless you build a retention job.
2. **R2 charges per byte per month.** Small per-byte, accumulates fast.

At 100 tenants running for 12 months: `100 × 1.6 MB × 365 = ~58 GB`. At Cloudflare's R2 pricing (in 05) that's a small monthly number. The problem isn't 58 GB; it's **the trend.** If you don't notice it growing, by the time you do it's 150 GB and accelerating.

That's why R2 is in the starter alert set at 20 GB. 20 GB is a canary, not a crisis — at MVP scale you won't hit it for months. When it does fire, it's the cue to enable a retention job, not to panic.

The retention job ties back to **11-tenant-lifecycle.md**, which establishes a 30-day grace period for offboarded tenants. On day 31, the offboarding checklist deletes the R2 prefix `tenants/<slug>/`. Two things to add now:

- **A separate retention policy for live tenants' historical snapshots.** Even an active tenant doesn't need 365 days; 90 is plenty for "let me see last quarter." A daily-cron Worker lists `snapshots/{tenant_slug}/` and deletes anything older than 90 days. Caps per-tenant footprint regardless of customer age.
- **The offboarding R2 deletion is the same shape.** When 11's grace period expires, the same listing-and-deleting logic runs once and removes the prefix entirely.

Pitfall — **offboarded tenant's R2 snapshots never deleted.** Twelve months later they account for 30% of total storage. Fix: 11's offboarding checklist explicitly schedules R2 prefix deletion at end of grace period. The 20 GB alert is your fallback when you forget.

Pitfall — **surprise R2 egress.** R2 reads from a Worker are free. R2 reads to the public internet (a public bucket URL, an external analytics tool pulling directly) are billed as egress. Fix: keep all R2 access internal — Worker reads from R2, browser reads from Worker. If an external tool needs logs, push to it (Logpush) rather than letting it pull.

---

## 11. The other cost traps

R2 is the biggest one. Three more, in BUG / FIX form.

**BUG: Client-side polling loop.** The frontend has `setInterval(refreshDashboard, 2000)` instead of `30000` — somebody dropped a zero. Worker request count spikes 15x overnight.

**FIX:** The "daily request anomaly" alert (§8) fires when total requests jump above 3x the rolling 7-day average. You see the alert, run `wrangler tail powerfab-api --search acme`, spot the polling pattern, push a one-line frontend fix. Without the alert: who knows when you'd have noticed.

**BUG: D1 N+1 query.** A Worker route loads 50 jobs, then runs a separate status query per job. 1 request becomes 51 D1 queries. Invisible at 5 tenants, 50x's the bill at 100.

**FIX:** Wrap your D1 client so every `prepare`/`run` increments a counter on the request context, and log it:

```ts
logger.info("request_end", { status: c.res.status, db_queries: c.get("dbCount") });
```

A `jq` query over a day's logs that filters for `db_queries > 10` surfaces every endpoint with N+1 problems. Better: log a warning when the counter crosses 10, so you notice the day the regression ships. Underlying fix is a single `JOIN` — 1 query instead of 51 — but you can't fix what you can't see.

**BUG: Container job hangs on malformed input.** Customer ERP exports a file with a wonky date format. The .NET 8 parser hits an infinite retry loop. The job runs for 4 hours instead of 20 minutes.

**FIX:** Two layers. (1) **Hard timeout in the orchestrating Worker** (07) — kills any Container that exceeds a per-tenant budget. (2) **Container job overrun alert** (§8) — the Container emits `job_start`/`job_end` log events with `tenant_slug` and `duration_ms`; a post-job Worker sums durations and fires a Slack webhook if total minutes exceed 2x expected. Combined: the timeout caps the bleed; the alert names the offender. You wake up to a Slack ping, not a $400 bill at the end of the month.

**BUG: Workers free-tier daily reset confusion.** The free tier's 100,000 requests/day allowance **resets at midnight UTC.** A non-UTC tenant assumes local midnight; their 6 PM heavy hour (which is UTC midnight) gets surprise-billed when the rollover catches them mid-batch.

**FIX:** Once on a paid plan, the daily allowance still applies account-wide; the UTC anchor still applies. Watch the billing dashboard during the first week of production. The Cloudflare billing detail view names the day of any overage. Mostly a "be aware of the boundary" thing.

---

## 12. What about Sentry, Datadog, and the rest?

**Sentry.** Sentry's SDK works in the Workers runtime. It catches uncaught exceptions, groups them by fingerprint (so 50 instances of the same bug show up as one issue), and gives you a UI with "first seen / last seen" timestamps. It adds about 50ms of cold-start overhead and has its own pricing. For MVP, structured `console.error` calls into Logpush plus the dashboard's Errors tab give you the same data. Sentry's grouping is genuinely useful — at 50+ tenants, when error volume justifies it. **Defer Sentry until you find yourself spending more than 30 minutes investigating a single incident because the logs lacked context.**

**Datadog, New Relic, Honeycomb, Splunk.** Real APM. Worth real money with a real team and significant traffic. Noise at 5–10 tenants and 200 requests a day.

**Web Analytics (Cloudflare's free RUM).** Worth turning on. Free JavaScript snippet on the Pages site that reports Core Web Vitals (LCP, FID, CLS, TTFB) from real users' browsers, no cookies, no consent banner. Tells you if the dashboard is slow for a tenant on a bad connection — which neither logs nor Workers analytics will tell you. Just turn it on.

**Workers Analytics Engine.** A Workers binding for writing arbitrary numeric custom metrics, queryable via a SQL-like API. The right tool for custom business metrics on Cloudflare. **Not an MVP requirement.** Structured logs in R2 + `jq` cover the same use cases until you have a real team. Revisit at 50.

Honest tradeoff: every one of these tools is good. Adopting them takes time you don't have. The free, log-based path here gets you to 50 tenants. After that, a real log UI and probably Sentry; after 200, real APM.

---

## 13. What this means for PowerFab

Three operational threads tie the content above to specific PowerFab decisions.

**Per-tenant grep via `tenant_slug` filter.** The workaround for Cloudflare's missing per-tenant view. Hono middleware parses the subdomain → calls `makeLogger({ tenant_slug })` → attaches the bound logger to the request context → every downstream call carries `tenant_slug` automatically. Logs ship via Logpush to R2. To answer "how is tenant X doing?" you `jq` filter on `tenant_slug == "X"`. The single architectural decision that makes this work is putting `tenant_slug` in the bound base, not in each call site.

**The R2 storage trap and the 11-tenant-lifecycle grace period.** R2 grows monotonically; nothing deletes itself. The 20 GB billing alert (§8) is a canary that catches "you forgot to clean up" before it becomes real money. Cleanup is two pieces:

- A daily Worker that prunes snapshots older than 90 days under `snapshots/{tenant_slug}/` for active tenants.
- The day-31 R2 prefix deletion in **11-tenant-lifecycle.md**'s offboarding checklist, which removes a cancelled tenant's full prefix at the end of the 30-day grace period.

Without either, R2 becomes the largest line item on your bill within a year. The 20 GB alert tells you whether your two cleanup mechanisms are actually running.

**The .NET 8 nightly job's runtime alert.** The Container nightly job (07) is the most expensive single thing you run, billed per minute. Failure mode: "hangs on malformed input and runs for hours." Defense in three layers:

1. **Hard timeout** in the orchestrating Worker — kills any Container that exceeds a per-tenant budget.
2. **Structured `job_start`/`job_end` log events** with `tenant_slug` and `duration_ms` — so you know *which tenant* caused the overrun.
3. **Post-job summing Worker** that fires a Slack webhook if total minutes exceed 2x expected.

That's the "Container job overrun" row of the alert table, made concrete. The alert lives outside Cloudflare's native notifications because Cloudflare doesn't know what your nightly batch should cost. You teach it by emitting structured log events and reading them back.

---

## 14. By the end of this doc you should know

- The three questions observability answers: is it broken, what broke for which tenant, and what did it cost.
- The vocabulary primer terms — RUM, p95/p99, Logpush, N+1, Class A/B, APM, ndjson, cold start, structured logs, alert fatigue.
- The full `makeLogger` helper — base fields, the underlying `log` function, the three shorthands, why `JSON.stringify(entry)`, why `extra` spreads last, why `request_id` is optional but `tenant_slug` required.
- How `wrangler tail` and Logpush relate — same source stream, different retentions.
- The log flow: Worker → Cloudflare Logs (~3-day) → Logpush → R2 ndjson → `jq` or future log UI.
- The starter alert set: 5xx spike, request anomaly, R2 threshold, billing threshold, Container overrun. And the rule about rates not raw events.
- Why per-tenant observability requires the `tenant_slug` workaround, and why the structured logger pattern is the load-bearing piece.
- The R2 storage trap, the 20 GB canary, and how cleanup ties to 11's offboarding grace period.
- The four cost-anomaly BUG/FIX pairs — polling loop, N+1 queries, Container hang, UTC reset.
- Why Sentry and full APM are deliberately deferred at MVP, and what the upgrade triggers look like.

If any of those still feel hazy, scroll back. §4 (the logger) is the keystone. If that's clear, everything else slots in around it.

---

**Next:** 15-deploys-and-rollbacks.md — shipping changes safely from `git push` through Pages preview, staging, and production; how to roll back when a deploy breaks production; and how the alerts in §8 hook into the deploy flow.
