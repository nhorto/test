# 02 — The one hard constraint: the FabSuite API is a Windows DLL

Everything in the next file (the architecture) follows from one fact about your codebase. This file's job is to make sure you really believe that fact, because it shapes every choice that comes after.

The short version: the FabSuite "API" is not a normal web API. It's a Microsoft Windows DLL that ships with PowerFab. Only programs running on the .NET runtime — i.e., C# (or another .NET language) on Windows — can call it. Everything else (TypeScript, Python, Rust) has to start a small C# helper program and ask it to do the call.

If that already makes sense, skim the rest. Otherwise, here is the walk-through.

## What "API" usually means

When most developers today say "API," they mean a service running on some web server somewhere that I talk to over HTTP. Examples: the Stripe API, the GitHub API, the OpenAI API. The model is:

```
   Your code (anywhere)                Their server (somewhere)
   -------------------                 ------------------------
        |                                       |
        |  HTTPS request — "POST /charges"      |
        |-------------------------------------->|
        |                                       |
        |  JSON response — "ok, paid"           |
        |<--------------------------------------|
        |                                       |
```

Two important features of this kind of API:

- **It's a network service.** You don't have to install anything on your machine. You just need an internet connection.
- **It doesn't care what language you wrote your code in.** As long as your language can speak HTTP and parse JSON or XML, you're fine. That's why every API has SDKs (helper libraries) in a dozen languages — Python, JavaScript, Go, Java, etc.

Because this is what most APIs look like today, it's easy to assume the FabSuite API is the same. It isn't.

## What the FabSuite "API" actually is

Let's open the file at `scripts/api/data-gen/Api/PowerFabApiClient.cs` and read it like detectives. There are three details that tell the whole story.

### Clue 1: An install directory

Lines 22–23:

```csharp
private const string DefaultInstallDir = @"C:\Program Files\Tekla\Tekla PowerFab";
private const string InterfaceDllName = "Tekla.PowerFab.Interface.dll";
```

That's a path on a Windows machine — specifically, the path where PowerFab gets installed. The constant `InterfaceDllName` is the name of a file Tekla puts in that folder. So before any "API call" can happen, the code has to find a file on disk in a specific Windows location.

If the FabSuite API were a normal web service, none of this would exist. You'd have a URL like `https://api.fabsuite.com/v1` and that's it. Instead, we have a file path. That's the first clue that we're dealing with something local, not remote.

### Clue 2: Tricks to load a DLL

Lines 26–27:

```csharp
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
private static extern bool SetDllDirectory(string lpPathName);
```

`SetDllDirectory` is a Windows operating-system function. It tells Windows "when something tries to load a DLL, look in this folder first." The C# code is going out of its way to make sure Windows can find `Tekla.PowerFab.Interface.dll`. That's because the DLL gets loaded into the running process, the way a library gets loaded into a program — not the way a server gets contacted over the network.

This is a native code loading mechanism (see section 8 of the concepts doc). It's the same thing that happens when Windows opens Notepad and pulls in `kernel32.dll` along with it. The DLL becomes part of your running process.

### Clue 3: A type from "TeklaPowerFabAPI"

Line 4:

```csharp
using TeklaPowerFab.TeklaPowerFabAPI;
```

And line 29:

```csharp
private readonly ITeklaPowerFabAPI _api;
```

These are .NET types provided by Tekla. Specifically, by an **interop assembly** — a thin C# wrapper around the native DLL that gives .NET programs a typed way to call its functions. The wrapper itself is .NET only. If you're not running on the .NET runtime, you cannot use the wrapper, and if you can't use the wrapper, you can't call the DLL.

### Putting it together

Look at line 77 — the actual moment a "request" gets made:

```csharp
responseXml = _api.ExecuteDirect(requestXml);
```

This is **not** an HTTP call. There is no URL. There is no `fetch()`. There is no socket being opened. It's a method call on an in-process object. The C# code hands an XML string to the Tekla DLL; the Tekla DLL goes off and does something (probably HTTP, probably to a FabSuite server somewhere, but we don't know and don't need to know); the DLL returns an XML string. The DLL hides the network and the protocol entirely.

