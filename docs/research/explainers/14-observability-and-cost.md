# 14 — Observability and Cost: Knowing What's Happening Without Watching Customer Machines

> **Prerequisites:** read 05, 08, 11.

> **By the end of this doc you will know:** what "observability" means for a desktop product where we don't see live data flow. The four signals we *can* see (update-poll logs, error reports, support contacts, the customer-visible health banner). The structured-logger pattern for the gateway, where most useful logging actually happens. What we deliberately *don't* monitor and why. The flat cost profile of the new architecture (and the four things that would change that). A small set of starter alerts that won't drown you in noise.

This is the operational counterpart to 05. 05 told you what runs where; this doc tells you — once tenants are live — how to know whether things are working, whether one tenant is suffering while the others are fine, and what your bill should look like.

---

## 1. The fundamental observability problem

In the old web plan, every metric, every page view, every data fetch went through our infrastructure. We could see it all: Worker logs, KV access patterns, R2 reads, Tunnel traffic. Observability was *easy* because we were sitting in the middle of every request.

In the new desktop plan, we are deliberately *not* in the middle. Every dashboard render happens on a customer's laptop talking to a gateway in the customer's network. We see none of it. Three implications:

- **We can't measure "is the dashboard rendering correctly?" directly.** We have to ask, or infer.
- **We have less data — and that's mostly a feature.** No accidental collection of customer business data.
- **We need to design what telemetry we *do* collect** very carefully, because everything we collect is data we now have to manage.

The good news: the architecture is simpler, so there's less to monitor. The bad news: when something is broken at a customer, we usually find out by them calling.

---

## 2. The four signals we have

### 2.1 Update-poll logs (server-side, automatic)

Every customer's app polls `https://updates.dashboard.example.com/latest.json` on startup and periodically. Those HTTP requests hit our update server. Logs from that server tell us:

- Roughly how many active installs we have.
- What versions they're running.
- Whether updates are actually being downloaded.
- Geographic distribution (less interesting for us).

