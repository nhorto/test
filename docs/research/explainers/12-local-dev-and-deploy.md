# 12 — Local Dev and Deploy: Running Tauri, Building Installers, Code Signing, Auto-Updates

> **Prerequisites:** read 00, 05, and 11 first.

> **By the end of this doc you will know:** how to run the Tauri app on your laptop in dev mode. How to build production installers for Windows, Mac, and Linux. The painful (but necessary) code-signing process for each OS. How the auto-updater works and how to host the update manifest. The seven specific bugs that bite people setting this up for the first time, and the fixes.

This doc is the bridge between *what we're building* (05–11) and *how you build it on your laptop today*. If 11 is the operational manual for tenants, this is the operational manual for the dev loop and the release pipeline.

---

## 1. Vocabulary primer

00 already defined Tauri, webview, Rust, Tauri command, sidecar, auto-updater, installer, code signing. Here are the new operational terms.

- **`tauri-cli`** — the command-line tool that wraps everything Tauri-related. You'll run `npm run tauri dev`, `npm run tauri build`, etc. Installed as a dev dependency.
- **`tauri.conf.json`** — the config file at `src-tauri/tauri.conf.json`. Names your app, lists allowed Tauri commands, configures the window, sets the auto-updater URL.
- **Hot module replacement (HMR)** — Vite's "save a file and see it update without restarting" feature. Works inside Tauri dev mode too.
- **Bundle / installer** — the .msi (Windows), .dmg (Mac), .AppImage/.deb/.rpm (Linux) file produced by `tauri build`.
- **Code-signing certificate** — a cryptographic certificate proving the binary came from you. Different ones for each OS.
- **Notarization** (Mac) — an extra step on top of signing where Apple actually checks your app for malware and stamps it OK. Required for distribution outside the App Store.
- **EV cert** (Windows) — an "Extended Validation" code signing cert. Required to avoid SmartScreen warnings. Comes on a USB hardware token. The cert lives on the token; signing requires plugging it in.
- **Auto-updater manifest** — a small JSON file (`latest.json`) hosted at a fixed URL. Tauri's auto-updater polls this URL, compares versions, and downloads if there's a newer one.

---

## 2. The dev loop, step by step

### 2.1 Prerequisites you install once

- **Node.js** (LTS — 20.x or 22.x are both fine). Vite needs it.
- **Rust** via `rustup`. Tauri's backend.
- **Platform-specific build deps:**
  - Windows: Microsoft Visual Studio C++ Build Tools.
  - macOS: Xcode Command Line Tools (`xcode-select --install`).
  - Linux: `webkit2gtk-4.1` + `libappindicator3` + a few others; the Tauri docs list them per distro.

The Tauri docs have an OS-by-OS install guide. Run through it once; it takes 30 minutes the first time.

### 2.2 First-time project setup

In an empty repo:

```bash
$ npm create tauri-app@latest dashboard -- --template react-ts
$ cd dashboard
$ npm install
$ npm run tauri dev
```

The dev command does three things at once:

1. **Starts Vite** in dev mode. Vite serves the React UI on a local port (e.g., `http://localhost:1420`) with HMR.
2. **Builds Tauri's Rust binary** in debug mode. Compiles fast (~30s first time, ~2s after).
3. **Launches the Tauri window**, pointing its webview at the Vite dev server. The window opens.

Edit `src/App.tsx`, save, watch it hot-reload inside the Tauri window. Edit `src-tauri/src/main.rs`, save, Tauri restarts the binary (slower than HMR — a few seconds). React state is lost on Rust restart, which can be annoying for iteration; minimize Rust changes during UI work.

### 2.3 Activating in dev (without juggling real license keys)

From doc 01 §6:

```bash
$ DEV_TENANT=acme npm run tauri dev
```

This sets a dev-only env var that the Rust side reads on startup. If present, Rust writes a fake `activation.json` with `tenant: "acme"` and skips the activation screen. Only works in debug builds.

For testing the real activation flow, generate a dev license key with `tools/sign-license.ts` and paste it in normally.

### 2.4 Running against a real gateway

Two options:

**Option A — gateway on localhost.** Run the gateway service on your laptop. Use `http://localhost:8080` as the gateway URL in the dev license key. Useful for end-to-end dev. Doc 06 §5 has the gateway config; run it with `uvicorn` or whatever.

**Option B — mock gateway responses.** Add a flag to the Rust `fetch_metric` command: if `MOCK_GATEWAY=1` and we're in debug build, return canned JSON for known metric IDs. Faster to set up, doesn't exercise the network path.

