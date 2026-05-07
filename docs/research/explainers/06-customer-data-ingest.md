# 06 — Customer Data Ingest: Getting MySQL Data Out of the Customer's Building

> **Pre-reqs:** Read `00-start-here.md` (vocabulary, the big picture) and `05-cloudflare-architecture.md` (where things run on Cloudflare). You should already know what a Worker, KV, and R2 are.
>
> **What you'll know by the end:**
> - The one fundamental question that decides everything else: who initiates the connection, us or them?
> - Five different ways to get data out of a customer's network, and why four of them are wrong for us.
> - What a daemon, an agent, a tunnel, mTLS, and DPAPI all actually mean.
> - The exact MySQL `GRANT` line we'll ask the customer's DBA to run, and why every word of it matters.
> - Where the C# .NET 8 binary that talks to the customer actually runs (short version: Cloudflare Containers, fallback to Fly.io).
> - Five concrete things not to do.

---

## 1. The setup, in plain English

Each PowerFab Dashboard customer is a steel-fabrication shop. Inside their building, they have:

- **A Windows server.** Could be a real metal box in a closet, could be a VM. Doesn't matter.
- **A MySQL database** running on that server. This is where Tekla PowerFab — the desktop software the shop uses to run their business — stores everything.
- **A FabSuite XML API** also running on or near that server. FabSuite is part of the same software family. It exposes some of the same data over an HTTP endpoint that returns XML.

The customer's network is behind a firewall, like every business network. By default, nothing on the public internet can reach into that MySQL database or that XML API. That's normal and correct. We do not want it any other way.

Our app, on the other hand, runs on Cloudflare — out on the public internet. The dashboard, the per-tenant config, the JSON snapshots that the React app reads at runtime — all of it lives in Cloudflare.

So we have a problem in geography:

```
   CUSTOMER'S BUILDING                       CLOUDFLARE (us)
   ┌───────────────────────────┐             ┌─────────────────┐
   │                           │             │                 │
   │  Windows server           │             │  Workers, KV,   │
   │   ├── MySQL (3306)        │   ???       │  R2, Containers │
   │   └── FabSuite XML API    │ ──────►     │                 │
   │                           │             │                 │
   │  Firewall: blocks all     │             │                 │
   │  inbound traffic          │             │                 │
   └───────────────────────────┘             └─────────────────┘
```

Once a night, we need a fresh snapshot of their data: shop orders, parts, hours worked, inspection results, everything that powers the seven dashboard panels. The question this whole doc answers is: **how does that data get from inside their building to inside Cloudflare, every night, reliably, without anyone having to do anything by hand?**

---

## 2. The fundamental question: who calls who?

Before any technology choice, there is one question that decides the entire shape of the solution:

> **Who initiates the connection?**

There are exactly two answers, and they have names.

### 2.1 PULL — we reach in

We sit on Cloudflare. When midnight comes, our code says "hey, MySQL inside Acme's building, run this query and give me the results." We are the one who reaches across the network boundary.

```
    CLOUDFLARE                 CUSTOMER
    ┌──────────┐                ┌──────────┐
    │ Worker   │                │  MySQL   │
    │ Container│ ──── 1. open ──►│          │
    │          │ ──── 2. query ─►│          │
    │          │ ◄─── 3. data ── │          │
    └──────────┘                └──────────┘

      "we initiated"                ^
                                    │
                              we connected TO them
```

The defining property: **the connection is set up from our side, going in.** That means *something* on the customer's side has to be willing to accept our incoming connection. Either a port is open in their firewall, or a tunnel agent on their server has already opened a back-channel we can travel down.

### 2.2 PUSH — they reach out

We sit on Cloudflare and wait. A small program on the customer's server runs every night, queries the local MySQL itself, packages the results, and POSTs them to us over plain HTTPS.

```
    CLOUDFLARE                 CUSTOMER
    ┌──────────┐                ┌──────────┐
    │ Worker   │                │ Agent    │
    │ R2       │                │   ↓      │
    │          │ ◄── 3. POST ── │  MySQL   │
    │          │                │ (1. query│
    │          │                │  2. pack)│
    └──────────┘                └──────────┘

         ^                          "they initiated"
         │
   they connected OUT to us
```

The defining property: **the connection is set up from the customer's side, going out.** Outbound HTTPS is already allowed by every business firewall on earth — that's how their browsers reach Google. So the customer's IT team usually doesn't have to touch the firewall at all.

### 2.3 Why this is THE question

Every other decision flows from this one. PULL means we own the schedule, we own the query logic, we own retries — and we have to find a way through the customer's firewall. PUSH means a piece of our software lives on their server, but we never have to ask them to open anything.

Hold this distinction in your head. The rest of the doc is just consequences of it.

---

## 3. Vocabulary primer

