# 13 — CI/CD with GitHub Actions: Multi-OS Builds, Signing, and Publishing Updates

> **Prerequisites:** read 00, 02, 05, 11, and 12. 12 in particular is the foundation — this doc is "automate everything 12 walks through manually."

> **By the end of this doc you will know:** what CI/CD actually means. The GitHub Actions vocabulary you need before the YAML stops looking like alphabet soup. A complete `.github/workflows/release.yml` walked piece by piece. How to build for Windows, Mac, and Linux in one run using matrix builds. How to sign Windows binaries in CI without shipping a USB token. How to notarize Mac binaries in CI. How to publish the auto-updater manifest atomically. How to roll back fast when something does ship broken. Eight bug/fix pairs.

This is the doc that turns "I push to main and hope the build works on my laptop later" into "I push to main and 30 minutes later signed installers are available for download." If 12 is *how* a release happens, this is *the safety net underneath every release.*

The most valuable artifact is §4 (the workflow YAML). If anything has to be cut for length, that stays.

---

## 1. What CI/CD actually means

Two phrases jammed together that everyone uses interchangeably. Let's separate them.

**CI — Continuous Integration.** Every push triggers an automated server to pull your code, install dependencies, run your type checker, run tests, run any other checks, and report pass/fail. The point: catch broken code at push time instead of "9 a.m. Monday from a customer email."

**CD — Continuous Deployment.** When CI passes on the right branch, that same server takes the just-built artifact and ships it to wherever it goes — for us, that's the update server (the static-file host hosting installers and `latest.json`). No human runs `tauri build` from a laptop. The pipeline does.

Stitched together: **CI/CD is a robot that re-checks every change and ships only the changes that pass.** The robot is GitHub Actions. The checks are npm scripts. The build/sign step is `tauri-cli` plus the OS signing tools. The publish step is "upload these files to the right URL."

A solo dev needs this *more* than a five-person team does. A team has at least one extra pair of eyes on a PR. You don't. The pipeline is your second pair of eyes — and unlike a teammate, it never gets tired, never deploys at 11 p.m. while distracted, and never forgets to run the tenant validator.

---

## 2. The GitHub Actions vocabulary

Eleven terms you'll see in YAML. Definitions first; we'll use them in §4.

- **Workflow** — a YAML file in `.github/workflows/`. One workflow per file. The whole thing runs in response to an event.
- **Event / trigger** — what fires a workflow. `on: push` runs on every push. `on: pull_request` on every PR. `on: workflow_dispatch` lets you start it manually from the UI.
- **Job** — a unit of work that runs on a fresh runner. Jobs in a workflow can run in parallel by default; you make them sequential with `needs:`.
- **Runner** — the virtual machine the job runs on. `ubuntu-latest`, `macos-latest`, `windows-latest`. GitHub provides them.
- **Step** — one command (or one action invocation) inside a job. Steps run sequentially.
- **Action** — a reusable script someone else (or you) wrote. `actions/checkout@v4` checks out your code. `actions/setup-node@v4` installs Node.
- **Matrix** — a way to run the same job multiple times with different inputs. We use it to run "build" on three OSes simultaneously.
- **Artifact** — a file produced by a job that gets uploaded for other jobs (or you) to download later.
- **Secret** — a key/value stored in your repo settings, available to jobs as `${{ secrets.NAME }}`. Never appears in logs. We use these for signing certs, Apple credentials, update-server credentials.
- **Environment** — a named context with its own secrets and approval rules. You might have a `production` environment that requires manual approval before deploying.
- **`needs:`** — a way to say "this job depends on that job finishing first."

---

## 3. The release model

For our project, what triggers a release?

There are two reasonable patterns:

### 3.1 Tag-driven (recommended)

Pushing a Git tag like `v1.2.3` triggers a release workflow that builds + signs + publishes installers for that version. Day-to-day pushes only run CI checks (validate, type-check, test); they don't build installers.

**Pros.**
- Releases are explicit. No accident-of-a-merge gets shipped.
- The tag *is* the release version. Easy to roll back ("revert the tag," more or less).
- Lighter CI on every push (no expensive build runs).

**Cons.**
- One extra step (push tag).

### 3.2 Main-branch-driven

Every push to `main` builds + signs + publishes. Version comes from `package.json` / `tauri.conf.json`.

**Pros.**
- Zero ceremony.

**Cons.**
- Every merge produces a release. If you forget to bump the version, the auto-updater doesn't see a new version (or you get duplicate releases).
- Easy to accidentally ship in-progress work.

**Recommendation: tag-driven.** A `release: ...` PR that bumps the version + opens a tag is the cleanest pattern.

