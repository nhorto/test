# 06 — Customer Data: How the Gateway Reads from Their Database

> **Prerequisites:** read `00-start-here.md` and `05-cloudflare-architecture.md` (which is now the Tauri architecture doc — see the note at the top of that file).

> **By the end of this doc you will know:**
> - Why the "how do we get data out of the customer's building?" problem from the old plan **no longer exists** in the new architecture.
> - What the customer's database typically looks like (SQL Server, MySQL, FabSuite, etc.) and how the gateway connects to it.
> - The exact GRANT / role lines you'll ask the customer's DBA for, and why every word of them matters.
> - What "read-only, never write" looks like in practice.
> - Five concrete things not to do.

---

## 1. The setup, in plain English

Each PowerFab Dashboard customer is a steel-fabrication shop. Inside their building, they have:

- **A Windows server.** Could be a real metal box in a closet, could be a VM. Doesn't matter.
- **A database** running on that server. This is where Tekla PowerFab — the desktop software the shop uses to run their business — stores everything. Most installs are **SQL Server** or **MySQL** depending on the customer's setup.
- **A FabSuite XML API** also running on or near that server. FabSuite is part of the same software family. It exposes some of the same data over an HTTP endpoint that returns XML.

The customer's network is behind a firewall, like every business network. By default, nothing on the public internet can reach into that database or that XML API. That's normal and correct. We do not want it any other way.

### How this used to be a problem (and isn't anymore)

In the old plan, our app ran on Cloudflare — out on the public internet. That meant we had a geography problem: data had to travel from inside the customer's building, across their firewall, all the way to Cloudflare. We considered tunnels, agents, port forwarding, mTLS, the works.

In the **new plan**, the dashboard runs on the customer's own laptops. The gateway runs on a machine inside the customer's network. The database is also inside the customer's network.

```
                 INSIDE THE CUSTOMER'S BUILDING
   ┌────────────────────────────────────────────────────────┐
   │                                                        │
   │   Employee laptop                                      │
   │      |  HTTP (LAN)                                     │
   │      v                                                 │
   │   Gateway machine                                      │
   │      |  SQL (LAN)                                      │
   │      v                                                 │
   │   Database / ERP server                                │
   │                                                        │
   │   <-- firewall stays closed to the internet -->        │
   └────────────────────────────────────────────────────────┘
```

There's no crossing of the firewall. Data goes from one machine on the customer's LAN to another. The customer doesn't have to open any inbound port to the internet. We don't have to think about tunnels.

The "fundamental question" — *who initiates the connection?* — has a boring answer now: **the gateway does, from inside their own network.** It's not even a question.

What this doc covers is the *short hop* the gateway makes: gateway → database. Less dramatic than the old "cross the internet" problem, but still has a few details worth getting right.

---

## 2. What the customer's database actually looks like

Three flavors come up:

### 2.1 SQL Server (Tekla PowerFab default)

Most shops run **Microsoft SQL Server**. The default install of Tekla PowerFab uses SQL Server Express or Standard. Connection string format:

```
Server=POWERFAB-SQL\SQLEXPRESS;Database=PowerFab;User Id=dashboard;Password=...
```

Notes:
- The instance name `\SQLEXPRESS` is common but not universal. Some shops have a default instance and no backslash.
- Port is `1433` by default, sometimes blocked even on the LAN.
- Windows Authentication ("integrated security") is also common — the gateway service account is granted access instead of a SQL login.

### 2.2 MySQL

Some shops are on **MySQL**. Connection string format:

```
Server=POWERFAB-MYSQL;Port=3306;Database=powerfab;User=dashboard;Password=...
```

Notes:
- Port `3306` by default.
- TLS is optional but should be enabled even on the LAN if the DB is on a different machine from the gateway.

### 2.3 The FabSuite XML API (parallel surface)

In addition to the raw database, Tekla PowerFab exposes a FabSuite XML HTTP API. It returns the same data the database has, just shaped differently. Some metrics are easier to compute from the API; others are easier from raw SQL.

A typical call looks like:

```
GET http://powerfab-server:8000/api/parts.xml
Authorization: Basic <base64 of user:pass>
```

We'll probably read from both, depending on the metric. The gateway is the right place to translate between the two sources.

---

## 3. The exact permissions the gateway needs (and only these)

