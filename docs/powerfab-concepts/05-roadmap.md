05 — A phased roadmap

This is a suggested order of work to get from where we are today (no Electron, no sidecar plumbing, dashboard reads pre-baked JSON) to "real customers running real installers and clicking through real screens."

The phases are arranged so that the riskiest, least-familiar work happens first. That way, if something turns out to be impossible or much harder than expected, we find out before we've poured weeks into peripheral polish.

Each phase has a goal, a done-when test you can actually demonstrate, and a rough size ("small / medium / large") rather than a calendar estimate, because calendar estimates lie.

Phase 0: Build a "hello sidecar" proof of concept

Goal: Convince yourself the sidecar pattern actually works on your machine. Nothing about PowerFab yet. Nothing about React yet.

What you build:

A throwaway folder, separate from the main repo.
A 50-line Electron app whose window has one button labeled "Ask C#".
A 30-line C# program (ASP.NET Core minimal API) with one endpoint GET /hello that returns {"message":"hi from C#"}.
Electron starts the C# .exe as a child process on launch, reads the port it picks, and when the button is clicked, calls /hello and shows the response in the window.
Done when: You can click the button and see "hi from C#" appear, on your own laptop, with no external dependencies.

Size: Small (a weekend, or a couple of focused afternoons).

Why this first: You will hit something — a port conflict, a "how do I package the .exe with Electron," a "wait, how does Electron actually start a child process" — and you want to hit it while there's no real code in flight. This phase is a learning project disguised as a deliverable. The throwaway folder is fine to delete after you're done; the lessons you carry forward are the point.

Phase 1: Wrap the existing C# data-gen as a real sidecar

Goal: The real PowerFabDataGen runs as an HTTP service on localhost, talks to a real PowerFab database and a real FabSuite DLL, and returns real data when you curl it.

What you build:

In scripts/api/data-gen/Program.cs, switch the entry point from a console app to ASP.NET Core minimal API. Keep the existing module classes (OverviewJobsModule, etc.) unchanged.
Add three endpoints, just to start:
POST /login — accepts credentials and a server address, verifies them by trying fsreqPing and a simple SQL query, returns 200 or an error.
GET /api/jobs — returns the same JSON your data-gen produces today for overview jobs.
GET /api/health — returns sidecar version + "alive."
No UI yet. You test with curl or Postman.
Done when: You can curl http://localhost:<port>/api/jobs after logging in via curl and see real PowerFab data.

Size: Small. The hard work was done when PowerFabDataGen was written; you're just exposing it.

Why this second: This proves the harder of the two integrations (the Tekla DLL) works in the new shape, without any UI complexity muddying the diagnosis. If something is wrong with how we load the DLL from a long-running web service vs. from a console app, we want to find out now.

Phase 2: Stand up the Electron shell with the existing React UI

Goal: The existing dashboard, in an Electron window, with no behavior change yet — still reading whatever it reads today.

What you build:

The electron/ folder with main.ts, preload.ts, sidecar.ts. Minimal feature set:
Open a window.
Load http://localhost:5173 in dev mode, or the packaged app/dist in production.
Window state (size, position) saved across launches.
No sidecar wiring yet. The React UI doesn't know it's in Electron.
Done when: You can run npm run dev (in three terminals, or one wrapper script) and see your existing dashboard inside an Electron window. Resize it, close it, reopen — it remembers where it was.

Size: Small. Electron's tutorial covers most of this.

Phase 3: Connect Electron to the sidecar

Goal: The Electron shell starts the sidecar on launch, knows its port, and exposes a small API to the React UI for calling it. The React UI's data layer gets a new "fetch from sidecar" implementation.

What you build:

electron/sidecar.ts — starts the C# sidecar .exe, captures its stdout to find the port and a one-time auth token (we'll add one), and exposes both to the renderer via a preload bridge.
A tiny TypeScript client library inside app/ that hides the details — calling dashboardApi.getJobs() from React eventually fires off fetch("http://localhost:51234/api/jobs", { headers: ...}).
A login screen in React that calls dashboardApi.login(...).
Done when: You launch the Electron app, log in, and see real PowerFab data on the existing dashboard pages.

Size: Medium. Lots of small wiring, no single hard thing. The plumbing work that makes everything from here easier.