These are the terms we'll use repeatedly. Skim now, refer back as you read.

- **Daemon** — a program that runs in the background, on its own, with no user opening a window for it. On Linux it's literally called a daemon. On Windows it's called a *Windows service*. They're the same idea: a thing that boots when the computer boots, runs forever, and does its job invisibly. `cloudflared` is a daemon. The PUSH agent we'll build is a daemon. Daemons are *not* "applications" in the user's sense — there's nothing to open, no UI, no window in the taskbar.

- **Agent** — in this doc, a daemon that we wrote and ship to the customer. "Connector agent" and "PUSH agent" mean the same thing. Same idea as a daemon, but the word "agent" emphasizes that it's *acting on our behalf* on the customer's machine.

- **Service** (Windows sense) — same thing as daemon, in Windows terminology. You'll see "runs as a Windows service" a lot. It just means: starts on boot, runs in the background, can be stopped/started/uninstalled with `sc.exe` or the Services control panel.

- **MSI** — Microsoft Installer. The standard Windows install file format. Double-click it, click Next a few times, software is installed. Ours will be a signed MSI so the customer's IT team can verify it came from us.

- **Inbound port** — a numbered "door" on a firewall that the firewall allows incoming traffic on. MySQL listens on port 3306. If the customer's firewall opens 3306 to the internet, that's an inbound port. IT teams hate opening inbound ports on production servers, and they're right to.

- **Outbound traffic** — connections initiated from inside the network, going out. Web browsing, email checking, software updates. Outbound 443 (HTTPS) is universally open. This is the property PUSH and Cloudflare Tunnel exploit.

- **TLS** — Transport Layer Security. The encryption layer that turns `http://` into `https://`. When you see "TLS" in this doc, it means "encrypted, and the server proved who it is with a certificate."

- **mTLS** — mutual TLS. Normal TLS proves the *server's* identity to the client (your browser checks Cloudflare's cert). mTLS adds the reverse — the *client* also has to prove its identity with its own certificate. Used when you want to allow only specific clients in, with cryptographic proof rather than passwords.

- **VPN** — Virtual Private Network. A general term for "make two networks act like one network." The customer's office gets a virtual cable plugged into our network. Many flavors: IPsec, WireGuard, OpenVPN.

- **IPsec** — a particular flavor of VPN protocol, the heavyweight one. Configured on enterprise firewalls. Requires a network engineer to set up phase-1 and phase-2 parameters, pre-shared keys, and routing tables. Painful.

- **Site-to-site VPN** — a VPN between two whole networks (rather than a single laptop and a network). The "sites" are the customer's office and our infrastructure. Always heavyweight.

- **cloudflared** — Cloudflare's tunnel daemon. A small Go binary you install on a customer's server. It opens an outbound TLS connection to Cloudflare and registers itself as a *named tunnel*. From our side, we address a hostname like `mysql.acme.internal.powerfab.app`, and Cloudflare routes the bytes down the tunnel to the customer's loopback interface, where MySQL is listening on 3306. Outbound-only on the customer side. No inbound port opened.

- **Cloudflare Tunnel** — the name of the *product* that uses `cloudflared`. People say "Cloudflare Tunnel" and "cloudflared" almost interchangeably. The tunnel is the abstract thing; cloudflared is the concrete program.

- **DPAPI** — Data Protection API. A built-in Windows facility for encrypting secrets (like passwords or API tokens) tied to a specific user account or machine. When our agent stores a MySQL password, it asks DPAPI to encrypt it; only code running on that machine, as that account, can decrypt it. A stolen `appsettings.json` file is useless without DPAPI access. Roughly the Windows equivalent of macOS Keychain or Linux libsecret.

- **Bastion** — a single hardened server that exists to be the only public-facing entry point into a private network. You SSH to the bastion, then SSH from the bastion onward. Reverse-SSH tunneling needs one. Bastions are real work to operate.

- **Reverse SSH tunnel** — a clever (read: hacky) trick where the customer's server runs `ssh -R` to your bastion, exposing their local MySQL on a port on your bastion. We mention it for completeness; we're not using it.

- **DLQ** — dead-letter queue. A queue where messages that failed processing repeatedly are parked for human inspection. Mentioned briefly in §10; covered in detail in 07.

- **Heartbeat** — a periodic message from the agent saying "I'm alive, here's my version, here's when I last succeeded." Lets us tell the difference between "agent is broken" and "agent is fine and the customer's data legitimately didn't change."

- **Self-contained .NET publish** — a way of packaging a C# .NET 8 program where the runtime is bundled into the output, so the customer's machine doesn't need .NET installed to run it. About 70 MB on disk. Means the install footprint is one folder, no prerequisites.

If any of those still feel fuzzy, that's fine — re-read this section after you finish §6. They make more sense in context.