You will ask the customer's DBA (or IT person if there's no DBA) to create a dedicated database account for the gateway. **Not the existing PowerFab account.** A new one, with read-only access to exactly the tables we read from.

### 3.1 SQL Server version

```sql
-- 1. Create the login
CREATE LOGIN dashboard_ro WITH PASSWORD = 'long-random-string-here';

-- 2. Create a user in the PowerFab database
USE PowerFab;
CREATE USER dashboard_ro FOR LOGIN dashboard_ro;

-- 3. Grant SELECT only, on the schema where the tables live
GRANT SELECT ON SCHEMA::dbo TO dashboard_ro;

-- 4. Explicitly DENY everything else (defense in depth)
DENY INSERT, UPDATE, DELETE, ALTER, EXECUTE ON SCHEMA::dbo TO dashboard_ro;
```

Every word matters:

- **`SELECT only`** — the dashboard is read-only. It must not be able to change anything.
- **`SCHEMA::dbo`** — limits permissions to one schema. Don't grant database-wide.
- **`DENY INSERT, UPDATE, DELETE, ALTER, EXECUTE`** — even if a future role grants permissions, the explicit deny wins. A "no" is louder than a "yes."

If the DBA pushes back on schema-wide SELECT and wants table-level, that's even better — list the tables we actually read. Slower onboarding but safer.

### 3.2 MySQL version

```sql
-- 1. Create the user
CREATE USER 'dashboard_ro'@'%' IDENTIFIED BY 'long-random-string-here';

-- 2. Grant SELECT only on the specific database
GRANT SELECT ON powerfab.* TO 'dashboard_ro'@'%';

-- 3. Restrict the host to the gateway's IP (better!)
-- (Replace 10.0.5.20 with the gateway machine's LAN IP.)
DROP USER 'dashboard_ro'@'%';
CREATE USER 'dashboard_ro'@'10.0.5.20' IDENTIFIED BY 'long-random-string-here';
GRANT SELECT ON powerfab.* TO 'dashboard_ro'@'10.0.5.20';

FLUSH PRIVILEGES;
```

Notes:
- Using `'dashboard_ro'@'10.0.5.20'` instead of `@'%'` means the credentials are useless from any machine other than the gateway. That's a meaningful extra protection if someone exfiltrates the password.

### 3.3 What to do if the DBA insists on the existing PowerFab account

Push back. The existing account has write permissions because the ERP needs to write. Sharing it with the dashboard means a bug in the dashboard could in principle modify production data. A dedicated read-only account costs the DBA 30 seconds and removes that whole category of risk.

If they absolutely refuse, document it in the customer's onboarding file (doc 11) and treat the deployment with extra care. But "we can't have a read-only account" is not normal — it's usually just unfamiliarity, not a hard policy.

---

## 4. What the gateway does with that connection

