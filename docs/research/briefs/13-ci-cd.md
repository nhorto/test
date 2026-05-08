# Research Brief: CI/CD with GitHub Actions for the Cloudflare Stack

> Intermediate research feeding the writing agent for `13-ci-cd.md`. May contain URL-shaped examples; the writing agent is instructed to rewrite without them.

---

## 1. Why CI/CD Matters for a Solo Developer

Solo developers are the most vulnerable to foot-gun deploys because there is no second pair of eyes before code ships. CI/CD compensates for the missing teammate by automating the checks that humans forget under time pressure.

Concrete value for this stack:

- **Type-check gate.** TypeScript's `tsc --noEmit` catches type errors that a bundler (Vite) silently ignores. Vite transpiles without type-checking; you can ship broken types and never know until runtime.
- **Tenant config validation gate.** Every `tenants/*.json` file is a live configuration that affects routing, feature flags, and KV namespace bindings. A malformed file can silently break one tenant while all others appear healthy. A CI gate catches this before code reaches Cloudflare.
- **Prevent foot-guns.** Deploying directly from a local machine means your local `node_modules`, `.env` overrides, and uncommitted edits can pollute the deploy. CI runs in a clean, reproducible environment every time.
- **Automatic preview deploys per PR.** Every pull request gets a unique, isolated URL on Cloudflare Pages. You can review UI changes before merging without touching production.
- **Repeatable deploys.** The same YAML file that runs today runs six months from now. No tribal knowledge required.

---

## 2. GitHub Actions Workflow File — Structure and Complete Example

**Terminology glossary:**
- **Workflow:** A YAML file in `.github/workflows/`. GitHub reads it automatically.
- **Trigger (`on:`):** The event that starts the workflow — a push, a pull request, a manual button press.
- **Job:** A group of steps that run on the same machine.
- **Step:** One unit of work inside a job — either a shell command or a pre-built action.
- **Runner:** The virtual machine that executes the job. `ubuntu-latest` is a Canonical Ubuntu VM provisioned by GitHub on demand.
- **Action:** A reusable package of steps published to the GitHub Marketplace, referenced as `uses: owner/repo@version`.
- **Secret:** An encrypted value stored in GitHub's repository settings, injected into the runner as an environment variable at runtime. Never visible in logs.

```yaml
# .github/workflows/deploy.yml
# Triggered on every push to main and on every pull request.

name: CI / Deploy

on:
  push:
    branches: [main]          # production deploys
  pull_request:               # preview deploys + gates on all PRs

jobs:
  ci:
    name: Type-check, Validate, Test, Build, Deploy
    runs-on: ubuntu-latest    # fresh Ubuntu VM, discarded after job

    steps:
      # 1. Check out the repository at the commit that triggered the run.
      - uses: actions/checkout@v4

      # 2. Install Node.js (LTS) and configure pnpm caching.
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm          # tells the action to cache ~/.pnpm-store

      # 3. Install pnpm itself (the package manager used by this project).
      - uses: pnpm/action-setup@v3
        with:
          version: 9

      # 4. Restore the pnpm store from cache, or populate it on cache miss.
      - uses: actions/cache@v4
        with:
          path: ~/.pnpm-store
          key: ${{ runner.os }}-pnpm-${{ hashFiles('**/pnpm-lock.yaml') }}
          restore-keys: ${{ runner.os }}-pnpm-

      # 5. Install dependencies from the lockfile — never upgrades versions.
      - run: pnpm install --frozen-lockfile

      # 6. TYPE CHECK — tsc with noEmit; fails step if any type error exists.
      - run: pnpm typecheck

      # 7. TENANT VALIDATION — loads and validates every tenants/*.json file.
      #    Must run BEFORE build; fail-fast if any tenant config is invalid.
      - run: pnpm validate:tenants

      # 8. TESTS — vitest in run mode (non-interactive, exits with code 1 on failure).
      - run: pnpm test

      # 9. BUILD — vite build; output lands in dist/.
      - run: pnpm build

      # 10a. PREVIEW DEPLOY — only on pull requests.
      - if: github.event_name == 'pull_request'
        run: pnpm wrangler pages deploy dist --project-name powerfab-dashboard --branch preview
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      # 10b. PRODUCTION DEPLOY — only when pushing to main.
      - if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        run: pnpm wrangler pages deploy dist --project-name powerfab-dashboard --branch main
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

**Annotation of key design choices:**
- Steps 6, 7, 8 run strictly before step 9 (build). If any gate fails, the job exits immediately and the build never runs. This is fail-fast ordering.
- The `if:` conditionals on steps 10a and 10b mean a single job file handles both preview and production paths without duplicating the entire job.
- `--frozen-lockfile` in step 5 prevents CI from silently upgrading a transitive dependency that differs from the developer's machine.
- The `env:` block on deploy steps scopes secrets to only those steps. Secrets are not available as global env vars, which limits the blast radius of accidental logging.

---

## 3. ASCII Pipeline Diagram

```
git push / PR opened
        |
        v
  [checkout@v4]
        |
        v
  [setup-node + pnpm install]
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
   _____|______
  |            |
  v            v
