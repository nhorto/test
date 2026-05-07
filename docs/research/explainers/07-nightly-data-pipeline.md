# 07 — The Nightly Data Pipeline: Cron, Queues, Containers, and the Manifest Pattern

> **Pre-reqs:** Read `00-start-here.md` (vocabulary), `05-cloudflare-architecture.md` (the products on Cloudflare), and `06-customer-data-ingest.md` (how the C# .NET 8 binary actually reaches into a customer's MySQL through a tunnel).
>
> **What you'll know by the end:** How one cron firing at 7am UTC ends up writing 200 customers' worth of fresh JSON into R2 — without one bad customer breaking the other 199, without the dashboard ever showing half-old / half-new data, and with you (Nick) getting paged in Slack the moment something fails. We will walk every box in the diagram and every line of every pseudocode block.

---

## 1. The hook

Today, on the Windows box, you have one cron-like Task Scheduler entry that runs Python which runs the C# binary which writes 17 JSONs into a folder. One customer. One machine. If something fails you find out the next morning when you open the dashboard and the numbers haven't moved.

Tomorrow you will have 200 customers, each with their own MySQL hidden behind their own firewall, and they all expect fresh numbers by the time the morning shift starts. That means once a night, your code has to:

1. Wake up on a schedule.
2. Figure out who today's customers are.
3. Reach into each customer's database (separately, with their credentials, through their tunnel).
4. Generate JSON.
5. Publish that JSON in a way that never shows the dashboard a partially-written snapshot.
6. Write down what happened, for every tenant, success or failure.
7. Page you when something is broken — not the next morning, *now*.

This doc is the cookbook for doing that on Cloudflare. Most of the moving parts are products you read about in `05-cloudflare-architecture.md` (Cron Triggers, Queues, Containers, R2, D1, KV). What's new here is **how they fit together** into one orchestrated pipeline, plus three patterns you have to get right or things go sideways: **fan-out**, **the manifest pattern**, and the **DLQ + alert path**.

---

## 2. What you'll know by the end

- What a Cron Trigger is, why one is enough, and why "200 crons" is a bad idea.
- What "fan-out via Queue" means and why it's better than a tight `for` loop.
- How a Cloudflare Worker invokes a Container, what's in the request body, and how secrets travel safely.
- The **manifest pattern** for atomic publishing — the single most important pattern in this doc.
- Where each piece of state lives (KV, D1, Workers Secrets, manifest.json, R2 bucket).
- What a Dead-Letter Queue (DLQ) is, and how a failed run becomes a Slack ping to your phone.
- How to handle UTC, daylight saving time, and schema versioning.
- Ten common pitfalls and how to avoid each one.

---

## 3. Vocabulary primer

Define every term before use. Refer back here whenever something feels mystery-meat.

- **Cron** — A unix tradition for "run this on a schedule." A cron expression is five fields (`minute hour day-of-month month day-of-week`) that say *when* to run. `0 7 * * *` means "at minute 0 of hour 7, every day, every month, any day of the week" — i.e., 7:00 AM.

- **Cron Trigger (Cloudflare)** — A binding you attach to a Worker that tells Cloudflare "wake this Worker up on this schedule." Instead of calling the Worker's normal `fetch()` handler (the one for HTTP requests), Cloudflare calls its `scheduled()` handler. Same Worker, different entry point.

- **UTC** — Coordinated Universal Time. The time zone everyone agrees on so we don't argue about whose clock counts. Cloudflare runs all crons in UTC. Always. There is no setting for "use Eastern Time."

- **DST** — Daylight Saving Time. The thing that makes 2 AM Eastern different from 2 AM Eastern depending on the season. Avoiding DST gotchas is why we work in UTC and pick a time that's safely past midnight in every customer's local time.

- **Producer** — In queue-speak, the program that *puts* messages into a queue.

- **Consumer** — In queue-speak, the program that *pulls* messages out of a queue and does work for each one.

- **Queue (Cloudflare Queues)** — Cloudflare's managed message queue. Producer Workers `send` messages to it; consumer Workers receive them, one or a small batch at a time, and run their handler. If the handler throws, Cloudflare redelivers the message later. After enough failures, the message goes to a Dead-Letter Queue.

- **Fan-out** — Taking one event ("nightly run starts") and turning it into many smaller events ("run for tenant 1", "run for tenant 2", … "run for tenant 200"). Fan-out is what lets us run 200 jobs in parallel instead of one after another.

- **DLQ (Dead-Letter Queue)** — A separate queue where messages go to die. When the main queue gives up retrying a message, it lands in the DLQ. A tiny consumer Worker on the DLQ logs the failure and pings you.

- **Idempotent** — A fancy word for "running it twice has the same effect as running it once." If you run the nightly pipeline for Acme on May 7th twice in a row, you should get exactly one good Acme-May-7 snapshot — not two, not a Frankenstein mix. Idempotency is what makes retries safe.

- **Manifest** — In our pipeline, a small JSON file (`manifest.json`) that lists which module files belong to a given run, with their sizes and checksums. The manifest is written *last*. The presence of a fresh manifest is what tells the dashboard "this run finished successfully — you can read these files now."

- **Pointer file** — A tiny file that points at something else. We have one called `current.json` per tenant. Its only job is to say "the freshest good run is dated 2026-05-07." The dashboard reads `current.json` first, then follows the pointer.

- **Atomic** — All-or-nothing. An atomic write is one that either completed fully or didn't happen at all — never partially. R2 doesn't give you atomic multi-file writes natively. The manifest + pointer pattern fakes atomicity by making the pointer flip the *one* thing that publishes a run.

- **Run-to-completion** — A scheduling property: once a job starts, the system lets it finish before it can be killed by another invocation of the same job. Cloudflare Queues consumers run-to-completion per message — once a consumer picks up a message, it runs until done or until it throws.

- **Exponential backoff** — Retry strategy where the wait between retries gets longer each time. First retry after 1 minute, second after 5, third after 15. The idea is "if the customer's DB is overloaded, hammering it every second makes it worse."

- **Container (Cloudflare Containers)** — A real Linux container running on Cloudflare's edge, started on-demand from a Worker. Inside lives our C# .NET 8 binary. Scale-to-zero: when no Worker is calling it, you pay nothing.

- **Binding** — Cloudflare-speak for "a thing your Worker can talk to": a KV namespace, a D1 database, a Queue, a Container, a Secret. Bindings are wired up in `wrangler.toml` and appear on the `env` object inside the Worker.

- **Workers Secret** — An encrypted environment variable for Workers. You set it once with `wrangler secret put X`. The Worker reads `env.X` at runtime. Secrets are never logged.

- **Structured logging** — Logging in JSON instead of plain text strings, so you can query and filter logs by field (e.g., "show me all runs where `tenant_slug = acme` and `status = failed`"). Cloudflare Workers Logs and external sinks both prefer this shape.

- **Tenant registry** — The list of "who are our customers right now." Lives in D1 and/or KV. The Cron Worker reads it to decide who to fan out to.

If any of these feel hand-wavy, re-read this section after you finish §4 below. The big picture clears them up.

---

## 4. The big picture

This is the diagram. We will refer back to it the entire rest of the doc. Print it out, keep it in your head.

```
                              +------------------------+
                              |  Cron Trigger          |
                              |  "0 7 * * *" (UTC)     |
                              |  fires Producer Worker |
                              +-----------+------------+
                                          |
                                          | invokes scheduled()
                                          v
+-----------------+      reads     +------+-----------+
|  KV/D1: tenant  | <------------- |  Producer Worker |
|  registry       |                |  (Cron handler)  |
+-----------------+                +------+-----------+
                                          |
                                          | env.NIGHTLY_QUEUE.send(...)
                                          | one message PER tenant
                                          v
                              +-----------+------------+
                              |  Queue: nightly-runs   |
                              |  (buffers 200 msgs)    |
                              +-----------+------------+
                                          |
                                          |  Cloudflare delivers to many
                                          |  consumer instances in parallel
                                          v
                              +-----------+------------+
                              |  Consumer Worker       |  --+
                              |  (queue handler)       |    |
                              +-----------+------------+    |
                                          |                 | x N parallel
                                          | env.CONTAINER   | (one per msg)
                                          |   .fetch(req)   |
                                          v                 |
                              +-----------+------------+    |
                              |  Container             |  --+
                              |  PowerFabDataGen.exe   |
                              |  (C# .NET 8)           |
                              +-----+------------+-----+
                                    |            |
                       reads via    |            |  writes JSON to
                       Cloudflare   |            |  R2 (S3 API)
                       Tunnel       |            |
                                    v            v
                       +------------+----+   +---+----------------------------+
                       | Customer's      |   | R2: tenants/<slug>/snapshots/  |
                       | on-prem MySQL   |   |   <YYYY-MM-DD>/                |
                       | (and FabSuite   |   |     estimating.json            |
                       |  XML endpoint)  |   |     time.json                  |
                       +-----------------+   |     ...17 module files...      |
                                             |     manifest.json (last!)      |
                                             |   current.json  (pointer)      |
                                             +--------------------------------+

                              +-----------+------------+
                              |  Consumer Worker       |  ---> D1: nightly_runs (insert)
                              |  (after container OK)  |  ---> KV: lastRun:<slug> (set)
                              +------------------------+

       Failure path (when retries exhaust):

       Queue --> DLQ: nightly-dlq --> DLQ Consumer Worker --> Slack webhook --> Nick's phone
```

Read it slowly. The shape is: **one schedule, one fan-out, many parallel runs, two destinations (customer DB in, R2 out), one publish (manifest), one log row per attempt, one pager on failure.**

Everything else in this doc is just zooming into one box at a time.

---

## 5. Box 1 — Cron Trigger fires

The whole pipeline starts with a single line in `wrangler.toml`:

```toml
[triggers]
crons = ["0 7 * * *"]
```

That's it. Once that's deployed, Cloudflare promises to invoke our Worker's `scheduled()` handler at 07:00 UTC every day.

### 5.1 The cron expression, field by field

```
0      7      *      *      *
^      ^      ^      ^      ^
|      |      |      |      +-- day of week  (0-6, * = any)
|      |      |      +--------- month        (1-12, * = any)
|      |      +---------------- day of month (1-31, * = any)
|      +------------------------ hour         (0-23)
+------------------------------- minute       (0-59)
```

`0 7 * * *` reads as: "minute 0, hour 7, any day, any month, any day-of-week." So 07:00 UTC daily.

A few more for reference:
- `*/15 * * * *` — every 15 minutes
- `0 */6 * * *` — every 6 hours, on the hour
- `0 7 * * 1-5` — 07:00 UTC, Monday through Friday only
- `@daily` — Cloudflare also accepts macros; this is shorthand for `0 0 * * *`

### 5.2 Why UTC, and the DST gotcha

Cloudflare Cron Triggers run in **UTC**, full stop. There is no "tenant local time" knob.

Your customers care about "before the morning shift starts." For US East Coast shops, the shift starts around 6 AM ET. ET is UTC-5 in winter (EST) and UTC-4 in summer (EDT) — that one hour shifts twice a year on DST changes.

Concrete example. You pick `0 6 * * *` (6 AM UTC):
- In **winter** (EST = UTC-5), 6 AM UTC = **1 AM Eastern**. Pipeline runs at 1 AM. Fine.
- In **summer** (EDT = UTC-4), 6 AM UTC = **2 AM Eastern**. Pipeline runs at 2 AM. Also fine.

Both are well before the morning shift. So `0 7 * * *` (7 AM UTC = 2 AM EST = 3 AM EDT) is the safer "always after midnight Eastern, always before the shift" choice. It survives DST without surprises.

The general rule: **pick a UTC time that's safely after midnight in your latest customer's local zone, and safely before their morning shift, in BOTH winter and summer.** Don't pick something close to a boundary or you'll get bug reports the week after a DST change.

### 5.3 Why one cron, not 200

You might think: "I'll just create one cron per tenant with their preferred run time." Here's why that's a trap:

| Pattern | Verdict |
|---|---|
| One Cron Trigger, Worker fans out to a Queue | Yes |
| One Cron Trigger per tenant (200 separate cron entries) | No — see below |
| One Cron, Worker iterates all tenants in-process | No — see §6 |

200 cron entries means 200 lines in `wrangler.toml` (or 200 Workers), no shared visibility, and an impossible onboarding story ("when a customer signs up, also edit the deploy config and redeploy"). Cloudflare allows 250 triggers per account on the paid plan, which sounds plenty until you remember some triggers might be needed for other things, and that any per-tenant cron is config-as-code drift.

**One cron, fan out via Queue.** That's the answer. Always.

### 5.4 What the Cron Worker is allowed to do

The Cron Worker has one job: read the registry, publish messages, return. Not "run the job." Not "talk to the customer DB." Just publish messages.

There are two reasons for this minimalism:

1. **Failure surface.** The less the Cron Worker does, the less can go wrong. If publishing succeeds, the queue's retry machinery handles every later failure. If the Cron Worker itself crashes mid-loop, tenants past the crash point silently get skipped — Cloudflare does **not** auto-retry a failed scheduled invocation.

2. **CPU budget.** Workers have a 30-second CPU-time cap (configurable up to 5 minutes on paid). Publishing 200 small messages takes milliseconds. Doing the actual work for 200 tenants serially would blow past that budget long before tenant 200.

---

## 6. Box 2 — The Producer Worker reads the registry and fans out

Here's the Cron Worker's `scheduled()` handler. We're using Hono types but the handler doesn't actually need Hono — it's straight Workers API.

```ts
// worker/cron.ts

type Env = {
  TENANT_REGISTRY: KVNamespace;        // KV with all tenant slugs
  NIGHTLY_QUEUE: Queue<NightlyRunMsg>; // the fan-out queue
};

type NightlyRunMsg = {
  tenantSlug: string;
  runDate: string;     // "2026-05-07", chosen by the producer
  attempt: number;     // 1 on first publish; queue increments on retry
};

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const runDate = new Date(event.scheduledTime).toISOString().slice(0, 10);
    const tenants = await listActiveTenants(env);

    let okCount = 0;
    for (const slug of tenants) {
      try {
        await env.NIGHTLY_QUEUE.send({ tenantSlug: slug, runDate, attempt: 1 });
        okCount++;
      } catch (err) {
        console.error("publish_failed", { slug, err: String(err) });
      }
    }

    console.log("fanout_done", { runDate, total: tenants.length, ok: okCount });
  }
};
```

Walking line by line.

```ts
type Env = {
  TENANT_REGISTRY: KVNamespace;
  NIGHTLY_QUEUE: Queue<NightlyRunMsg>;
};
```

These are the bindings (recall §3: a binding is something the Worker can talk to). `TENANT_REGISTRY` is a KV namespace where we store the list of active tenants — we'll keep it simple and just enumerate keys with prefix `tenants:`. `NIGHTLY_QUEUE` is the Cloudflare Queue we'll fan messages into. Both come from `wrangler.toml`.

```ts
type NightlyRunMsg = {
  tenantSlug: string;
  runDate: string;
  attempt: number;
};
```

The shape of one queue message. **Notice what's NOT here**: no DB password, no FabSuite token, no API keys. Queue messages are observable in Cloudflare's tooling — anything you put in here might show up in a log somewhere. Secrets stay in Workers Secrets. The message just has the slug; the consumer looks up secrets by slug.

```ts
async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
```

The `scheduled` handler. Cloudflare calls this — not `fetch` — when a Cron Trigger fires. `event.scheduledTime` is the millisecond timestamp Cloudflare *intended* to fire (not necessarily exactly when our code started).

```ts
const runDate = new Date(event.scheduledTime).toISOString().slice(0, 10);
```

Take the scheduled timestamp, convert to ISO string (`"2026-05-07T07:00:00.000Z"`), keep the first 10 chars (`"2026-05-07"`). This is our "run date" — every output file for this run will be keyed under this date. Using `event.scheduledTime` instead of `Date.now()` means a delayed-by-30-seconds firing still produces files dated for the intended day. Tiny detail; it matters for cleanliness.

```ts
const tenants = await listActiveTenants(env);
```

A helper (we'll define it in a moment). Returns an array of slugs: `["acme", "bobs-beams", "cora-construction", ...]`.

```ts
let okCount = 0;
for (const slug of tenants) {
  try {
    await env.NIGHTLY_QUEUE.send({ tenantSlug: slug, runDate, attempt: 1 });
    okCount++;
  } catch (err) {
    console.error("publish_failed", { slug, err: String(err) });
  }
}
```

The fan-out loop. For each tenant, push one message onto the queue. **The `try/catch` per iteration is critical** — if one tenant's send call somehow fails (rare, but possible), we don't want it to abort the loop and skip the remaining 153 tenants. Catch and log, keep going.

`attempt: 1` is just a hint we send. The queue's own retry counter is the source of truth, but having `attempt` in the message makes consumer logging clearer.

```ts
console.log("fanout_done", { runDate, total: tenants.length, ok: okCount });
```

The heartbeat. This is your "the cron actually fired" signal — search Workers Logs for `fanout_done` and you'll see one entry per night. If you don't see one, set up an alert. (We'll get into observability in §13.)

### 6.1 The `listActiveTenants` helper

```ts
async function listActiveTenants(env: Env): Promise<string[]> {
  const list = await env.TENANT_REGISTRY.list({ prefix: "tenants:" });
  return list.keys.map(k => k.name.slice("tenants:".length));
}
```

`KV.list({ prefix })` returns all keys starting with that prefix. Keys look like `tenants:acme`, `tenants:bobs-beams`, etc. We strip the prefix and return just `["acme", "bobs-beams", ...]`.

For 200 tenants this is one cheap KV operation. If you grow to 10,000 tenants you'd graduate to D1 with a real `SELECT slug FROM tenants WHERE active = 1`. For the foreseeable future, KV `list` is fine.

### 6.2 What the Cron Worker is NOT doing

It is *not*:
- Talking to any customer DB.
- Running the C# binary.
- Writing to R2.
- Updating run status anywhere.

All of that is the consumer's job. The Cron Worker exists only to convert "it's 7 AM UTC" into 200 queue messages. Total wall-clock: under a second on a normal day.

---

## 7. Box 3 — The Queue, and why fan-out beats a tight loop

You might be wondering: if we have 200 tenants, why not just put a `for` loop in the Cron Worker and run them one at a time?

Here's the comparison from the brief:

| Concern | Tight loop in Cron Worker | Queue fan-out |
|---|---|---|
| Parallelism | Sequential — 200x serial | Cloudflare runs many consumers concurrently |
| Per-tenant retry | All-or-nothing | Each message retried independently |
| Crash isolation | One panic kills the run | Bad message goes to DLQ, others continue |
| Wall-clock limit | One Worker's 30s/5min CPU cap | Each consumer invocation has its own budget |
| Backpressure | None (you'd hammer customer DBs) | Configurable consumer concurrency |

Read each row. Each one is a real problem at scale.

**Parallelism.** A tight loop processes tenants one after another. Even if each tenant takes 30 seconds, that's 100 minutes for 200 tenants. The Cron Worker's CPU limit (30 sec by default, 5 min max) caps you long before that. With Queue fan-out, Cloudflare can be running 10+ consumers at the same time — you're done in ~10 minutes wall-clock.

**Per-tenant retry.** If tenant 73's run fails because their MySQL was rebooting, you want *only* tenant 73 to retry — not the whole batch. The queue redelivers the failing message; the others are already done.

**Crash isolation.** A bad config or malformed registry entry on one tenant shouldn't take down the whole night. With a queue, that one message hits the DLQ; the others sail through.

**Wall-clock limit.** Already covered. Each consumer invocation is its own Worker request with its own budget.

**Backpressure.** Suppose 50 of your customers share a hosted MySQL provider. If you launch 200 containers all at once, you might DDoS that provider (and your own customers!). Cloudflare Queues has a `max_concurrency` setting — pin it to, say, 15, and the queue will only let 15 messages be in-flight at a time. Polite default behavior, no extra code.

The queue config in `wrangler.toml` looks like:

```toml
[[queues.producers]]
binding = "NIGHTLY_QUEUE"
queue = "nightly-runs"

[[queues.consumers]]
queue = "nightly-runs"
max_batch_size = 1            # one tenant per invocation
max_batch_timeout = 1         # don't wait to fill batches
max_concurrency = 15          # at most 15 parallel consumers
max_retries = 3               # 3 redeliveries before DLQ
dead_letter_queue = "nightly-dlq"
```

`max_batch_size = 1` matters. The default is 10 — Cloudflare would otherwise hand you up to 10 messages per consumer invocation, expecting you to process them as a batch. For "run a heavy container per tenant" we want strictly one message per consumer invocation, so we pin batch size to 1.

`max_retries = 3` plus `dead_letter_queue` is the safety net we'll explore in §11.

---

## 8. Box 4 — The Consumer Worker invokes the Container

This is where it gets interesting. The consumer Worker is the glue between "queue handed me a tenant slug" and "the C# binary runs against that tenant's DB."

```ts
// worker/consumer.ts

type Env = {
  CONTAINER: Fetcher;            // binding to the C# Container
  TENANT_REGISTRY: KVNamespace;  // tenant config lookup
  RUNS_DB: D1Database;           // nightly_runs table lives here
  LAST_RUN: KVNamespace;         // lastRun:<slug> pointer
  R2_PUBLIC: R2Bucket;           // R2 bucket for snapshots
  // Per-tenant secrets are accessed via env[`SECRET_DB_${slug}`] etc.
};

export default {
  async queue(batch: MessageBatch<NightlyRunMsg>, env: Env, ctx: ExecutionContext) {
    for (const msg of batch.messages) {
      const { tenantSlug, runDate, attempt } = msg.body;
      const startedAt = Date.now();

      try {
        await runOneTenant(env, tenantSlug, runDate);

        await recordSuccess(env, tenantSlug, runDate, startedAt);
        msg.ack();
      } catch (err) {
        await recordFailure(env, tenantSlug, runDate, startedAt, err, attempt);
        msg.retry({ delaySeconds: backoffSeconds(attempt) });
      }
    }
  }
};
```

The handler is named `queue` (not `fetch`, not `scheduled`). Cloudflare invokes it whenever a batch of messages is ready.

Walking through:

```ts
async queue(batch: MessageBatch<NightlyRunMsg>, env: Env, ctx: ExecutionContext) {
```

`batch` is the small group of messages this invocation got. With `max_batch_size = 1` it'll always have exactly one message. We loop anyway because the API is shaped for batches.

```ts
for (const msg of batch.messages) {
  const { tenantSlug, runDate, attempt } = msg.body;
  const startedAt = Date.now();
```

Pull the fields out of the message body. `startedAt` will go into our run-status row at the end.

```ts
try {
  await runOneTenant(env, tenantSlug, runDate);
  await recordSuccess(env, tenantSlug, runDate, startedAt);
  msg.ack();
}
```

Try to do the run. If it succeeds, write the success row and call `msg.ack()`. `ack` tells Cloudflare "I'm done with this message; don't redeliver it."

```ts
catch (err) {
  await recordFailure(env, tenantSlug, runDate, startedAt, err, attempt);
  msg.retry({ delaySeconds: backoffSeconds(attempt) });
}
```

If anything threw, log a failed-attempt row and call `msg.retry`. Retry asks Cloudflare to redeliver this message later. After `max_retries` retries, the message goes to the DLQ instead.

`backoffSeconds(attempt)` is exponential backoff:

```ts
function backoffSeconds(attempt: number): number {
  // 1, 5, 15 minutes
  return [60, 300, 900][Math.min(attempt - 1, 2)];
}
```

Attempt 1 fails → wait 60 seconds before retrying. Attempt 2 fails → wait 300 (5 min). Attempt 3 fails → wait 900 (15 min). Attempt 4 → DLQ.

Now the meaty part: what does `runOneTenant` do?

```ts
async function runOneTenant(env: Env, slug: string, runDate: string): Promise<void> {
  // 1. Look up per-tenant config (DB host, FabSuite endpoint, etc.) from KV.
  const config = await env.TENANT_REGISTRY.get(`tenants:${slug}`, "json");
  if (!config) throw new Error(`tenant not found: ${slug}`);

  // 2. Pull per-tenant secrets from Workers Secrets.
  const dbPassword = (env as any)[`SECRET_DB_${slug.toUpperCase()}`];
  const fabSuiteToken = (env as any)[`SECRET_FAB_${slug.toUpperCase()}`];
  if (!dbPassword || !fabSuiteToken) {
    throw new Error(`secrets missing for tenant: ${slug}`);
  }

  // 3. Build the request body for the Container.
  const containerReq = new Request("https://container.local/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenantSlug: slug,
      runDate,
      mysql: {
        host: config.mysqlHost,
        port: config.mysqlPort,
        database: config.mysqlDatabase,
        user: config.mysqlUser,
        password: dbPassword,
      },
      fabSuite: {
        endpoint: config.fabSuiteEndpoint,
        token: fabSuiteToken,
      },
      r2: {
        bucket: config.r2Bucket,
        prefix: `tenants/${slug}/snapshots/${runDate}/`,
      },
      schemaVersion: 3,
    }),
  });

  // 4. Invoke the Container.
  const resp = await env.CONTAINER.fetch(containerReq);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`container failed: ${resp.status} ${body}`);
  }

  // 5. Verify the manifest landed.
  const result = await resp.json<{ files: string[]; bytes: number }>();
  await publishManifest(env, slug, runDate, result);
}
```

Step by step.

**Step 1 — Read tenant config from KV.** This is per-tenant non-secret stuff: which MySQL host, which port, which schema, which FabSuite URL. Not secrets — those come from step 2. KV is the right home for this because it changes rarely and we read it on every run.

**Step 2 — Pull secrets from Workers Secrets.** Notice the casting: `(env as any)[\`SECRET_DB_${slug.toUpperCase()}\`]`. Workers Secrets are accessed by name on `env`. We name them `SECRET_DB_ACME`, `SECRET_DB_BOBSBEAMS`, etc. The `as any` is because TypeScript doesn't know about dynamic env keys; in real code you'd type this more carefully. The key point: secrets are NOT in KV, NOT in the queue message, NOT in any log. They live encrypted in Workers and surface only inside this function's scope.

**Step 3 — Build the container request body.** This is what the C# binary sees. Plain JSON, includes the secrets it needs *for this one run*. The container is invoked-and-forgotten; it doesn't store these secrets across runs.

Notice we tell the container exactly where to write in R2 (`prefix: tenants/<slug>/snapshots/<runDate>/`). The container has its own R2 credentials (configured via Container env vars or its own Workers Secret bindings); the Worker just tells it the prefix.

We also pass `schemaVersion: 3`. The container's output is tagged with this version. We'll come back to schema versioning in §12.

**Step 4 — Invoke the Container.** `env.CONTAINER.fetch(req)` is how a Worker calls a Container binding. The request goes to a Container that Cloudflare spins up on demand near the Worker. The container is essentially a small HTTP server (an ASP.NET Core endpoint wrapping the C# binary) — see `06-customer-data-ingest.md` for the inside view.

The Worker awaits the Container's response. This is a synchronous wait — the Worker is parked while the container runs. That's fine: Worker CPU time is *CPU time*, not wall-clock; awaiting a subrequest does not count against the 30-second budget. Container runs lasting a few minutes are perfectly survivable from the Worker's perspective.

**Step 5 — Publish the manifest.** This is the one bit we DO want the Worker to handle, not the container. Why? Because publishing the manifest is the moment a run becomes visible to the dashboard, and we want the Worker (which has the full picture: all files written, sizes verified) to control that moment. The container's job ends with "I wrote 17 files." The Worker's job is "verify, then flip the pointer."

That's `publishManifest` — and it's so important it gets its own section.

---

## 9. Box 5 — The Container runs the C# binary

This is the inside of one of the parallel boxes in the diagram. We're deferring most of the detail to `06-customer-data-ingest.md` because that doc is all about how the C# binary actually reaches into customer infrastructure. But here's the shape:

1. The container is a Linux container running .NET 8. Inside, an ASP.NET Core minimal API exposes one endpoint: `POST /run`.
2. When the Worker calls `env.CONTAINER.fetch(...)`, Cloudflare routes that request into the container's HTTP server.
3. The handler reads the JSON body, opens a MySQL connection through Cloudflare Tunnel to the customer's DB, optionally fetches FabSuite XML, runs the existing C# transform logic, and writes module JSON files directly to R2 via the S3-compatible API (the container has R2 credentials of its own).
4. When done, the handler returns `200 OK` with a small payload: `{ files: [...], bytes: 1640000, durationMs: 42100 }`.
5. The container exits idle. Cloudflare scales it to zero shortly after.

If anything inside fails — DB connection refused, FabSuite returned malformed XML, R2 write got rate-limited — the handler returns a `5xx` with an error body. The Worker sees the non-`ok` response and throws, which sends the message back through the retry / DLQ machinery.

**Important property:** the container does NOT write `manifest.json` or update `current.json`. It only writes the per-module files. Those last two writes are the Worker's job, after the container reports success. This separation is what makes the manifest pattern work cleanly — the container can crash mid-write and the dashboard still won't see the half-written run, because the manifest swap never happened.

---

## 10. Box 6 — The manifest pattern (the most important section in this doc)

Pay attention here. This is the pattern that, if you skip, will cause your dashboard to occasionally show inconsistent data — Inspections numbers from today, Time numbers from yesterday — because the dashboard read the bucket while the container was halfway through writing.

### 10.1 The bug, in slow motion

Imagine you don't use a manifest. The container writes module files directly to a fixed path, like `tenants/acme/current/<module>.json`. The dashboard reads from the same fixed path.

Here's a time-diagram of what goes wrong:

```
TIME    CONTAINER (writing)              DASHBOARD (reading)            RESULT
---     ----------------------           ---------------------          --------
T+0     start writing estimating.json
T+1     done   estimating.json (NEW)
T+2     start writing time.json
T+3     done   time.json (NEW)
T+4                                       reads estimating.json (NEW)
T+5     start writing inspections.json
T+6                                       reads time.json (NEW)
T+7     done   inspections.json (NEW)
T+8                                       reads inspections.json (NEW)
T+9     start writing purchasing.json
T+10                                      reads purchasing.json (OLD!)   <-- BUG
T+11    done   purchasing.json (NEW)
T+12                                      reads inventory.json (OLD)     <-- BUG
T+13    start writing inventory.json
T+14    done   inventory.json (NEW)
T+15    start writing prodcontrol.json
...
```

The dashboard at time T+10 saw fresh `estimating`, fresh `time`, fresh `inspections`, but stale `purchasing` and stale `inventory`. From the user's perspective: numbers across panels don't agree. Worse, refreshing the page a few seconds later gives different stale-vs-fresh combos, so the user thinks the dashboard is broken.

This is the **partially-published-write** problem. R2, like S3, has no multi-object transaction. You can't say "atomically swap all 17 files at once."

### 10.2 The fix: manifest + pointer

Two extra files solve this:

- `manifest.json` — written *last*, lists which files belong to this run.
- `current.json` — a tiny pointer, updated *last of all*, says which date's manifest is the freshest good one.

Layout in R2:

```
tenants/acme/snapshots/2026-05-06/estimating.json    (yesterday)
tenants/acme/snapshots/2026-05-06/time.json          (yesterday)
tenants/acme/snapshots/2026-05-06/...                (yesterday)
tenants/acme/snapshots/2026-05-06/manifest.json      (yesterday)

tenants/acme/snapshots/2026-05-07/estimating.json    (today)
tenants/acme/snapshots/2026-05-07/time.json          (today)
tenants/acme/snapshots/2026-05-07/...                (today)
tenants/acme/snapshots/2026-05-07/manifest.json      (today, written LAST in run)

tenants/acme/snapshots/current.json   (pointer; says { "currentDate": "..." })
```

**Two key tricks:**

1. **Each run writes to its own date-prefixed folder.** Today's run never touches yesterday's folder. So while the run is in progress, all writes happen under `2026-05-07/`, leaving `2026-05-06/` completely untouched.

2. **`current.json` flips at the very end.** As long as `current.json` still points at `2026-05-06`, the dashboard reads yesterday's complete snapshot. When the new manifest is verified and `current.json` flips to `2026-05-07`, the dashboard atomically (in a single read) starts seeing today's complete snapshot.

Time-diagram of the fix:

```
TIME    CONTAINER (writing today's      DASHBOARD reads via current.json
        files into 2026-05-07/)         (still pointing at 2026-05-06/)
---     ----------------------          ---------------------
T+0     start writing estimating.json
T+1     done   estimating.json
T+2     ... 16 more module files ...
T+15    done all module files
T+16    Worker writes manifest.json     reads current.json -> "2026-05-06"
                                        reads 2026-05-06/manifest.json
                                        reads 2026-05-06/<module>.json files
                                        ALL CONSISTENT (all yesterday)
T+17    Worker flips current.json
        from "2026-05-06" -> "2026-05-07"
T+18                                    reads current.json -> "2026-05-07"
                                        reads 2026-05-07/manifest.json
                                        reads 2026-05-07/<module>.json files
                                        ALL CONSISTENT (all today)
```

The user might see yesterday's data at T+15 and today's data at T+18. They never see a half-and-half mix. That's the property we want.

### 10.3 The `publishManifest` code

Here's the Worker-side code that does the manifest swap. Walked line by line.

```ts
async function publishManifest(
  env: Env,
  slug: string,
  runDate: string,
  result: { files: string[]; bytes: number }
): Promise<void> {
  const manifest = {
    schemaVersion: 3,
    tenantSlug: slug,
    runDate,
    generatedAt: new Date().toISOString(),
    files: result.files,
    bytes: result.bytes,
  };

  // Step A: write manifest.json INTO the date-prefixed folder.
  await env.R2_PUBLIC.put(
    `tenants/${slug}/snapshots/${runDate}/manifest.json`,
    JSON.stringify(manifest),
    { httpMetadata: { contentType: "application/json" } }
  );

  // Step B: flip the pointer.
  const pointer = { currentDate: runDate, schemaVersion: 3 };
  await env.R2_PUBLIC.put(
    `tenants/${slug}/snapshots/current.json`,
    JSON.stringify(pointer),
    { httpMetadata: { contentType: "application/json" } }
  );
}
```

```ts
const manifest = {
  schemaVersion: 3,
  tenantSlug: slug,
  runDate,
  generatedAt: new Date().toISOString(),
  files: result.files,
  bytes: result.bytes,
};
```

Build the manifest object. `schemaVersion` travels with the data — that's the field the dashboard checks first to decide whether it knows how to render this snapshot. `files` is the explicit list of module file names the container reported writing (so the dashboard knows what's available for this run, even if we add new modules later). `bytes` is a sanity check.

```ts
await env.R2_PUBLIC.put(
  `tenants/${slug}/snapshots/${runDate}/manifest.json`,
  JSON.stringify(manifest),
  { httpMetadata: { contentType: "application/json" } }
);
```

Step A. Write the manifest into the same date-prefixed folder as the module files. **Crucially this is the second-to-last write.** At this point, every module file is already in place, and now the manifest exists alongside them. But `current.json` still points at yesterday — so the dashboard hasn't switched over yet.

```ts
const pointer = { currentDate: runDate, schemaVersion: 3 };
await env.R2_PUBLIC.put(
  `tenants/${slug}/snapshots/current.json`,
  JSON.stringify(pointer),
  { httpMetadata: { contentType: "application/json" } }
);
```

Step B. Flip the pointer. The dashboard's next read of `current.json` will see the new date and start serving today's data. From the dashboard's perspective, the entire run "happened" at this single moment.

If the Worker dies between Step A and Step B (rare but possible), no harm done: the date-prefixed folder is fully written, but `current.json` still points at yesterday. The dashboard keeps showing yesterday's data, which is the right failure mode. Tomorrow's run will overwrite today's folder *or* successfully flip the pointer, either of which is fine.

### 10.4 You might wonder

**"Why not just put everything in one big JSON file?"**

You'd get atomicity for free (one write = either it landed or it didn't). But the dashboard would have to download all 1.6 MB on cold cache even if the user just wants the Time panel. With per-module files, the user opens the Time panel and we fetch only `time.json` (~100 KB). Big load-time win.

**"Can we just use R2 versioning instead?"**

R2 supports object versioning, which keeps old versions around when you overwrite. Useful for accidental-overwrite recovery. But it doesn't solve the partial-write problem — versioning is per-object, not across-objects. You'd still hit the same "module 3 fresh, module 4 stale" issue mid-write.

**"What if the dashboard is mid-fetch when the pointer flips?"**

The dashboard's read sequence is: `GET current.json` → `GET <date>/manifest.json` → `GET <date>/<module>.json`. Once the dashboard has read `current.json`, it's locked into that date for the rest of its read sequence. So even if `current.json` flips between the dashboard's first and second read, the dashboard is already committed to the previous date's folder, which still exists and is still complete. No half-and-half.

---

## 11. Box 7 — Logging the run, and Box 8 — the DLQ failure path

Two things still need to happen for every run: writing structured state, and routing failures to your phone.

### 11.1 The success path

`recordSuccess` writes two pieces of state:

```ts
async function recordSuccess(
  env: Env,
  slug: string,
  runDate: string,
  startedAt: number
): Promise<void> {
  const endedAt = Date.now();
  const durationMs = endedAt - startedAt;

  // 1. Insert a row into D1 nightly_runs.
  await env.RUNS_DB.prepare(`
    INSERT INTO nightly_runs
      (tenant_slug, run_date, status, started_at, ended_at, duration_ms, error_message)
    VALUES (?, ?, 'success', ?, ?, ?, NULL)
  `).bind(slug, runDate, startedAt, endedAt, durationMs).run();

  // 2. Update KV lastRun pointer (for the dashboard freshness banner).
  await env.LAST_RUN.put(`lastRun:${slug}`, JSON.stringify({
    runDate,
    status: "success",
    endedAt,
  }));

  console.log("run_success", { slug, runDate, durationMs });
}
```

D1 gives us the queryable history (last 90 days, search by tenant, look at trends). KV gives us a cheap single-key read the dashboard does on every page load to show "Last updated: 4 hours ago."

### 11.2 The failure path

`recordFailure` is similar but writes status=`failed` and includes the error:

```ts
async function recordFailure(env, slug, runDate, startedAt, err, attempt) {
  await env.RUNS_DB.prepare(`
    INSERT INTO nightly_runs
      (tenant_slug, run_date, status, started_at, ended_at, duration_ms,
       error_message, error_class, attempt_number)
    VALUES (?, ?, 'failed', ?, ?, ?, ?, ?, ?)
  `).bind(
    slug, runDate, startedAt, Date.now(), Date.now() - startedAt,
    String(err.message ?? err), err.constructor?.name ?? "Error", attempt
  ).run();

  console.error("run_failed", { slug, runDate, attempt, err: String(err) });
}
```

Note: this row is written for **every** failed attempt, not just the final one. So if a tenant fails attempt 1, then succeeds on attempt 2, you'll see two rows in D1: one failed (attempt 1) and one succeeded (attempt 2). That's intentional — you want the full retry history visible.

### 11.3 The DLQ consumer

After 3 failed attempts, the queue gives up and routes the message to the DLQ. We have a separate, very small Worker bound to the DLQ:

```ts
// worker/dlq.ts

type DlqEnv = {
  SLACK_WEBHOOK_URL: string;     // a Workers Secret
  RUNS_DB: D1Database;
};

export default {
  async queue(batch: MessageBatch<NightlyRunMsg>, env: DlqEnv) {
    for (const msg of batch.messages) {
      const { tenantSlug, runDate } = msg.body;

      // 1. Mark this run as permanently failed in D1.
      await env.RUNS_DB.prepare(`
        INSERT INTO nightly_runs
          (tenant_slug, run_date, status, started_at, ended_at, error_message)
        VALUES (?, ?, 'dlq', ?, ?, 'exhausted retries')
      `).bind(tenantSlug, runDate, Date.now(), Date.now()).run();

      // 2. Page Nick.
      await fetch(env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `Nightly run FAILED: tenant=${tenantSlug} date=${runDate}. Check D1 nightly_runs for details.`,
        }),
      });

      msg.ack();
    }
  }
};
```

Walk-through:

- The DLQ consumer is a separate Worker. Its only job is to log permanent failures and notify you.
- It writes a `status='dlq'` row to D1 so the run-status page shows "this tenant didn't run last night."
- It POSTs to a Slack incoming webhook. Slack pushes a notification to your phone within seconds. One message per failed tenant.

You set up the Slack webhook once (Slack docs: "incoming webhooks"), put the URL in a Workers Secret called `SLACK_WEBHOOK_URL`, and you're done. Total code: ~10 lines. Total reliability: very high.

You might wonder why use a DLQ at all instead of just paging on the first failure. Two reasons:

1. **Transient failures self-heal.** If you paged on every retry, you'd get spammed at 3 AM by a 20-second customer-network blip that recovered on its own. The DLQ paging policy means "I've exhausted all 3 retries, this is real."

2. **DLQ messages are inspectable.** The DLQ keeps the failed message body around, so the next morning you can replay it manually or look at the message contents to understand the failure.

---

## 12. State management — where each thing lives

You may have noticed state has been showing up in a lot of different places. Let's catalog it. Memorize this table.

| State | Where it lives | Why |
|---|---|---|
| Tenant registry (slugs, names, MySQL hosts, FabSuite endpoints) | KV (`tenants:<slug>`) | Read on every run; rarely changes; KV's eventual-consistency is fine |
| Tenant secrets (DB passwords, FabSuite tokens) | Workers Secrets (`SECRET_DB_<SLUG>`, `SECRET_FAB_<SLUG>`) | Encrypted at rest, never logged, never transit through queue |
| Slack webhook URL | Workers Secret (`SLACK_WEBHOOK_URL`) | Same reasons — it's a secret |
| Last successful run per tenant | KV (`lastRun:<slug>`) | One cheap read on every dashboard page load |
| Full run history (90 days, every attempt) | D1 (`nightly_runs` table) | Queryable: trends, status pages, debugging |
| Schema version of latest snapshot | Inside `manifest.json` itself | Travels with the data; survives storage migrations |
| Pointer to latest good run date | R2 (`tenants/<slug>/snapshots/current.json`) | Lives next to the data; flipping it is the publish moment |
| Per-tenant snapshot data (the JSON that drives the dashboard) | R2 (`tenants/<slug>/snapshots/<date>/<module>.json`) | Big-ish, immutable per date, free egress, archive-friendly |
| Tenant credential rotation log (NOT the secrets themselves) | D1 (`tenant_credentials` table — `last_rotated_at` etc.) | Auditable: "rotate any tenant whose creds are >90 days old" |

The principles behind that table:

- **Secrets in Workers Secrets, never anywhere else.** Not in KV, not in queue messages, not in R2, not in D1, not in logs.
- **Hot single-key reads in KV.** Tenant config, `lastRun:<slug>` — anything you read once per request.
- **Queryable history in D1.** Anything you'll filter by, aggregate over, or build a status page from.
- **Bulk data in R2.** Anything large, immutable, or archived. Egress is free.
- **Schema version travels with the data.** Don't store "the current version" in a separate place; put it inside the manifest.

---

## 13. Schema versioning — handling C# output changes without breaking dashboards

Six months from now, you change the C# binary's output. Maybe Estimating starts including a new `proposalCount` field. Maybe the Time panel splits `monthlyHours` into `regularHours + overtimeHours`. The dashboard for tenants whose freshest snapshot is from before the change doesn't know about the new shape.

The pattern: **every snapshot carries its own schema version, and the dashboard checks before rendering.**

In the manifest:

```json
{
  "schemaVersion": 3,
  "tenantSlug": "acme",
  "runDate": "2026-05-07",
  "files": ["estimating.json", "time.json", ...],
  ...
}
```

`schemaVersion` is just an integer you bump every time the C# output shape changes in a way the dashboard cares about.

There are two kinds of changes you'll handle differently:

**Additive changes.** A new optional field appears (`proposalCount`). Old dashboards ignore it; new dashboards use it. No version bump needed — TypeScript with `additionalProperties: true` parsing handles this naturally.

**Breaking changes.** A field is renamed, removed, or restructured. Bump `schemaVersion`. Two strategies:

1. **Migration shim in the dashboard.** The dashboard reads `manifest.schemaVersion`, and if it's an older version, runs a small client-side migration function that maps the old shape to the new shape before rendering. Works for small reshapes.

2. **Versioned paths.** For really structural changes, version the path itself: `tenants/<slug>/snapshots/<date>/v3/<module>.json`. Old data stays at `v2/`, new data lands under `v3/`. The dashboard picks the path matching the version it understands.

The third option — **silent breakage** — is what we're avoiding. Your dashboard gets pushed with new code that expects `regularHours`, but tenants whose latest snapshot still has `monthlyHours` see broken charts. By checking `schemaVersion` first, you can show "Snapshot is from an older version; running tonight will refresh it" instead of a half-rendered chart.

The principle: **everything that crosses a process boundary needs a version field.** The C# binary writes JSON; the dashboard reads it. That's a process boundary. Version it.

---

## 14. Time zones and DST, with concrete numbers

We touched on this in §5.2. Let's nail it down.

Cloudflare runs crons in UTC. Period. Your customers care about their local time. Reconciling the two is a one-time decision that needs to survive twice-yearly DST flips.

**Concrete example.** US East Coast customer expects "fresh by 6 AM." Their morning shift starts at 6 AM ET.

ET in winter = EST = UTC-5. In summer = EDT = UTC-4.

| You set cron to | Run time in winter (EST) | Run time in summer (EDT) | Verdict |
|---|---|---|---|
| `0 4 * * *` (4 AM UTC) | 11 PM ET (previous day!) | 12 AM ET | Risky — runs while customer's day is still happening |
| `0 6 * * *` (6 AM UTC) | 1 AM ET | 2 AM ET | Safe — well after midnight in both seasons |
| `0 7 * * *` (7 AM UTC) | 2 AM ET | 3 AM ET | Safest — but be careful at 5 AM ET in summer it's already 9 AM UTC if you push later |
| `0 11 * * *` (11 AM UTC) | 6 AM ET | 7 AM ET | TOO LATE in winter — customer already at work |

Recommendation: **`0 7 * * *`** (7 AM UTC). Always between 2 and 3 AM Eastern. Survives DST transitions cleanly.

If you onboard a customer in another time zone (e.g., Mountain Time, UTC-7 / -6), reverify. 7 AM UTC is midnight to 1 AM Mountain — still safe. 7 AM UTC for Pacific (UTC-8 / -7) is 11 PM to midnight — boundary case; you'd want to push earlier or split into time-zone buckets.

The long-term pattern (when you have customers across many time zones): store a `runHourUTC` per tenant in the registry. Have a single hourly cron `0 * * * *` that fans out only the tenants whose `runHourUTC` matches the current hour. One cron, per-tenant timing, no DST math required.

---

## 15. Observability — what to log, where to put it, how Nick gets paged

You can't fix what you can't see. The whole observability stack for the nightly pipeline boils down to four sinks:

**1. Workers Logs (built-in).** Every `console.log` and `console.error` in any Worker is captured automatically. Searchable in the Cloudflare dashboard. Use **structured logging** (objects, not strings):

```ts
console.log("run_success", { slug, runDate, durationMs });
```

You can search later by `run_success` to see all successful runs, or by `slug:acme` to see one tenant's history.

**2. D1 `nightly_runs` table.** Every attempt — successful, failed, DLQ'd — gets one row. Schema:

```sql
CREATE TABLE nightly_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_slug TEXT NOT NULL,
  run_date TEXT NOT NULL,
  status TEXT NOT NULL,           -- 'success' | 'failed' | 'dlq'
  started_at INTEGER NOT NULL,    -- ms epoch
  ended_at INTEGER,
  duration_ms INTEGER,
  bytes_written INTEGER,
  file_count INTEGER,
  error_message TEXT,
  error_class TEXT,
  attempt_number INTEGER
);
CREATE INDEX idx_runs_tenant_date ON nightly_runs (tenant_slug, run_date);
```

Build a tiny `/admin/status` page in your dashboard that does `SELECT * FROM nightly_runs WHERE run_date = ? ORDER BY tenant_slug`. This is your morning "did everyone run?" check.

**3. KV `lastRun:<slug>`.** One key per tenant. Holds the most recent successful run summary. The dashboard reads it on page load to show a freshness banner ("Last updated: 4 hours ago").

**4. Slack webhook.** The only sink that pages you in real time. Fired only from the DLQ consumer — i.e., only after a tenant has exhausted retries and definitively failed. Low signal-to-noise.

**The fields to always log** (every successful or failed run):

| Field | Why |
|---|---|
| `tenant_slug` | Which customer |
| `run_date` | Which night |
| `status` | success / failed / dlq |
| `started_at`, `ended_at`, `duration_ms` | Performance trend over time |
| `bytes_written`, `file_count` | Sanity — did the run produce the expected volume? |
| `error_message`, `error_class` | Debugging |
| `attempt_number` | Was this a retry? |

**Cloudflare's built-in tooling that's already there in 2026:**

- **Workers Observability dashboard.** Invocation counts, error rates, CPU time. Free.
- **Tail sessions.** Live `tail -f` of your Worker's logs. Use during deploys.
- **Workers Analytics Engine.** High-cardinality time-series store if you outgrow log search. Optional.
- **Logpush.** Export logs to R2 / S3 / Datadog for retention beyond Cloudflare's rolling window. Optional.

For day one: Workers Logs + D1 `nightly_runs` + KV `lastRun` + Slack webhook. That's enough.

---

## 16. Ten common pitfalls

Each of these has bitten someone. Read them, take them seriously.

**1. Reading the dashboard before the manifest pattern is in place.**
Symptom: complaints like "the Inspections panel updated but Jobs didn't." Root cause: dashboard reads module files directly, mid-write. Fix: dashboard reads `current.json` first, then `manifest.json`, then individual modules. Never list R2 prefixes from the dashboard.

**2. Doing the work in the Cron Worker instead of fanning out.**
Works at 5 tenants, hits the wall-clock limit at 50, silently drops the rest. Retrofitting fan-out under pressure (when you've onboarded customer 51 and the run starts dropping people) is much worse than designing it in from day one. Fan out via Queue. Always.

**3. Putting secrets in the Queue message body.**
Queue messages get logged by observability tools. The slug is fine; passwords are not. Keep secrets in Workers Secrets, look them up by slug in the consumer.

**4. Forgetting DST when picking a UTC cron time.**
"2 AM Eastern" is 7 AM UTC in winter and 6 AM UTC in summer. Pick a UTC time that's safely after midnight in every customer's local zone, year-round. `0 7 * * *` is a defensible default for US-only customers.

**5. No DLQ, no notifications.**
First failed run goes unnoticed for days. Customer notices before you do. Set up the Slack webhook before your first paying customer. Even if it's spammy at first, fix the noisy false positives — don't disable alerting.

**6. Non-idempotent writes that corrupt on retry.**
Appending instead of overwriting, or writing to a path that doesn't include the run date, means a retry produces a Frankenstein snapshot mixing two runs. **Date-key everything and overwrite.** Each run writes into its own dated folder; retries just rewrite that folder cleanly.

**7. Skipping the `nightly_runs` table.**
Without it, "did Acme run last night?" requires log archaeology. Even a 10-column table written from the consumer pays for itself the first time a customer asks.

**8. Trusting the customer's network.**
The on-prem MySQL or FabSuite endpoint can be down, slow, or returning malformed XML. Wrap fetches with timeouts. Log raw response sizes. Fail fast with clear error messages instead of letting the C# binary hang for 25 minutes and time out the whole consumer invocation. Set sensible timeouts in the C# code (say, 5 minutes max for the whole run; 60 seconds for individual queries).

**9. No schema version in the manifest.**
Six months from now you change the C# output. Tenants whose latest snapshot is older break. Bump `schemaVersion` on every change that affects the dashboard, and have the dashboard check it before rendering.

**10. Running 200 containers at maximum concurrency.**
If many customers share a hosted MySQL provider, you DDoS yourself. Pin `max_concurrency = 10` or `15` on the queue consumer. The whole run takes a few minutes longer; nobody notices; everyone's database stays up.

---

## 17. End-of-doc checklist

By the end of this doc you should know:

- [ ] What a Cron Trigger is, what `0 7 * * *` means, and why `0 7 * * *` is a DST-safe default for US customers.
- [ ] Why one cron + Queue fan-out beats both "200 crons" and "one cron with a tight loop."
- [ ] What the Producer Worker does (reads registry, publishes one queue message per tenant) and what it deliberately does NOT do (no DB calls, no R2 writes, no work).
- [ ] Why `max_batch_size = 1` and `max_concurrency = 15` are the right consumer settings for this pipeline.
- [ ] How the Consumer Worker invokes the Container, where the secrets come from (Workers Secrets, by tenant slug), and what's in the request body.
- [ ] How the Container writes module JSON to R2 directly, and why publishing the manifest is the *Worker's* job, not the Container's.
- [ ] **The manifest pattern**: write all module files first → write manifest.json → flip `current.json`. Why each step is in that order. What the dashboard reads in what order to stay consistent.
- [ ] Why the partial-write bug looks like "Inspections fresh, Jobs stale" to users — and why the manifest pattern fixes it.
- [ ] Where each piece of state lives: KV (registry, `lastRun`), D1 (`nightly_runs`), Workers Secrets (passwords, tokens, webhook URL), R2 (snapshots, `current.json`, manifest.json).
- [ ] What `schemaVersion` is, where it lives (inside the manifest), and how additive vs breaking schema changes are handled.
- [ ] How a permanent failure becomes a Slack ping: queue retry exhausts → DLQ → DLQ Consumer → Slack webhook → your phone.
- [ ] The 10 pitfalls in §16 — name three of them from memory.

If any of those are still fuzzy, re-read the relevant section. The manifest pattern (§10) is the one that, if you skip, will hurt later.

---

**Next:** `08-data-isolation.md` — once you have data flowing, how do you prove that Acme cannot read Bob's-Beams's data, and that your code couldn't possibly cross the streams even with a bug? Tenant isolation testing, the right shape of integration tests, and the security review you should run before opening to a second customer.