---

## 4. The full workflow YAML

Here's a complete, working `.github/workflows/release.yml`. Pasted as-is, then walked piece by piece.

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  ci:
    name: Pre-release checks
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run validate:tenants
      - run: npm run typecheck
      - run: npm test

  build:
    name: Build ${{ matrix.os }}
    needs: ci
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: windows-latest
            target: x86_64-pc-windows-msvc
            artifact: PowerFab.Dashboard_*.msi
          - os: macos-latest
            target: aarch64-apple-darwin
            artifact: PowerFab.Dashboard_*.dmg
          - os: macos-latest
            target: x86_64-apple-darwin
            artifact: PowerFab.Dashboard_*.dmg
          - os: ubuntu-latest
            target: x86_64-unknown-linux-gnu
            artifact: powerfab-dashboard_*.AppImage
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}

      - name: Install Linux deps
        if: matrix.os == 'ubuntu-latest'
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev \
            libappindicator3-dev \
            librsvg2-dev \
            patchelf

      - run: npm ci

      - name: Build the Tauri app
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_UPDATER_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_UPDATER_PRIVATE_KEY_PASSWORD }}
          # macOS signing/notarization
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          # Windows signing (Azure Key Vault, see §6)
          AZURE_KEY_VAULT_URI: ${{ secrets.AZURE_KEY_VAULT_URI }}
          AZURE_KEY_VAULT_CLIENT_ID: ${{ secrets.AZURE_KEY_VAULT_CLIENT_ID }}
          AZURE_KEY_VAULT_CLIENT_SECRET: ${{ secrets.AZURE_KEY_VAULT_CLIENT_SECRET }}
          AZURE_KEY_VAULT_TENANT_ID: ${{ secrets.AZURE_KEY_VAULT_TENANT_ID }}
          AZURE_KEY_VAULT_CERT_NAME: ${{ secrets.AZURE_KEY_VAULT_CERT_NAME }}
        run: npm run tauri build -- --target ${{ matrix.target }}

      - name: Upload installer artifacts
        uses: actions/upload-artifact@v4
        with:
          name: installer-${{ matrix.target }}
          path: |
            src-tauri/target/${{ matrix.target }}/release/bundle/**/${{ matrix.artifact }}
            src-tauri/target/${{ matrix.target }}/release/bundle/**/*.sig

  publish:
    name: Publish to update server
    needs: build
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4

      - name: Download all installers
        uses: actions/download-artifact@v4
        with:
          path: artifacts/

      - name: Configure AWS / S3 credentials (or R2)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.UPDATES_R2_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.UPDATES_R2_SECRET_ACCESS_KEY }}
          aws-region: auto

      - name: Upload installers to update server
        run: |
          aws s3 cp artifacts/ s3://updates-dashboard/${{ github.ref_name }}/ \
            --recursive \
            --endpoint-url ${{ secrets.UPDATES_R2_ENDPOINT_URL }}

      - name: Build latest.json manifest
        run: node scripts/build-update-manifest.mjs ${{ github.ref_name }} > latest.json

      - name: Publish latest.json (atomic swap)
        run: |
          aws s3 cp latest.json s3://updates-dashboard/latest.json.new \
            --endpoint-url ${{ secrets.UPDATES_R2_ENDPOINT_URL }}
          aws s3 mv s3://updates-dashboard/latest.json.new s3://updates-dashboard/latest.json \
            --endpoint-url ${{ secrets.UPDATES_R2_ENDPOINT_URL }}