---

## 4. What Nick will accept (and won't)

Before walking through the options, let's be explicit about the constraints. These come from Nick, not from research:

**Acceptable on the customer side:**

- A small **firewall change**, if needed. Adding an outbound rule. Allow-listing one hostname. That's fine.
- A small **daemon** — a Windows service that runs in the background, takes no user input, has no UI. Installs from an MSI in a few clicks.
- A read-only MySQL account that the customer's DBA creates for us.

**Not acceptable on the customer side:**

- A "whole application" — anything with its own UI, its own database, its own update story, that ends up on the customer's start menu and demands attention.
- Anything that requires the customer's IT team to schedule a multi-hour engineering call to set up.
- Anything that involves opening **inbound ports** on their production server to the public internet.

That last one is non-negotiable, and not because Nick is being paranoid. It's because the customer's IT team's cyber-insurance policy probably forbids it, and even if it doesn't, asking them to open 3306 on their MySQL box to the internet is the fastest way to lose a sale. We can rule that whole class of solution out before we begin.

**What the customer creates:** a read-only MySQL user — we'll walk through the exact `GRANT` statement in §9. They give us the username and password. We store it in a Cloudflare secret (PULL model) or in DPAPI on their own machine (PUSH model). They never email us a password in plaintext.

---

## 5. The five connection topologies

There are five plausible ways to bridge "MySQL on a customer's Windows server" and "Cloudflare." Here's each one, walked through. We'll come back at the end and pick.

### 5.1 Cloudflare Tunnel (cloudflared) — PULL

**What it is:** a small (~30 MB) Go binary called `cloudflared` runs as a Windows service on the customer's server. On startup, it opens an outbound TLS connection to Cloudflare and says "I am the tunnel for `mysql.acme.internal.powerfab.app`." The connection stays open. From our side — a Worker or a Container — we connect to that hostname, and Cloudflare invisibly routes the bytes down the existing tunnel to the customer's loopback interface, where MySQL is listening on 3306.

**What installs where:**
- On the customer's server: cloudflared (one MSI install, one ~10-line YAML config file, runs as a Windows service).
- On our side: a Cloudflare account configuration that names the tunnel and binds it to a hostname.

**Footprint on the customer side:**
- ~30 MB binary.
- Zero inbound ports opened.
- Outbound 443 to Cloudflare (which is already allowed in every business network).
- Auto-restarts on crash via Windows service supervision.
- Auto-reconnects when the network drops.

**IT objections we'll actually hear:**
- "What is this 30 MB process running on our server 24/7?" — answerable. It's an open-source, signed binary from a known vendor.
- "We don't allow third-party persistent services on production servers." — at strict shops this is a hard no. Most steel fabricators are not that strict, but some are.
- "Can we audit what it's doing?" — yes, the local logs are verbose.

**Security posture:** very strong. The connection is outbound-only and TLS. There is no listening port on the customer's side that the public internet can see. The MySQL credential we use to authenticate is held in our Cloudflare secrets — it never travels in plaintext.

**MVP effort:** low. The MSI installs in a few minutes; the Cloudflare side is a few dashboard clicks plus a Worker that uses a `connect()` call.

**Ops burden at 200 tenants:** low. Each tenant is one named tunnel. Cloudflare manages the edge half of every tunnel. Our monitoring just checks "is each tunnel up?" The whole point of Cloudflare Tunnel is that the operational complexity stays linear.

### 5.2 IP-allowlist + mTLS — PULL

**What it is:** the customer publishes their MySQL (or a thin proxy in front of it) on a public IP. They configure their firewall to allow incoming connections only from a specific list of source IPs (ours), and they require mTLS — meaning we have to present a client certificate to even open the connection.

**What installs where:**
- On the customer's side: a firewall rule list, a public DNS record, a TLS server certificate, an mTLS configuration.
- On our side: an mTLS client certificate, and code that connects out using it.

**Footprint on the customer side:**
- No new software. But — and this is the killer — they have to **open an inbound port to the public internet on their production server.**

**IT objections (the real ones):**
- "You want us to open an inbound port on our production database server?" — this is the killer objection. At many shops it's a flat refusal, end of conversation.
- "What if your client cert leaks?" — fair, and mTLS rotation is real ongoing work.
- "Our cyber-insurance policy prohibits inbound DB exposure." — increasingly common, and unappealable.

**The IP-allowlist freshness problem.** Cloudflare Workers do not have stable egress IPs by default. Cloudflare can change the egress IPs as their network evolves. You can pay for "Workers Egress Dedicated IPs" but the set can still shift. Every time it shifts, every customer's firewall rule needs updating. At two customers this is annoying. At 200 it's an operations job in itself.