A pseudo-code sketch of the gateway, in Python (we'll discuss language tradeoffs in doc 07):

```python
# gateway/main.py
from fastapi import FastAPI, Depends, HTTPException, Header
import sqlalchemy as sa

app = FastAPI()
DB_URL = os.environ["DATABASE_URL"]            # from gateway config
BEARER = os.environ["GATEWAY_BEARER_TOKEN"]    # shared secret with the desktop apps

engine = sa.create_engine(DB_URL, pool_size=5, max_overflow=2)

def check_auth(authorization: str = Header(...)):
    if authorization != f"Bearer {BEARER}":
        raise HTTPException(401, "unauthorized")

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

Three pieces to notice:

1. **One SQL query per metric.** No general "run this SQL" endpoint. The gateway has one route per metric, with the SQL baked in. This is what makes it safe to expose to the laptops — they can't ask for arbitrary data, only the predefined metrics.
2. **Connection pooling.** `engine` keeps a small pool of DB connections open. Without this, every request opens a new connection, which is slow and stresses the DB.
3. **Bearer-token auth on every call.** The token is shared between the gateway and the license keys (so each tenant's laptops have it). If someone on the LAN tries to call the gateway without the token, they get a 401.

We'll go deeper on the gateway's structure in doc 09 (data fetching from the React side) and doc 07 (what language to write it in).

---

## 5. Configuration: where the DB credentials actually live

The gateway needs to know:

- The DB connection string
- The bearer token expected from desktop apps
- (Optionally) Which port to listen on, log level, etc.

These live in a config file or environment variables on the gateway machine. Concrete examples:

### 5.1 Environment-variable style (`/etc/gateway.env` or systemd Environment lines)

```bash
DATABASE_URL=mssql+pyodbc://dashboard_ro:s3cr3t@powerfab-sql/PowerFab
GATEWAY_BEARER_TOKEN=very-long-random-string-shared-with-license-keys
LISTEN_ADDR=0.0.0.0:8080
LOG_LEVEL=info
```

### 5.2 YAML or TOML config file

```yaml
# /etc/gateway/config.yaml
database:
  driver: mssql
  host: powerfab-sql
  database: PowerFab
  username: dashboard_ro
  password_env: GATEWAY_DB_PASSWORD
auth:
  bearer_token_env: GATEWAY_BEARER_TOKEN
listen:
  addr: 0.0.0.0
  port: 8080
```

Either way, the actual password should be in an env var, not in a file on disk in plaintext. (On Windows, use Windows Credentials Manager or DPAPI; on Linux, set the env var via systemd's `EnvironmentFile=` directive with `chmod 600`.)

The gateway loads its config on startup and holds it in memory. No call out to anywhere else.

---

## 6. What we read (table sketch)

We don't need every table in the ERP. We need:

- Job / project tables (for Estimating, Project Management metrics)
- Time entries (for Time metrics)
- Parts / inventory (for Inventory, Purchasing)
- Inspections (for Inspections metrics — when the tenant has them)
- Production / shipment data (for Production Control)

The exact table names vary slightly between Tekla PowerFab versions. Onboarding (doc 11) includes a step to confirm the table list with the customer's DBA, and to write the per-metric queries against that specific install.

A useful onboarding tool: a `test-connection.py` script the customer's IT can run from the gateway machine to confirm the credentials work and the expected tables are visible:

```python
import os, sqlalchemy as sa
engine = sa.create_engine(os.environ["DATABASE_URL"])
with engine.connect() as conn:
    for tbl in ["JOBS", "TIME_ENTRIES", "PARTS", "INSPECTIONS"]:
        try:
            n = conn.execute(sa.text(f"SELECT COUNT(*) FROM {tbl}")).scalar()
            print(f"OK {tbl}: {n} rows")
        except Exception as e:
            print(f"X  {tbl}: {e}")
```

Run on the gateway machine, output goes to the onboarding ticket.

---

## 7. Five things not to do

### 7.1 Don't connect to the DB from the laptops

This is anti-pattern §7.1 in doc 05 said another way. The desktop apps must NEVER hold the DB connection string. Always go through the gateway.

### 7.2 Don't use the customer's existing PowerFab DB account

It has write permissions. The gateway should never have write access to anything.

### 7.3 Don't store the DB password in plaintext in a file

Put it in an environment variable read at startup. On Windows, prefer Windows Credentials Manager / DPAPI. On Linux, restrict the env file with `chmod 600` and a systemd `EnvironmentFile=`.

### 7.4 Don't write a "raw SQL" endpoint

It's tempting to make a `/query` endpoint that takes a SQL string from the laptop. Don't. That's a database-on-the-internet pattern just dressed up as JSON. Every metric is a separate endpoint with a fixed query. No exceptions.

### 7.5 Don't skip TLS just because it's "all on the LAN"

If the gateway and the DB are on different machines on the LAN, the SQL traffic between them is on the wire. A misconfigured switch, a captured laptop, a guest WiFi accidentally on the same VLAN — any of these makes "LAN traffic" not so private. Enable TLS on the DB connection where possible. It's free; the customer's DBA can flip it on.

---

## 8. By the end of this doc you should know

- Why the old "data crossing the firewall to Cloudflare" problem no longer exists.
- The shape of the customer's database — typically SQL Server or MySQL, plus a FabSuite XML API.
- The exact GRANT lines for a read-only gateway account, on SQL Server and MySQL.
- Why the gateway has one endpoint per metric, not a generic SQL endpoint.
- Where the gateway's config lives, and why the password is in an env var not a file.
- The five concrete don'ts: no DB creds in the app, no shared PowerFab account, no plaintext passwords, no raw-SQL endpoint, no skipping TLS.

---

**Next:** [`07-nightly-data-pipeline.md`](./07-nightly-data-pipeline.md) — what the old nightly pipeline did, why we're killing it in the new architecture, and what to do with the C# .NET 8 binary that used to do the heavy lifting.
