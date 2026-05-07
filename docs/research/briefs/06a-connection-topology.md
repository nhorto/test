# Research Brief: Customer Data Ingest for PowerFab Dashboard

## Executive framing

PowerFab Dashboard runs on Cloudflare. The data lives on a Windows server inside each customer's network — a MySQL instance (Tekla PowerFab's backing database) plus a FabSuite XML API endpoint. Every night we need a fresh snapshot. The architectural question is not "which protocol" — it's **who initiates the connection**: us reaching in (PULL) or the customer's machine reaching out (PUSH). Everything else flows from that decision.

The constraints Nick has approved:

- A small daemon on the customer's Windows host is acceptable.
- Firewall changes are negotiable but unwelcome — IT teams hate inbound ports.
- A "whole application" customer-side is not acceptable.
- A read-only MySQL user is the credential model; secret stored in Cloudflare.

---

## 1. Cloudflare Tunnel (cloudflared)

`cloudflared` is a small Go binary (~30 MB) that runs as a Windows service. It opens an outbound-only TLS connection to Cloudflare's edge and registers itself as a named tunnel. From our side (a Worker or a Container in Cloudflare's compute), we address `mysql.acme-fab.internal.powerfab.app` (or similar) and Cloudflare routes the TCP stream down the tunnel to the customer's loopback interface, where MySQL is listening on 3306.

### Customer-side footprint

| Aspect | Detail |
|---|---|
| Install size | ~30 MB binary, MSI installer available |
| Runs as | Windows service (auto-start on boot) |
| Inbound ports opened | **Zero** |
| Outbound required | 443 to Cloudflare (almost always already open) |
| Config file | One YAML, ~10 lines |
| Updates | `cloudflared update` command, or MSI re-run |

### Authentication

Two layers. The tunnel itself authenticates to Cloudflare with a tunnel token (long random string baked into the service config). Our Worker authenticates to MySQL with the read-only credential. We can additionally put a Cloudflare Access policy in front of the tunnel hostname so that only our Worker's service token (or a mTLS cert) can reach it — defense in depth in case the tunnel hostname leaks.

### Latency and scale

A persistent tunnel means no handshake-per-query overhead — the TLS session is already warm. Expect ~30-80 ms added vs. local LAN, dominated by geography. At 200 tenants, you have 200 named tunnels in your Cloudflare account; this is a normal scale for the product. Each tunnel is a separate cloudflared process on a separate customer machine, so there is no shared-fate risk between tenants.

### Failure modes

- If `cloudflared` crashes, Windows service restarts it within seconds.
- If the customer's internet drops, the tunnel reconnects automatically when it returns.
- If the customer reboots and the service is somehow disabled, the next nightly run fails — we need monitoring.
- If the customer firewall starts deep-packet-inspecting outbound 443, the tunnel can be flagged. Rare, but happens at security-paranoid shops.

### IT objections (real ones)

- "What is this service running 24/7 on our server?" — answerable; it's an open binary from a known vendor.
- "We don't allow third-party services on production servers" — at strict shops, this kills it. Steel fabricators are not usually that strict.
- "Can we audit what it's doing?" — yes, cloudflared logs are local and verbose.

| Score | |
|---|---|
| Security posture | 9/10 — outbound-only, TLS, no inbound surface |
| MVP install effort | Low — MSI + one config file |
| Ops burden at 200 | Low — Cloudflare manages the edge half |

---

## 2. IP-allowlisted public exposure with mTLS

The customer publishes MySQL (or a thin proxy in front of it) on a public IP, allowlists a set of source IPs, and requires mTLS client certs. We connect from Cloudflare with our cert.

### The IP allowlist problem

Cloudflare Workers do not have stable egress IPs by default. You can buy "Workers egress" with dedicated IPs, but it's a paid add-on and the IP set can still change. Customers' IT teams will demand a static IP or a small CIDR. Every time Cloudflare's egress changes, every customer firewall rule needs updating — this is an operational nightmare at 200 tenants.

### IT objections (real ones)

- "You want us to open an inbound port on our production server to the public internet?" — this is the killer objection. At many shops it's a hard no, full stop.
- "What if your cert leaks?" — fair, mTLS rotation is real work.
- "Our cyber-insurance policy prohibits inbound DB exposure" — increasingly common.

### Failure modes

- Cert expiry kills everything if rotation is missed.
- A misconfigured firewall rule exposes MySQL to the internet briefly.
- Brute-force / scan traffic on the open port even when allowlisted (allowlist drops it, but logs fill).