**Security posture:** mediocre. mTLS is genuinely strong, but the inbound port is a meaningful attack surface in itself — it's a thing on the public internet that responds to traffic, which means it's a thing that gets scanned and probed forever even when nothing gets through.

**MVP effort:** medium. Cert provisioning per customer, firewall rule per customer, DNS record per customer.

**Ops burden at 200:** high. IP rotation, cert rotation, firewall coordination per customer.

### 5.3 Site-to-site VPN — PULL

**What it is:** a network-level bridge between Cloudflare's network and the customer's office network. Either the customer's existing firewall appliance terminates an IPsec tunnel back to us, or we ship them a WireGuard endpoint as a small VM.

**What installs where:**
- On the customer's side: configuration on their existing firewall (their network engineer's job), or an additional VM running a WireGuard endpoint.
- On our side: a tunnel endpoint, route tables, a Magic WAN configuration (Cloudflare's product for this).

**Footprint:** heavyweight by definition. VPN setup is a "schedule a call with their IT team" project, not a self-serve install. The customer's network engineer has to sit down with us, exchange phase-1 and phase-2 parameters, set up pre-shared keys, configure routes.

**When site-to-site is actually warranted:**
- When the customer wants 4+ services exposed to us, not just one MySQL.
- When the customer is already running site-to-site VPNs for other vendors (a Tier-1 ERP integration, e.g.) and has the muscle.
- When compliance regimes (defense contractors, regulated finance) require network-level segmentation rather than service-level.

For PowerFab Dashboard's customer base — small-to-mid steel-fab shops — this is enormously over-spec'd. They typically don't have a dedicated network engineer at all. A site-to-site VPN means "every customer onboarding is a multi-week project."

**Security posture:** good — strong protocols, real isolation. But there's a flip side: a compromised VPN gives access to the *whole customer LAN*, not just the one MySQL we wanted. Bigger blast radius if anything goes wrong on either end.

**MVP effort:** high.

**Ops burden at 200:** very high. Every IT team configures slightly differently; every customer onboarding is bespoke.

### 5.4 Customer-installed connector agent — PUSH

**What it is:** a small Windows service that **we** write and ship. Customer installs it from a signed MSI. It runs as a Windows service. Once a night, it wakes up, queries the local MySQL on `127.0.0.1:3306` and the local FabSuite XML endpoint, packages the results into JSON, and POSTs them to a Cloudflare endpoint we run.

**Why C#.** Nick already writes C# .NET 8. The customer's machine is Windows. A self-contained .NET 8 publish produces a single ~70 MB folder with no runtime prerequisite — the customer doesn't need to install .NET separately. Alternatives considered: Go (smaller binary, but Nick doesn't write Go), Rust (overkill for this).

**What installs where:**
- On the customer's side: one MSI install. A few config values (MySQL connection string, agent ID, agent secret) get set during install. Runs as a Windows service afterward.
- On our side: an HTTPS endpoint that accepts the agent's POSTs, plus an R2 bucket where the data lands, plus an observability dashboard that watches heartbeats.

**Footprint on the customer side:**
- ~70 MB binary, single install folder.
- Runs as a Windows service.
- Zero inbound ports opened.
- Outbound 443 to `*.powerfab.app` only.
- Config in `appsettings.json`; secrets in Windows DPAPI.
- Updates via signed MSI (manual at first, auto-update later).

**Why this is what IT teams actually prefer.** Outbound HTTPS is already allowed in every business network on earth, so they don't have to touch the firewall at all. The security review is *bounded*: "what does this signed binary do?" rather than the open-ended "what could you reach if you got into our LAN through a tunnel?" And the customer can pull the plug instantly: stop the Windows service. There is no persistent connection from our side that they have to chase down.

**Failure handling — this is where PUSH genuinely shines.** Because the agent owns the schedule, it can handle failure intelligently:

- It can retry with exponential backoff if Cloudflare is temporarily unreachable.
- It can hold a small local SQLite queue of unsent batches if it accumulates a backlog.
- It can send a heartbeat every 5 minutes so we know it's alive even on nights when the data didn't change.
- It can write errors to the Windows event log, where the customer's IT team can see them.
- If the customer's server reboots at 11:55 PM, the agent simply runs when it wakes up. No "midnight window missed" problem.

**How we know an agent is healthy.** The heartbeat. Each agent sends `{agent_id, version, last_successful_run, last_error}` on a schedule. Our backend has a dashboard of all agents. If one goes silent for more than 25 hours, we get paged. Without this, you discover a broken customer three weeks later when they complain that their dashboard is stale.

**Update mechanism, two viable paths:**
- **Signed MSI + auto-update.** Agent checks a manifest URL hourly, downloads new MSI, runs it. Faster rollout, but auto-update bugs are catastrophic — a bad version breaks every customer at once.
- **Manual MSI push.** You email customers when there's a new version. Safer, slower.

For MVP: manual. Add auto-update around the 50-customer mark when manual cadence breaks down.

**Security posture:** strong, with one important caveat. Outbound-only, scoped credential, no inbound port. **But** we own a binary running on customer hardware — that's a supply-chain responsibility. We have to sign the binary, secure the build pipeline, and treat the update mechanism as critical infrastructure. We're trading "operate a tunnel daemon written by someone else" for "operate our own daemon."

**MVP effort:** medium. We're writing and maintaining real software here. Plan on 4-8 weeks to get an agent production-ready: installer, auto-update, observability, signing pipeline, error reporting.

**Ops burden at 200:** medium. Agent observability and update logistics are real, but they scale linearly. Heartbeat dashboard tells us at a glance which agents are healthy.

### 5.5 Reverse SSH — PULL (mentioned for completeness)

**What it is:** the customer's server runs `ssh -R` outbound to a bastion server we operate. That command exposes their local MySQL on a port on our bastion. Then anything on Cloudflare can connect through the bastion to reach the customer's MySQL.

**Why we don't pick it:**
- We'd have to operate and harden a bastion (real work — bastion hygiene is a job).
- SSH keys to manage per customer.
- Cloudflare doesn't natively orchestrate any of this; we'd be running infrastructure outside the platform we've committed to.
- Cloudflare Tunnel does exactly the same job better, with no bastion.

We mention it because it's the kind of thing a one-IT-guy shop will sometimes propose ("can we just SSH-tunnel?"). The polite answer is "we use Cloudflare Tunnel, which is the same idea but managed for us." Move on.

---

## 6. Head-to-head: PULL vs PUSH

Now that we've walked the options individually, here's the comparison the brief lays out. PULL groups Tunnel, mTLS, and VPN; PUSH is the agent.

| Dimension | PULL (Tunnel / mTLS / VPN) | PUSH (Agent) |
|---|---|---|
| Who controls the schedule | Cloudflare | Customer's agent |
| Who handles retries | Worker code | Agent code |
| Customer server down at midnight | Job fails; we either retry or skip | Agent retries when it comes back, sends backlog |
| Who sees errors first | We do (in our logs) | Agent does (local), then us via heartbeat |
| Schema-evolution coupling | We must speak MySQL wire protocol — schema drift breaks queries silently | Agent owns the query, ships a versioned JSON shape — we decouple |
| Credential surface | We hold the MySQL credential in Cloudflare secrets | We hold per-agent tokens; MySQL credential never leaves customer LAN |
| Network sensitivity | Latency-sensitive — every query is a round trip | Insensitive — local query, then one upload |
| Bandwidth efficiency | Worse — many small queries over the WAN | Better — one batched payload |
| Customer IT perception | "They're reaching into our server" | "Our server sends them data" |
| MVP velocity | Faster — no agent to write | Slower — agent is real software |

### 6.1 The midnight-server-down case, walked through

This is the example that makes PUSH's advantage concrete. Imagine the customer's IT team is doing maintenance. They reboot the server at 11:55 PM. The reboot takes seven minutes. The server is fully back online at 12:02 AM.

**PULL (Cloudflare Tunnel):** at midnight UTC, our scheduled job fires. It tries to connect through the tunnel. The tunnel is not up — cloudflared isn't running yet, the server is rebooting. The connection fails. Our job either:
- Logs an error and gives up, and a customer's dashboard is stale tomorrow morning until somebody notices.
- Retries on a schedule we have to design, and we have to figure out what "give up eventually" means.

Either way, *we* are the one writing the retry logic, and we are the one who has to be paranoid about every failure mode.

**PUSH (agent):** the agent is configured to run every night at 1 AM (giving the server a comfortable buffer). At 1 AM the server is back online. The agent runs, queries MySQL, packages JSON, POSTs to Cloudflare. Done. We didn't have to do anything. If somehow the server was *still* down at 1 AM, the agent would simply run at 2 AM, or whenever it next wakes up. The agent is built to catch up.

The general principle: **with PUSH, the side that has the most context about what's actually happening (the agent on the customer's machine) is the side making the scheduling decisions.** That's almost always the right shape.