preview URL  production URL
(PR only)    (main only)
```

---

## 4. Secret Injection

**How secrets are stored:** In GitHub, navigate to the repository's Settings > Secrets and variables > Actions. Add two secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. GitHub encrypts these with libsodium before storing; even GitHub staff cannot read them back.

**How secrets are referenced in YAML:** `${{ secrets.CLOUDFLARE_API_TOKEN }}`. The `${{ }}` syntax is GitHub Actions expression syntax. At runtime, GitHub substitutes the encrypted value. If the value accidentally appears in a log line, GitHub replaces it with `***`.

**How masking works:** GitHub maintains a list of secret values for the run. Any time a value from that list appears in stdout or stderr, it is replaced by `***` before the log is written. This masking is not foolproof if a secret is base64-encoded or split across lines; avoid logging secrets explicitly.

**Least-privilege API token scopes:** When creating a Cloudflare API token, use a custom token (not the global API key). Grant only:
- `Cloudflare Pages: Edit` — allows wrangler to create and update Pages deployments.
- `Workers Scripts: Edit` — allows wrangler to deploy Worker scripts (needed for the Hono backend Worker).

Do not grant `Account: Administrator`, `Zone: Edit`, or any billing/DNS permissions. If the token leaks, the blast radius is limited to deployments.

---

## 5. `pnpm validate:tenants` — What It Does and Why It Is a CI Gate

**The problem it solves:** Tenant config files (`tenants/acme.json`, `tenants/riverstone.json`, etc.) are hand-edited JSON. A missing required field, a typo in a feature flag name, or a wrong KV namespace binding will silently pass JSON parsing but break the tenant at runtime. The Zod `TenantConfig` schema defines the contract; validation enforces it.

**Why it must be in CI, not just local:** Developers forget to run local validation. A fast local-only script gives a false sense of security. CI runs it unconditionally on every commit and PR, regardless of what the developer remembers to do.

**Sketch of the script (`scripts/validate-tenants.ts`, ~18 lines):**

```typescript
import { glob } from "glob";
import { readFileSync } from "fs";
import { TenantConfig } from "../src/schemas/tenant";  // Zod schema

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

if (failed) process.exit(1);  // non-zero exit code fails the CI step
```

`process.exit(1)` is the mechanism that fails the GitHub Actions step. Any step whose process exits with a non-zero code is marked as failed, and the job stops.

---

## 6. Deploy Mechanism: Cloudflare Git Integration vs. GitHub Actions

**Option A — Cloudflare Git integration:** Cloudflare can be connected directly to a GitHub repository. It detects pushes and deploys automatically without any GitHub Actions workflow. Simple to set up; zero YAML required.

**Option B — `wrangler pages deploy` inside GitHub Actions:** The deploy is triggered by the GitHub Actions job after all gates pass. The workflow YAML is the source of truth.

**Tradeoff:** Option A bypasses every CI gate. A push with a broken tenant config still deploys; Cloudflare never sees the validation result. Option B deploys only after typecheck, validation, and tests pass.

**Recommendation: Option B for this stack.** The tenant validation gate is a hard requirement; Option A cannot enforce it. Option B requires more setup but is the correct architecture when a pre-deploy gate exists.

**For Workers (Hono backend):** `wrangler deploy` in GitHub Actions is the standard path. There is no equivalent "Git integration" for Workers — Cloudflare's auto-deploy feature applies to Pages only.

---

## 7. Branch → Environment Mapping

| Branch | Event | Deploy target | wrangler flag |
|---|---|---|---|
| any | `pull_request` | Preview | `--branch preview` |
| `main` | `push` | Production | `--branch main` |
| `staging` (optional) | `push` | Staging | `--branch staging` |

For Workers, `wrangler.toml` defines named environments:

```toml
[env.preview]
name = "powerfab-worker-preview"
vars = { ENVIRONMENT = "preview" }

[env.production]
name = "powerfab-worker"
vars = { ENVIRONMENT = "production" }
```

In GitHub Actions, pass `--env preview` or `--env production` to `wrangler deploy` depending on the branch. The `if:` conditional (shown in the workflow example) handles the switching.

---

## 8. Preview Deploys and KV Namespace Isolation

**What preview deploys are:** When `wrangler pages deploy` is called with a non-production branch, Cloudflare Pages creates a deployment scoped to a unique hash-based subdomain on the project's Pages preview domain. Each PR gets its own URL. These URLs are visible in the GitHub Actions log output and in the Cloudflare dashboard.

**The KV namespace problem:** By default, preview deployments inherit the same KV namespace bindings as production. That means a preview deploy reading `TENANT_CONFIG` is reading and writing real production tenant configs. This is dangerous.

**Solution — separate preview KV namespace:**
In `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "TENANT_CONFIG"
id = "PRODUCTION_NAMESPACE_ID"   # production namespace