These logs **don't contain customer business data**. They're just "someone polled the manifest from IP X.X.X.X." The IP can tell you something (is this Acme's known IP range or a new install on their network?), but you'll mostly aggregate them.

Cheap, automatic, useful as a sanity check: "we have 87 active installs running v1.2.3."

### 2.2 Error reports (opt-in)

If you wire in error reporting (Sentry, Bugsnag, etc.), unhandled errors in the React or Rust side can be sent to you. **Always opt-in**, never default-on. The user gets a banner: "Send error reports to help us fix problems? (recommended)" or similar.

What you collect:
- Error type (e.g., `TypeError: Cannot read property 'monthly' of undefined`).
- Stack trace.
- App version.
- OS + version.

What you **must not** collect:
- The actual data that caused the error.
- Tenant slug, employee name, customer business data of any kind.

Most error reporters have a `beforeSend` hook. Use it to strip everything except the type, stack, and OS info. Test it once on data you control and verify nothing customer-identifiable is in the payload.

### 2.3 Voluntary diagnostics ("Send Diagnostics" button)

For support cases: a button in the app that bundles up local logs (the Tauri-side log file) plus app version plus OS info into a zip, asks the user "send this to support?", and emails it (or uploads to a support ticket).

The user is consenting per-incident. This is the cleanest model.

### 2.4 Gateway-side logs (on the customer's machine)

The most useful observability lives on the customer's gateway. The gateway logs:

- Every incoming request (metric ID, response time, status).
- Every DB query (timing, row count).
- Errors with full context.

Those logs stay on the gateway machine. They never come to us automatically. When a customer asks for support, you ask them to grab the gateway log and attach it. This keeps customer data inside the customer's network — by design.

For ourselves, we standardize the log format (next section) and write tooling to parse it.

---

## 3. The gateway's structured logger

The single most useful pattern: every log line is a JSON object with consistent fields. Makes parsing trivial when you do see logs.

```python
# gateway/log.py
import json, sys, time

def log(level, event, **kwargs):
    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "level": level,
        "event": event,
        **kwargs,
    }
    print(json.dumps(record), file=sys.stderr)

# Usage:
log("info", "request_start", metric_id="time.monthly-hours", request_id="abc")
log("info", "db_query", duration_ms=42, rows=120, metric_id="time.monthly-hours")
log("info", "request_end", duration_ms=58, status=200, metric_id="time.monthly-hours")
log("error", "db_error", error=str(e), metric_id="time.monthly-hours")
```

Each line is parseable with `jq`. To find every slow request:

```bash
$ jq 'select(.event == "request_end" and .duration_ms > 1000)' gateway.log
```

To count requests per metric:

```bash
$ jq -s 'group_by(.metric_id) | map({metric: .[0].metric_id, count: length})' gateway.log
```

A flat newline-delimited JSON file is plenty for the gateway's volume (a single fab shop has dozens to hundreds of requests per hour, not millions).

**Rotate logs daily** (use `logrotate` on Linux or write to a date-named file on Windows). Old logs older than ~30 days can be auto-deleted; they're rarely useful and they accumulate.

**Never log values from the customer's database.** Log the metric ID, the timing, the row count — never the rows themselves. Even an "I'll just dump the rows for debugging" comment in production is the leak waiting to happen.

---

## 4. The customer-visible health banner

From doc 09 §7: the dashboard polls `/health` on the gateway every 30 seconds. If it fails for a stretch, a banner appears:

> Can't reach the data gateway. Numbers may be out of date. Ask your IT person to check the gateway machine.

This is the customer's *own* observability. They see it before they call us. Three small upgrades make it much better:

- **Show the last successful fetch time** ("Last updated 14 minutes ago"). Helps them tell "slightly stale" from "actually broken."
- **Show the gateway URL** (in a small "details" tooltip). Helps their IT verify they're trying the right machine.
- **Show the app's version** (in the same tooltip). Lets you tell on a support call whether they're up to date.

A 30-line component, big debugging payoff.

---

## 5. What we deliberately do NOT monitor

To avoid scope creep, here's an explicit list of things we don't try to instrument:

- **Per-metric render times in production.** We get these on dev machines; we don't need to spy on customer renders.
- **Click tracking / heatmaps.** Customer-business-confidential by nature.
- **Per-user activity.** No per-user identity in v1; even with v2 per-user auth, we don't capture activity centrally.
- **DB query plans on the customer's DB.** Their DBA's job.
- **Custom usage analytics.** "How often does Acme open the Estimating tab?" is interesting but not worth the privacy debt.

If a customer specifically asks for usage analytics for their own employees, that's a feature *for them to use*, served by their own gateway, not data leaving their network.

---

## 6. A starter alert set (small, won't drown you)

Five alerts. That's it. More creates fatigue (doc 14 vocab from the old plan still applies: alert fatigue is the killer).

### 6.1 Update server returns errors

Alert: "5xx rate on `updates.dashboard.example.com` > 1% over 5 minutes."

Why: if the update server is broken, no one's apps update. Customers don't see anything weird *yet*, but tomorrow they'll have stale versions. Catching it within minutes is high-leverage.

### 6.2 Update poll volume dropped 50%

Alert: "Daily polls to `updates.dashboard.example.com` < half of yesterday's count."

Why: a big drop usually means either (a) most customers' apps are crashing on startup (so they don't poll), or (b) our DNS / hosting is down. Either way you want to know.

### 6.3 Error report rate spike

Alert: "Sentry (or whatever) error events for `dashboard-app` > 10× baseline."

Why: a bad release ships through CI, customers update, errors spike. Catch within hours, hotfix.

### 6.4 New error type appears

Alert: "Sentry issue is created with `event: first_seen`."

Why: usually means a regression in the latest version. You get a one-line summary and can decide whether to investigate.

### 6.5 Code-signing cert about to expire

Alert: "Code-signing cert (Windows EV, macOS Developer ID) expires in less than 60 days."

Why: an expired cert means new builds can't be signed and existing installs can't validate updates. 60 days is plenty of lead time to renew.

That's the whole list. Set these once; tune over time.

---

## 7. Cost profile

The cost story changes drastically from the old plan. Reminder from doc 05 §6:

| Item | Annual cost |
|---|---|
| Windows EV signing cert | $300–500 |
| Apple Developer Program | $99 |
| Update server (R2 / S3 / GitHub Releases) | $0–100 |
| Error reporting (free tier of Sentry covers ~5k events/month) | $0 |
| Domain | $10–20 |
| Maybe a managed status page (Statuspage, BetterStack) | $0 (free tier) |
| **Total** | **~$500–700/year** |

