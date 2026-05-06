# 03 — Customer Data Ingest: How a Cloudflare-anchored SaaS Reads On-Prem Tekla PowerFab + FabSuite

> Status: research / decision document
> Audience: founder + future ops/security reviewer
> Scope: how the multi-tenant dashboard (Cloudflare Pages + Workers + D1 + R2 + KV) actually pulls nightly data out of a customer's Windows host, where the existing C# .NET 8 binary runs, and what the customer's IT person has to do for each option.

---

## TL;DR — the honest answer

**No realistic pattern gives you "zero install AND zero firewall change."** Pick one. Every credible on-prem SaaS ingest vendor — Fivetran, Stitch, Airbyte, Datadog, MuleSoft, Boomi — converges on exactly two patterns:

1. **Outbound-only agent** the customer installs (Datadog Agent, Fivetran HVA, Airbyte worker, Mule Runtime, Boomi Atom). No inbound firewall change.
2. **Inbound rule + IP allowlist** with TLS/mTLS. No install. Customer IT has to approve exposing a service.

**Recommended primary: Cloudflare Tunnel (`cloudflared`)** as a Windows service on the same host as PowerFab. Lightest install in the industry (~80 MB single binary, outbound 443 only, no inbound firewall change). Integrates natively via Hyperdrive + Tunnel for the MySQL leg and a public hostname for the FabSuite XML API. ([Tunnel docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/), [Hyperdrive private DB](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database/))

**Recommended C# .NET 8 host: Cloudflare Containers (GA April 2026).** Workers Cron Trigger fires a Worker, Worker spawns a container running the existing .NET binary, scales to zero between runs. ([Containers GA](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/), [Cron container example](https://developers.cloudflare.com/containers/examples/cron/)) Fits inside the Workers Paid included quota at MVP scale. **Fly.io Machines** is the strongest fallback if .NET 8 hits container-runtime quirks.

---

## Section A — Customer-network access options, ranked

The constraint: the data lives on a Windows host inside a small business LAN, behind whatever consumer-grade-to-mid-market firewall the customer happens to have (Meraki, SonicWall, Fortinet, Ubiquiti, even just a Comcast Business gateway). You need to read MySQL on `localhost:3307` and POST XML to the FabSuite API on the same host.

### Comparison table

| Option | Customer install? | Inbound firewall change? | Our op burden / tenant | Scale to 200 | Security posture |
|---|---|---|---|---|---|
| 1. Public expose + IP allowlist + TLS | No | **Yes (significant)** | Low (just credentials) | Excellent | Medium — depends on customer hardening |
| 2. Site-to-site IPsec / WireGuard VPN | Maybe (no — done on edge firewall) | Yes (VPN endpoint) | **High** — 200 tunnels to babysit | Painful | High |
| 3. Cloudflare Tunnel (`cloudflared`) | **Yes** (single binary / Win service) | No (outbound 443 only) | Low — Cloudflare manages plane | Excellent | High |
| 4. Reverse SSH tunnel | Yes (SSH client + autossh) | No | Medium (you run a jumpbox) | Painful | Medium-High |
| 5. Custom Windows connector agent | **Yes** (your binary) | No | High initially, low at scale | Excellent | Highest (data never leaves) |
| 6. Edge appliance | Yes (physical box) | Maybe | Very high | Hard | High |
| 7. Public reverse proxy + mTLS | No (their box) | Yes | Low | Good | High |

Now in detail.

### A1. Customer-managed inbound rules + IP allowlist

