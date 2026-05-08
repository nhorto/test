# 13 — CI/CD with GitHub Actions: Gates, Deploys, and Why a Solo Dev Needs Them

> **Pre-reqs:** Read `00-start-here.md`, `02-config.md`, `05-cloudflare-architecture.md`, and `11-tenant-lifecycle.md`. 00 has the vocabulary (tenant, slug, KV, R2). 02 explains the tenant config and why it's Zod-validated. 05 explains the Pages + Workers target. 11 explains how a single broken `tenants/<slug>.json` is the highest-impact mistake you can make on this stack — that's the failure mode this doc's gates exist to catch.
>
> **What you'll know by the end:** What CI/CD actually means in plain English. Eleven pieces of GitHub Actions vocabulary you have to know before the YAML stops looking like alphabet soup. A complete `.github/workflows/deploy.yml` walked line by line. The `validate-tenants.ts` script walked line by line, and why it has to be a hard gate, not a "remember to run it locally" habit. How preview deploys work and why you must isolate the preview KV namespace from production. How secrets get from your repo settings to a running job without ever appearing in a log. Eight bug/fix pairs. How to roll back fast when something does ship broken.

This is the doc that turns "I push to main and hope it works" into "I push to main and the system refuses to ship anything broken." If `11` is *what* an onboarding looks like, this doc is *the safety net underneath every deploy that supports one*.

The most valuable artifacts are §3 (the workflow YAML) and §6 (the validator script). If anything has to be cut for length, those two stay.

---

## 1. What CI/CD actually means

Two phrases jammed together that everyone uses interchangeably. Let's separate them.

**CI — Continuous Integration.** Every push triggers an automated server to pull your code, install dependencies, run your type checker, run tests, run any other checks, and report pass/fail. The point: catch broken code at push time instead of "9 a.m. Monday from a customer email."

**CD — Continuous Deployment.** When CI passes on the right branch, that same server takes the just-built artifact and ships it to your hosting platform — Cloudflare Pages and Workers in our case. No human runs `wrangler deploy` from a laptop. The pipeline does.

Stitched together: **CI/CD is a robot that re-checks every change and ships only the changes that pass.** The robot is GitHub Actions. The checks are pnpm scripts. The ship step is the wrangler CLI. The whole thing lives in one YAML file.

A solo dev needs this *more* than a five-person team does. A team has at least one extra pair of eyes on a PR. You don't. The pipeline is your second pair of eyes — and unlike a teammate, it never gets tired, never deploys at 11 p.m. while distracted, and never forgets to run the tenant validator. The foot-guns this catches — a `tenants/acme.json` typo, a TypeScript error Vite silently transpiled past, a `node_modules` mismatch between laptop and production — are exactly the ones a solo dev is most exposed to.

---

## 2. Vocabulary primer

GitHub Actions has its own dialect. Define every term once, then nothing in §3 surprises you.

- **Workflow** — a YAML file in `.github/workflows/`. GitHub finds it automatically; no registration step. One repo can have many workflow files. We have one: `deploy.yml`.
- **Trigger** (`on:` in YAML) — the event that starts a workflow running. Examples: a push to `main`, a pull request opened, a manual button click. Without a trigger, the workflow never runs.
- **Job** — a named group of steps that runs on one machine, top to bottom, stopping on the first failure. A workflow can have multiple jobs that run in parallel; we have one job called `ci`.
- **Step** — one thing the job does. Either a shell command (`run: pnpm test`) or a pre-built reusable unit (`uses: actions/checkout@v4`). Steps inside a job share a working directory and environment variables.
- **Runner** — the actual virtual machine the job runs on. We use `ubuntu-latest`, which is a fresh Ubuntu VM that GitHub spins up for the job and throws away when the job finishes. Every run starts from a clean slate.
- **Action** — a reusable, versioned, named step published on the GitHub Marketplace. Referenced like `actions/checkout@v4`. Think of it as an npm package for CI steps. The `@v4` is the version pin, exactly like a semver tag.
- **Secret** — an encrypted value stored in your repo's Settings page. Injected into a step at runtime as an environment variable. Never appears in a log; if it does try to appear, GitHub replaces it with `***` automatically. We use two: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- **Gate** — a step whose job is to fail the run if a condition isn't met. Type-checking is a gate. Tenant validation is a gate. Tests are a gate. Gates run *before* the build and deploy steps so a failure stops the deploy.
- **Preview deploy** — a deployment to a temporary, isolated URL, separate from production, generated for a pull request. Lets you click around the change in a real browser before merging. Cloudflare Pages creates one automatically when you call `wrangler pages deploy` with a non-`main` branch flag.
- **Rollback** — undoing a deploy. Either by reverting the offending commit (slow, safe, re-runs all gates) or by telling Cloudflare to re-serve a previous deployment (fast, skips gates — emergency only).
- **Frozen lockfile** — telling pnpm "install exactly what `pnpm-lock.yaml` says, do not upgrade anything, fail if the lockfile is out of date." The flag is `--frozen-lockfile`. Without it, CI can silently install a newer version of a transitive dependency than the one on your laptop, and your "tested locally" changes don't match what shipped.