Use Option B for fast iteration, Option A when working on gateway-related changes.

---

## 3. The `tauri.conf.json` file

The single most important config file. Lives at `src-tauri/tauri.conf.json`. A pared-down example:

```jsonc
{
  "$schema": "../node_modules/@tauri-apps/cli/schema.json",
  "productName": "PowerFab Dashboard",
  "version": "1.0.0",
  "identifier": "com.yourcompany.dashboard",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "title": "PowerFab Dashboard",
        "width": 1400,
        "height": 900,
        "minWidth": 1024,
        "minHeight": 720
      }
    ],
    "security": {
      "csp": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'"
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/icon.icns", "icons/icon.ico", "icons/32x32.png", "icons/128x128.png"],
    "category": "Productivity",
    "publisher": "Your Company, LLC",
    "windows": {
      "wix": {
        "language": "en-US"
      },
      "signCommand": null
    },
    "macOS": {
      "frameworks": [],
      "minimumSystemVersion": "10.15"
    }
  },
  "plugins": {
    "updater": {
      "endpoints": ["https://updates.dashboard.example.com/latest.json"],
      "pubkey": "BAKED_IN_UPDATER_PUBLIC_KEY_HERE"
    }
  }
}
```

The fields that matter most:

- **`identifier`** — a unique string for your app. Used by the OS to namespace things (the app-data directory comes from this). Don't change it after launch; doing so means existing installs lose their settings.
- **`version`** — the version that gets compared by the auto-updater. Bump on every release.
- **`build.frontendDist`** — where the production React build lives. `npm run build` writes here.
- **`security.csp`** — Content Security Policy for the webview. Restrict to `'self'` so the webview can't load arbitrary scripts. (This is also why all data fetches go through Rust — the CSP forbids the webview from making outbound HTTP calls directly.)
- **`bundle.targets`** — which installers to build. `"all"` means everything supported on the current OS; you can also list explicitly (`["msi", "nsis"]` for Windows, etc.).
- **`plugins.updater`** — the auto-updater config. `endpoints` is where the app polls for updates; `pubkey` verifies update manifests are signed by us. See §6.

---

## 4. Building production installers

Run:

```bash
$ npm run tauri build
```

This compiles Rust in release mode (~3–5 minutes), runs `npm run build` to produce the React production bundle, packages everything into installers for the current OS, and outputs them to `src-tauri/target/release/bundle/`.

You'll get something like:

- `src-tauri/target/release/bundle/msi/PowerFab Dashboard_1.0.0_x64_en-US.msi` (Windows)
- `src-tauri/target/release/bundle/dmg/PowerFab Dashboard_1.0.0_x64.dmg` (Mac)
- `src-tauri/target/release/bundle/appimage/powerfab-dashboard_1.0.0_amd64.AppImage` (Linux)

The build only produces installers for the host OS. To build for all three OSes, you need either three machines or a CI pipeline that runs on three OSes — covered in doc 13.

### 4.1 Build sizes

Tauri installers are usually small:
- Windows .msi: ~5–10 MB
- macOS .dmg: ~6–12 MB
- Linux .AppImage: ~10–18 MB (includes the AppImage runtime)

Compare with Electron at ~80 MB. The savings are real because we're using the OS's built-in webview.

### 4.2 What about ARM Macs / ARM Windows?

Apple Silicon Macs need an arm64 build. From an Intel Mac, you cross-compile with:

```bash
$ npm run tauri build -- --target aarch64-apple-darwin
```

From an Apple Silicon Mac, do the same for x64:

```bash
$ npm run tauri build -- --target x86_64-apple-darwin
```

Or, more easily, ship a "universal" build that contains both:

```bash
$ npm run tauri build -- --target universal-apple-darwin
```

ARM Windows is rare enough you can skip it for now.

---

## 5. Code signing — the painful part

Unsigned installers trigger scary warnings (Windows SmartScreen) or outright refuse to launch (macOS Gatekeeper). You must sign.

### 5.1 Windows signing

You need a **code-signing certificate**, ideally an **EV (Extended Validation) cert**. Difference:

- **Standard OV cert**: ~$100–250/year, file-based. Avoids the "from an unknown publisher" warning *after* SmartScreen builds reputation (usually thousands of downloads). New customers may still see warnings for months.
- **EV cert**: ~$300–500/year, ships on a USB hardware token. Avoids SmartScreen warnings *immediately*. Required for any commercial product.

