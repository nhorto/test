# 01 — Concepts you need before anything else makes sense

This file is a vocabulary tour. Every other doc assumes you've read it once. Don't try to memorize anything — just read straight through. The glossary at the end of the set has short reminders if you forget a term later.

The order goes: where software runs → what software is made of → how the pieces talk → how it all gets onto a laptop.

## 1. Clients and servers

Almost every modern application is two programs pretending to be one.

The **client** is the program in front of you. It draws the buttons, listens to your clicks, shows you the data. Examples: the Chrome tab with Gmail open in it, the Slack app on your phone, a video game.

The **server** is the program somewhere else — usually in a data center, sometimes in the same office — that holds the data, enforces the rules, and sends pieces of it to the client when asked. Examples: Google's mail server, Slack's chat server, a multiplayer game's match server.

The client never sees the data directly. It asks the server, the server checks who is asking and what they're allowed to see, the server sends back a small piece, the client draws it.

> **Analogy.** A restaurant. You (the client) don't walk into the kitchen. You sit at a table, tell a waiter (a network connection) what you want, the kitchen (the server) prepares it, the waiter brings it out. You only ever see the plate, not the pantry.

For PowerFab Dashboard, the PowerFab database is the kitchen. The dashboard you build is the customer (the client). The question of this whole exploration is: where do we put the customer? On a website, or on a laptop?

## 2. Hosted, self-hosted, on-prem, local

Four words that sound similar and mean different things. They describe who runs the server.

- **Hosted** (a.k.a. SaaS — "Software as a Service"). You, the software vendor, run the server. Customers don't install anything; they open a website. Examples: Gmail, Notion, Linear. The original PowerFab Dashboard plan ("customers log in to our site") was hosted.
- **Self-hosted.** Each customer runs their own copy of the server, usually on a computer they own in their own office. The vendor ships an installer. Examples: GitLab Self-Managed, Plex, an old Microsoft Exchange box in the IT closet.
- **On-prem** ("on-premises"). Almost the same as self-hosted, but the emphasis is "physically on the customer's property" — not in a cloud account they rent. Often used in regulated industries.
- **Local.** No server at all. The program runs entirely on the user's own computer and stores its data on that same computer. Examples: Microsoft Word with a `.docx` file on your desktop, a calculator app.

The current question for PowerFab Dashboard is somewhere between self-hosted and local: the app runs on the user's own laptop, but it isn't fully local — it still reaches out across the office network to talk to the customer's PowerFab database and FabSuite API. That "reaches out to a database somewhere else" is what makes it unusual; pure local apps usually own all their own data.

We're going to call our shape "thick client + remote data" and move on.

## 3. Web app vs desktop app

You can build a user interface in two main ways.

- **Web app.** The UI lives on a website. You open a browser, type a URL, the browser downloads HTML/CSS/JavaScript and runs it. The user doesn't install anything; new versions ship automatically the next time they refresh. Examples: Gmail, the existing dashboard you can open in your browser today.
- **Desktop app.** The UI is a program installed on the computer. It has an icon in the Start menu, it opens its own window, it can access files on disk and other programs on the same machine. Examples: Microsoft Excel, Slack's desktop app, Visual Studio.

There is a third thing that looks like a desktop app but is secretly a web app: a desktop app built with Electron or Tauri. It uses web technology (HTML/CSS/JS — the same stuff a website uses) but it ships as a `.exe` and runs in its own window. We will use this. It's a big deal and gets its own section below.

## 4. Thick client vs thin client

Two more words for the same client/server relationship, but describing how much work the client does itself.

- A **thin client** does almost nothing on its own. It just shows what the server tells it to show. A web browser viewing Gmail is thin — almost all the logic is on Google's servers.
- A **thick client** has real code on the user's machine — it can open files, talk to multiple databases, run calculations, work even when the network is flaky. Microsoft Excel is a classic thick client.

The plan for PowerFab Dashboard, as you described it, is a thick client. The user's laptop has a real program on it. The program itself reaches out to the PowerFab database, runs queries, calls the FabSuite API, formats the result, draws the screen. There is no "PowerFab Dashboard server" in the middle.