| Score | |
|---|---|
| Security posture | 5/10 — inbound port is a meaningful attack surface even with mTLS |
| MVP install effort | Medium — cert provisioning, firewall rules per customer |
| Ops burden at 200 | High — IP rotation, cert rotation, per-customer firewall coordination |

---

## 3. Site-to-site VPN (IPsec / WireGuard)

A network-level bridge between Cloudflare's network (via Magic WAN or a self-hosted gateway) and the customer's LAN.

### Footprint

Heavyweight. Either the customer's existing firewall appliance terminates IPsec (requires their network engineer to configure phase-1 / phase-2 parameters, pre-shared keys, route tables) or you ship a WireGuard endpoint as a VM/appliance. Either way, this is a "schedule a call with their IT" project, not a self-serve install.

### When it's actually warranted

- The customer has 4+ services they want exposed (not just one MySQL).
- They are already running site-to-site VPNs for other vendors and have the muscle.
- Compliance regimes (defense contractors, etc.) require network-level segmentation.

For PowerFab Dashboard's customer base — small-to-mid steel fab shops — this is overkill. They likely don't have a dedicated network engineer.

| Score | |
|---|---|
| Security posture | 8/10 — solid, but bigger blast radius if compromised (full LAN exposure) |
| MVP install effort | High — multi-hour IT engagement per customer |
| Ops burden at 200 | High — every IT team configures slightly differently |

---

## 4. Customer-installed connector agent (PUSH model)

A small Windows service we write and ship. It runs on the customer's host, connects locally to MySQL on `127.0.0.1:3306` and to the FabSuite XML API on the LAN, packages the data as JSON (or NDJSON), and POSTs it to a Cloudflare Worker endpoint or directly to an R2 pre-signed URL.

### What language

C#. Nick already has .NET 8 expertise, the customer machine is Windows, and a single self-contained .NET publish produces a ~70 MB folder with no runtime dependency. Alternatives: Go (smaller binary, but Nick doesn't write Go), Rust (overkill for this).

### Install footprint

| Aspect | Detail |
|---|---|
| Install size | ~70 MB self-contained .NET 8 publish |
| Runs as | Windows service (Topshelf or built-in `sc.exe` install) |
| Inbound ports opened | **Zero** |
| Outbound required | 443 to `*.powerfab.app` |
| Config | `appsettings.json` with MySQL connection string, agent ID, agent secret |
| Updates | Either auto-update from a signed manifest, or MSI push |

### Authentication of the agent itself

Each agent gets a unique agent ID and a long random token at provisioning time (you generate it when you onboard the customer). The token is stored in the Windows DPAPI-protected credential store, not in plain config. The Worker validates the token on every push and stamps the data into the right tenant's R2 prefix.

### Failure handling

This is where PUSH genuinely shines. The agent owns the schedule. It can:

- Retry with exponential backoff if Cloudflare is unreachable.
- Hold a local queue (SQLite) of unsent batches if it accumulates a backlog.
- Send a heartbeat every 5 minutes so we know it's alive even on nights when the data didn't change much.
- Surface errors locally to the Windows event log, where the customer's IT can see them.

### Observability — how WE know the agent is healthy

Heartbeat endpoint. Every agent posts `{agent_id, version, last_successful_run, last_error}` on a schedule. Our backend has a dashboard of all agents and pages us when one goes silent for >25 hours. Without this, you discover problems three weeks later when a customer calls.

### Update mechanism

Two viable paths:

- **Signed MSI + auto-update**: agent checks a manifest URL hourly, downloads new MSI, runs it. Faster rollout, but auto-update bugs are catastrophic.
- **Manual MSI push**: you email customers when there's a new version. Safer, slower.

For MVP, manual is fine. Add auto-update at ~50 customers when the manual cadence breaks down.

### IT objections (real ones)

- "What does this service do?" — easy to answer; you can publish the source or a SOC-style description.
- "Will it slow our PowerFab server down?" — a nightly read query is negligible; explain query patterns up front.
- "How do we uninstall it?" — MSI uninstall, full cleanup. Document this.

In practice IT teams **prefer** this model over inbound ports. It's the path of least resistance.

| Score | |
|---|---|
| Security posture | 8/10 — outbound-only, scoped credential, but you own a binary running on customer hardware (supply-chain responsibility) |
| MVP install effort | Medium — you're writing and maintaining the agent |
| Ops burden at 200 | Medium — agent observability and update logistics are real, but linear |