### 6.2 Where PULL still wins

Honest tradeoffs — PULL is not strictly worse on every axis:

- **Day-1 velocity.** A Cloudflare Tunnel + a Worker that runs a `SELECT` is a weekend's work. An agent is multiple weeks. If you need to onboard the first pilot customer next Friday, Tunnel is the answer.
- **Ad-hoc queries.** If you ever need to run a one-off diagnostic query during a support call ("what's row 12345 in the parts table?"), PULL gives you that. PUSH locks you to the queries the agent ships.
- **Schema discovery.** While we're still figuring out what data the dashboard actually needs, PULL is more forgiving — change the query, redeploy. PUSH means cutting an agent release.

These are real advantages, especially in the first few weeks. We'll lean on them, deliberately, in §7.

---

## 7. Recommendation

**Primary, long-term: PUSH agent.** A C# .NET 8 Windows service, distributed as a signed MSI. This is the path we'll be on by customer 5-10 and forever after.

**Fallback for MVP velocity: Cloudflare Tunnel.** For the first 2 pilot customers, while the agent is being built, we use cloudflared on their server plus a Worker doing the queries. This gets pilots live in days instead of weeks.

### 7.1 Why the PUSH agent is the right long-term choice

1. **IT teams accept it.** B2B SaaS that ingests on-premise data has converged on this pattern because customer security teams will not open inbound ports and increasingly resist persistent third-party tunnels on production servers. Outbound HTTPS is universally allowed and easy to defend in a security review.
2. **C# matches Nick's stack.** No new language, no new toolchain. The data-extraction logic Nick has been writing in C# since the first version of this dashboard ports directly.
3. **It survives schema drift.** Tekla PowerFab database updates absorb at the agent layer in a typed C# data class; the JSON shape we ship to Cloudflare stays stable. With PULL, a Tekla schema change silently breaks our remote query and we find out three weeks later.
4. **Observability is in our hands.** Heartbeats, agent versions, last-success timestamps — all signals we control. With PULL, the only signal we have is "did the query work?"
5. **Failure modes are forgiving.** A customer's server being down at 2 AM is a non-event with PUSH. With PULL it's a fire drill.