Why does this matter? Because the C# code in your repo is a thick-client part. It's a chunk of logic that opens a connection, sends an XML message, parses the reply. That code is going to keep existing in this new design — it just gets bundled into the installer that goes on the laptop.

## 5. Programs, processes, and how they coexist

You start a program by double-clicking it. The operating system loads it into memory and starts running it. That running copy is called a **process**.

A few facts about processes that will matter:

- A program file on disk is not the same as a running process. `notepad.exe` is a file. The Notepad window currently open on your desktop is a process of it. You can have several Notepad windows open — that's several processes from one program file.
- Processes can't see each other's memory. If two processes need to share information, they have to send it somehow. They can't just look at each other's variables. The "somehow" is called **inter-process communication**, IPC for short.
- One program can start another program. A web browser starts a rendering process. A text editor starts a "format the document" helper. This is normal. The first program is the parent; the one it started is the child.

The design we're going to land on has two processes inside one installer: an Electron process (the UI) and a small C# process (the sidecar). The Electron process is the parent. It starts the C# process when the app launches and stops it when the app quits. The user only sees one window. That's the "two processes pretending to be one" pattern you'll hear more about.

## 6. The smallest amount of networking you need to know

Just enough to follow the rest of the docs.

- An "address" is two things: an **IP address** (which machine?) and a **port number** (which program on that machine?). An IP address looks like `192.168.1.5` or `10.0.0.42`. A port is a number from 1 to 65535. `192.168.1.5:1433` means "the program listening on port 1433 of the machine at 192.168.1.5."
- `localhost` is a magic name that means "this machine, right here." `localhost:5000` means "whatever program on my own computer is listening on port 5000." This is how two processes on the same laptop talk to each other over networking — without actually using a network card. The traffic never leaves the machine.
- **HTTP** is the most common way programs talk to each other over a network. The client sends a small text message (`GET /users/42`) and the server sends back another text message ("here is some JSON data describing user 42"). It's the language of the web. It's also the language we'll use between the Electron UI and the C# sidecar, even though they're on the same laptop, because it's well-understood and easy to debug.
- **SQL Server** uses its own protocol, not HTTP. Port `1433` is the default. When the dashboard wants to read from the PowerFab database, it opens a connection to something like `powerfab-db.acmesteel.local:1433`, says "I'm Sarah, my password is hunter2," and starts asking questions.
- The **FabSuite API** uses neither HTTP nor SQL directly. It uses a Tekla-supplied DLL (see the next section), which under the hood uses something — we don't know what, and we don't have to. The DLL hides that detail.

## 7. Files programs are made of: `.exe`, `.dll`

When a developer writes a program in a language like C# or C++, they end up with one or more of these files:

- **`.exe` (executable).** The starting point. Double-click it and a process starts. Examples: `notepad.exe`, `excel.exe`, `PowerFabProbe.exe` in your repo.
- **`.dll` (Dynamic Link Library).** A bundle of code that an `.exe` can borrow from. A `.dll` can't run on its own. It just sits on disk until something asks it for a function it provides. Examples: `kernel32.dll` is a Windows system library every program uses. `Tekla.PowerFab.Interface.dll` is the one that matters for us.

Why this distinction matters here. The thing your code calls "the API" is actually a `.dll` — `Tekla.PowerFab.Interface.dll`. It sits on disk inside `C:\Program Files\Tekla\Tekla PowerFab`. Your C# code, when it runs, loads that DLL into the same process and calls functions in it. This is very different from how most modern "APIs" work. Most modern APIs are remote services you reach over HTTP, where the client and server can be in different languages and on different operating systems. A DLL-based API is the opposite: the client has to share a runtime with the DLL — same machine, same programming-language family. The next doc walks through exactly what this means for us.

## 8. Native code vs interpreted code

When you write a program, something eventually has to translate your text into instructions a CPU understands. There are roughly two ways:

- **Native code.** The translation happens once, ahead of time. The result is a `.exe` or `.dll` full of CPU instructions for a specific processor (usually x86-64) and a specific operating system (Windows, macOS, Linux). It runs fast. It does not run on a different OS or processor without recompiling. C++, Rust, and Go programs are usually native. The `Tekla.PowerFab.Interface.dll` is native — Windows x86-64 only.
- **Interpreted (or "managed") code.** The translation happens at the moment the program runs, by another program called a runtime or interpreter. The original source files are usually portable — the same JavaScript file runs on Windows, Mac, and Linux because the runtime (Node.js, the browser) handles the differences. Python and JavaScript are interpreted. C# is a special case: it compiles to "Intermediate Language," which a runtime called .NET turns into native code as it runs. Close enough to interpreted for our purposes.

The reason this matters: interpreted code can't directly load native code that wasn't written for its specific runtime. A Node.js program cannot load a .NET DLL. A Python program cannot load a Tekla-built C# DLL. They speak different "machine vocabularies" even though they all run on Windows. To bridge across, you need a process boundary — the next concept.

## 9. Runtimes: .NET, Node.js, the browser

A **runtime** is a program whose job is to run other programs.

- **.NET** (or ".NET Runtime", or "the CLR"). The runtime for C#, F#, and VB.NET. Ships with Windows (mostly). When you double-click a C# `.exe`, the .NET runtime is what actually executes it.
- **Node.js.** The runtime for server-side JavaScript and TypeScript. It's a downloadable program you install separately.
- **A browser.** Chrome, Edge, Firefox each contain a JavaScript runtime called V8 (or SpiderMonkey in Firefox). When you open a web page, the browser runs the page's JavaScript.

When we say "the existing C# code stays as a C# program," what we really mean is "the existing C# code keeps depending on the .NET runtime." When we say "the existing React frontend stays as it is," we mean it keeps depending on a JavaScript runtime — specifically, a browser-like one bundled inside Electron.

## 10. Electron and Tauri (desktop app shells)

Two ways to wrap a web UI (HTML/CSS/JS) so it looks and behaves like a desktop app.

