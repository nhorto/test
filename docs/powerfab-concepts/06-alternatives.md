# 06 — Roads not taken

For each option we considered and rejected, this file explains:

- What the option is, in plain language.
- What's attractive about it.
- Why we didn't pick it.

The goal isn't to dunk on the alternatives — most of them are reasonable in some other universe. The goal is to make sure you'd give the same answers if a colleague asked "why didn't you do X instead?" six months from now.

The options, in roughly the order they came up:

1. Stay hosted (the original SaaS plan)
2. Customer-hosted server, thin client per user
3. Pure C# desktop app (WPF / WinForms / MAUI / Avalonia)
4. Pure web app rewrite where the user installs nothing
5. Rewriting everything in TypeScript / Node.js
6. Direct-to-database client with no API at all
7. Tauri instead of Electron (we may revisit)
8. Bundling the Tekla DLL ourselves

## 1. Stay hosted (the original SaaS plan)

**What it is.** You run a web service somewhere — AWS, Azure, a dedicated machine — that holds dashboard accounts. Each customer's user logs into your website. Your server reaches across the internet to read their PowerFab data and shows it back in a browser tab.

**What's attractive.**

- Familiar shape. Most modern B2B software works this way.
- One codebase, deployed once; everyone gets updates instantly.
- No installer, no Windows-only constraint.

**Why we didn't pick it.**