```

Now the walk-through.

### 4.1 `on: push: tags: 'v*'`

The whole workflow only fires when you push a tag starting with `v`. Normal pushes to `main` don't trigger it. (You'd have a separate, lighter workflow for PR checks; I'm focusing on the release one here.)

### 4.2 The `ci` job

Runs once, on Linux, before any expensive build. Three gates:

- **`npm run validate:tenants`** — the Zod validator from doc 02 §8. A typo in any `tenants/*.json` fails the build *before* the expensive multi-OS Tauri compile starts. Saves 20 minutes of CI time and surfaces the error fast.
- **`npm run typecheck`** — strict `tsc --noEmit`. A type error fails the build.
- **`npm test`** — unit tests. Whatever you have.

### 4.3 The `build` job — matrix

The matrix runs **four parallel jobs**: Windows x64, Mac arm64, Mac x64, Linux x64. Each job is independent. `fail-fast: false` means if Linux fails, Windows and Mac still complete (so you can see all the failures, not just the first).

`include:` lets you specify per-matrix-cell values — the target triple, the OS, the artifact glob pattern.

`runs-on: ${{ matrix.os }}` is the magic line: it picks the OS based on the matrix entry. Windows builds run on `windows-latest`, Mac on `macos-latest`, etc.

### 4.4 Installing system deps

Tauri needs system libraries on Linux (WebKitGTK and friends) that aren't pre-installed on `ubuntu-latest`. The conditional `if: matrix.os == 'ubuntu-latest'` step installs them. Adds ~30 seconds.

Windows and macOS runners have everything we need pre-installed.

### 4.5 The build step + secrets

`tauri build --target <triple>` produces installers and (if updater is configured) `.sig` files. The environment variables pass through all the signing material.

Notice we never inline a secret in the YAML — it's always `${{ secrets.NAME }}`. GitHub redacts these from logs automatically.

### 4.6 The `publish` job

Runs after all four `build` jobs succeed. Downloads every artifact, uploads to the update server, builds and publishes `latest.json`.

**`environment: production`** enables manual approval gates. You can require a click in the GitHub UI before this job actually runs — useful if you want a final "yes, ship this" moment.

### 4.7 The atomic manifest swap

Two-step publish for `latest.json`:

1. Upload to `latest.json.new`.
2. Atomically rename to `latest.json`.

Why? Because if you uploaded directly to `latest.json` and the upload was interrupted halfway, customer apps polling at that moment could see a half-written manifest, fail to parse it, and silently stop updating. The atomic swap means `latest.json` is always either the old version or the new version — never a torn write.

---

## 5. Signing Windows binaries in CI (the Azure Key Vault dance)

Doc 12 §5.1 said EV certs come on a USB hardware token. You can't plug a token into GitHub's runners. So how do you sign in CI?

The standard answer is **Azure Key Vault** with a hardware-backed key. Process:

1. Buy an EV code-signing cert from a CA that supports Azure Key Vault key generation (e.g., SSL.com, Sectigo).
2. During issuance, the CA generates the private key inside Azure Key Vault (you don't get a physical token).
3. You install **AzureSignTool** in your build pipeline — a `signtool`-replacement that signs by calling Azure Key Vault to use the key remotely.
4. Tauri's `signCommand` in `tauri.conf.json` calls AzureSignTool with the right flags.

The Azure Key Vault setup is fiddly the first time. Allow a day. The advantages over a USB token:

- Works in CI.
- Multiple people can be authorized to sign without sharing a physical token.
- Audit trail of every signing operation.
- Can't be physically lost.

For Mac, no such issue — you just keep the signing cert in GitHub Secrets (as a base64-encoded `.p12` file with a password). The workflow `keychains` actions decode it into a temporary keychain at the start of the build.

Linux: still no signing.

---

## 6. Building the manifest

`scripts/build-update-manifest.mjs` produces the `latest.json` from the artifacts in the publish job. Sketch:

```js
// scripts/build-update-manifest.mjs
import fs from 'fs';
import path from 'path';

const version = process.argv[2].replace(/^v/, '');
const base = `https://updates.dashboard.example.com/v${version}`;

function readSig(fname) {
  // .sig files live next to their installers
  return fs.readFileSync(path.join('artifacts', fname), 'utf8').trim();
}

const manifest = {
  version,
  notes: process.env.RELEASE_NOTES || '',
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: readSig('installer-x86_64-pc-windows-msvc/PowerFab.Dashboard_*.msi.sig'),
      url: `${base}/PowerFab.Dashboard_${version}_x64_en-US.msi`,
    },
    'darwin-aarch64': {
      signature: readSig('installer-aarch64-apple-darwin/PowerFab.Dashboard_*.dmg.sig'),
      url: `${base}/PowerFab.Dashboard_${version}_aarch64.dmg`,
    },
    'darwin-x86_64': {
      signature: readSig('installer-x86_64-apple-darwin/PowerFab.Dashboard_*.dmg.sig'),
      url: `${base}/PowerFab.Dashboard_${version}_x64.dmg`,
    },
    'linux-x86_64': {
      signature: readSig('installer-x86_64-unknown-linux-gnu/powerfab-dashboard_*.AppImage.sig'),
      url: `${base}/powerfab-dashboard_${version}_amd64.AppImage`,
    },
  },
};

console.log(JSON.stringify(manifest, null, 2));
```

You'd want to refine the glob patterns to handle the real artifact names, but this is the shape.

---

## 7. Rolling back fast

Something shipped broken. How do you roll back?

The auto-updater is the constraint: customer apps will refuse to "downgrade" to an older version automatically. So "rollback" really means "publish a *new* version that's the same as the old one."

The fast steps:

1. Identify the last known good version (e.g., `v1.2.2`).
2. Push a tag `v1.2.4` from the `v1.2.2` commit. CI builds new installers from that commit, with version `1.2.4`.
3. The new manifest points at `v1.2.4`.
4. Customers' auto-updaters poll, see the "new" version, install. Effectively: a rollback wearing the disguise of a forward update.

Time-to-rollback: ~30 minutes (build + sign + publish) plus the auto-updater poll cadence (~24 hours worst case).

To speed this up:

- Keep the previous installers on the update server. Don't delete them; they're tiny.
- For really fast rollback, have an "emergency hotfix" workflow with manual approval that skips matrix and only rebuilds one OS at a time.
- If a customer is on fire, hand them a direct download link to the previous installer (they reinstall manually, immediate).

---

## 8. The PR-check workflow (lighter than the release one)

You also want CI on every PR. A small workflow `.github/workflows/pr-check.yml`:

```yaml
name: PR check
on: [pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run validate:tenants
      - run: npm run typecheck
      - run: npm test
      - run: npm run lint
```

That's plenty for PR-time. The expensive multi-OS Tauri build only happens on tag push.

---

## 9. Eight bug/fix pairs

### 9.1 Build fails on Windows with "MSBuild not found"

Newer Windows runners use a different default Visual Studio version.

**Fix:** Add an explicit `microsoft/setup-msbuild` action, or pin to a specific runner version (`windows-2022`).

### 9.2 Mac build hangs in notarization

`tauri build` submitted the binary but didn't wait long enough.

**Fix:** Tauri waits by default; if you're customizing, ensure `xcrun notarytool ... --wait` is used.

### 9.3 Mac signing fails with "no identity found"

The keychain doesn't have your Developer ID cert because we never decoded it.

**Fix:** Add a step before build that decodes the base64 `.p12` from secrets into a temporary keychain. There are pre-built actions for this (e.g., `apple-actions/import-codesign-certs`).

### 9.4 Linux AppImage missing libraries

Not all WebKitGTK deps are installed.

**Fix:** Use the exact apt list from doc 12 §2.1. Re-check the Tauri Linux deps page for changes.

### 9.5 Auto-updater fails for users on the new version

`latest.json` is correct, installers are correct, but updates don't apply.

**Fix:** Check that the `signature` field is the **raw contents** of the `.sig` file, not base64-of-base64 or otherwise re-encoded. A common mistake when scripts read the file in the wrong mode.

### 9.6 Build is slow (>30 minutes)

Cargo's incremental compile state isn't shared between runs.

**Fix:** Add `Swatinem/rust-cache@v2`. Caches the `target/` directory across runs. Brings 20-minute Rust builds down to 2–3 minutes after warmup.

### 9.7 Secrets accidentally appearing in logs

You logged an env var.

**Fix:** GitHub auto-redacts known secrets. But if you `echo` a value into something or use it in a filename, it can leak. Audit any step that touches a secret.

### 9.8 The publish job ran on a half-built artifact

A `build` matrix entry failed but `publish` still tried to download all artifacts.

**Fix:** Use `if: success()` on the publish job (which is the default), and consider explicit `needs:` listing each matrix cell so a failure in any one cell halts the publish.

---

## 10. A 60-second mental model of the whole thing

You push tag `v1.2.3`. Twenty-five minutes later:

1. CI passed: tenants validated, types check, tests pass.
2. Three runners spun up in parallel (Windows, Mac×2, Linux). Each compiled Tauri, signed the artifact, uploaded it.
3. A fourth job pulled all artifacts, uploaded them to the update server under `v1.2.3/`, built `latest.json`, atomically swapped it in.
4. Customer apps poll `latest.json`, see version `1.2.3`, download, prompt to restart.
5. Restarts roll out over the next 24 hours.

End to end: code change → in customers' hands ≈ a day, with no manual steps after `git tag && git push --tags`.

---

## 11. By the end of this doc you should know

- What CI/CD actually means and why a solo dev needs it more than a team does.
- The 11 pieces of GitHub Actions vocabulary.
- The tag-driven release model (and why it beats push-to-main).
- A complete `.github/workflows/release.yml` walked line by line.
- How to sign Windows in CI without a physical USB token (Azure Key Vault).
- How to sign and notarize Mac in CI.
- How to build the `latest.json` manifest and publish it atomically.
- How to roll back quickly when something ships broken.
- Eight specific build-CI bugs and their fixes.

---

**Next:** [`14-observability-and-cost.md`](./14-observability-and-cost.md) — what you actually pay for in the desktop world, and how to know if a deployed app is failing somewhere without poking at customer machines.