Get the EV cert. Sources: DigiCert, Sectigo, SSL.com.

**Signing workflow:**

1. The EV cert lives on a USB token plugged into the signing machine.
2. In `tauri.conf.json`:
   ```jsonc
   "bundle": {
     "windows": {
       "signCommand": "signtool.exe sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 /a \"%1\""
     }
   }
   ```
   `signtool` is part of the Windows SDK. The `/a` flag picks the best cert from the certificate store (which the token populates when plugged in).
3. After `tauri build` produces the .msi, signtool signs it.

In CI, you can use a remote-signing service (DigiCert KeyLocker, AzureSignTool with Azure Key Vault) so you don't have to ship the USB token around. Doc 13 has the CI pieces.

### 5.2 macOS signing + notarization

For Mac you need an **Apple Developer Program** membership ($99/year). It gives you:

- A **Developer ID Application certificate** for signing.
- The ability to **notarize** builds (submit to Apple, get a stamp back).

**Signing + notarization workflow:**

1. Generate the Developer ID Application cert in Apple's developer portal. Download it to your Mac's Keychain.
2. In `tauri.conf.json`:
   ```jsonc
   "bundle": {
     "macOS": {
       "signingIdentity": "Developer ID Application: Your Company, LLC (XXXXXXXXXX)",
       "providerShortName": "XXXXXXXXXX"
     }
   }
   ```
3. Set env vars before `tauri build`:
   ```bash
   export APPLE_ID="your-apple-id@example.com"
   export APPLE_PASSWORD="<app-specific-password>"  # NOT your iCloud password; generate one in appleid.apple.com
   export APPLE_TEAM_ID="XXXXXXXXXX"
   ```
4. `tauri build` signs the .app, packages it into a .dmg, signs the .dmg, submits to Apple for notarization, waits (1–15 minutes), staples the notarization to the .dmg.

The first time you do this, things will go wrong. Common errors:

- "An app-specific password is required" — generate one at `appleid.apple.com → Sign-In and Security → App-Specific Passwords`.
- "The provider could not be found" — make sure `APPLE_TEAM_ID` matches your developer team.
- Notarization fails with "the binary contains an unsigned framework" — Tauri's bundling of dependencies needs `--deep` signing or a `hardenedRuntime` flag.

Allow a full day to get the first signed + notarized Mac build out.

### 5.3 Linux signing

Linux doesn't really have a signing equivalent. AppImage builds are unsigned by default; users either trust your domain (download from `https://updates.dashboard.example.com/...`) or don't.

For .deb / .rpm packages, you'd sign with GPG and publish a repo, but that's only worth it if you have many Linux customers. For our use case (mostly Windows + some Mac), don't bother.

---

## 6. The auto-updater

Tauri ships with a built-in updater. Setup:

### 6.1 Generate an updater key pair (one time)

```bash
$ npx tauri signer generate -w ~/.tauri/updater.key
```

Outputs a private key and a public key. The public key goes in `tauri.conf.json` under `plugins.updater.pubkey`. The private key stays in your password manager — it signs every update bundle.

### 6.2 Build + sign update bundles

```bash
$ TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/updater.key) \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  npm run tauri build
```

This produces, in addition to the installers, an `*.sig` file per installer (the signature) and a manifest stub.

### 6.3 Host the update manifest

Create `latest.json` at the URL in `tauri.conf.json` (`https://updates.dashboard.example.com/latest.json`). Format:

```jsonc
{
  "version": "1.2.3",
  "notes": "Bug fixes and a new Estimating metric.",
  "pub_date": "2026-05-14T10:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<contents of the .sig file>",
      "url": "https://updates.dashboard.example.com/PowerFab.Dashboard_1.2.3_x64-setup.msi"
    },
    "darwin-aarch64": {
      "signature": "...",
      "url": "https://updates.dashboard.example.com/PowerFab.Dashboard_1.2.3_aarch64.dmg"
    }
  }
}
```

Upload the installers to the same domain.

### 6.4 What the app does at runtime

On startup (and periodically thereafter), Tauri's updater plugin:

1. Fetches `https://updates.dashboard.example.com/latest.json`.
2. Compares `version` against the running version.
3. If newer, downloads the platform-appropriate installer.
4. Verifies the signature against the baked-in public key.
5. Shows the user a "Update available — restart to install" prompt.

If verification fails (e.g., someone tampered with the .msi on the server), the update is rejected. The updater public key is the same kind of "trust anchor" as the license-key public key — bake it in, never change.

