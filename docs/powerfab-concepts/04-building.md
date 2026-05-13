04 — Building, packaging, and shipping

The previous file described what the finished app looks like. This one describes how you (the developer) and a customer (the end user) actually get to that finished state, day to day.

Two roles in this file:

You, the developer. What you do on your own machine while building features.
Them, the end user. What they download, click, and run.
We'll walk through each.

1. What the codebase looks like

After this redesign, the repo has three top-level technical concerns that need to coexist:

powerfab-dashboard/
├── app/                          ← React/TypeScript UI (exists today)
├── electron/                     ← NEW — Electron shell + sidecar manager
│   ├── main.ts                   ← the "main process" entry point
│   ├── preload.ts                ← bridges UI ↔ Electron's Node side
│   └── sidecar.ts                ← starts/stops the C# sidecar process
├── scripts/api/data-gen/         ← C# sidecar (exists today as PowerFabDataGen)
│   ├── Api/PowerFabApiClient.cs  ← (unchanged)
│   ├── Modules/...               ← (unchanged)
│   ├── Models/...                ← (unchanged)
│   └── Program.cs                ← UPDATED — switches from console mode
│                                    to ASP.NET Core minimal API
├── installer/                    ← NEW — electron-builder config
│   └── electron-builder.yml
└── package.json                  ← UPDATED — adds Electron + builder deps
You can think of it as three pieces:

app/ — what the user sees. TypeScript, React, Tailwind. Same as today, runs in a browser-like environment.
electron/ — the glue. Maybe ~200 lines of TypeScript total. Starts the C# sidecar, points the UI at it, handles open-on-startup, auto-updates, window state.
scripts/api/data-gen/ — the C# sidecar. Mostly your existing code; one file changes (the entry point) and one new dependency is added (Microsoft.AspNetCore.App, which is built into modern .NET).
The Python scripts under scripts/ are not part of the shipped product. They stay as developer tools — for analyzing the database schema, generating docs, etc. They don't go in the installer.

2. The development loop (your day-to-day)

Roughly: you open three terminal windows.

Terminal 1: the React UI in dev mode

cd app
npm run dev
This is exactly what you do today. It starts Vite on http://localhost:5173 and watches your TypeScript files. Edits appear in the browser instantly.

Terminal 2: the C# sidecar in watch mode

cd scripts/api/data-gen
dotnet watch run
dotnet watch run rebuilds the C# code whenever you save a file and restarts the sidecar process. The sidecar listens on a localhost port (it'll print the port at startup).

Terminal 3: Electron, pointed at the dev UI

cd electron
npm run dev
This launches Electron in development mode. Instead of loading the packaged UI, it points its window at http://localhost:5173 (the Vite dev server in terminal 1). It also starts the C# sidecar process if one isn't already running (or attaches to the one you started in terminal 2 — both options are possible).

Net effect: You edit a .tsx file, save, the browser-side hot reload kicks in and the Electron window updates without restarting. You edit a .cs file, save, dotnet watch restarts the sidecar and the next HTTP call from the UI hits the new code.

This is a "normal" web dev loop, with an extra terminal. If you have worked with npm run dev before, you're 80% of the way there.

A small confession: in practice most teams build a single wrapper command (npm run dev:all) that starts all three terminals at once, so you don't have to juggle. We can do that early — it's a 10-line script.
3. The build step (turning source into a shippable thing)

When you're ready to release a version, four things happen, in order:

Step 1: Build the React UI.

cd app
npm run build
This runs Vite's production build. Result: a folder of static HTML, CSS, and JS files (app/dist/) optimized and minified for shipping.

Step 2: Publish the C# sidecar as a self-contained executable.

cd scripts/api/data-gen
dotnet publish -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true
Translation:

-c Release — optimized build, not debug.
-r win-x64 — for 64-bit Windows.
--self-contained true — include a copy of the .NET runtime in the output, so we don't depend on the user having .NET installed.
/p:PublishSingleFile=true — bundle everything into one .exe file (well, almost — there are a couple of native DLLs that have to stay separate, but it's close enough).
Result: a folder containing PowerFabDataGen.exe and a few companion files, totaling ~30 MB. This is the "sidecar" that gets shipped.

Step 3: Build the Electron app.

cd electron
npm run build
This compiles the small amount of Electron-specific TypeScript (main.ts, preload.ts, sidecar.ts) into JavaScript.

Step 4: Run electron-builder to produce the installer.

npm run dist
electron-builder is a popular npm package that handles the actual packaging. We configure it via installer/electron-builder.yml to:

Pull in the React build from app/dist/.
Pull in the C# sidecar from scripts/api/data-gen/bin/Release/.../publish/.
Pull in the Electron runtime.
Wrap it all in a Windows installer (NSIS by default — the most common Windows installer format).
(Optional but recommended) sign the installer with a code-signing certificate so Windows SmartScreen doesn't show "Unknown publisher" warnings.
Result: dist/PowerFab Dashboard Setup 1.0.0.exe. This is what the end user downloads.

In CI (GitHub Actions, etc.) we'd wire steps 1–4 into a single workflow that runs on every tagged release. You push a tag like v1.0.0, the workflow produces the .exe, uploads it to a release page, the update server points at it. We don't have to figure this out before we have a working v0.

4. What the end user does

This is the easy part.

First time: They download PowerFab Dashboard Setup 1.x.x.exe from your customer portal (or wherever you host releases — doesn't really matter where, as long as they can reach it).
They double-click. Windows shows them an installer wizard. They click Next, Next, Install.
They see a Start menu entry and a desktop shortcut. They click the shortcut.
The app opens. They see a login screen. They type their PowerFab username and password (and possibly the address of their PowerFab server, if it's not auto-discovered — see "Things still to figure out" below).
They use it.
Next time, they just click the shortcut.
If a new version is available, the app notices on launch (or after a few minutes — configurable), downloads it in the background, and shows a small "Restart to update" banner. The user can ignore it or click it. On click, the app quits, the new version installs, the app reopens.

5. File layout on the user's machine

Once installed, here's where things live on the user's laptop:

C:\Program Files\PowerFab Dashboard\
├── PowerFab Dashboard.exe        ← the Electron shell (what's in the
│                                    Start menu)
├── resources\
│   ├── app.asar                  ← the packaged React UI + Electron
│   │                                main code
│   └── sidecar\
│       ├── PowerFabDataGen.exe   ← the C# sidecar
│       └── (a few native DLLs)
├── (the bundled Chromium and Node.js, courtesy of Electron)
└── Uninstall.exe

C:\Users\<sarah>\AppData\Roaming\PowerFab Dashboard\
├── config.json                   ← per-user settings (window size, the
│                                    PowerFab server address, NOT
│                                    credentials)
└── logs\
    └── main.log                  ← rolling log files for diagnostics
Two things to notice:

Program Files holds shared code. All users on one Windows machine share the same .exe files. They installed once. Updates rewrite this folder.
AppData holds per-user settings. Sarah's window position and Bob's window position don't interfere with each other. No credentials live in this folder, ever.
This is standard Windows app behavior. Electron and electron-builder get it right by default.

6. Logging and diagnostics

Things will go wrong. The user will need a way to send you logs. Plan for this from day one — it costs almost nothing if you set it up early, and a fortune if you bolt it on after launch.

The C# sidecar writes logs to its own log file (e.g. AppData\Roaming\PowerFab Dashboard\logs\sidecar-2025-05-13.log). Standard .NET pattern, ~5 lines of setup.
The Electron main process writes its own log (...\logs\main-2025-05-13.log). Standard Electron pattern.
The React UI sends errors to the Electron main, which writes them to the same set of logs.
The app has a "Help → Show logs folder" menu item that opens Explorer to the logs directory. When a user reports a problem, you ask them to zip that folder and email it to you.
(Later) you can wire in an automatic crash reporter (Sentry, BugSnag, etc.), but it's optional and adds external dependencies.
Never log credentials. The existing C# code already includes a small redaction helper for the FabSuite XML envelope (search Redact in PowerFabApiClient.cs). We should extend that habit everywhere.

7. Code-signing and the "Unknown publisher" warning

If you publish a Windows installer without signing it, Windows SmartScreen will show a scary "Windows protected your PC" dialog the first time a user runs it. They have to click "More info → Run anyway" to install your app. This is a poor first impression.

The fix is a code-signing certificate — a cryptographic identity issued to your business by an authority like DigiCert or Sectigo. It costs ~$200–$700 per year. You sign the installer (signtool sign ...) and electron-builder also signs each .exe and .dll inside. With a real cert, Windows shows your business name; with an EV ("Extended Validation") cert, the warning disappears entirely.

This is a "before-you-ship-to-real-customers" task, not a "before- you-write-any-code" task. We can defer it. Just don't forget it.

8. What changes vs. what stays the same

A quick scorecard so you know how much actually moves:

Component	State today	State after redesign	Effort
React UI (app/)	Static, reads pre-baked JSON	Same code, calls localhost HTTP for data	Small — a thin data layer swap
Electron shell	Doesn't exist	New, ~200 lines	Medium — new but well-documented
C# data-gen modules	Console app	Same modules, wrapped in minimal API	Small — entry point change
C# API client (PowerFabApiClient.cs)	Already correct	Unchanged	None
Python scripts	Dev tools	Still dev tools (not shipped)	None
Installer	Doesn't exist	electron-builder config	Small
Auto-update	Doesn't exist	electron-updater	Small
Code signing	Doesn't exist	Cert + signtool	Admin work (one-time)
The point: most of the existing code keeps working. The biggest new pieces are the Electron shell (well-documented territory) and a ~30-line wrapper around the C# modules.

Things we still need to figure out

TODO: Decide how the user enters the PowerFab server address. Is it auto-discoverable? Probably not — likely a settings field they fill in once. Per-machine or per-user?
TODO: Decide where the official release files get hosted (S3, GitHub releases, a custom CDN). The auto-updater needs a stable URL.
TODO: Settle on a release versioning scheme (v1.0.0, v2025.05.13, etc.) and how it maps to the .NET assembly version and Electron app version. They should match.
TODO: Decide whether the installer is per-machine (Program Files, requires admin) or per-user (no admin needed, installs into the user's AppData). The latter is friendlier in locked-down IT environments; the former is more conventional.