That's the whole dialect. Eleven words. Now the YAML reads like English.

---

## 3. The full workflow YAML, line by line

This is the artifact. One file, `.github/workflows/deploy.yml`, runs both PR previews and production deploys. Drop it in, fill in the two secrets, push.

```yaml
name: CI / Deploy

on:
  push:
    branches: [main]
  pull_request:

jobs:
  ci:
    name: Type-check, Validate, Test, Build, Deploy
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - uses: pnpm/action-setup@v3
        with:
          version: 9

      - uses: actions/cache@v4
        with:
          path: ~/.pnpm-store
          key: ${{ runner.os }}-pnpm-${{ hashFiles('**/pnpm-lock.yaml') }}
          restore-keys: ${{ runner.os }}-pnpm-

      - run: pnpm install --frozen-lockfile

      - run: pnpm typecheck

      - run: pnpm validate:tenants

      - run: pnpm test

      - run: pnpm build

      - if: github.event_name == 'pull_request'
        run: pnpm wrangler pages deploy dist --project-name powerfab-dashboard --branch preview
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        run: pnpm wrangler pages deploy dist --project-name powerfab-dashboard --branch main
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Now, line by line.

### 3.1 Top matter and triggers

- `name: CI / Deploy` — the human-readable name shown in the Actions tab. Cosmetic.
- `on:` — opens the trigger block. Answers "when does this run?"
- `push: branches: [main]` — run on a push to `main`. The production deploy path.
- `pull_request:` (no qualifier) — run on any pull request, opened, synchronized, or reopened. The preview deploy path.

Two triggers, one workflow. The job body uses `if:` conditions to branch between preview and production — same checks, different deploy command.

### 3.2 The job header

- `jobs:` — opens the jobs block. A workflow can declare many jobs in parallel.
- `ci:` — the job's machine-readable id.
- `name:` — human-readable name shown in the UI.
- `runs-on: ubuntu-latest` — pick the runner. A fresh Ubuntu VM, reset every run.
- `steps:` — opens the step list. Steps run top to bottom; the first non-zero exit fails the job and skips the rest.

### 3.3 The setup steps (1–4)

The first four steps are pure plumbing — Node, pnpm, and the dependency cache.

```yaml
- uses: actions/checkout@v4
```

GitHub's official action that clones your repo into the runner at the exact commit that triggered the run. Without it, the runner is a blank VM with no code. `@v4` is the major version pin — frozen against upstream changes.

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 20
    cache: pnpm
```

Installs Node.js (LTS, version 20). `cache: pnpm` is a built-in shortcut that wires up cache hooks for pnpm's store. Without it, every run downloads every dependency cold.

```yaml
- uses: pnpm/action-setup@v3
  with:
    version: 9
```

Installs pnpm itself, pinned to major 9. Node ships with npm; pnpm has to be added explicitly.

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.pnpm-store
    key: ${{ runner.os }}-pnpm-${{ hashFiles('**/pnpm-lock.yaml') }}
    restore-keys: ${{ runner.os }}-pnpm-