### 6.5 Hosting options

The update server is static files. Options:

- **R2 + a public bucket + a Cloudflare-managed domain.** Cheap, fast, zero ops.
- **S3 + CloudFront.** Standard, slightly more setup.
- **GitHub Releases.** Tauri has built-in support for GitHub Releases as an update endpoint; great if your repo is open and free if your repo is private and you fit GitHub's bandwidth limits.

Pick one. They're all fine at our scale.

---

## 7. The seven specific bugs (and the fixes)

### 7.1 `npm run tauri dev` opens a blank window

Vite is slow to start, Tauri's webview opens before Vite is ready, you see a blank window. Vite catches up after a second; the webview doesn't auto-refresh.

**Fix:** `tauri.conf.json` → `build.beforeDevCommand: "npm run dev"`, and wait for Vite's "ready" message before Tauri opens the window. Or click reload in the dev tools.

### 7.2 Rust changes don't trigger a rebuild

`npm run tauri dev` watches `src-tauri/src/*.rs` but not other files (like Cargo.toml).

**Fix:** Edit a `.rs` file with a trivial change to force a rebuild, then revert.

### 7.3 "Unsigned binary" warning on Windows even with EV cert

You signed, but didn't timestamp.

**Fix:** Use a timestamp server in your sign command (`/tr http://timestamp.digicert.com /td sha256`). Without the timestamp, Windows treats the signature as valid only until your cert expires, then everyone's existing copy stops being trusted.

### 7.4 macOS notarization "in progress" forever

You submitted, didn't wait for the response, the build script exited too early.

**Fix:** Use `xcrun notarytool ... --wait`. Tauri does this by default; if you're running notarization separately, don't forget `--wait`.

### 7.5 Auto-updater fails with "signature mismatch"

Two common causes: (a) the manifest's `signature` field has line breaks in it, breaking parsing; (b) the public key in `tauri.conf.json` was regenerated between releases.

**Fix:** Treat `signature` as a single-line string (no JSON-encoding quirks). Lock the public key for the life of the app.

### 7.6 "WebView2 not found" on Windows 7 (if anyone is still on it)

WebView2 is only included by default on Windows 10/11.

**Fix:** Bundle the WebView2 bootstrapper. Tauri can do this — set `tauri.conf.json` → `bundle.windows.webviewInstallMode = "embedBootstrapper"`. Adds a few MB to the installer but no extra customer steps.

### 7.7 Tauri commands return `null` instead of throwing on Rust errors

A common surprise. If your Rust command returns `Result<T, E>`, `Err(e)` becomes a rejected Promise on the JS side. But if your command is `Result<T, ()>` (unit error), the error becomes `null`.

**Fix:** Return `Result<T, String>` (or another serializable error type). Always. Doc 09's examples do this.

---

## 8. A realistic dev → release flow

To pull it together — what a release looks like end to end for a small change:

1. Branch off `main`, make changes, commit.
2. `npm run tauri dev` — sanity check it works.
3. Open a PR.
4. CI (doc 13) runs `npm run validate:tenants`, `npm run tsc`, `npm test`. Green.
5. Merge to `main`.
6. CI builds + signs installers for Windows, Mac (notarized), Linux.
7. CI publishes installers to the update server.
8. CI updates `latest.json` to point at the new version.
9. (Hours pass.) Customers' apps poll `latest.json`, see a new version, download it.
10. User clicks "restart to update," restarts, new version running.

A small change goes from `git push` to "in customers' hands" in roughly 24 hours, gated by users actually restarting their apps.

---

## 9. By the end of this doc you should know

- How to run Tauri in dev mode, with HMR, in under a minute.
- How to activate the app in dev without juggling real license keys.
- Every meaningful field of `tauri.conf.json`.
- How to build installers for Windows, Mac, and Linux.
- The two flavors of Windows code-signing cert (standard vs. EV) and why EV is worth it.
- The Mac signing + notarization workflow and the common errors.
- That Linux signing is not really a thing for desktop.
- How the Tauri auto-updater works: key pair, signed bundles, `latest.json`, on-launch poll.
- Where to host the update server (R2, S3, or GitHub Releases — pick one).
- The seven specific bugs that bite first-time users.
- The realistic time-to-customer for a release: ~24 hours.

---

**Next:** [`13-ci-cd.md`](./13-ci-cd.md) — automating the build/sign/release flow for all three OSes in GitHub Actions (or your CI of choice).