That's mostly flat regardless of tenant count. We're not paying per request, per laptop, or per database query — those costs are on the customer's infrastructure (which they were already paying for anyway).

### 7.1 Four things that would change this

If you ever start running infrastructure on behalf of customers, costs scale. The four most likely shifts:

#### 7.1.1 You move to fetched configs (Option B in doc 02 §6.2)

You're now running a small server. Costs are still tiny (~$10/month on a basic VPS or essentially free on Cloudflare Workers free tier for static JSON), but it's a thing to monitor.

#### 7.1.2 You add a cloud gateway for some customers

A "we host the gateway" tier. Now you're handling DB traffic, holding customer creds, paying for compute. Easily $50–200/month per customer on a small VPS each, before you optimize.

#### 7.1.3 You add per-user auth with a centralized identity service

A user table, auth server, password reset emails. Costs more in ops than dollars, but Auth0 / Cognito / similar start to add up at scale.

#### 7.1.4 You add real telemetry / aggregated analytics

A small ClickHouse or BigQuery or PostHog spend, plus the engineering time to define what's collected and the privacy policy to back it. Doable, but pick the moment carefully.

Until any of those, you're at $500–700/year total. That's startling for a multi-customer product and one of the strongest arguments for the desktop architecture.

---

## 8. Building a per-tenant version dashboard

Even though we don't see customer data, we can see — from update-server logs — what version each install is on. A small admin tool that's high-leverage:

1. Parse update-server logs nightly.
2. For each unique source IP / install ID, record the most recent version.
3. Aggregate by tenant (if you can map IPs to tenants — or attach a tenant slug to the install-time user-agent).
4. Show a table: "Tenant | active installs | latest version | oldest version."

When you ship `v1.2.4` you can watch the table over the next day or two and see who's stuck. If "BigShop" is stuck on `v1.0.0` while everyone else moved on, something's wrong with their auto-updater (often: a corporate firewall blocking the update server). Time to call them.

This is your single best operational tool. Worth building once you have 20+ tenants.

---

## 9. What "production is on fire" looks like in this architecture

To pull it together — what does an actual incident look like?

### Scenario A — A customer's gateway is down

- Customer's dashboard shows "Can't reach the data gateway" banner.
- They call support.
- You ask them to (a) check the gateway machine is running, (b) check the gateway service is running, (c) attach the gateway log.
- Usually the answer is "the machine got rebooted last night and the service didn't auto-restart." You walk them through enabling auto-start (or send the docs).

**You** weren't paged. **You** didn't know. **They** found out and reached out. That's the cost of the architecture.

### Scenario B — A bad release went out

- Sentry pages you: error spike.
- You look at the error: it's a TypeError in the latest version.
- You roll back (doc 13 §7): publish a new tag from the previous good commit.
- Within 30 minutes, the new manifest points at the rolled-back version.
- Customers auto-update over the next day.

**You** were paged. **You** acted. Customers mostly noticed nothing.

### Scenario C — A new metric returns wrong numbers

- Customer emails: "the win-rate looks wrong."
- You look at the customer's gateway log (they attach it to the ticket).
- The SQL query has a bug.
- You fix the query in the gateway code, ship a new gateway release, roll it out to the customer (with their IT).

This one's slowest because it involves the gateway, which doesn't auto-update like the desktop app (doc 11 §11.4 — surprise gateway updates are bad). Coordinate with IT, ship over a couple of days.

---

## 10. By the end of this doc you should know

- Why observability is fundamentally different in the new architecture: we're not in the request path.
- The four signals we have: update-poll logs, opt-in error reports, voluntary diagnostics, gateway logs (on the customer's machine).
- The structured-logger pattern for the gateway — JSON per line, no customer data.
- The customer-facing health banner as their own observability.
- The five starter alerts (and why "more alerts" is the trap).
- The flat ~$500–700/year cost profile and the four things that would inflate it.
- The per-tenant version dashboard as the single best operational tool.
- What actual incidents look like: gateway down, bad release, wrong-numbers bug.

---

> **You're done with the series.** Docs 00–14 cover the full Tauri desktop architecture: what it is, why it is, how to build it, how to ship it, and how to live with it. If a piece is fuzzy, point at it and we'll rewrite the section. The series is meant to be a *living* set of explainers, not a closed reference.
