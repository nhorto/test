# 06 — Where Does `PowerFabDataGen.exe` Run? (Compute Host Research, May 2026)

## 1. Cloudflare Containers — 2026 Status

### GA status
Cloudflare Containers and the Sandbox SDK reached **General Availability on April 13, 2026**. The Workers Paid plan ($5/month) is required. Public beta opened mid-2025; February 2026 brought a 15x increase in concurrency limits; April 2026 was full GA with secure credential injection, snapshot recovery, and the active-CPU pricing model that matters for nightly batch workloads.

### .NET 8 support
There is no special "language runtime" abstraction. Containers run an arbitrary OCI image — whatever Docker can build, Containers can run. The Microsoft `mcr.microsoft.com/dotnet/runtime:8.0` (or `aspnet:8.0`) base image works the same as it does anywhere else. **Caveat:** Linux-only. If `PowerFabDataGen.exe` is currently a Windows-targeted .NET 8 binary, it must be published as `linux-x64` (`dotnet publish -r linux-x64`). If it has any P/Invoke into Win32 DLLs, that has to go. Self-contained publish with trimming is recommended to keep image size down.

### Limits and instance types
Standard sizes top out at the `standard-4` instance: **4 vCPU, 12 GiB memory, 20 GB disk**. Custom instance types are available — you specify vCPU/memory/disk independently with a 1 vCPU minimum. Account-level concurrency: ~1,500 vCPU, 6 TiB memory, 30 TB disk total. For a 1.6 MB output, ~5–10 minute job, the `standard-1` (1 vCPU / 4 GiB / 8 GB) is the natural fit.

### Cold start
**1–3 seconds typical for lightweight images, 3–5+ seconds for heavier ones.** A self-contained .NET 8 image with the ASP.NET runtime layer falls in the 3–5s range. For a nightly 5–10 minute job, cold start is rounding error.

### Billing model
- **Active CPU**: $0.000020 per vCPU-second (only while CPU is doing work, billed per 10ms).
- **Memory**: $0.0000025 per GiB-second (provisioned, while running).
- **Disk**: provisioned, while running.
- Workers Standard plan includes 375 vCPU-minutes and 25 GiB-hours of container time per month.
- **Scale-to-zero is the default.** When idle past timeout, the instance sleeps and billing stops.

### Cron invocation
Pattern: a Worker with a `[triggers]` cron expression in `wrangler.toml` plus a `[[containers]]` binding. The `scheduled()` handler does:

```
let c = getContainer(env.DATAGEN);
await c.start({ envVars: { TENANT_ID: "acme" } });
```

The Container runs to completion, exits, and sleeps. Cron runs in UTC.

### Region availability
**Anycast-only — you do not pick a region.** Cloudflare provisions across 320+ cities and routes to the nearest healthy pre-warmed slot. For a backend job that talks to a customer's MySQL, this is mostly fine, but it does mean the egress IP a customer firewalls is unstable. **This is the first real gotcha for Nick:** customers who want to allow-list a source IP for MySQL access cannot do so against Container egress. Mitigation is a Cloudflare Tunnel.

### Build pipeline
- `wrangler containers build --push` from local dev or GitHub Actions.
- Cloudflare hosts its own registry at `registry.cloudflare.com` (auto-integrated).
- Docker Hub and Amazon ECR are also supported as image sources, including private images.
- GitHub Actions → `wrangler deploy` is the canonical CI path.

### Networking
- Outbound TCP including MySQL (3306) **works**. Cloudflare's `connect()` API supports raw TCP and the MySQL wire protocol.
- No special egress restrictions for arbitrary outbound TCP from a Container.
- For customers who don't expose MySQL publicly, **Cloudflare Tunnel + cloudflared on the customer's network** is the right pattern.

### Observability
- `wrangler tail` for live logs.
- Logs route into Workers Logs (Logpush available to R2/S3/etc.).
- Per-container CPU, memory, requests visible in Cloudflare dashboard.
- SSH support added at GA for live debugging.

### Pricing math for Nick's workload
Assume 1 vCPU, 1 GiB, 8 minutes per tenant per night, full CPU pegged:

- 10 tenants: 10 × 480s × $0.000020 = **$0.096/night CPU** + ~$0.012 memory ≈ **$0.11/night → $3.30/month**, comfortably inside Workers Standard included usage.
- 200 tenants: 200 × 480s = 96,000 CPU-seconds = **~$1.92/night CPU** + memory ≈ **~$2.30/night → ~$70/month**. Still trivial.

### Known gotchas
- Linux-only — Windows .NET binaries won't run.
- No region pinning — egress IP not stable for customer firewall allow-lists.
- 4 vCPU / 12 GiB ceiling per instance — fine for this workload.
- Workers Paid plan required ($5/mo floor).
- Logs are Cloudflare-flavored, not stdout-to-tail-file — observability mental model is different from a VM.
- Image pulls on cold provisioning add to first-of-the-night latency in a fresh region.

---

## 2. Fly.io Machines (primary fallback)

- **Per-second billing, scale-to-zero supported.** Stopped Machines bill nothing for CPU/RAM (volumes still cost $0.15/GB/mo).
- **.NET 8 first-class** — same Linux container story, no caveats. `fly launch` detects .NET projects.
- **Wake latency 1–3 seconds** for an HTTP-trigger wake; image-pull-on-first-start is longer.
- Pricing 2026: `shared-cpu-1x` / 256 MB ≈ $1.94/mo always-on; per-second rate makes a 5–10 min nightly job pennies.
- **Cron invocation from Cloudflare Worker**: HTTP request to a Fly app URL wakes the Machine; Machine runs to completion and stops itself. Or use the Fly Machines REST API directly from the Worker.
- Persistent volumes available (region-pinned, $0.15/GB/mo).
- **Region pinning is supported** (e.g., `iad`, `ord`, `lhr`) — meaningful if Nick wants a stable egress region or static IP for customer firewall allow-listing. This is Fly's main edge over Cloudflare Containers for the firewall-allow-list customer case.
- Outbound TCP to MySQL: zero special config.

**When Fly wins:** customers demand a stable egress IP for their MySQL firewall, or Containers turns out to have an unforeseen .NET regression.

---

## 3. Azure Container Apps Jobs

- **Job mode** (not the "always-on Container App" mode) is exactly the right shape: scheduled or manually-triggered, runs to completion, billed only while running.
- **Scheduled trigger built in** — cron expression on the Job resource. Or invoke from a Worker via Azure REST API.
- **Pricing**: Consumption plan, active rate only while executing. Free tier: 180,000 vCPU-seconds + 360,000 GiB-seconds per subscription per month — at 10 tenants it's effectively free.
- **.NET-friendly** — Microsoft heritage, every .NET sample lands here first.
- **Identity**: Managed Identity / Workload Identity for accessing other Azure resources; for customer MySQL, plain secrets in the Container App's secrets store.
- Outbound TCP MySQL: works.

**When ACA Jobs wins:** Nick wants the most "boring, mature, Microsoft-blessed .NET hosting" option, or any tenant requires Azure for compliance reasons. Downside: a second cloud account to manage outside Cloudflare.

---

## 4. AWS Fargate + EventBridge Scheduler

- ECS task definition, Fargate launch type, EventBridge Scheduler rule.
- Pricing 2026: $0.04048 per vCPU-hour + $0.004445 per GB-hour. 1 minute minimum charge.
- 200 tenants × 8 min × 1 vCPU + 1 GiB ≈ ~$3/night = ~$90/month (similar to others, but with **NAT Gateway tax** at $0.045/GB if private subnet — a known silent budget killer).
- Cold start: 30–90 seconds for image pull + task startup is typical. Worst of the bunch.
- Setup effort: high. VPC, subnets, IAM roles, task definition, EventBridge rule, ECR repo. Multi-day learning curve from zero.
- **When Fargate wins:** existing AWS shop, or hard requirement to colocate with an RDS instance in the same VPC. **For Nick (zero AWS context, Cloudflare-anchored stack): never.**

---

## 5. GitHub Actions Scheduled Workflow