```

The actual cache step:

- `path: ~/.pnpm-store` — what to cache. pnpm's content-addressed package store.
- `key:` — the lookup key. Three parts joined with hyphens: the runner's OS, the literal `pnpm`, and a hash of every `pnpm-lock.yaml` in the repo. Same lockfile = same key = instant hit. Different lockfile = miss = fresh download.
- `restore-keys:` — fallback prefixes on cache miss. If the new key misses, GitHub warm-starts from the most recent `Linux-pnpm-...` cache, and `pnpm install` only downloads the deltas.

The `${{ ... }}` syntax is GitHub Actions' expression language. `runner.os` and `hashFiles(...)` are built-in functions that evaluate at runtime.

### 3.4 The install step (5)

```yaml
- run: pnpm install --frozen-lockfile
```

A `run:` step is a shell command. This one tells pnpm: install exactly what `pnpm-lock.yaml` says, and **fail if the lockfile doesn't match `package.json`**.

Without the flag, CI can silently fix up a stale lockfile by upgrading transitive deps. Your laptop's `node_modules` and the runner's diverge. You tested version A; production ships version B. With the flag, the run fails fast with "lockfile is out of date." Annoying when it triggers; saves you from bugs that are almost impossible to reproduce.

### 3.5 The four gates (steps 6–9)

These are the checks that have to pass before any deploy. Order matters.

```yaml
- run: pnpm typecheck
```

Runs `tsc --noEmit` (configured in `package.json`'s `scripts.typecheck`). `--noEmit` means "type-check only; don't write output files." Vite — the bundler — does *not* type-check. It happily transpiles invalid TypeScript into runnable JS. Without this step, type errors ship to production as runtime crashes. Putting `tsc` here, before the build, is what makes TypeScript actually safe.

```yaml
- run: pnpm validate:tenants
```

Runs the script we walk in §6. Loads every `tenants/<slug>.json`, parses each with the Zod `TenantConfig` schema (defined in `02-config.md`), and exits non-zero if any file fails. **This is the single most PowerFab-specific line in the whole pipeline.** §9 explains why.

```yaml
- run: pnpm test
```

Vitest in run mode. Exits non-zero on any failure. Standard.

```yaml
- run: pnpm build
```

`vite build`. Output lands in `dist/`. This is the artifact the deploy step uploads.

The crucial detail: build comes *after* typecheck, validate, and test. If any of those three fails, the job stops, the build never runs, the deploy never runs. There is no "build despite errors" path. Gate ordering is enforced by step ordering, not by documentation.

### 3.6 The conditional deploy steps (10a, 10b)

```yaml
- if: github.event_name == 'pull_request'
  run: pnpm wrangler pages deploy dist --project-name powerfab-dashboard --branch preview
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

`if: github.event_name == 'pull_request'` — run only when triggered by a pull request. `github.event_name` is a built-in context variable holding the trigger name.

Walking the wrangler invocation:

- `pnpm wrangler` — invokes the wrangler CLI installed as a dev dependency.
- `pages deploy dist` — the Pages deploy subcommand; `dist` is the directory of static files (the Vite output).
- `--project-name powerfab-dashboard` — names the Cloudflare Pages project. Has to match a project you've already created in the Cloudflare dashboard. Pick the name once; the production URL is keyed on it.
- `--branch preview` — anything that isn't `main` becomes a preview-class deploy, with its own auto-generated subdomain on Cloudflare's preview hosting.

The `env:` block scopes two variables to *this step only*. `${{ secrets.CLOUDFLARE_API_TOKEN }}` pulls the encrypted value from repo secrets and decrypts it into the runner just for this step. Wrangler reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from env by convention. After the step ends, the variable is gone — secrets aren't global on the runner, so a different step's `printenv` wouldn't see them. Smaller blast radius.

```yaml
- if: github.ref == 'refs/heads/main' && github.event_name == 'push'
  run: pnpm wrangler pages deploy dist --project-name powerfab-dashboard --branch main
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

The production twin. Runs only when the trigger was a push *and* the branch is `main`. `github.ref` for a push is the full git ref (`refs/heads/main`). `&&` requires both conditions.

The wrangler call is identical except `--branch main`, which Cloudflare interprets as "production deploy."

You might be wondering why this isn't one clever line with `--branch ${{ github.head_ref }}`. The answer: the `if:` split is more explicit and harder to misread at 10 p.m. Two named paths beat one expression, especially when one path ships to production.

---

## 4. The pipeline as an ASCII diagram

Same workflow, drawn as a flow. Reading top to bottom corresponds to running steps top to bottom.

```
git push to main / PR opened or updated
                |
                v
        [actions/checkout@v4]
                |
                v
        [setup-node + pnpm + cache]
                |
                v
        [pnpm install --frozen-lockfile]
                |
                v
        [pnpm typecheck]  ----FAIL----> job stops, deploy blocked
                |
                v
        [pnpm validate:tenants]  ----FAIL----> job stops, deploy blocked
                |
                v
        [pnpm test]  ----FAIL----> job stops, deploy blocked
                |
                v
        [pnpm build]
                |
                v
        [wrangler pages deploy]
                |
         _______|_______
        |               |
        v               v
   preview URL     production URL
   (PR only)       (push to main only)