### 7.2 Why Cloudflare Tunnel is the right fallback (and why it's a fallback, not the primary)

The agent will take 4-8 weeks to get production-ready: installer, auto-update, observability dashboard, code-signing pipeline. Cloudflare Tunnel gets a pilot customer live in a weekend. So for the first two pilots — where we're learning the data shape and the dashboard requirements anyway — Tunnel is exactly right. By customer 5-10 we're cutting over to the agent and turning Tunnel off.

Why doesn't Tunnel stay the primary forever? Three reasons. First, the schema-drift problem: a remote `SELECT` couples us tightly to the customer's MySQL schema, and Tekla updates it. Second, the observability gap: with Tunnel we only know ingest worked when we run it, and only learn it failed if we look. Third, the support-call experience: when something is wrong, all our diagnostics are at our end of a long pipe, not on the box where the data actually is.

### 7.3 Why the alternatives are worse

In honest terms:

- **mTLS + IP allowlist** is dead-on-arrival because of the inbound-port objection. Even if we got past that, the IP-allowlist freshness problem at 200 tenants is unsustainable — every time Cloudflare's egress IPs shift, every customer's firewall needs updating. No.
- **Site-to-site VPN** is the wrong shape for small steel fabs. They don't have the network engineering capacity, and they don't need to expose four services to us — they need to expose one MySQL and one XML endpoint. VPN is the right answer for a defense contractor with a CISO; it is the wrong answer for a 30-person fab shop.
- **Reverse SSH** has all the downsides of PULL plus we now operate a bastion. Cloudflare Tunnel gets us the same shape, run by Cloudflare. There is no scenario where reverse SSH wins.

---

## 8. Where the C# .NET 8 binary actually runs

Quick note. The PUSH agent runs on the customer's server — that's the whole point. But there's a *separate* C# .NET 8 binary on **our** side: the orchestration that processes incoming agent payloads, runs the data transforms, and writes per-tenant JSON to R2. The detailed orchestration is covered in `07-nightly-data-pipeline.md`. For now, just the host placement question.

**Primary: Cloudflare Containers.** As of April 2026 it's GA. It runs an arbitrary OCI image — meaning a Linux .NET 8 container works the same as it does anywhere else. Active-CPU pricing means a 5-10 minute nightly job per tenant costs effectively zero at MVP scale and around $70/month at the 200-tenant horizon. The Worker-fires-cron-fires-Container pattern fits cleanly into the rest of our Cloudflare-anchored stack.