- **PowerFab is on the customer's internal network.** For your hosted server to talk to it, the customer would have to open a hole in their firewall (or set up a VPN, or expose SQL Server to the internet, or run a "connector" agent on their side). All of these are real projects per customer, often blocked by IT.
- **The Tekla DLL doesn't run on Linux servers.** Your hosted server would have to be a Windows machine — fine but unusual, and you still don't have anywhere to install PowerFab on it (it's not licensed for that).
- **You'd own customer credentials.** Storing PowerFab usernames and passwords on your servers is a security and compliance liability you don't currently have. With the local design, you never see them.

This option becomes more attractive if Tekla ever publishes a real web API. Until then, it's blocked by the same DLL problem that shaped the whole architecture.

## 2. Customer-hosted server, thin client per user

**What it is.** Each customer runs one small server somewhere on their network — could be an old desktop in the office. That server has the dashboard backend, the C# code, the database connection. Their 10 employees open a browser and point it at `https://powerfab.acmesteel.local`. They log in there, the server does the work.

**What's attractive.**

- The DLL constraint is fine — the customer's server is also a Windows machine on their network.
- Centralized: updates ship in one place, all 10 users get them.
- Adding cross-user features later (shared saved views, scheduled reports, audit logs, alerts) is straightforward — you have a central place to put state.

**Why we didn't pick it (for now).**

- **The customer has to install and maintain a server.** Even a small one. That's a real ask — they need a machine to dedicate, a DNS entry, possibly an SSL certificate, an IT person who understands "service that runs in the background." For a steel fabricator with 10 dashboard users, this is overkill.
- **You're recreating PowerFab's user system in front of PowerFab.** The server would have to either reuse PowerFab credentials (extra plumbing) or have its own — defeating the "they just sign in like PowerFab" UX you asked for.
- **It's strictly more moving parts than the thick-client design.** We can always add this later as an option for customers who want it.

This is the next design to consider if a customer says "we want all 10 users to share state across machines." Not now.

## 3. Pure C# desktop app (WPF / WinForms / MAUI / Avalonia)

**What it is.** Throw away the React UI. Rewrite the entire dashboard in C# using a native Windows UI framework — typically WPF (the modern one) or MAUI (the cross-platform one Microsoft is pushing now).

**What's attractive.**

- One language, end to end. No sidecar dance, no IPC, no JavaScript runtime. The UI directly calls the same C# code that calls the Tekla DLL. Everything in one process.
- Smallest installer (~30 MB for a self-contained .NET app, vs. 100+ MB for Electron).
- Most "native" feel on Windows — fonts, controls, accessibility all match the OS naturally.

**Why we didn't pick it.**

- **Your existing React UI is real work.** Throwing it away and redoing it in WPF/MAUI is months. Your team is also more comfortable in TypeScript/React than in XAML/MAUI, by your own description.
- **The styling toolkit matters.** Tailwind, Recharts, and the React ecosystem have a wide surface area you'd be giving up. WPF/MAUI has its own ecosystem but it's narrower and less actively evolving.
- **Tailored UIs are a UI problem, not a backend problem.** The benefits above (one language, small installer) are real, but they're paid for in lost UI velocity. Most teams who build C# desktop apps regret being on the WPF/MAUI styling treadmill within a year.

This option would be a strong choice if the dashboard didn't exist yet and the team's strongest skill was C#. Given the actual starting point, Electron is the better fit.

## 4. Pure web app rewrite where the user installs nothing

**What it is.** A clever architecture sometimes called "BYOC" (bring your own compute). You publish a static website. The website's JavaScript talks directly to the user's local PowerFab. No installer.

**What's attractive.**

- Zero installer. Just a URL.

**Why we didn't pick it.**

- **Browsers can't load DLLs.** Modern web browsers run JavaScript in a sandbox by design — no file system access, no native code loading. There is no realistic way for a webpage to call `Tekla.PowerFab.Interface.dll`. Period.
- **Browsers can't talk to SQL Server either.** SQL Server's protocol isn't HTTP. There are workarounds (a separate proxy service the user installs), but at that point you've installed something — defeating the premise.
- **WebAssembly doesn't help.** People sometimes ask "what about Blazor WebAssembly or Pyodide?" Those let you run .NET or Python in the browser sandbox — same restrictions. They can't reach the Tekla DLL on disk either.

This option simply can't be made to work given the constraint. It's mentioned here so you can quickly dismiss it if someone proposes it.

## 5. Rewriting everything in TypeScript / Node.js

**What it is.** Eliminate the C# entirely. Port `PowerFabApiClient` and all the modules to TypeScript. Talk to the Tekla "API" directly from Node.js.

**What's attractive.**

- One language across the stack. Easier to hire for, easier to share code.
- No sidecar plumbing.

**Why we didn't pick it.**

- **There's nothing to "port to."** This is the same dead end as option 4, just on the desktop: TypeScript / Node.js cannot load a .NET DLL into its own process. Even on Windows.
- **Reimplementing Tekla's protocol from scratch** is the only way to avoid the DLL, and we covered why that's a bad idea in `02-the-constraint.md` — undocumented, proprietary, likely against the license, will silently break on PowerFab updates.

The "just use one language" instinct is good. The fact that we can't is genuinely Tekla's choice, not ours.

## 6. Direct-to-database client with no API at all

**What it is.** Skip the FabSuite API entirely. The dashboard only talks to SQL Server. Everything we display is either a query or something we can compute from query results.

**What's attractive.**

- No DLL. No sidecar. The whole thing could be TypeScript.
- SQL Server is a documented, language-agnostic protocol. We can hit it from Node, Python, anywhere.

**Why we didn't pick it.**

- **You said both API and DB are needed.** Some of the data the dashboard relies on is only available via the FabSuite API, not via raw DB queries. (Or, more subtly: it's technically in the DB, but the joins and business logic to compute it correctly are baked into the API server. Reimplementing them by hand is fragile and ages badly with each PowerFab update.)
- **Writes are even worse.** If we ever want the dashboard to do anything besides read — set a status, approve an item — going through the API is the only safe route. Direct DB writes bypass PowerFab's business rules.

We could split the difference: read most data from the DB, use the API only for things we can't query. That's a fine optimization for later, but it doesn't change the fact that we still need the API for some operations, so we still need the C# sidecar, so we still have the same architecture.

## 7. Tauri instead of Electron

**What it is.** Replace Electron with Tauri as the desktop shell (see `01-concepts.md` § 10). Smaller installer, native Rust backend.

**What's attractive.**

- Installer drops from ~100 MB to ~30 MB.
- Lower memory footprint at runtime.
- Modern, actively developed.

**Why we didn't pick it (yet).**

- **The team doesn't know Rust.** Tauri's "Node side" is Rust. You can avoid touching it 90% of the time, but the 10% of the time you do is the 10% that matters (the sidecar manager, IPC bridges).
- **Electron is the boring choice.** Every desktop-app-for-React tutorial assumes Electron. The chance of getting stuck on a weird Tauri-specific issue is non-zero, and we already have one not-trivial integration (C# sidecar) absorbing our complexity budget.
- **The size argument is real but small.** 70 MB savings per install matter if you're shipping to a million users on slow internet. They matter much less for a B2B install that happens once per laptop.

This is the option most likely to be revisited. If at any point Electron's installer size or memory footprint becomes a real complaint, swapping it for Tauri is a contained refactor — the sidecar, the React UI, the build pipeline all stay the same. We'd just rewrite `electron/main.ts` and `electron/sidecar.ts` in Rust and update the installer config.

## 8. Bundling the Tekla DLL ourselves

**What it is.** Instead of relying on `Tekla.PowerFab.Interface.dll` being installed by PowerFab, we copy it into our installer and ship our own copy.

**What's attractive.**

- The app could conceivably run on a machine that doesn't have PowerFab installed (probably never useful, but technically).
- Eliminates the "is the DLL where we expect?" question entirely.

**Why we didn't pick it.**

- **Licensing.** Redistributing a vendor's DLL without permission is a license violation in most enterprise software contracts. Tekla almost certainly doesn't grant blanket redistribution rights.
- **Version skew.** The DLL talks to the FabSuite server, and Tekla updates them in lockstep. If we ship version X of the DLL and the customer's server is at version Y, we get mystery failures. The "correct" version of the DLL to use is "whatever the user's PowerFab installed."
- **No real benefit.** The customer has to have PowerFab installed anyway — that's the only reason they want our dashboard. The DLL is already there for free. There's nothing to gain by duplicating it.

If we ever discover a customer who somehow doesn't have PowerFab locally installed but wants to use the dashboard, that's a separate, weird conversation about whether we can support them at all.

## The recommendation, restated

The thick-client + bundled C# sidecar design picked itself, in the following sense:

- Option 4 and 5 are physically impossible.
- Option 1 is blocked by network and licensing realities.
- Option 2 is reasonable but heavier than necessary.
- Option 3 is reasonable but throws away your React investment.
- Option 6 doesn't actually solve the problem.
- Option 8 is a license risk for no gain.
- Option 7 is a future swap, not a different design.

What's left is what we picked.

## Things we still need to figure out

- **TODO:** Have we explicitly confirmed with Tekla (or read their developer documentation) that there's no future plan for a real REST API? If there is one in development, that genuinely changes the math.
- **TODO:** Decide a concrete "we'd revisit Tauri if X" trigger. E.g., "if any customer's IT department complains about the 100 MB installer size."