```

The shape to internalize: the four gates are the chokepoint. Anything broken hits one of those four blocks. The deploy only runs if the chokepoint clears.

---

## 5. Branch → environment mapping

Three paths, one workflow file.

| Branch | Trigger event | Deploy target | Wrangler flag |
|---|---|---|---|
| any feature branch | `pull_request` | Preview (per-PR URL) | `--branch preview` |
| `main` | `push` | Production | `--branch main` |
| `staging` (optional) | `push` | Staging | `--branch staging` |

We don't ship a `staging` branch in the MVP — preview-per-PR plus production is enough. If you add staging later, it's another `if:` block on the deploy step, same shape as the production one, with its own branch flag.

For the Worker (the Hono backend, separate from Pages), `wrangler.toml` defines named environments per `[env.NAME]` block — see `12-local-dev-and-deploy.md` for the toml setup. The CI workflow then passes `--env preview` or `--env production` to `wrangler deploy` to pick the right one. The branch-to-env mapping in CI must match a section name that actually exists in `wrangler.toml`, or wrangler silently falls back to the top-level config (pitfall #4 in §10).

---

## 6. The `validate-tenants.ts` script, line by line

Why this exists, in one sentence: a typo in `tenants/acme.json` will pass `JSON.parse`, pass `vite build`, pass `wrangler pages deploy`, and break Acme at runtime when the Worker tries to read a missing field. The Zod schema is the contract; this script enforces it before the deploy runs.

The whole script, ~18 lines:

```ts
// scripts/validate-tenants.ts
import { glob } from "glob";
import { readFileSync } from "fs";
import { TenantConfig } from "../src/schemas/tenant";

const files = glob.sync("tenants/*.json");
let failed = false;

for (const file of files) {
  const raw = JSON.parse(readFileSync(file, "utf-8"));
  const result = TenantConfig.safeParse(raw);
  if (!result.success) {
    console.error(`INVALID: ${file}`);
    console.error(result.error.format());
    failed = true;
  } else {
    console.log(`OK: ${file}`);
  }
}