---

## 5. Reverse SSH tunnel

A `ssh -R` from the customer's host to a bastion you operate, exposing their local MySQL on a port on your bastion. Cheap, simple, and used by exactly the kind of shop that has one IT guy.

Reasons to skip it for PowerFab Dashboard:

- You'd need to operate and harden a bastion (bastion hygiene is real work).
- SSH keys to manage per customer.
- Cloudflare doesn't natively orchestrate this — you're running infra outside the platform you've committed to.
- Cloudflare Tunnel does the same job better.

Mention only for completeness.

| Score | |
|---|---|
| Security posture | 7/10 |
| MVP install effort | Medium |
| Ops burden at 200 | High — bastion is a single point of failure |

---

## PULL vs PUSH — head to head

| Dimension | PULL (Tunnel / mTLS / VPN) | PUSH (Agent) |
|---|---|---|
| Who controls the schedule | Cloudflare | Customer's agent |
| Who handles retries | Worker code | Agent code |
| Customer server down at midnight | Job fails; we either retry or skip | Agent retries when it comes back, sends backlog |
| Who sees errors first | We do (in our logs) | Agent does (local), then us via heartbeat |
| Schema-evolution coupling | We must speak MySQL wire protocol — schema drift breaks queries silently | Agent owns the query, ships a versioned JSON shape — we decouple |
| Credential surface | We hold MySQL credential; one leak = all tenants exposed if the same scheme repeats | We hold per-agent tokens; MySQL credential never leaves customer LAN |
| Network sensitivity | Latency-sensitive — every query is a round trip | Insensitive — local query, then one upload |
| Bandwidth efficiency | Worse — many small queries | Better — one batched payload |
| Customer perception | "They're reaching into our server" | "Our server sends them data" — friendlier framing |
| MVP velocity | Faster — no agent to write | Slower — agent is real software |

### Where PUSH wins decisively

- The midnight-server-down case. With PULL, if the customer reboots at 11:55 PM, you miss the window and have to re-run logic. With PUSH, the agent simply runs when it can and catches up.
- Schema drift. Tekla PowerFab schema changes are absorbed at the agent layer in a typed C# DTO; the wire format to Cloudflare stays stable.
- The IT conversation. "We send you data" is a fundamentally easier sell than "you reach into our database."

### Where PULL wins

- Day-1 velocity. A Cloudflare Tunnel + a Worker that runs `SELECT` is a weekend's work. An agent is multiple weeks.
- Ad-hoc queries. If you ever need to run a one-off diagnostic query during a support call, PULL gives you that. PUSH locks you to whatever the agent ships.

---

## Recommendation

**Primary: Customer-installed connector agent (PUSH model), written in C# / .NET 8, distributed as a signed MSI, running as a Windows service.**

**Fallback for MVP-velocity: Cloudflare Tunnel + Worker, used for the first 3-5 pilot customers while the agent is being built.**

### Why agent is the right long-term choice

1. **IT teams accept it.** B2B SaaS that ingests on-prem data has converged on this pattern because customer security teams will not open inbound ports and increasingly resist persistent third-party tunnels on production servers.
2. **C# matches Nick's stack.** No new language, no new toolchain. A self-contained .NET 8 publish is one folder.
3. **It survives schema drift.** Tekla PowerFab updates will not silently break ingest the way they would for a remote SQL query.
4. **Observability is in your hands.** Heartbeats, agent versions, and last-success timestamps are first-class signals you control.
5. **Failure modes are forgiving.** A customer's server being down at 2 AM is a non-event with PUSH.

### Why Tunnel is a strong fallback

The agent will take 4-8 weeks to get production-ready (installer, auto-update, observability dashboard, signing pipeline). Cloudflare Tunnel gets a pilot customer live in days. Use it for the first wave, learn the data shape, then ship the agent.

### Why the others are worse

- **mTLS + IP allowlist**: The IP-allowlist freshness problem at 200 tenants is unsustainable, and the inbound port is a deal-breaker for many IT teams.
- **Site-to-site VPN**: Wrong shape for small steel fabs; requires IT engagement you can't expect.
- **Reverse SSH**: All the downsides of PULL plus you operate a bastion.

---

## Industry context

B2B SaaS reaching into customer on-premise systems has converged on three patterns, in roughly this order of prevalence:

1. **Customer-installed connector agent (PUSH)**. The dominant pattern for ERP-adjacent, manufacturing, healthcare, and financial-data SaaS. Vendors ship a small Windows or Linux service. The customer's IT runs an installer, configures credentials once, and forgets it. Updates flow through the vendor's signed manifest. Examples of the *pattern* (not naming products): integration platforms, observability vendors, accounting connectors, EHR integrators all use this shape.
2. **Outbound tunnel (Cloudflare Tunnel, Tailscale Funnel, Twingate)**. Newer, growing fast, but customer security teams are still wary of "what is this persistent tunnel binary doing." Common where the vendor needs interactive access (support, debugging) rather than just nightly batch.
3. **Inbound mTLS / IP-allowlist**. Mostly legacy. Used by older vendors who shipped before tunnels were a category. New SaaS rarely picks this.

The reason customer IT teams prefer PUSH agents is simple: outbound HTTPS is already allowed everywhere, the security review is bounded ("what does this binary do?") rather than open-ended ("what could you reach on our LAN?"), and the customer can pull the plug instantly by stopping a service.

---

## Credential model

| Concern | Pattern |
|---|---|
| Account creation | Customer's DBA creates a MySQL user, e.g., `powerfab_dashboard`@`localhost` |
| Privileges | `GRANT SELECT ON powerfab_db.* TO 'powerfab_dashboard'@'localhost'` — read-only, scoped to the PowerFab database only |
| Storage (PULL model) | Cloudflare Worker secret bound to the per-tenant Worker, or a row in a tenants table with the secret reference |
| Storage (PUSH model) | Agent reads from Windows DPAPI credential store; **the credential never leaves the customer's machine** |
| Rotation expectation | Annual rotation is standard; document the steps |
| Revocation | Customer runs `DROP USER 'powerfab_dashboard'@'localhost'`; ingest fails immediately, agent logs it, your heartbeat dashboard pages |

### Least-privilege MySQL grants

- `SELECT` only — never `INSERT`, `UPDATE`, `DELETE`, or any DDL.
- Scope to the PowerFab schema only — not `*.*`.
- Bind to `localhost` (PUSH) or to the loopback exposed via tunnel (PULL with Cloudflare Tunnel) — never to `%`.
- No `FILE`, no `PROCESS`, no `SUPER`.
- Document a `SHOW GRANTS FOR 'powerfab_dashboard'@'localhost'` command the customer can run to verify.

### What "revoke access" looks like for the customer

- PUSH: stop the Windows service, uninstall the MSI, drop the MySQL user. Three commands.
- PULL (Tunnel): stop `cloudflared`, drop the MySQL user. Two commands.

Make this explicit in the onboarding doc — IT teams need to know the off-ramp before they sign on.

---

## FabSuite XML API note

FabSuite (acquired into the Trimble / Tekla family) exposes data over an XML-based HTTP API. In customer deployments it typically runs on the same Windows host as PowerFab itself, listening on the LAN — not the public internet. From the connectivity standpoint, **it has the same on-prem reachability problem as MySQL**: we can't hit it from Cloudflare directly.

The fix is symmetric with the MySQL story:

- **PUSH model**: the agent makes local HTTP GETs against the FabSuite endpoint, parses the XML in C# (`System.Xml.Linq`), maps to the same JSON shape, and ships it alongside the MySQL extract in one nightly batch.
- **PULL model**: Cloudflare Tunnel can publish HTTP services as well as TCP, so the FabSuite endpoint can ride the same tunnel with a different hostname.

The XML API tends to be more brittle than direct SQL — pagination, rate limits, and occasional schema changes in the XML elements are normal. This is another reason the agent's typed-DTO approach pays off: you absorb XML quirks in C# code on the customer side, not in a Worker.

---

## Closing summary

| Approach | Security | MVP effort | Ops at 200 | Pick for PowerFab? |
|---|---|---|---|---|
| Cloudflare Tunnel | 9/10 | Low | Low | Fallback for pilot |
| mTLS + IP allowlist | 5/10 | Medium | High | No |
| Site-to-site VPN | 8/10 | High | High | No |
| Connector agent (PUSH) | 8/10 | Medium | Medium | **Primary** |
| Reverse SSH | 7/10 | Medium | High | No |

Build the agent. Ship Cloudflare Tunnel for the first two pilots so you can iterate on data shape while the agent is in development. By customer 5-10, the agent should be the only path supported.