So when we say "the FabSuite API," we really mean two layers stacked on top of each other:

```
   Your application code (C#)
           |
           | function call (in-process)
           v
   Tekla.PowerFab.Interface.dll   <-- WINDOWS-ONLY, .NET-ONLY
           |
           | mystery protocol over the network
           v
   The actual FabSuite server somewhere
```

The top layer is the only one you can touch. The mystery protocol is Tekla's business, not yours. You don't get to skip the DLL and talk to the server directly — even if you could figure out the protocol, it would change without warning the next time PowerFab updates and your app would break.

## What if Python wants to use it?

You don't have to take my word for any of this — the codebase already demonstrates it. Look at `scripts/api/probe.py`. Python is a totally different ecosystem than .NET. How does Python make FabSuite API calls? Lines 45–46:

```python
SHIM_EXE = REPO_ROOT / "scripts" / "api" / "probe-shim" / "bin" / "Release" / "net8.0-windows" / "PowerFabProbe.exe"
```

`PowerFabProbe.exe` is a tiny C# program. Python doesn't talk to the DLL itself; it starts a C# child process and asks it for the result. Look at the rest of the file: it uses `subprocess` (Python's "start another program" module) to launch the `.exe`, pipes XML in, reads the response back out, and parses it on the Python side.

This is the sidecar pattern from `concepts.md`, in real working code, in your own repo. Python had the exact same problem you have with TypeScript — it can't load a .NET DLL — and the solution was the same one we're going to use: spawn a small C# helper and talk to it from the outside.

## Why we can't "just port it"

A reasonable question: "Can't we figure out what bytes the DLL is sending over the wire and just write that protocol ourselves in TypeScript?" In principle, yes. In practice, no, for three reasons:

1. **The protocol is undocumented and proprietary.** Tekla didn't publish it. You would have to capture the network traffic with a tool like Wireshark and reverse-engineer it byte by byte. That takes weeks even if everything is plain text — and it might not be.
2. **It will change without notice.** Tekla updates PowerFab. They are not obligated to keep the wire format stable. Your TypeScript reimplementation would break, possibly silently, and you'd find out via angry customer phone calls.
3. **It's almost certainly against the license.** Most enterprise software EULAs forbid reverse-engineering. Even if it's technically possible, doing it commercially is a bad idea.

The DLL is the official supported way in. We use it.

## What this means concretely

- **Some part of our app has to be a .NET program.** Specifically, the part that actually calls the Tekla DLL.
- **That .NET program has to run on Windows.** No Mac, no Linux. The DLL is Windows-native. (You confirmed this is fine — all your customers are on Windows.)
- **That .NET program has to run on the user's own machine.** Because the user already has PowerFab installed on their laptop, the Tekla DLL is already there — at `C:\Program Files\Tekla\Tekla PowerFab\Tekla.PowerFab.Interface.dll`. If we tried to run the .NET program on a central server somewhere, we'd have to install PowerFab on that server too, which isn't how PowerFab is normally licensed or deployed.
- **The .NET program does not have to be the whole app.** It only has to be the chunk that touches the Tekla DLL. The rest of the app — the UI, the SQL Server queries, the user settings, the charts — can be in any language we want.

That is the entire constraint. Three sentences. The rest of the design is just "okay, given that, what's the cleanest way to put it together?" — and that's the next file.

## Things we still need to figure out

- **TODO:** Confirm with Tekla (or by reading their license docs) whether redistributing `Tekla.PowerFab.Interface.dll` is allowed. Our current plan doesn't redistribute it — we rely on it being already installed on the user's machine as part of PowerFab. That's almost certainly fine, but worth a quick check.
- **TODO:** Confirm the exact path. Is it always `C:\Program Files\Tekla\Tekla PowerFab`, or do some customers install elsewhere? If elsewhere, our sidecar will need a way to be told. The existing C# code already supports this — see `Create(string? installDir = null)` at line 38 — so we just need a setting for it in the UI.
- **TODO:** Confirm what minimum PowerFab version we need. The DLL's function names and behavior may have changed across versions. Your C# code is written against some version — we should know which one and write that down in a system-requirements section of the installer.