if (failed) process.exit(1);
```

Walking it:

- `import { glob } from "glob";` — shell-style filename matching in Node. The script discovers tenant files; it doesn't hard-code their names.
- `import { readFileSync } from "fs";` — Node's sync file reader. Fine for a short-lived CI script.
- `import { TenantConfig } from "../src/schemas/tenant";` — the Zod schema from doc 02. **Single source of truth.** The Worker uses the same schema at request time. Same parser, two callers, no drift.
- `const files = glob.sync("tenants/*.json");` — every `.json` directly under `tenants/`. Returns relative paths.
- `let failed = false;` — accumulator. Validate every file before exiting, not bail on the first. If three files are bad, you want all three failures in one run.
- `for (const file of files) {` — loop the file paths.
- `const raw = JSON.parse(readFileSync(file, "utf-8"));` — read UTF-8, parse as JSON. This catches purely malformed JSON (a stray comma, an unquoted key); if it throws, the script fails CI.
- `const result = TenantConfig.safeParse(raw);` — hand to Zod. `safeParse` (vs `parse`) returns a result object with `success: boolean` instead of throwing, so we can keep going on failure.
- `if (!result.success) { ... } else { ... }` — branch on outcome.
- `console.error(`INVALID: ${file}`);` — flag the file on stderr.
- `console.error(result.error.format());` — Zod's `.format()` returns a structured tree of errors with field paths. Tells you exactly which field is wrong.
- `failed = true;` — set the flag; keep checking.
- `console.log(`OK: ${file}`);` — happy-path log to stdout. Confirms in CI that all files passed.
- `if (failed) process.exit(1);` — if any file failed, exit non-zero.

Why is `process.exit(1)` the part that "fails the step"? GitHub Actions decides pass/fail per step by reading the exit code of the process. **Exit 0 = success. Non-zero = failure. The job stops on the first failed step.** Any script that exits non-zero is a gate.

Add to `package.json`:

```json
{
  "scripts": {
    "validate:tenants": "tsx scripts/validate-tenants.ts"
  }
}
```

`tsx` runs TypeScript without a separate compile step. The CI step (`pnpm validate:tenants`) just calls this entry.

### 6.1 Why this has to be a CI gate, not a dev habit

Running `pnpm validate:tenants` locally before every commit is exactly the discipline a solo dev forgets at 11 p.m. on Sunday. A local-only check is hope, not safety.

CI inverts the default: the validator runs *every* push, regardless of what you remembered. Cost: one second of runner time. Benefit: a broken tenant config can never reach Cloudflare. For PowerFab — where one bad tenant file can break one customer or crash the Worker for *all* tenants on next deploy (pitfall #2 in `11`) — that asymmetry is overwhelmingly worth it.

---

## 7. Secrets — how the API token reaches wrangler safely

Wrangler needs a Cloudflare API token. We never want it in the repo, a log, or on a laptop. GitHub Actions secrets exist for this.

**Storage.** Repo → Settings → Secrets and variables → Actions → New repository secret. Add two: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. GitHub encrypts with libsodium before writing to disk. No UI to read them back; you can rotate or delete, not view.

**Reference in YAML.** `${{ secrets.CLOUDFLARE_API_TOKEN }}`. The runtime substitutes the decrypted value at the call site. Use only inside `env:` blocks scoped to the deploy steps (§3.6) — never as a global env, never echoed.

**Log masking.** GitHub maintains a list of secret values per run. Any matching string in stdout or stderr gets replaced with `***` before the log persists. Not bulletproof — base64-encoded or line-split values can slip through — but it covers the common case. The rule: never `echo` a secret, never `set-output` a secret (pitfall #7).

**Least-privilege Cloudflare token.** When creating the token in Cloudflare's dashboard, *don't* use the global API key (account-wide, edit-everything). Create a custom token with only:

- `Cloudflare Pages: Edit` — for `wrangler pages deploy`.
- `Workers Scripts: Edit` — for `wrangler deploy` of the Hono backend.

No `Account: Administrator`, no `Zone: Edit`, no DNS or billing scope. If the token leaks despite the precautions, the blast radius is "attacker can deploy to your project" — not "attacker can rotate your DNS, change billing, or read your KV data." Cloudflare-side scoping is the real security layer; GitHub masking is the seatbelt.

---

## 8. Preview deploys and KV namespace isolation

Every PR gets a deploy. Cloudflare Pages assigns a unique, hash-based subdomain on its preview hosting and serves the build there. The URL appears in the Actions log and in the Cloudflare dashboard. Click; see your branch live.

The dangerous half: which KV namespace is that preview bound to?

**Default behavior.** A preview deploy inherits production's KV namespace bindings. Preview code (possibly unreviewed) reads and writes the *real production* `TENANT_CONFIG` namespace. One bad write corrupts every tenant's config.

**Fix — separate preview namespace.** In `wrangler.toml`, override the binding inside `[env.preview]` so previews point at a throwaway namespace.

```toml
[[kv_namespaces]]
binding = "TENANT_CONFIG"
id = "PRODUCTION_NAMESPACE_ID"

[env.preview]
[[env.preview.kv_namespaces]]
binding = "TENANT_CONFIG"
id = "PREVIEW_NAMESPACE_ID"
```

The top-level binding is production. The `[env.preview]` block defines a *different* namespace ID for the same binding name. The Worker code is identical; the data layer is isolated. A preview that goes haywire writes garbage to a namespace nobody reads in production.

This is the highest-impact isolation step in the whole CI setup. Skip it and you've got a footgun pointed at every customer's config every time you open a PR. (See `12-local-dev-and-deploy.md` for the full `wrangler.toml` walk.)

---

## 9. Why we use `wrangler` from CI instead of Cloudflare's git integration

Cloudflare offers a "git integration" — connect a GitHub repo, Cloudflare watches for pushes and auto-deploys without any Actions workflow. Two-click, zero YAML.

Wrong choice for this stack, because **the git integration bypasses every CI gate.** It builds and ships. It doesn't run `pnpm typecheck`, `pnpm validate:tenants`, or `pnpm test`. A push with a typoed tenant file deploys, breaks a customer, and you find out via email.

Running `wrangler pages deploy` from inside Actions inverts the architecture: Actions controls the gates, the gates run *first*, the deploy is a consequence of passing. The workflow YAML — checked in, version-controlled, code-reviewable — is the source of truth.

Cost: ~30 lines of YAML and ~18 lines of validator. Benefit: a malformed tenant config, a TS error, or a broken test cannot reach Cloudflare. For a stack where a broken config silently breaks one customer, the Actions-driven approach is the only correct shape.

For the Hono Worker (separate Cloudflare product), `wrangler deploy` from CI is the only path — Cloudflare's git auto-deploy is a Pages-only feature.

---

## 10. Pitfalls — bug/fix pairs

**1. Echoing a secret.**
**Bug.** Someone adds `run: echo "Token: $CLOUDFLARE_API_TOKEN"` for debugging. Sometimes masking works (the line shows `Token: ***`); sometimes a subprocess base64s or splits the value and masking misses. Now the token sits in a log forever.
**Fix.** Never echo a secret in any form. To confirm a secret is set, log its length, not its value. Treat masking as backup, not primary defense.

**2. `validate:tenants` omitted from the workflow.**
**Bug.** You rewrite the workflow, remove the validator step "temporarily," forget to put it back. A PR ships with `tenants/new-customer.json` containing a typo. Build passes, deploy ships, the new customer 404s on first visit.
**Fix.** Mandatory ordering — install → typecheck → validate:tenants → test → build → deploy — encoded in the YAML, not in a checklist.

**3. `pnpm build` before `pnpm typecheck`.**
**Bug.** "Build is the slow step, run it first to fail faster." Vite transpiles past TS errors; the build succeeds with broken types; production crashes at runtime.
**Fix.** Typecheck always precedes build. The order isn't about speed; it's about which step catches which class of error.

**4. `--env` flag mismatched with `[env.X]` in `wrangler.toml`.**
**Bug.** Workflow passes `--env staging`; toml only defines `[env.preview]` and `[env.production]`. Wrangler silently falls back to the *top-level* config — which is production's — and deploys staging code with production bindings.
**Fix.** The `--env` flag must match an `[env.NAME]` section that actually exists. Silent fallback is the real bug; the mismatch is the trigger.

**5. `compatibility_date` set on the command line, not in `wrangler.toml`.**
**Bug.** A past `wrangler deploy --compatibility-date 2024-09-23` from a laptop diverges from CI's toml `2024-01-01`. Worker behaves differently in CI deploys than in the manual one.
**Fix.** Set `compatibility_date` only in `wrangler.toml`. Never on the CLI. The date lives in source control; everyone deploys the same semantics.

**6. Preview deploy bound to production's KV namespace.**
**Bug.** Default `wrangler.toml`: one `[[kv_namespaces]]`, no `[env.preview]` override. A preview test writes a malformed key. Production tenant resolution fails until you find and delete it.
**Fix.** The `[env.preview]` KV override from §8. The single most important hardening step.

**7. Secret leaked via `set-output` or `$GITHUB_OUTPUT`.**
**Bug.** A step computes a value that includes a secret substring and exposes it as a step output. The output escapes the `env:` scope and lands in a log or artifact.
**Fix.** Secrets travel only via `env:` blocks scoped to the step that needs them. Never as a step output, job output, or artifact.

**8. Auto-merge with an untrusted gate.**
**Bug.** Auto-merge is on. A PR opens, CI passes (because the same PR disabled the test that would have failed), auto-merges, ships.
**Fix.** Branch protection on `main` requiring `ci` to pass *and* at least one approving review. For a solo dev, "review by yourself before merging" is weak — but combined with mandatory gates it forces a 30-second pause.

---

## 11. Caching — the small win

The `actions/cache@v4` step (§3.3) caches `~/.pnpm-store` keyed by `pnpm-lock.yaml`. With a warm cache, `pnpm install` finishes in seconds because every package is already on disk; install is just symlinking.

If Vite's incremental build cache ever matters (rarely, on small frontends), add a parallel cache step keyed on `vite.config.ts` and pointed at `node_modules/.vite`. Don't add it speculatively — premature caching adds complexity for negligible savings on a project this size.

---

## 12. Rollback — three ways, two of them dangerous

Something shipped broken. How do you get back to a known-good state?

| Method | Speed | Safe? | When to use |
|---|---|---|---|
| Revert commit + push to `main` | 2 minutes (CI re-runs) | Yes — gates re-run on the revert | Default rollback. The slow path is the right path. |
| `wrangler rollback` | Seconds | No — skips all CI gates | Active incident only |
| Re-promote a previous deploy from the Cloudflare dashboard | Seconds | No — skips all CI gates | Active incident only |

The honest tradeoff: the fast paths are unsafe because they bypass the gates that exist precisely to keep this kind of mistake out. They're the right tool when a customer is actively broken and you need to stop the bleeding. They're the wrong tool for a leisurely fix.

The discipline: use `wrangler rollback` to triage, then immediately push a real revert commit so `main` reflects what's actually deployed. Otherwise your git history says one thing and production runs another, and the next deploy from `main` will redeploy the broken commit on top of the rollback.

---

## 13. What this means for PowerFab specifically

Most gates in §3 are generic — typecheck, test, frozen lockfile — and belong in any TypeScript pipeline. One isn't: `pnpm validate:tenants`.

That gate exists because of PowerFab's specific risk profile:

- **One typo in `tenants/<slug>.json` breaks one customer.** A missing field, a misspelled module name, a bad flag — the Worker loads the malformed config and either crashes on first request or renders an empty dashboard. The customer notices; you don't, until the email arrives.
- **One *malformed* tenant file can break the Worker for *all* tenants.** If config-loading throws during cold start, every tenant on that data center hits the same error until a fix ships.
- **You're a solo dev.** No teammate reviews your PRs. The pipeline is the reviewer.

The validate:tenants gate is the cheapest insurance against that failure mode. One step, one second of runner time, and the pipeline refuses to ship a broken config. If every other gate were stripped out, this is the one to keep.

Same logic for the preview-namespace isolation (§8). Without it, every PR is one accidental write away from corrupting production tenant configs. With it, a preview can do whatever it wants to a throwaway namespace; production stays clean. That's a PowerFab-specific guardrail because PowerFab specifically stores load-bearing routing data in KV.

The shape to internalize: a CI/CD pipeline isn't checks-for-the-sake-of-checks. Each gate maps to a real failure mode in your specific stack. For PowerFab, the two most important gates are the ones that protect the tenant config — because that's where your stack is most fragile.

---

## 14. By the end of this doc you should know

- What CI and CD mean separately, and why a solo dev needs them more than a team does.
- The eleven Actions-dialect terms in §2 — workflow, trigger, job, step, runner, action, secret, gate, preview deploy, rollback, frozen lockfile.
- Every line of the workflow YAML in §3 — why `--frozen-lockfile` matters, why typecheck precedes build, why the deploy is split into two `if:`-guarded variants.
- Every line of `validate-tenants.ts` in §6, and why `process.exit(1)` is what fails a GitHub Actions step.
- Why we run `wrangler pages deploy` from inside Actions instead of using Cloudflare's git integration — gates, not convenience.
- What a preview deploy is and why preview deploys must use a separate KV namespace from production.
- How the two Cloudflare secrets reach the deploy step without ever appearing in a log, and why the token is scoped to Pages and Workers only.
- The eight bug/fix pairs in §10, especially #2 (don't drop the validator) and #6 (isolate the preview KV namespace).
- The three rollback paths and which two are emergency-only.
- Why validate:tenants protects PowerFab from its single most dangerous failure mode.

If §3 still feels alien, re-read §2 first, then §3 with the vocabulary in mind.

---

**Next:** `14-observability.md` — what to log, what to alert on, how to know when a tenant breaks before the customer email arrives. Builds directly on this doc's deploy pipeline (because every deploy is itself an observability event).