**How it works:** Customer opens TCP 3307 (MySQL) and 443 (FabSuite) inbound and allowlists your egress IPs. MySQL with `require_secure_transport=ON` (TLS 1.2/1.3), CA-signed cert, user with `REQUIRE SSL`. ([MySQL encrypted connections](https://dev.mysql.com/doc/refman/8.4/en/using-encrypted-connections.html))

**Customer IT:** NAT/port-forward, allowlist source IPs, install a TLS cert. Most fabricator IT shops are one person or an MSP; "open MySQL to the internet" makes IT auditors cry, even with allowlists. Cloudflare's egress space is wide and rotates — you'd need [BYOIP/dedicated egress IPs](https://developers.cloudflare.com/byoip/).

**Op burden / scale:** Low; works fine to 200 — nothing per-tenant your side beyond credentials.

**Verdict:** Works for technically-mature customers; non-starter for half the small fabricators. **Fallback only**, not primary.

### A2. Customer-managed site-to-site VPN

**How it works:** Customer's edge firewall (Fortinet/Palo/Meraki/SonicWall) builds an IPsec or WireGuard tunnel to a VPN concentrator you operate. Once up, you reach the Windows host privately. ([Palo Alto site-to-site overview](https://www.paloaltonetworks.com/cyberpedia/what-is-a-site-to-site-vpn))

**What customer IT actually does:** Real network engineering — pre-shared keys, Phase 1/Phase 2, route advertisements, NAT traversal. Some fabricators have it; most don't.

**Op burden / scale to 200:** **High and growing.** Operating a VPN concentrator with 200 IPsec tunnels, monitoring flaps, troubleshooting MTU and asymmetric routing — a full-time network engineer's job. The industry moved off this pattern for SaaS for a reason. ([SASE vs VPN](https://sase.cloud/guides/sase-vs-vpn))

**Verdict:** Wrong startup answer. Reserve for the one enterprise customer who demands it and can pay for it.

### A3. Cloudflare Tunnel (`cloudflared`) — the recommended primary

**How it works:** Install `cloudflared` as a Windows service on the same host running PowerFab. ([Windows service guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/windows/)) The daemon makes four long-lived outbound QUIC/HTTP2 connections to Cloudflare on TCP 443. You get:

- A stable hostname (`tenant-acme.tunnels.yourdomain.com`) routing to the FabSuite XML API at `localhost:8080`.
- A private TCP route to MySQL via Hyperdrive's [Connect to a private database using Tunnel](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database/) feature. Hyperdrive auto-provisions Cloudflare Access service tokens so only your Worker can use the route. ([Tunnel for Postgres blog](https://blog.cloudflare.com/cloudflare-tunnel-for-postgres/), [Workers VPC changelog](https://developers.cloudflare.com/changelog/post/2026-04-29-hyperdrive-vpc-private-databases/))
- Built-in redundancy: four connections to two CF data centers per tunnel.

**Customer IT:** Run the MSI (or a `winget`/PowerShell one-liner), paste a tunnel token. Outbound 443 to `*.cloudflare.com` is already open in every business firewall. No inbound rule, no port-forward.

**Op burden:** Lowest of any still-secure option. Cloudflare runs the control plane, cert rotation, DDoS protection, Access policy. You manage one row per tenant.

**Scale to 200:** Excellent. Tunnel itself is $0 on Workers Paid; you pay only for Worker / Hyperdrive / Container compute consuming it.

**Honest tradeoffs:**

- **It IS an install.** Frame to customers as "single ~80 MB Windows service, no inbound ports, runs alongside PowerFab" — not "install our software." The only alternative is exposing MySQL to the internet.
- If the host dies, you don't get data — but no architecture saves you from a dead host.

**Why not Tailscale / ZeroTier / ngrok?** Tailscale is closest in spirit (WireGuard, outbound-only, single binary) ([comparison](https://tailscale.com/compare/cloudflare-access)) and would work, but adds a second control plane. Hyperdrive's native Tunnel integration tilts the decision to Cloudflare. ZeroTier (L2 overlay) is conceptually heavier; ngrok is strictly inferior on cost and integration. ([Awesome tunneling list](https://github.com/anderspitman/awesome-tunneling))

### A4. Reverse SSH tunnel

**How it works:** Customer host runs `autossh` outbound to a jumpbox you operate. The jumpbox forwards a port to MySQL+FabSuite on their side. ([Stitch reverse SSH docs](https://www.stitchdata.com/docs/security/data-encryption/setting-up-reverse-ssh-tunnel), [GCP DMS reverse SSH](https://cloud.google.com/database-migration/docs/mysql/configure-connectivity-reverse-ssh-tunnel))

**Customer IT:** Install OpenSSH (built-in since Win10), run `autossh` as a service, share a public key. Outbound 22.

**Op burden / scale:** Medium-to-painful. You operate the jumpbox: 200 reverse-tunneled ports, key rotation, multi-tenant lateral-movement risk ([Securing reverse SSH tunnels](https://arlimus.github.io/articles/ssh.reverse.tunnel.security/)). Stitch only ships this on Premium — that's the operational signal.

**Verdict:** Functionally equivalent to Cloudflare Tunnel but you carry the ops burden Cloudflare absorbs for free. Skip.

### A5. Custom Windows connector agent

**How it works:** Ship a Windows MSI containing your C# .NET 8 binary. It runs as a Windows Service on a local cron, reads MySQL + FabSuite, POSTs the resulting JSON to a Cloudflare Worker over HTTPS. Data never leaves their network except as the final ~1.6 MB payload. Same model as Datadog Agent and Fivetran HVA. ([Datadog network model](https://docs.datadoghq.com/agent/configuration/network/), [Fivetran HVA](https://www.fivetran.com/resources/datasheets/high-volume-agent-architecture))

**Op burden:** Highest *initial* — code-signed MSI, CI for Windows builds, auto-update server, telemetry, customer-side debugging without RDP. Real work.

**Scale to 200:** Excellent once built — what Fivetran/Datadog/Airbyte do at scale.

**Why not for MVP:** User explicitly doesn't want it, and Cloudflare Tunnel gets 90% of the security posture for 10% of the engineering cost.

**Keep the door open:** If an enterprise customer ever insists data not traverse third-party infra, this is the answer. The C# binary already exists; flipping it from "runs on our side" to "runs on customer side" is a deployment change, not a rewrite.

### A6. Edge appliance

Skip. Appliance economics don't pencil at this ACV.

### A7. Public reverse proxy with mTLS

A strict variant of A1 — Caddy/nginx with client-cert auth in front of the services. Cloudflare Tunnel achieves the same posture out of the box and doesn't ask the customer to configure mTLS correctly. Skip in favor of A3.

---

## Section B — The "zero install" question, answered honestly

> Q: Is there ANY pattern where we connect to a customer's internal MySQL+API without (a) them installing something OR (b) them opening a firewall rule?

**A: No. Not in any serious architecture.**

The argument is symmetric. Three things can happen:

1. **Customer side reaches out** (Cloudflare Tunnel daemon, Datadog Agent, Fivetran HVA, autossh, our custom binary). Requires install.
2. **Our side reaches in** (direct connect, VPN, port-forward). Requires firewall change.
3. **A magic third option.** Does not exist. Anyone claiming otherwise is describing #1 or #2.

The "people have done this" claim is correct — what they did was #1 or #2.

### What real SaaS integrators actually do (verified)

| Vendor | Pattern | Customer-side burden |
|---|---|---|
| **Fivetran HVR / HVA** | Install agent (~135 MB, Windows service or Linux daemon) on/near source DB. Outbound to Fivetran hub. | Install agent. ([Fivetran HVA architecture](https://www.fivetran.com/resources/datasheets/high-volume-agent-architecture), [HVA connectors docs](https://fivetran.com/docs/connectors/databases/hva-connectors)) |
| **Stitch (Talend)** | Three options — public IP + allowlist, SSH tunnel, *reverse* SSH tunnel (Premium). | Either install something or open a port. ([Stitch reverse SSH](https://www.stitchdata.com/docs/security/data-encryption/setting-up-reverse-ssh-tunnel)) |
| **Airbyte Enterprise Flex / Hybrid** | "Lightweight worker containers installed inside your VPC or on-premises cluster… initiate outbound-only traffic." | Install agent. ([Airbyte hybrid control plane](https://airbyte.com/data-engineering-resources/hybrid-control-plane-architecture-cloud-orchestration), [Data plane flexibility](https://airbyte.com/data-engineering-resources/data-plane-flexibility-on-premises-cloud-or-hybrid-per-workload)) |
| **Hightouch / Census** | Direct connect (allowlist) OR SSH tunnel. Reverse-ETL tools have less on-prem footprint because their customers usually have cloud warehouses. | Open port or run SSH tunnel. ([Hightouch security model](https://hightouch.com/platform/reverse-etl)) |
| **Segment** | Cloud-to-cloud primarily; for on-prem destinations, customers run a self-hosted "Object API" or use a tunnel. | Same two options. |
| **MuleSoft** | Install Mule Runtime + Anypoint Runtime Manager Agent on customer hardware. Outbound to Anypoint. | Install agent. ([MuleSoft hybrid setup](https://medium.com/another-integration-blog/mulesoft-how-to-setup-a-platform-for-hybrid-deployment-option-for-a-customer-cd56e6c70dbd)) |
| **Boomi** | "Atom" runtime — the canonical example of an on-prem connector agent. | Install agent. ([Boomi Atom architecture](https://www.unitedtechno.com/boomi-vs-mulesoft-vs-workato-integration/)) |
| **Workato** | Cloud-first; "On-Prem Agent" for behind-firewall. | Install agent. |
| **Snowflake Snowpipe** | Designed around cloud storage; on-prem path requires customer to push to S3/Azure/GCS *or* run the Snowpipe Streaming SDK locally. | Push from customer side, requires outbound. ([Snowpipe ingestion](https://www.snowflake.com/en/product/features/data-ingestion/)) |
| **Datadog Agent** | Canonical outbound-only agent. "All communication is outbound." Outbound 443 to `*.datadoghq.com`. | Install agent. ([Datadog network](https://docs.datadoghq.com/agent/configuration/network/)) |

Pattern recognition: **every vendor that *seriously* targets on-prem ships an agent.** Vendors that don't ship an agent require an inbound firewall change. There is no third pattern.

### The honest recommendation to give the user

> "Zero install" is not on the menu in any architecture used by anyone serious. Cloudflare Tunnel is the closest thing — a single ~80MB Windows service, outbound-only, no firewall change, no inbound exposure. Frame it that way to customers and they will say yes. If a specific customer refuses any install, fall back to A1 (open MySQL with TLS + IP allowlist). If they refuse both, they cannot be a customer at this price point.

---

## Section C — Where the C# .NET 8 nightly job runs

Cloudflare Workers cannot run .NET. The 2k-LOC C# binary needs a .NET 8 host. Options ranked by fit.

### C0. Two architectures to consider first

Before picking a host, decide *which* component runs the C#:

- **Architecture α (recommended):** Cloudflare Worker (Cron Trigger) → spawns a Cloudflare Container running your .NET binary → container reads MySQL via Hyperdrive→Tunnel and POSTs FabSuite XML via the same Tunnel's HTTPS route → writes JSON to R2 / D1. Container scales to zero. ([Cron Container example](https://developers.cloudflare.com/containers/examples/cron/))
- **Architecture β (fallback):** External .NET host (Fly.io / Azure / etc.) on its own cron → connects to customer via Cloudflare Tunnel public hostname for FabSuite + Cloudflare Tunnel TCP route for MySQL → pushes results to a Cloudflare Worker over HTTPS → Worker writes to R2 / D1.

Architecture α is better if Cloudflare Containers handles .NET 8 cleanly. Architecture β is the fallback.

### C1. Cloudflare Containers (GA April 2026)

**Fit for .NET 8:** Any standard Docker image runs. Use `mcr.microsoft.com/dotnet/runtime:8.0` (Debian) or the Alpine variant. No .NET-specific support claim from Cloudflare because none is needed — it's just Linux containers.

**Scheduling:** Workers Cron Trigger → Worker → Durable Object → starts the container. ([Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Cron Container template](https://developers.cloudflare.com/containers/examples/cron/))

**Instance types:** lite (1/16 vCPU, 256 MiB) → standard-2 (1 vCPU, 6 GiB), up to 4 vCPU / 12 GiB custom. ([Limits](https://developers.cloudflare.com/containers/platform-details/limits/))

**Pricing (Workers Paid $5/mo includes):** 25 GiB-hours memory, 375 vCPU-minutes, 200 GB-hours disk. Overage: $0.000020/vCPU-sec, $0.0000025/GiB-sec. ([Pricing](https://developers.cloudflare.com/containers/pricing/))

**Cost math:** 10-min run on standard-1 (0.5 vCPU, 4 GiB), nightly. At 10 tenants: ~$3/mo over the $5 base. At 200 tenants: ~$60–80/mo. Negligible.

**Op simplicity:** Highest. One platform, one billing relationship, native D1/R2/KV/Hyperdrive/Tunnel integration, Wrangler deploy.

**Verdict:** **Recommended** if it works. Risk: .NET 8 container runtime quirks (glibc/ICU). Mitigation: validate one tenant in week 1 before committing.

### C2. Fly.io Machines + Cron Manager

**Fit:** Excellent. Docker-native, .NET 8 base images run untouched. [Cron Manager](https://fly.io/docs/blueprints/task-scheduling/) spins up ephemeral Machines per job; Machines also support native `schedule = "daily"`.

**Pricing:** `shared-cpu-1x@256mb` ≈ $0.0027/hr; 10-min run ≈ $0.0005. 200 tenants × 30 days = ~$3/month compute. ([Fly pricing](https://fly.io/pricing/))

**Verdict:** **Strongest fallback.** Pick if Cloudflare Containers proves brittle for .NET 8.

### C3. Azure Container Apps Jobs

First-class .NET 8 support; scheduled job triggers built in. Consumption pricing — first 180k vCPU-sec and 360k GiB-sec/month free per subscription, so our 200-tenant workload sits inside free tier. ([Jobs docs](https://learn.microsoft.com/en-us/azure/container-apps/jobs), [pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/))

**Verdict:** Strong if you're already in Azure or want Microsoft .NET vendor support.

### C4. AWS Fargate + EventBridge Scheduler

ECS Fargate + EventBridge cron is the canonical AWS pattern. ([ECS scheduled tasks](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/scheduled_tasks-event-bridge.html)) ~$30/mo at 200 tenants. More moving parts than Fly. Pick if AWS is your default.

### C5. Render / Railway / Northflank

All handle scheduled .NET 8 containers. Render has native cron jobs, Railway uses service-level crontab, Northflank treats scheduled jobs as primitives. ([Northflank alternatives roundup](https://northflank.com/blog/top-cloudflare-containers-alternatives)) No advantage over Fly. Skip unless you already use one.

### C6. Hetzner / OVH VPS

€4.5/mo CX22 + systemd timer. Cheapest per dollar; you patch the OS. Skip unless cost dominates time.

### C7. GitHub Actions

Cron workflow runs `dotnet run` on a hosted runner. Free tier covers it but runner IPs are wide and not allowlist-friendly. Quirky — a CI tool used as a scheduler. Not recommended as primary.

### C summary table

| Host | .NET 8 fit | Cron native | Cost @ 10 tenants | Cost @ 200 tenants | Op complexity | CF integration |
|---|---|---|---|---|---|---|
| **Cloudflare Containers** | Good (just Linux) | Via Workers Cron | ~$5/mo | ~$60–80/mo | Lowest | Native |
| **Fly.io Machines** | Excellent | Yes (Cron Manager) | ~$2/mo | ~$5–10/mo | Low | Via HTTPS |
| **Azure Container Apps Jobs** | First-class | Yes | $0 (free tier) | $0–10/mo | Low | Via HTTPS |
| **AWS Fargate + EventBridge** | Good | Yes | ~$2/mo | ~$30/mo | Medium | Via HTTPS |
| **Render / Railway / Northflank** | Good | Yes | $5–10/mo | $30–60/mo | Low | Via HTTPS |
| **Hetzner VPS** | Good | systemd timer | €5/mo flat | €5/mo flat | Highest (you patch) | Via HTTPS |
| **GitHub Actions** | Good | Yes (workflow_dispatch + schedule) | $0 free tier | risk overage | Medium | Via HTTPS |

---

## Section D — How real SaaS integrators do it (cross-check)

Already covered in Section B's table, but stepping back: every vendor in the integration / observability / data-ingest space ships either an agent or requires a firewall change. The market has not invented a third option in 15+ years of trying. The "magic" outbound-from-cloud-to-on-prem-without-anything-on-prem doesn't exist because of basic IP routing — packets cannot reach a private RFC1918 address from the internet without something on the inside accepting or initiating the connection.

The most relevant precedent for our case is **Datadog Agent** ([architecture docs](https://docs.datadoghq.com/agent/architecture/)), because Datadog operates at hundreds of thousands of customers each running an outbound-only agent on customer hardware, with auto-update and telemetry. That's the proof point that the Cloudflare-Tunnel-on-Windows pattern scales to 200+ tenants. We're not building anything Datadog hasn't normalized.

---

## Section E — Recommended path

### Primary path (MVP, 5–10 customers)

**Cloudflare Tunnel (`cloudflared`) installed as a Windows service on the customer's PowerFab host, plus Cloudflare Containers running the existing .NET 8 binary on a Workers Cron Trigger.**

Why:
- Cloudflare Tunnel is the lightest possible "install something" option. Outbound 443 only, no inbound firewall change, sells to small-fab IT in one sentence: "single Windows service, no inbound ports, runs alongside PowerFab."
- Cloudflare Containers + Workers Cron lets the existing C# binary run unchanged in the same control plane as the rest of the stack (Pages, Workers, D1, R2, KV, Hyperdrive). One billing relationship, one set of secrets, one deploy story.
- Costs are negligible at MVP scale (~$5–10/mo all-in over the $5 Workers Paid base).

### Secondary path (one customer refuses install)

**Public expose with TLS + IP allowlist** (Section A1). Customer opens MySQL on TCP 3307 with `require_secure_transport=ON` and a CA-signed cert; FabSuite over HTTPS only; both allowlisted to a small set of pinned cloud egress IPs. ([MySQL secure deployment](https://dev.mysql.com/doc/mysql-secure-deployment-guide/5.7/en/secure-deployment-secure-connections.html))

If they refuse both: they're not a fit for the product at this ACV.

### Long-term path (200 tenants)

**Same primary path scales fine.** 200 Cloudflare Tunnels is uneventful for Cloudflare. 200 nightly Container runs is well within the per-account concurrency limits. The only operational addition is *fleet management for `cloudflared` itself* — keeping the Windows service updated. Cloudflare publishes signed MSIs and supports an auto-update flag; in practice, plan for a quarterly "click yes on the update" message in the customer portal, or ship a tiny PowerShell script that runs `winget upgrade Cloudflare.cloudflared` on a schedule.

If a specific enterprise customer demands "data must not traverse Cloudflare," fall back to Section A5 — package the C# binary as a Windows MSI, run it customer-side, push results outbound. The C# code is the same; only the host changes.

### Where the C# job runs (decision)

**Cloudflare Containers** for the primary architecture. Validate in week 1 with one tenant; if .NET 8 has any container-runtime issues you can't debug in a day, **fall back to Fly.io Machines + Cron Manager** as Architecture β. Both options are cheap at MVP scale; the decision is reversible in days, not weeks.

### Per-tenant onboarding checklist (what customer IT does)

1. **Run a signed PowerShell one-liner** that downloads `cloudflared.msi`, installs it as a Windows service, and registers it with the tenant-specific tunnel token we generate.
2. **Confirm outbound 443** from the PowerFab host can reach `*.cloudflare.com` (already true for ~100% of business firewalls).
3. **Create a read-only MySQL user** scoped to the PowerFab database, share credentials via the onboarding portal.
4. **Create a FabSuite API user** with the same minimum permissions, share credentials via the onboarding portal.
5. **Verify a test pull** from the dashboard's "Run Sync Now" button. If JSON arrives in our R2 bucket, onboarding is done.

Everything else — tunnel ID provisioning, Hyperdrive config, Worker bindings, Container deployment, Access service tokens — is on our side, scripted, idempotent.

### One more honest note on the C# code

The user said "rewriting it to TypeScript is possible but real work; user prefers to keep it." Agreed — keep it. 2k LOC of working .NET 8 that already authenticates with FabSuite and posts XML envelopes is *exactly* the code you don't gold-plate. The architectural decisions above are explicitly designed to let that binary run unchanged, on either Cloudflare Containers or Fly.io. The day a TypeScript rewrite makes sense is the day you outgrow .NET-specific quirks; that day is not in your near future.

---

## Key references

Cloudflare: [Tunnel](https://developers.cloudflare.com/tunnel/) · [Tunnel Windows service](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/windows/) · [Hyperdrive private DB via Tunnel](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database/) · [Workers VPC private DB changelog](https://developers.cloudflare.com/changelog/post/2026-04-29-hyperdrive-vpc-private-databases/) · [MySQL Tunnel tutorial](https://developers.cloudflare.com/cloudflare-one/tutorials/mysql-network-policy/) · [Worker→Tunnel→MySQL example](https://github.com/brettscott/cloudflare-worker-tunnel-mysql-example) · [Containers GA (Apr 2026)](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/) · [Containers pricing](https://developers.cloudflare.com/containers/pricing/) · [Containers limits](https://developers.cloudflare.com/containers/platform-details/limits/) · [Cron container example](https://developers.cloudflare.com/containers/examples/cron/) · [Workers Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

Industry precedent: [Fivetran HVA datasheet](https://www.fivetran.com/resources/datasheets/high-volume-agent-architecture) · [Stitch reverse SSH](https://www.stitchdata.com/docs/security/data-encryption/setting-up-reverse-ssh-tunnel) · [Airbyte hybrid control plane](https://airbyte.com/data-engineering-resources/hybrid-control-plane-architecture-cloud-orchestration) · [MuleSoft hybrid setup](https://medium.com/another-integration-blog/mulesoft-how-to-setup-a-platform-for-hybrid-deployment-option-for-a-customer-cd56e6c70dbd) · [Datadog network model](https://docs.datadoghq.com/agent/configuration/network/)

Compute / scheduling: [Fly task scheduling](https://fly.io/docs/blueprints/task-scheduling/) · [Fly pricing](https://fly.io/pricing/) · [Azure Container Apps Jobs](https://learn.microsoft.com/en-us/azure/container-apps/jobs) · [ACA pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/) · [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/) · [ECS scheduled tasks](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/scheduled_tasks-event-bridge.html) · [Northflank alternatives roundup](https://northflank.com/blog/top-cloudflare-containers-alternatives)

Networking / security: [MySQL 8.4 encrypted connections](https://dev.mysql.com/doc/refman/8.4/en/using-encrypted-connections.html) · [MySQL secure deployment](https://dev.mysql.com/doc/mysql-secure-deployment-guide/5.7/en/secure-deployment-secure-connections.html) · [Tailscale vs Cloudflare Access](https://tailscale.com/compare/cloudflare-access) · [Awesome tunneling list](https://github.com/anderspitman/awesome-tunneling) · [Securing reverse SSH tunnels](https://arlimus.github.io/articles/ssh.reverse.tunnel.security/) · [SASE vs site-to-site VPN](https://sase.cloud/guides/sase-vs-vpn) · [Palo Alto S2S overview](https://www.paloaltonetworks.com/cyberpedia/what-is-a-site-to-site-vpn)