The one real gotcha: Cloudflare Containers don't give us a stable egress IP. Cloudflare provisions instances across 320+ cities. So if a customer ever insists on firewalling us by source IP, Containers can't deliver that. Not a problem for the agent (it's POSTing *to* us), but worth knowing.

**Fallback: Fly.io Machines.** Same operational shape — Linux containers, scale-to-zero, per-second billing. Crucial difference: Fly supports region pinning. If we end up with a customer who insists on a stable egress region or static IP, Fly gives us that. .NET 8 is first-class on Fly.

**Switch criteria — when we'd move from Containers to Fly:**
1. Cold start on the production .NET 8 image consistently exceeds 30 seconds.
2. A customer contractually requires a static egress IP for their MySQL firewall and refuses to install cloudflared.
3. Per-run cost exceeds ~$0.50/tenant/night at any tenant count.
4. A blocking .NET 8 issue surfaces on Containers' Linux runtime that doesn't exist on Fly.

That's all that needs to be said here. The actual orchestration — Worker cron firing, Container starting, queue dispatch, R2 manifest swap — is the subject of `07-nightly-data-pipeline.md`. Don't go deep here.

---

## 9. The credential model

Now that we know how the data physically gets out, what's the credential we use to authenticate at the MySQL layer? Same answer regardless of PULL or PUSH: a least-privilege read-only MySQL user that the customer's DBA creates.

### 9.1 The GRANT line, walked word by word

We ask the customer's DBA to run this on their MySQL:

```sql
CREATE USER 'powerfab_dashboard'@'localhost' IDENTIFIED BY 'a-strong-random-password';
GRANT SELECT ON powerfab_db.* TO 'powerfab_dashboard'@'localhost';
SHOW GRANTS FOR 'powerfab_dashboard'@'localhost';
```

Walking through line by line:

```sql
CREATE USER 'powerfab_dashboard'@'localhost' IDENTIFIED BY 'a-strong-random-password';
```

- `CREATE USER` — makes a new MySQL user account.
- `'powerfab_dashboard'` — the username. Naming it after our app makes it obvious in the customer's audit logs what this user is for.
- `@'localhost'` — this part matters a lot. MySQL user identity is `username@hostname` — the same username at a different host is a different user. `@'localhost'` means **this user can only log in from the same machine MySQL is running on**. Not from the LAN, not from the internet. Just localhost. Combined with the rest of our setup, this means the credential is useless to anyone who isn't already inside the agent (PUSH) or on the cloudflared loopback (PULL).
- `IDENTIFIED BY 'a-strong-random-password'` — sets the password. The customer's DBA generates this, gives it to us through a secure channel (a password manager share, not email).

```sql
GRANT SELECT ON powerfab_db.* TO 'powerfab_dashboard'@'localhost';
```

- `GRANT` — give permissions.
- `SELECT` — *only* read. No `INSERT`, no `UPDATE`, no `DELETE`, no DDL like `ALTER TABLE`. We literally cannot write to their database with this credential. If someone steals our credential, they cannot corrupt the customer's data. The most they can do is read it.
- `ON powerfab_db.*` — only on the PowerFab database, all tables (`*`). Not `*.*` (all databases). If the customer also has a separate `payroll` MySQL database on the same server, our user cannot see it.
- `TO 'powerfab_dashboard'@'localhost'` — applying to that user we just made.

```sql
SHOW GRANTS FOR 'powerfab_dashboard'@'localhost';
```

- Prints back exactly what permissions the user has, so the DBA can verify before sharing the credential.

A few things we **explicitly do not grant**:

- `FILE` — would let the user read/write arbitrary files on the server filesystem. No.
- `PROCESS` — would let the user see what queries other users are running. No.
- `SUPER` — godmode. Absolutely not.

We document all of this in the customer onboarding doc so their DBA can run it without us in the loop, and verify it themselves.

### 9.2 Where the credential lives, in PUSH and PULL

**PUSH model:** the agent stores the username and password in Windows DPAPI on the customer's own machine. **The credential never leaves the customer's network.** That's a real property of PUSH — even if our entire Cloudflare account were compromised, no MySQL credential would leak.

**PULL model:** we store the credential in Cloudflare secrets, bound to the per-tenant Worker that does the query. Cloudflare secrets are encrypted at rest, only readable by the Worker that owns them. Reasonable, but the credential does live on our infrastructure. One leak of the secrets-management layer would expose every tenant's credential.

This is a real point in PUSH's column. Customer security reviews tend to like it.

### 9.3 Rotation

Annual rotation is the standard expectation. The flow:

1. Customer's DBA generates a new password, runs `ALTER USER 'powerfab_dashboard'@'localhost' IDENTIFIED BY 'new-password';`
2. They share the new password with us through the same secure channel.
3. We update the secret (PULL) or push a small config update to the agent (PUSH).
4. Verify the next ingest run succeeds.

We document this calendar reminder in the per-tenant onboarding record. If a tenant skips a rotation, that's their call — we just keep running.

### 9.4 Revocation — what "stop trusting us" looks like

The customer can shut us off at any moment.

**PUSH:**
1. Stop the Windows service: `sc stop PowerFabAgent`
2. Uninstall the MSI.
3. Drop the MySQL user: `DROP USER 'powerfab_dashboard'@'localhost';`

Three commands. Done.

**PULL (Tunnel):**
1. Stop cloudflared: `sc stop cloudflared`
2. Drop the MySQL user.

Two commands. Done.

This matters. Customers will sign on more easily if the off-ramp is short and obvious. We document it in the onboarding doc, up front.

---

## 10. The FabSuite XML API note

Same connectivity story as MySQL. FabSuite typically runs on the same Windows server, listening on the LAN — not the public internet. We can't reach it from Cloudflare directly; we have the same on-prem reachability problem.

The fix is symmetric:

- **PUSH model:** the agent makes local HTTP GETs to the FabSuite endpoint (something like `http://localhost:8080/api/...`), parses the XML in C# using `System.Xml.Linq`, maps it to the same JSON shape we use for MySQL data, and ships it in the same nightly batch. One agent, both data sources, one upload.
- **PULL model:** Cloudflare Tunnel can publish HTTP services as well as TCP. The FabSuite endpoint can ride the same tunnel under a different hostname, e.g., `fabsuite.acme.internal.powerfab.app`.

The XML API tends to be flakier than direct SQL — pagination, occasional rate-limiting, schema changes in the XML elements between FabSuite versions. This is another reason the agent's typed-data-class approach pays off long-term: we absorb XML quirks in C# code that we can update on a per-customer cadence, rather than in a Worker that's the same for everyone.

---

## 11. Five anti-patterns to avoid

Concrete things not to do, with reasons.

### 11.1 Don't put the MySQL credential in the Queue message body

Once we have the agent working, the data flow looks like: agent POSTs payload → Worker writes to a Cloudflare Queue → Container picks up the queue message and processes it. It's tempting to stuff the MySQL credential into the queue message so the Container has it handy. **Don't.** Queue messages are not designed as a secret-storage layer. They get logged, replayed to dead-letter queues, retried. Keep credentials in Cloudflare secrets or DPAPI; pass *references* (tenant ID, agent ID) through queues, then look up the secret at the consuming side.

### 11.2 Don't retry forever on auth failures

If MySQL says "access denied," retrying with exponential backoff is wrong — the credential is wrong, retrying doesn't fix it, and you'll fill logs and eat budget. Distinguish *transient* errors (network blip, server busy) from *terminal* errors (auth failed, table doesn't exist). Transient → retry. Terminal → fail fast, page us, stop hammering the customer's server.

### 11.3 Don't cron the agent at exactly midnight

If 200 customers all run at exactly 00:00 UTC, you get a 200-way thundering herd hitting your Cloudflare endpoint at the same moment. Spread it. The simplest version: each agent reads a per-tenant "preferred minute" (0-59) from its config and runs at `01:MM UTC`, deterministically distributed at provisioning time. Same idea applies to PULL: don't fire all 200 Worker cron jobs at the same minute.

### 11.4 Don't store the agent's secret token in `appsettings.json` in plaintext

The agent has its own credential to authenticate to *us* — separate from the MySQL credential. Don't write it to a plain config file. Use Windows DPAPI: the install step asks for the secret, encrypts it via DPAPI, and writes the encrypted blob. At runtime, the agent decrypts it via DPAPI. Anyone who steals the file off the disk gets nothing.

### 11.5 Don't skip the heartbeat in the MVP "to save time"

It feels optional. It's not. Without a heartbeat, you discover broken customers when *they* tell you their dashboard is stale, which is several weeks too late. Build the heartbeat from agent v0.1. It's literally `POST /heartbeat {agent_id, version, last_success_at}` and a tiny dashboard. Skipping it is the false economy you'll regret first.

---

## 12. By the end of this doc you should know

- The fundamental question — **who initiates the connection?** — and that the answer is PUSH for us.
- What a daemon, an agent, a tunnel, mTLS, IPsec, DPAPI, an MSI, and a bastion all are.
- The five connection topologies and why four of them aren't right for us.
- The PULL vs PUSH tradeoff table, and the midnight-server-down scenario for each.
- The recommendation: **PUSH agent (C# .NET 8 Windows service) primary; Cloudflare Tunnel for the first 2 pilots while the agent is being built.**
- The exact MySQL `GRANT` line we ask the DBA to run, and why every clause matters (`@localhost`, `SELECT`-only, scoped to `powerfab_db.*`).
- Where the credential lives in PUSH vs PULL, and how rotation and revocation work.
- That FabSuite XML rides the same connectivity story as MySQL.
- That the C# binary on **our** side runs in Cloudflare Containers (primary) or Fly.io (fallback), and the four switch criteria.
- Five concrete things not to do.

If any of these are still fuzzy, the most likely sticking point is §2 — the PULL vs PUSH framing. Re-read it before moving on. Everything in 07 builds on it.

---

**Next:** `07-nightly-data-pipeline.md` — what happens after the agent's POST lands. Cron, Queues, Containers, R2, manifest swaps, and how the React app sees a fresh snapshot the next morning.