- **Electron.** Created by GitHub for the Atom editor. Used today by VS Code, Slack, Discord, Notion, Postman, Teams, Figma's desktop app, and many more. The way it works: it bundles a copy of Chromium (the browser engine that powers Chrome) and a copy of Node.js inside your installer. When the user opens your app, Electron starts the bundled Chromium to show your UI and the bundled Node.js to run any backend-style code you need. Cost: the installer is about 80–120 megabytes because it ships a whole browser. Benefit: every web technique you already know works.
- **Tauri.** Newer alternative. Instead of bundling Chromium, it asks the operating system for its built-in web view (Microsoft Edge's engine on Windows). Result: ~5–10 megabyte installers. The "backend" half is written in Rust instead of Node.js. Cost: Rust is unfamiliar to most teams, and the OS-provided web view has occasional rendering quirks across Windows versions.

For us, the recommendation is Electron, for one boring reason: your dashboard is already written in React/TypeScript, the team is comfortable in that language, and Electron is the well-trodden path. Tauri is fine but is a separate learning project, and we already have a separate learning project (the C# sidecar plumbing).

We can revisit Tauri later if installer size becomes a real complaint.

## 11. Database connections

A database is a separate program (a server) that stores data and answers questions about it. The questions are written in SQL. The PowerFab database is Microsoft SQL Server — a specific database product.

To talk to it, the dashboard needs a **database driver** — a piece of code, specific to the programming language, that knows how to speak SQL Server's protocol over the network.

- For C#, the driver is `Microsoft.Data.SqlClient`. It comes from Microsoft, it's free, it Just Works.
- For TypeScript / Node.js, the driver is the `mssql` package. Also free, also widely used.

Both languages can talk to SQL Server. So database access is not the thing pinning us to C#. The thing pinning us to C# is the FabSuite API DLL, which we'll get to in the next doc.

A **connection string** is one line of text that tells the driver "which server, which database, who am I, what's my password." Example: `Server=powerfab-db.acmesteel.local;Database=PowerFab;User Id=sarah;Password=hunter2;`. In our design, that string gets built fresh each session from the credentials the user typed at login, then forgotten when they sign out. Nothing is stored in plain text on disk.

## 12. Authentication

A long word for "proving who you are." The most common form is username + password, which is what PowerFab uses today.

Two things need to be authenticated when our app starts up:

1. **The SQL Server connection.** PowerFab has user accounts in its database. SQL Server checks the username and password and decides whether to let the connection through.
2. **The FabSuite API call.** Look at `PowerFabApiClient.cs` lines 144–148 — every request includes a `<Connect>` block with a username and password. The DLL forwards that to the FabSuite server, which decides whether to honor the request.

In your case, both checks use the same username and password — the user's existing PowerFab credentials. From the user's point of view, that's the only login screen they ever see. From the app's point of view, it has to remember those credentials in memory for the lifetime of the session and use them in two different places.

This is one of the reasons we don't need to build a login system of our own. PowerFab already has one. We're piggybacking.

## 13. The "sidecar" pattern

Here's the puzzle piece that ties everything together.

Imagine you're writing a TypeScript program and you need to do something that only a C# program can do — like load a Windows DLL that only .NET programs can call. You can't load the DLL into your TypeScript program (different runtimes, different machine vocabularies — see section 8). So what do you do?

You start a separate C# program from your TypeScript program, and have it do the C#-only work for you. You talk to it over IPC (usually HTTP over `localhost`), as if it were a tiny web service running on your laptop. The two processes coexist; the user only sees the TypeScript-driven window.

The C# program is the **sidecar** — like the sidecar on a motorcycle. It rides along, the motorcycle is in charge, but the sidecar carries something the motorcycle alone can't.

Visually:

```
   Your TypeScript code                Your C# code
   (in Electron's main process)        (your sidecar .exe)
   --------------------------          ---------------------------
              |                                  |
              |   HTTP request over localhost    |
              |--------------------------------->|
              |                                  | (calls Tekla DLL)
              |   JSON response                  |
              |<---------------------------------|
              |                                  |
```

The user has no idea the second program exists.

This is the same trick Postman uses (a bundled Node helper), the same trick VS Code uses for language servers, the same trick GitHub Desktop uses for git. It's not exotic. It's the default answer when you have to glue two different language ecosystems together.

In our design, the sidecar is the existing C# code in `scripts/api/data-gen/`. We don't rewrite it. We add a tiny wrapper around it (an ASP.NET Core "minimal API" — about 30 lines) so it listens on `localhost:<some port>` and exposes its existing functions as HTTP endpoints. Then we bundle the resulting `.exe` into the Electron installer.

## 14. Installers and updates

The very last hop: getting all this onto a user's laptop and keeping it up to date.

- An **installer** is a `.exe` (sometimes `.msi`) that the user downloads and double-clicks. It unpacks files into Program Files, creates a Start menu shortcut, maybe registers some Windows metadata. The standard tool for Electron apps is `electron-builder`.
- An **auto-updater** is code inside your app that, every time the app starts, asks a known URL "is there a newer version?" If yes, it downloads the new installer in the background and offers to install it next time the user quits. The standard package for Electron is `electron-updater`.
- The "known URL" has to live somewhere. The simplest place is a public bucket (Amazon S3, Cloudflare R2, even a GitHub release page) where each new version drops a few files. The auto-updater reads a small JSON manifest from that bucket to find the latest version.

These are concerns for later — once we have a working app, hooking up auto-updates is well-trodden territory and there are tutorials. We mention it now so you know it's a solved problem.

## Recap

You should now have a mental model that includes:

- A client runs on the user's computer; a server runs elsewhere.
- A thick client does real work locally. We're building one.
- Electron is a way to make a web UI feel like a desktop app.
- Processes are isolated; they talk to each other via IPC, often over HTTP on `localhost`.
- `.exe` and `.dll` are different file types. A DLL can't run on its own; an EXE loads it.
- Native code and interpreted/managed code can't easily mix inside one process. Across a process boundary, anything goes.
- .NET is the runtime that runs C# programs.
- The sidecar pattern is "start a separate program in a different language and talk to it over IPC." It's how we'll bridge from TypeScript to C# without rewriting the C# code.

The next doc uses every one of these concepts to explain why the C# code in your repo is non-negotiable.