- Free for public repos; **2,000 min/month** for private on free plan.
- Cron syntax, **5-minute minimum interval**, runs in UTC.
- **6-hour max per job.**
- **No guaranteed timing** — 10–30 minute delays at peak are documented and routine. Auto-disables after 60 days of repo inactivity.
- .NET 8 supported on the runners.
- **Connectivity to customer on-prem MySQL is the killer**: GH-hosted runners use a wide rotating IP pool. The only viable patterns are (a) customer exposes MySQL publicly with allow-list of GH IP ranges (sketchy), (b) Tailscale/WireGuard sidecar in the workflow, or (c) Cloudflare Tunnel client started in-job. All workable, all annoying.

**Brutal honesty:** Fine for the first 1–3 tenants as a proof of concept. **Not appropriate at 50+ tenants.** Schedule jitter alone makes "every tenant by 6am" hard to guarantee.

---

## 6. Self-hosted VPS (Hetzner / Linode)

- Hetzner CX22: 2 vCPU / 4 GB RAM / **~€3.79/month** flat. Cron via `crontab -e`. .NET 8 installs from Microsoft's Debian repos in three commands.
- Single static IP (good for customer firewall allow-listing — meaningfully better than Containers).
- **Ops burden:** SSH key management, OS patching, log rotation, monitoring, backup. Single point of failure. If the disk fills, every tenant breaks.
- **Security implications:** one box holds *every customer's* MySQL credentials. A single compromise = total tenant data exposure. This is the main reason it's a duct-tape option, not a destination.

**When VPS wins:** Week 1 MVP, before Cloudflare Containers is wired up, or as a fallback if Containers turns out broken. Move off it before tenant #5.

---

## 7. Comparison Table

| Option | 2026 status | .NET 8 fit | Setup effort | Per-run cost @ 10 tenants | Per-run cost @ 200 tenants | Customer-DB connectivity | Recommendation |
|---|---|---|---|---|---|---|---|
| Cloudflare Containers | GA (Apr 2026) | Linux-only, fine | Low (one Worker + Dockerfile) | ~$0 (in free quota) | ~$70/mo | TCP fine; **no stable egress IP** without Tunnel | **Primary** |
| Fly.io Machines | GA (mature) | First-class | Low-medium | ~$0–$2/mo | ~$50–$80/mo | TCP fine, **stable region IP** | **Primary fallback** |
| Azure Container Apps Jobs | GA | First-class | Medium | ~$0 (free tier) | ~$60–$100/mo | TCP fine, Azure secrets | Strong fallback if MS-aligned |
| AWS Fargate + EventBridge | GA | Fine | **High** | ~$10/mo | ~$90/mo + NAT egress | TCP fine in VPC | Skip — bad fit for solo dev |
| GitHub Actions cron | GA | Fine | Very low | $0 | Strains free minutes; jitter | **Hard** without Tunnel | MVP only, not for scale |
| Hetzner VPS | Mature | Fine | Low (but ongoing ops) | ~$4/mo flat | ~$10/mo flat | **Best** (static IP) | Duct-tape MVP only |

---

## 8. Recommendation

**Confirm: Cloudflare Containers stays the primary.** GA in April 2026 closes the last "is this real?" question. Active-CPU pricing makes a 5–10 min nightly job effectively free at current scale and ~$70/mo at the 200-tenant horizon. The Worker-cron-to-Container-binding pattern is exactly the integration shape Nick wants given the Cloudflare-anchored stack.

**Clear fallback: Fly.io Machines.** Same operational model (container, scale-to-zero, per-second billing), but with **region pinning and a stable egress IP** — which becomes the deciding factor for any customer that insists on firewalling MySQL by source IP rather than running a Cloudflare Tunnel.

### Concrete switch criteria
Switch off Cloudflare Containers to Fly.io if any one of the following holds:

1. **Cold start on the production .NET 8 image consistently exceeds 30 seconds** in measured runs.
2. **A customer contractually requires a static egress IP** for their MySQL firewall and refuses to install cloudflared on their network.
3. **Per-run cost exceeds ~$0.50/tenant/night** at any tenant count.
4. **A blocking .NET 8 issue surfaces on the Containers Linux runtime** that doesn't exist on Fly.

Azure Container Apps Jobs is the **second** fallback if Nick ever needs a Microsoft-aligned compliance story for a specific tenant. AWS Fargate, GitHub Actions, and self-hosted VPS are explicitly **not** recommended as production destinations at any tenant scale Nick is targeting.