Phase 4: Port the rest of the dashboard's data flows

Goal: Every page in the dashboard that needs live data fetches it from the sidecar instead of from pre-baked JSON files.

What you build:

For each Module in scripts/api/data-gen/Modules/, add a corresponding endpoint in the sidecar.
For each consumer in app/, swap the data-loading code from "import JSON file" to "call sidecar endpoint."
Done when: The dashboard works end-to-end, all pages, on a real customer database, with no pre-generated JSON in the loop.

Size: Medium. It's mechanical, but there are a lot of small "oh, this module returns slightly different shape" surprises. Expect to discover schema mismatches.

Phase 5: Package into a real installer

Goal: A .exe you can email to a colleague who doesn't have the source code, and they can install and run it.

What you build:

installer/electron-builder.yml — the package config.
CI workflow (GitHub Actions or similar) that runs dotnet publish + npm run build + electron-builder on every tag.
A "first launch" experience: settings screen for the PowerFab server address, friendly errors if the Tekla DLL isn't found.
Test on a clean Windows VM — one that has only PowerFab installed, not Node, not .NET, not Visual Studio. Make sure the installer doesn't assume anything is already there.
Done when: A colleague who has never seen the project before can download the .exe, install it, log in with their PowerFab credentials, and see the dashboard.

Size: Medium. The first time is the slow time; future releases are one command.

Phase 6: Auto-updates, code signing, and polish

Goal: The app feels like a real product. Users get updates without your help. Windows doesn't warn them about you.

What you build:

electron-updater wired up to a release feed (S3 bucket, Cloudflare R2, or GitHub releases).
A code-signing certificate purchased, set up in CI, and used to sign every installer.
"About" dialog showing version + a "Check for updates" button.
Crash/error reporting (Sentry or similar) — optional but cheap insurance.
Done when: You can publish v1.0.1, and v1.0.0 users get a "Restart to update" banner the next time they open the app.

Size: Small to medium. The cert procurement is admin work that can take a couple of weeks of calendar time even though it's small work. Start it early.

Phase 7: Real-world hardening

Goal: The app stays alive under the messy conditions of an actual office network.

What you build:

Retry logic for transient failures (the existing PowerFabApiClient.cs already does some — extend it).
Reconnect logic for SQL Server when the user's laptop sleeps and wakes.
Graceful handling of the customer's PowerFab being temporarily unreachable — show a banner, retry in the background, don't crash.
A "Send diagnostics" button that zips logs + system info and produces a file the user can email to support.
Done when: A user can put their laptop to sleep, take it home, open it on a different network, come back, and the app picks up where it left off without manual intervention.

Size: Medium-large. Easy to underestimate. Plan for it as a distinct phase rather than scattered fixes.

What's deliberately not on this roadmap

Multi-tenancy / per-customer config baked into the installer. Initially everyone gets the same installer; they configure their PowerFab server address on first launch. We can revisit if we end up wanting per-customer-branded installers later.
A separate "admin" feature set (user management, audit logs, etc.). PowerFab handles user management. We're not adding a parallel one.
macOS or Linux builds. The Tekla DLL is Windows-only. Done.
An online version "alongside" the desktop version. We can always add a hosted variant later if the business demands it, but doing both at once doubles the work.
A backend service of our own. Per the architecture, we don't have one and don't need one. Adding one would change everything upstream of here.
Suggested sequencing

If we wanted to be aggressive about getting something in front of a friendly customer for feedback:

Phases 0–3 in sequence (you can't really overlap them).
Phase 4 + Phase 5 can overlap once Phase 3 lands.
Phase 6 can start in parallel with Phase 4 (cert procurement especially — it's admin work, not coding work).
Phase 7 is ongoing — it never really "ends," it just becomes maintenance.
The first usable internal demo is end of Phase 3. The first shareable build is end of Phase 5. The first "real product" is end of Phase 6.

Things we still need to figure out

TODO: Who is the first friendly customer for Phase 5? Knowing this up front shapes a lot of "what do we test against" decisions.
TODO: Decide whether Phases 1–4 happen on a long-lived feature branch (and merge to main at the end) or in small slices to main behind a feature flag.
TODO: Decide whether we want a v0 ("internal only, only ever used on one specific customer's data") before v1. Internal-only buys time to learn without code-signing/installer polish.
