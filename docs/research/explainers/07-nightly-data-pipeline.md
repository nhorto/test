# 07 — No More Nightly Pipeline (and What to Do With the C# Binary)

> **Prerequisites:** read `00-start-here.md`, `05-cloudflare-architecture.md` (the new Tauri architecture), and `06-customer-data-ingest.md`.

> **By the end of this doc you will know:**
> - Why the nightly batch pipeline is *gone* in the new architecture, and what replaces it.
> - What the old pipeline (Python + C# .NET 8 binary, writing 17 JSON snapshots) did, piece by piece, so you understand what we're trading away.
> - Where each of those responsibilities moves in the new world — most of them dissolve into "run on demand in the gateway."
> - The honest decision the docs leave open: **what to do with the C# .NET 8 binary.** Rewrite in Python? Keep as a sidecar? Rewrite in Rust? Rewrite in TypeScript? Pros and cons of each.
> - What "live" actually means in performance terms — and the cache pattern that makes live affordable.

---

## 1. The big shift

The original plan had a nightly batch pipeline: at 7am UTC, a chain of Cloudflare Workers would wake up, fan out across 200 customers, run the C# binary against each customer's database through a tunnel, write 17 JSON files per tenant to R2, and the dashboard would read those files all day. If you opened the dashboard at 3pm, you saw numbers as of 7am.

The new plan kills all of that. Live data. Every time you open a module, the desktop app asks the gateway, the gateway asks the database, and you see the current numbers.

```
   OLD:  Database  --(once a night)-->  Pipeline  -->  R2 snapshot JSONs  -->  Dashboard
                                                                          (24 hours stale)

   NEW:  Database  <--(per dashboard open)--  Gateway  <--  Dashboard
                                                            (live)
```

This shift removes a lot of moving parts and adds one (the gateway). The trade is fewer-things-to-orchestrate for slightly-more-CPU-per-render. For dashboards with metrics over reasonable time windows, the trade is great — but only if you cache appropriately, which §6 covers.

---

## 2. What the old pipeline did (and where it goes now)

To make the shift concrete, let's enumerate what the pipeline used to handle and trace each responsibility to its new home.

### 2.1 "Wake up on a schedule" (Cron Trigger)

**Old:** A Cloudflare Cron Trigger fired at 7am UTC daily.

**New:** Gone. There's no schedule. The dashboard opens, the gateway is asked, data comes back. The "schedule" is "whenever a user looks."

### 2.2 "Figure out who today's customers are" (a tenant registry)

**Old:** A `tenants` table or KV lookup of all active tenants.

**New:** Gone. There's no "all tenants" iteration. Each tenant's app talks to their own gateway. Each gateway only knows about its own tenant. We never enumerate.

### 2.3 "Reach into each customer's database" (Cloudflare Tunnel + C# binary)

**Old:** Cloudflared running inside the customer's network exposed their MySQL to a Worker, which spun up a Cloudflare Container that ran the C# binary which connected to MySQL and read tables.

**New:** The gateway, sitting on the customer's LAN, connects to the database directly over the LAN. No tunnel. No container. (Doc 06 covers exactly how.)

### 2.4 "Generate JSON" (the C# binary + Python wrapping)

**Old:** A C# .NET 8 binary contained the metric-computation logic — given DB rows, produce the shaped output. Python wrapped it for ergonomics.

**New:** The metric-computation logic still has to live *somewhere*. In the new world its home is the gateway. **What language it's written in is the one genuinely open question** — see §4.

### 2.5 "Publish JSON atomically" (the manifest pattern)

**Old:** Write all 17 JSONs to R2 with a version, write a `manifest.json` that points to that version. Dashboard reads the manifest first. This ensured the dashboard never saw a half-written snapshot.

**New:** Gone. There's no snapshot to publish atomically because there's no batch write. Each request gets fresh data; consistency is per-request, not per-snapshot.

### 2.6 "Write down what happened, page on failure" (logs, DLQ, alerts)

**Old:** Workers logged to a D1 table. Failed messages went to a Dead-Letter Queue. A separate Worker watched the DLQ and pinged Slack.

**New:** Logs live on the gateway machine. Failure to fetch a metric is observed by the user directly (they see a "couldn't load this metric" tile). Health monitoring becomes "is the gateway up?" — a much simpler thing to check (doc 14).

### 2.7 "Handle UTC and DST" (cron expressions)

**Old:** Headaches about whether `0 7 * * *` meant 3am Eastern, 2am Eastern, etc.

**New:** Gone. No schedule.

### 2.8 "Handle schema migrations" (versioned snapshots in R2)

**Old:** Each snapshot included a schema version so a v1 dashboard wouldn't break on a v2 snapshot.

**New:** Still applies — the gateway and the desktop app have to agree on the shape of metric responses. But the coordination is simpler because there's one gateway version per customer (we control its deployment, doc 11) and one dashboard version per customer (auto-updater, doc 12).

---

## 3. So what does the gateway actually do at run time?

Recap from doc 06, with the lens of "this used to be the pipeline":

```python
@app.get("/metrics/time/monthly-hours", dependencies=[Depends(check_auth)])
def time_monthly_hours():
    with engine.connect() as conn:
        rows = conn.execute(sa.text("""
            SELECT YEAR(work_date) AS yr, MONTH(work_date) AS mo, SUM(hours) AS hrs
            FROM time_entries
            WHERE work_date >= DATEADD(MONTH, -12, GETDATE())
            GROUP BY YEAR(work_date), MONTH(work_date)
            ORDER BY yr, mo
        """)).all()
    return {"data": [{"month": f"{r.yr}-{r.mo:02d}", "hours": float(r.hrs)} for r in rows]}
```

This little function is doing — in 8 lines — what used to take a multi-stage pipeline: connect to DB, run query, shape result. It runs in response to a request, not on a schedule. The "pipeline" is collapsed into one synchronous call.

For 80 metrics, there are 80 endpoints like this. Each is short. Each is independent. Each is testable in isolation.

That's the architecture. The rest of this doc is about the **language** that this code is written in.

---

## 4. What to do with the C# .NET 8 binary

The old pipeline used a C# binary because that's what someone wrote first. In the new architecture, the metric logic lives in the gateway. We have to decide what language the gateway is in. This is genuinely an open question, and I'll lay out the options honestly.

### Option 1 — Rewrite everything in Python

Port the C# logic to Python. The gateway is a single Python service.

**Pros.**
- Same language as the rest of the existing pipeline code (Python wrapping the C# binary). You already have Python in your stack.
- Python has excellent DB drivers for SQL Server (`pyodbc`, `pymssql`), MySQL, Postgres, etc.
- FastAPI is a great HTTP-server framework.
- Easy to debug, easy to read.
- One language to maintain.

**Cons.**
- You have to actually port the C# logic. Depending on how much there is, this is real work.
- Python is slower than C# / Rust for CPU-heavy computation. For our metric queries (mostly SQL + light shaping), this almost certainly doesn't matter.
- Deploying Python on Windows machines is fiddly (PyInstaller, embedded Python, or a Docker container).

**Best if.** You like Python, you have time to port, and the C# logic is straightforward.

### Option 2 — Keep the C# binary, call it from the gateway

Write a thin gateway in Python (or Rust) whose HTTP endpoints just shell out to the C# binary for the actual metric logic.

```python
@app.get("/metrics/time/monthly-hours", ...)
def time_monthly_hours():
    output = subprocess.run(
        ["./powerfab-metrics.exe", "--metric", "time.monthly-hours"],
        capture_output=True, check=True,
    ).stdout
    return json.loads(output)
```

**Pros.**
- Zero porting work. The C# binary continues to do what it does.
- C# is fast.
- You can rewrite later piece-by-piece.

**Cons.**
- Spawning a process per request is slow (typically 50–300 ms of overhead per call). For a dashboard that loads 30 metrics on open, that's ~1.5–9 seconds of process spawning. Painful.
- You can have the C# binary run as a long-lived sidecar with its own HTTP/RPC interface to avoid spawn overhead — but now you've built a second service inside your gateway. Complexity creeps.
- Two languages to maintain. Anyone working on the gateway has to know both.
- Distribution: you have to ship both the gateway runtime AND the C# binary AND the .NET runtime to every customer's gateway machine.

**Best if.** The C# logic is large and gnarly, and you'd rather defer porting.

### Option 3 — Rewrite in Rust (the gateway's natural language)

Tauri's backend is Rust. Why not write the gateway in Rust too?

**Pros.**
- Same language as the Tauri Rust side — knowledge transfer is good.
- Excellent performance, single static binary you can drop on any machine.
- Strong types catch bugs early.
- Compile-time correctness for SQL via libraries like `sqlx` (queries are checked against the DB at build time).

**Cons.**
- Steeper learning curve than Python.
- Slower to write than Python.
- SQL Server support in Rust is less polished than Python.
- For metric logic that's mostly "read rows, do simple math, return JSON," Rust's strengths (performance, type safety) are less valuable than Python's strengths (write fast, read fast).

**Best if.** You want one language across the stack (Rust for both the Tauri backend and the gateway) and the team's comfortable with Rust.

### Option 4 — Rewrite in TypeScript (Node)

A TypeScript gateway running on Node.js.

**Pros.**
- Same language as the React UI. Shared types between the gateway response and the React fetch.
- Excellent DB drivers via npm.
- TypeScript's type system is genuinely useful for shaping API responses.

**Cons.**
- Node on Windows can be fussy.
- Async error handling in Node is a foot-gun if you're not careful.
- Adds another language runtime to install on the gateway box (Node).

**Best if.** You want type-shared contracts between gateway and UI and you're comfortable with Node deployment.

### Option 5 — Hybrid: Python gateway with the C# binary as a long-lived sidecar

A middle path. The Python gateway starts the C# binary at startup; the C# binary listens on a Unix socket or local TCP port and serves "give me metric X" requests. No per-request spawn overhead.

**Pros.**
- Keeps the C# code as-is.
- Python on the outside (where you want it) and C# on the inside (where the existing logic is).
- Spawn overhead happens once at startup.

**Cons.**
- Two languages, two runtimes, two release cycles.
- You design the IPC protocol between Python and C#. Easy to get wrong.
- Distribution: still need .NET + Python on every gateway machine.

**Best if.** You're certain the C# logic is too valuable to port AND too slow as a per-request subprocess.

### Comparison table

| Option | Languages | Porting work | Perf | Distribution | Long-term cost |
|---|---|---|---|---|---|
| 1 — All Python | 1 (Py) | Real | Fine | Easy-ish | Low |
| 2 — Python + spawn C# | 2 | None | Bad | Hard | Medium |
| 3 — All Rust | 1 (Rust) | Real | Excellent | Easy | Medium-low |
| 4 — All TypeScript | 1 (TS) | Real | Good | Easy | Low |
| 5 — Python + sidecar C# | 2 | None | Good | Hard | Medium-high |

### A non-prescriptive recommendation

If pushed to pick one — **Option 1 (all Python)**. The reasons:

- The metric logic is mostly "SQL + shape JSON," which is exactly what Python is great at.
- One language to maintain.
- Easy to hand off to anyone else later.
- The "C# is fast" argument doesn't apply when 95% of the time is in the SQL query, not in the metric computation.

But if porting the C# is genuinely scary (e.g., it does some non-trivial domain math), Option 5 is a defensible bridge — port one metric at a time from C# to Python; eventually retire the C# binary.

**Avoid Option 2 (per-request spawn).** The latency adds up too quickly to be tolerable for a "live" dashboard.

This is a decision worth making explicitly during the project kickoff. Once made, every metric handler is written that one way and the docs (06, 09) get specific about the language.

---

## 5. What about scheduled work that still might make sense?

We said "no nightly pipeline." That's mostly true, but there are a few cases where a scheduled job on the gateway is still useful:

### 5.1 Materialized cache refreshes for expensive metrics

If a metric requires a heavy SQL query (e.g., a 12-month rolling window over a big table), running it on every dashboard open might be slow. A scheduled job inside the gateway can precompute and cache the result every hour (or 15 minutes, or whatever):

```python
@app.on_event("startup")
async def schedule_refresh():
    asyncio.create_task(refresh_loop())

async def refresh_loop():
    while True:
        try:
            await refresh_heavy_metrics()
        except Exception as e:
            log.exception("refresh failed")
        await asyncio.sleep(15 * 60)  # every 15 minutes
```

This is *inside the gateway*, not a separate scheduled service. It's an implementation detail of "make some metrics fast." From the dashboard's perspective, everything is still live (it always asks the gateway), but some endpoints serve cached numbers.

### 5.2 Cleanup or housekeeping inside the gateway

If the gateway accumulates any local state (logs, cached responses, temporary files), an internal scheduler cleans them up. Same pattern — inside the gateway, not a separate orchestrator.

### 5.3 Things that genuinely require batch — none

For our dashboards, all metrics are queryable on demand. There's nothing that fundamentally needs a batch run. If a future feature does (say, an emailed weekly report), the gateway grows a scheduled task for it. We cross that bridge when it shows up.

---

## 6. Making "live" actually fast — caching strategy

"Live" is great until it's slow. A 4-second dashboard open is worse than 24-hour-stale data the user already learned to live with. Cache strategy:

### 6.1 The default: no cache, run on every request

For metrics whose query takes < 500 ms, just run on every request. Simpler, no stale-data debate.

### 6.2 In-gateway cache for slow metrics

```python
from cachetools import TTLCache
import time

cache = TTLCache(maxsize=1000, ttl=60)  # 60 seconds

@app.get("/metrics/estimating/win-rate")
def win_rate():
    key = "estimating.win-rate"
    if key in cache:
        return cache[key]
    with engine.connect() as conn:
        result = compute_win_rate(conn)
    cache[key] = result
    return result
```

A 60-second TTL means: the dashboard always reads from the cache, the cache refreshes at most once a minute. For metrics that don't change minute-by-minute, this is plenty live.

### 6.3 React Query / browser-side cache

The dashboard also caches in the webview. React Query (or TanStack Query) does this beautifully — same metric requested twice in a short window only fetches once. Doc 09 covers this on the React side.

### 6.4 Don't pre-cache everything

Avoid the temptation of "let's prefetch all 80 metrics on app boot." That's just the nightly pipeline in disguise. Prefetch a metric *when the user is about to look at it* (e.g., when they navigate to its module), not before.

---

## 7. What this means for the C# binary in practice

If you go with **Option 1 (Python rewrite)**:
- You'll port each metric's computation from C# to Python, one at a time.
- The C# binary stops being part of the deployed system.
- You can keep it in the repo for reference until porting is complete, then archive it.

If you go with **Option 2/5 (keep C# somehow)**:
- The C# binary becomes a sidecar of the gateway.
- Bundle it alongside the gateway in the installer for the gateway machine.
- Document the IPC protocol between gateway and C# binary.

Either way, the C# binary is **never invoked by the desktop apps directly.** It only ever runs on the gateway machine, behind the gateway's bearer-token-authenticated HTTP API.

---

## 8. Common pitfalls

### 8.1 "Let's just keep the pipeline AND the gateway"

If you find yourself thinking "we'll keep the nightly pipeline as a backup, and the live gateway for fresh data," stop. Now you have two systems to maintain, two definitions of every metric (the nightly C# version and the live Python version), and inevitable drift between them. Pick one.

### 8.2 Pre-fetching all metrics at app boot

Tempting because it makes everything feel instant. But it makes the gateway do 80 queries at every dashboard open per employee. With 30 employees and a 9am login spike, that's 2400 queries in a minute. Fetch on demand.

### 8.3 Skipping caching for genuinely slow metrics

A 5-second query is fine to run nightly; not fine to run on every dashboard open. Add the in-gateway TTL cache for those specific metrics.

### 8.4 Forgetting the gateway is a single point of failure

When the gateway is down, the dashboard is down. Treat the gateway as production infrastructure: monitoring, alerts, graceful restart, log rotation. Doc 14 has the checklist.

### 8.5 Building a "metric definition DSL" so config can describe new metrics

Same trap as anti-pattern 3.2 in doc 04 (Turing-complete config). New metric = code change in the gateway + code change in the registry. Not a JSON schema for metric definitions.

---

## 9. By the end of this doc you should know

- Why the nightly pipeline goes away entirely in the new architecture.
- Where each of its responsibilities (schedule, fan-out, atomic publish, DLQ, etc.) moves — most of them dissolve.
- The five language options for the gateway: all Python, Python + per-request C#, all Rust, all TypeScript, Python + sidecar C#. Pros and cons of each.
- Why the per-request-spawn option (#2) is a trap.
- That this is a real decision you need to make, with my soft recommendation being Option 1 (all Python).
- Why "live" isn't expensive if you cache the right things — and why pre-fetching everything misses the point.
- What happens to the C# binary in each scenario.

---

**Next:** [`08-data-isolation.md`](./08-data-isolation.md) — in a world where each install is single-tenant by default, what isolation concerns still exist and how to handle them.