[env.preview]
[[env.preview.kv_namespaces]]
binding = "TENANT_CONFIG"
id = "PREVIEW_NAMESPACE_ID"      # separate namespace, safe to corrupt
```

Preview deployments then read/write a throwaway namespace. Production data is never touched.

---

## 9. Caching

**pnpm store cache:** The `actions/cache@v4` step (shown in the workflow) caches `~/.pnpm-store` keyed by the lockfile hash. On cache hit, `pnpm install` completes in seconds rather than minutes. On cache miss (lockfile changed), pnpm downloads fresh packages and repopulates the cache.

**Vite build cache:** Vite 5+ writes a `.vite` cache directory. This can be cached similarly:

```yaml
- uses: actions/cache@v4
  with:
    path: node_modules/.vite
    key: ${{ runner.os }}-vite-${{ hashFiles('vite.config.ts') }}
```

---

## 10. Rollback Paths

| Method | Speed | When to use |
|---|---|---|
| Revert commit + push to main | ~2 min (CI runs) | Normal rollback; CI gates re-run, safe |
| `wrangler rollback` | Seconds | Emergency; skips CI gates |
| Redeploy specific deployment from CF dashboard | Seconds | Emergency; skips CI gates |

**Tradeoff:** `wrangler rollback` and the dashboard redeploy are fast but bypass typecheck and tenant validation. Use them only during active incidents. Follow up with a proper revert commit to restore CI-gated history.

---

## 11. Pitfalls — BUG / FIX Pairs

**BUG:** Secret value printed in logs via `echo "Token: $CLOUDFLARE_API_TOKEN"` inside a run step.
**FIX:** Never echo secrets. GitHub's masking replaces `***` only if the value appears verbatim. If the log line is `Token: ***` in plain runs but the raw value slips through a subprocess, the secret is exposed. Remove all echo/print of secret values entirely.

**BUG:** `validate:tenants` step omitted from the workflow. A developer merges a PR with a typo in `tenants/new-customer.json`. The build succeeds; the deploy ships. The new tenant 404s at runtime.
**FIX:** `validate:tenants` is a mandatory step, positioned before `pnpm build`. Gate ordering is enforced by step sequence, not documentation.

**BUG:** `pnpm build` (Vite) runs before `pnpm typecheck`. Vite transpiles successfully despite TypeScript errors. Deploy ships with type-unsafe code.
**FIX:** `typecheck` always precedes `build` in step order.

**BUG:** `wrangler.toml` defines `[env.production]` with `vars = { ENVIRONMENT = "production" }` but the GitHub Actions workflow passes `--env staging`. The Worker boots with the staging env's vars instead of production's.
**FIX:** The `--env` flag passed to `wrangler deploy` must exactly match an `[env.X]` key in `wrangler.toml`. Lint the YAML and the toml together; a mismatch silently falls back to the top-level config.

**BUG:** `compatibility_date` in `wrangler.toml` is `2024-01-01` locally but a developer manually deployed from a machine with `--compatibility-date 2024-09-23`. The Worker behaves differently in CI than it did in the manual deploy.
**FIX:** Set `compatibility_date` only in `wrangler.toml`, never on the command line. CI reads the toml; the date is locked to source control.

**BUG:** Preview deployment uses the production KV namespace binding (default behavior). A developer testing tenant onboarding in a preview deploy writes a malformed config key to `TENANT_CONFIG`, corrupting the production namespace.
**FIX:** Define a separate `[env.preview]` KV namespace binding in `wrangler.toml` as described in section 8. This is the single highest-impact isolation step in the entire CI setup.

**BUG:** Developer uses `set-output` in a custom script step and inadvertently includes a secret in the output string. Older GitHub Actions runner versions wrote `set-output` values to log.
**FIX:** Never pass secrets through `set-output` or `$GITHUB_OUTPUT`. Secrets should only appear as `env:` bindings scoped to the exact step that needs them.

---

## Summary of Gate Ordering (Non-Negotiable Sequence)

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck` — catches TS errors Vite ignores
3. `pnpm validate:tenants` — catches broken tenant configs
4. `pnpm test` — catches logic regressions
5. `pnpm build` — only runs if all gates pass
6. `wrangler pages deploy` / `wrangler deploy` — only runs if build passes

This sequence means a single broken tenant JSON file blocks the deploy as firmly as a TypeScript type error. Both are treated as first-class correctness requirements, not optional checks.
