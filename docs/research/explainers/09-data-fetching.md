# 09 — Data Fetching: How the Dashboard Reads Snapshots Without Leaking Tenants

> **Pre-reqs:** Read `00-start-here.md` (the big picture and the vocabulary), `02-config.md` (tenant config schema and where it lives), `07-nightly-pipeline.md` (you need to know what an R2 manifest pattern is — the nightly job writes per-tenant JSON snapshots into R2 and updates a "latest" pointer), and `08-isolation.md` (this is where the tenant-cache-scoping security worry comes from — leaking one tenant's cached data into another tenant's view is the canonical multi-tenant SaaS bug).
>
> **What you'll know by the end:** The full path a number takes from R2 all the way to a rendered tile in the user's browser, and which cache it sits in at every step. What TanStack Query is, why we picked it over four other options, and how to use its core hook (`useQuery`) without booby-trapping your app. The tenant-cache-scoping rule that prevents the worst class of multi-tenant bug. A sane URL design (`/api/tenants/<slug>/snapshots/<date>/<module>.json`) and why the date has to be in the URL. A `queryKeys` factory pattern that makes the rule un-skippable. A `QueryClient` defaults block walked through line by line. An error-handling table you can copy. The five things not to do.

This is a long one. It's the doc that makes the difference between a dashboard that "works on my laptop" and one that doesn't leak Acme's numbers into BigShop's screen during a tenant switch. Take your time.

---

## 1. The hook

Docs 00–08 covered how a request reaches the right tenant, how config decides what renders, and how the nightly pipeline writes snapshot JSON into R2. This doc covers the seemingly boring middle bit: how the React app actually *reads* those JSON files at runtime. It's where multi-tenant SaaS apps most often spring a leak — not in the database, not in the auth, but in the in-memory cache the React app keeps of "the last data I fetched." We'll build that layer correctly the first time, with TanStack Query as the workhorse and a strict rule: the tenant slug goes in every cache key, no exceptions.

---

## 2. Vocabulary primer (extends doc 00 §5)

You'll see all of these terms in this doc. Skim now, refer back as you read.

- **Query** — in TanStack Query, "a query" is one piece of data you've asked for (not a SQL query). "Time module snapshot for Acme on 2026-05-07" is one query. Components asking for the same query share one cache entry.

- **Cache** — short-term storage of fetched data. We have several stacked (Cloudflare edge cache, browser HTTP cache, TanStack Query in-memory cache); the word alone is ambiguous, so we'll always say which one.

- **Stale** — TanStack Query's word for "older than `staleTime`; refetch in the background next time someone asks." Stale data still renders; the refetch is invisible. Stale ≠ wrong.

- **Fresh** — the opposite. Younger than `staleTime`. Will not be refetched, even when new components mount. This is what makes 5 components asking for the same data cost 1 network request.

- **`gcTime`** ("garbage collection time," formerly `cacheTime`) — how long unused cache entries linger after the last observer unmounts. After `gcTime` with no observers, the entry is dropped.

- **`queryKey`** — a serializable array uniquely identifying a query. Same key = same cache entry. Example: `['snapshot', 'acme', 'inspections', '2026-05-07']`. The heart of the system.

- **`queryFn`** — an async function returning the data. Called only when the cache is missing or stale.

- **`useQuery`** — the React hook. Pass `queryKey` and `queryFn`; get back `{ data, isPending, isError, error, ... }`.

- **`useMutation`** — the hook for *changing* server state. After success, you call `invalidateQueries` so observers refetch.

- **`invalidate`** — mark cache entries stale so they refetch on next observe. `queryClient.invalidateQueries({ queryKey: [...] })`.

- **Suspense** — React feature for showing a fallback while a child is "still loading." Covered for lazy components in doc 03; works for data with `useSuspenseQuery`.

- **Optimistic update** — update the local cache *before* the server confirms; roll back on rejection. Beginner trap; skip at MVP.

- **Immutable URL** — a URL whose response will never change. `/api/snapshots/2026-05-07/inspections.json` is immutable: that file is the snapshot for that date, forever. Tomorrow's data lives at a *different* URL. Lets us cache forever with no cache-busting.

- **Cache-Control** — HTTP response header telling caches how long they may keep a response. `Cache-Control: public, max-age=31536000, immutable` = "cache for a year, will never change."

- **CORS** (Cross-Origin Resource Sharing) — browser rule. JS from `app.example.com` calling `api.example.com` triggers a preflight check and is blocked unless the API explicitly opts in. Same domain = no CORS. Different subdomain = cross-origin.

- **Same-origin** — exact same scheme + host + port. `https://acme.app.example.com` → `https://acme.app.example.com/api/...` is same-origin. Subdomains do *not* count.

- **HttpOnly cookie** — browser sends it but JS can't read it via `document.cookie`. Stops XSS-based session theft.

- **Secure cookie** — only sent over HTTPS, never plain HTTP.

- **SameSite=Lax** — cookie attribute: don't send on cross-site requests except top-level navigations. Blocks most CSRF for free.

- **`isPending`** — flag meaning "no data yet, first fetch in progress." (In v4: `isLoading`.)

- **`isFetching`** — "a fetch is in flight," cached or not. `isPending` implies `isFetching`; the reverse doesn't hold.

- **Snapshot** — JSON file produced by the nightly pipeline for one tenant on one date. ~1.6 MB total, split into per-module files.

- **Module** (panel) — one of the 7: Estimating, Production Control, Project Management, Time, Inspections, Purchasing, Inventory.

---

## 3. The big picture — the layers a number passes through

Here's the full path. Memorize this picture; we'll refer to specific layers throughout.

```
┌─────────────────────────────────────────────────────────────────┐
│  R2 (Cloudflare object storage)                                 │
│  /tenants/acme/snapshots/2026-05-07/inspections.json            │
│  Lifetime: forever (immutable per date)                         │
└────────────────────────────┬────────────────────────────────────┘
                             │  Worker reads on cache miss
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker                                              │
│   - Validates the request (auth cookie, slug match)             │
│   - Reads from R2                                               │
│   - Sets Cache-Control: public, max-age=31536000, immutable     │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Cloudflare edge cache                                          │
│  Same JSON cached at every Cloudflare data center.              │
│  Lifetime: per Cache-Control (effectively forever).             │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Browser HTTP cache (the disk/memory cache built into Chrome)   │
│  Lifetime: per Cache-Control. After first fetch, subsequent     │
│  page loads return the JSON without hitting the network at all. │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  TanStack Query in-memory cache (lives inside the React app)    │
│  Keyed by ['snapshot', tenantSlug, module, date].               │
│  Lifetime: while at least one component observes, plus gcTime.  │
│  Multiple components asking the same query get one fetch.       │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  React component                                                │
│  Renders the chart/table/tile from `data`.                      │
└─────────────────────────────────────────────────────────────────┘
```

Each layer has its own job. R2 is durable storage. The Worker enforces auth and sets headers. The edge cache is the geographic optimization (don't hit R2 from every continent). The browser HTTP cache is the per-user optimization (don't hit Cloudflare on a reload). TanStack Query is the per-tab optimization (don't hit the browser cache from every component on the same page).

When something goes wrong, the diagnosis is "which layer is wrong" — that's why this picture is worth pinning up.

---

## 4. The fetching options, walked through

Four options were on the table. We picked TanStack Query v5. Here's the honest comparison.

### 4.1 Native `fetch` + React 19 `use()` + Suspense

React 19 added a hook `use()` that takes a Promise and unwraps it inside a render. With `<Suspense>`:

```tsx
function Inspections({ promise }: { promise: Promise<InspectionsData> }) {
  const data = use(promise);   // unwraps the promise
  return <Chart points={data.points} />;
}

<Suspense fallback={<Skeleton />}>
  <Inspections promise={fetch('/api/.../inspections.json').then(r => r.json())} />
</Suspense>
```

You get: a clean way to write "this component reads a value that's not here yet" without `useEffect` + `useState` + `isLoading` boilerplate.

You do *not* get: caching (two components fetching the same URL = two HTTP requests), dedup, retries on 5xx, refetch on reconnect, DevTools, stale-while-revalidate semantics, or invalidate-after-mutation. You'd hand-roll all of it.

For a one-page demo with a single fetch, fine. For a 7-module multi-tenant dashboard with retries and DevTools, not enough. Skip.

### 4.2 TanStack Query v5 — what we picked

A library that wraps `fetch` (or any async function) with caching, deduplication, retries, and a React hook. Mental model:

- Give it a unique key (`queryKey`) for each piece of data.
- Give it a function (`queryFn`) that returns the data.
- It handles "have we fetched this, is it cached, is it stale, should we refetch" — you don't.

Best thing: if 5 components ask for the same `queryKey`, exactly one `queryFn` call happens. The other 4 share its result. In a 7-module dashboard, that keeps the network quiet.

Second-best thing: a DevTools panel showing every active query, its status, its cache entry, and a refetch button. As a beginner, being able to *see* your cache during debugging is worth the library on its own.

Bundle cost: ~13 KB gzipped. Against a 1.6 MB snapshot, a rounding error.

### 4.3 SWR

From Vercel. Same family of ideas, hooks-only, smaller bundle (~5 KB gzipped), simpler API.

Pick it if: you're deep in Next.js + Vercel, you never mutate, and bundle size is critical. None of these is true for us. TanStack Query has better DevTools and a larger community for advanced patterns. Both fine; for a beginner solo dev TanStack Query is the safer pick.

### 4.4 Custom fetch wrapper + React Context

The trap. Looks "simple." A `DataProvider` fetches the JSON on mount, shoves it into Context, components read from there.

Looks simple until:

- User switches tenants. You have to manually nuke the Context and refetch. Forget once → Acme's data leaks into BigShop's session.
- A network blip fails one fetch. You write retry logic. It has bugs.
- Two components want the same data. Context re-renders the entire subtree on every value change. You add `useMemo` everywhere. Still slower than a real cache.
- You want a "refresh" button. You write dedup or fire 3 requests on double-click. It has bugs.

You will reinvent TanStack Query badly over three months and ship a multi-tenant data leak. Skip.

---

## 5. TanStack Query v5: the working example, line by line

Here's a complete component fetching the Inspections snapshot for the current tenant. Read it once for shape, then we'll walk it line by line.

```tsx
// src/panels/inspections/InspectionsPanel.tsx
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../data/queryKeys';
import { fetchSnapshot } from '../../data/fetchSnapshot';
import { tenantConfig } from '../../tenant';
import { Skeleton } from '../../components/Skeleton';
import { ErrorTile } from '../../components/ErrorTile';
import { InspectionsChart } from './InspectionsChart';

export function InspectionsPanel() {
  const slug = tenantConfig.tenantId;
  const date = tenantConfig.latestSnapshotDate;

  const { data, isPending, isError, error } = useQuery({
    queryKey: queryKeys.snapshot(slug, 'inspections', date),
    queryFn: () => fetchSnapshot(slug, 'inspections', date),
  });

  if (isPending) return <Skeleton variant="chart" />;
  if (isError) return <ErrorTile error={error} />;

  return <InspectionsChart points={data.points} />;
}
```

Now line by line.

- `import { useQuery } from '@tanstack/react-query';` — the hook. This is the only thing 95% of components will need from the library.

- `import { queryKeys } from '../../data/queryKeys';` — our centralized key factory. We'll define it in §6. Components never construct `queryKey` arrays inline; they always go through this factory. That's how we make the tenant-scoping rule un-skippable.

- `import { fetchSnapshot } from '../../data/fetchSnapshot';` — our centralized fetch wrapper. It builds the URL, sets credentials, handles 401/404 in one place. Components never call `fetch` directly. We'll write it in §7.

- `import { tenantConfig } from '../../tenant';` — the per-tenant config injected into the page (see doc 02). This object has fields like `tenantId` (the slug) and `latestSnapshotDate` (which date the nightly pipeline finished last).

- `const slug = tenantConfig.tenantId;` — pull the slug into a local. It's used in the key AND in the URL. Always read it from one place; never hard-code.

- `const date = tenantConfig.latestSnapshotDate;` — pull the date. We'll explain in §9 why this comes from the tenant config and not from a separate fetch.

- `const { data, isPending, isError, error } = useQuery({ ... });` — call the hook. Destructure the four fields we'll use. There are more (`isFetching`, `refetch`, `dataUpdatedAt`, `status`, ...), but for a basic read-and-render the four above are enough.

- `queryKey: queryKeys.snapshot(slug, 'inspections', date),` — build the key via the factory. The result is something like `['snapshot', 'acme', 'inspections', '2026-05-07']`. The four pieces uniquely identify the data.

- `queryFn: () => fetchSnapshot(slug, 'inspections', date),` — the function TanStack Query calls when the cache for that key is missing or stale. It returns a Promise of the parsed JSON.

- `if (isPending) return <Skeleton variant="chart" />;` — first render, no data yet, show a skeleton. As covered in doc 03 §7, skeletons (gray boxes shaped like the real UI) beat spinners for anything that takes more than a couple hundred ms.

- `if (isError) return <ErrorTile error={error} />;` — fetch failed. Show a small error tile inside the panel slot, not a full-page crash. Other panels keep working.

- `return <InspectionsChart points={data.points} />;` — happy path. By the time we reach this line, TS narrows `data` to non-undefined because `isPending` and `isError` are both false. Render the chart.

That's the entire pattern. Most panels in the app will look exactly like this — three imports, one hook call, two early-returns, one happy-path render. Repeating that shape across modules is a feature; the muscle memory keeps people from getting clever.

---

## 6. Tenant cache scoping — the rule that prevents the worst bug

This is the most important section in this doc. Read it twice.

### 6.1 BUG: the data leak across tenants

In a hurry, someone writes:

```tsx
// DON'T DO THIS
const { data } = useQuery({
  queryKey: ['snapshot', 'inspections', date],   // <-- no tenant slug
  queryFn: () => fetchSnapshot(slug, 'inspections', date),
});
```

The `queryFn` knows the tenant (it's in the URL). The `queryKey` does not. To TanStack Query, the cache key is `['snapshot', 'inspections', date]`. With an internal admin switching tenants:

1. Admin views Acme. Inspections data cached under `['snapshot', 'inspections', '2026-05-07']`.
2. Admin switches to BigShop. `<InspectionsPanel />` mounts and calls `useQuery` with the same key.
3. TanStack Query finds the key in cache. **Returns Acme's data** without calling `queryFn`.
4. The screen shows BigShop's branding and Acme's numbers.

Textbook multi-tenant data leak. Not a Worker bug, not an R2 bug, not an auth bug. A cache-key bug. It passes code review because the cache mechanism is invisible.

### 6.2 FIX: tenant slug in every key, enforced by a factory

The fix is two rules:

1. The tenant slug is always the second element of the `queryKey` (after a domain prefix like `'snapshot'`).
2. Components never construct `queryKey` arrays inline. They always go through a centralized factory.

The factory:

```ts
// src/data/queryKeys.ts
import type { ModuleId } from '../registry';

export const queryKeys = {
  snapshot: (tenantSlug: string, module: ModuleId, date: string) =>
    ['snapshot', tenantSlug, module, date] as const,

  tenantConfig: (tenantSlug: string) =>
    ['tenantConfig', tenantSlug] as const,

  latestPointer: (tenantSlug: string) =>
    ['latestPointer', tenantSlug] as const,
} as const;
```

Walking through it:

- `export const queryKeys = { ... } as const;` — a single object exported for the whole app. Components import `queryKeys` from one place; there are no other places to construct keys. Reviewers can grep for `queryKey: [` and any hit is suspect.

- `snapshot: (tenantSlug: string, module: ModuleId, date: string) =>` — the function that builds a snapshot key. Three required arguments. You can't accidentally call it without the slug, because TypeScript will fail to compile if you do.

- `['snapshot', tenantSlug, module, date] as const` — the actual key. Note the order: domain (`'snapshot'`) first so different domains don't collide; then `tenantSlug`; then specifics. The `as const` means TypeScript treats this as a tuple of literals, not a `string[]`, which gives nicer types downstream.

- `tenantConfig: (tenantSlug: string) => ['tenantConfig', tenantSlug] as const` — even data that "feels global" (like a tenant's config) gets a slug-scoped key. Future-proofing for "admin viewing two tenants in two tabs."

- `latestPointer: (tenantSlug: string) => ...` — same.

Now the component looks like §5. Compare:

```ts
// before — danger
queryKey: ['snapshot', 'inspections', date],

// after — safe
queryKey: queryKeys.snapshot(slug, 'inspections', date),
```

You can't write the after-version without the slug. The compiler refuses.

### 6.3 The lint rule (optional but cheap)

If you want belt and suspenders, add an ESLint rule that bans `queryKey:` followed by `[` in any file outside `data/queryKeys.ts`. Five minutes of config; catches the bug at PR time forever. (Doc 08 walks through tenant-isolation tests; this lint is the static-analysis cousin.)

### 6.4 What about clearing the cache on tenant switch?

Some teams call `queryClient.clear()` on tenant switch as defense in depth. We won't rely on it as primary protection (easy to forget, nukes legitimately shared queries, doesn't help when two keys collide *within* one tenant's session). Slug-in-key is the primary defense; `clear()` is a belt for later.

Cross-reference: doc 08 covers the tenant-isolation test that proves the server side rejects mismatched-slug requests. The cache-key rule is the client-side companion to that server-side check.

---

## 7. URL design

The URL pattern:

```
/api/tenants/<slug>/snapshots/<YYYY-MM-DD>/<module>.json
```

Concrete example:

```
/api/tenants/acme/snapshots/2026-05-07/inspections.json
```

Why each piece is in the URL:

- **`<slug>`** — makes Worker routing trivial and the URL self-documenting in logs. Yes, the subdomain already tells us the tenant — putting it in the path too is redundant on purpose. Auth checks compare them; mismatch → reject.

- **`<YYYY-MM-DD>`** — the snapshot date. **THE key design decision of this doc.** With the date in the URL, every day's snapshot lives at a different URL. We can serve `Cache-Control: public, max-age=31536000, immutable` and never worry about cache busting. Tomorrow's snapshot lives at a new URL, not the same one.

- **`<module>.json`** — per-module fetching (see §17). Each module is its own file; independent fetches happen in parallel.

### 7.1 Why "today" or "latest" in URLs is wrong

Tempting to write `/api/tenants/acme/snapshots/today/inspections.json` and resolve "today" server-side. Don't.

- **Cache poisoning.** Caches see one URL and cache the response. At midnight UTC, "today" means a new file, but the cache serves yesterday's. You end up purging manually every day and getting it wrong.
- **Race conditions.** During the pipeline write window, "today" is mid-update. Different Worker instances may disagree.
- **Debugging.** When a customer says "the numbers were wrong on May 7," you can't reproduce without dated URLs.

Date-in-URL costs nothing to do right and weeks of mystery bugs to do wrong.

---

## 8. SSR vs client fetch — should the Worker inline the snapshot?

The Worker already injects the tenant config into HTML as `<script type="application/json" id="tenant-config">...</script>` (see doc 02). Should it also inject the dashboard snapshot data? Zero client-side fetches if so.

**Pros of inlining the snapshot:** zero client fetch on first paint; one round trip instead of two.

**Cons:**

| Issue | Detail |
|---|---|
| HTML bloat | 1.6 MB of JSON in HTML = 1.6 MB HTML download. First-byte latency tanks. Streaming HTML doesn't help when the body is one giant `<script>`. |
| Cache invalidation | Inlined data ages with the HTML cache. If HTML caches 5 minutes, the data does too — no longer immutable. |
| Per-module fetching impossible | If everything's in the page, you can't lazy-load Time when the Time tab opens. You paid up front. |
| Worker CPU | Reading 1.6 MB from R2 and templating it into HTML on every cold load adds up across 200 tenants. |

**Recommendation:** inject *small* things into HTML — tenant config, latest snapshot date pointer (~1 KB each, used immediately, benefit from zero round trips). Fetch the *big* thing — the snapshot data — client-side via TanStack Query. The browser HTTP cache plus an immutable URL makes repeat loads almost as fast, and avoids every con above.

Rule: **inline what you'd be sad to send twice (config); fetch what you'd be sad to send 200x at once (data).**

Revisit only if real-user metrics show first-paint is unacceptable.

---

## 9. The latest-date pointer problem

A subtle question: **how does the client know which date to fetch?** The client wants `/api/tenants/acme/snapshots/<DATE>/inspections.json`. What's `<DATE>`?

### 9.1 Option A — small extra fetch ("latest pointer")

Client fetches `/api/tenants/acme/latest.json` first → `{ "date": "2026-05-07" }`, then uses that date for real fetches.

- Pro: clean separation. Pointer changes; snapshots stay immutable.
- Con: extra round trip on every page load, blocking the real fetches.

### 9.2 Option B — inline the date in the tenant config script tag (PICKED)

The Worker, while rendering HTML, reads the latest date from KV and embeds it in the tenant config blob:

```html
<script type="application/json" id="tenant-config">
{
  "tenantId": "acme",
  "enabledModules": [...],
  "latestSnapshotDate": "2026-05-07"
}
</script>
```

The client reads it synchronously at boot. No extra fetch. The first thing a panel does is start fetching its actual data.

- Pro: zero extra round trips.
- Con: the inlined date is coupled to the HTML cache. If HTML caches 30 min and the pipeline finishes during that window, the inlined date is yesterday's for up to 30 min.

### 9.3 Why option B works for us anyway

The pipeline runs at ~2 AM. By the time customers wake up, the HTML cache has long since absorbed the new date. The "stale 5–30 min" window matters only if a customer is at their desk while the pipeline runs — vanishingly rare. Set HTML cache TTL to 5–15 min. Snapshots themselves stay immutable forever.

### 9.4 Reading the inlined date in code

Doc 02 shows how to read the tenant config blob. The shape now includes `latestSnapshotDate`:

```ts
// src/tenant.ts (excerpt — extends doc 02)
export type TenantConfig = {
  tenantId: string;
  enabledModules: ModuleId[];
  latestSnapshotDate: string;        // ISO date, e.g. '2026-05-07'
  // ...other fields from doc 02
};

const el = document.getElementById('tenant-config');
if (!el) throw new Error('No tenant config in document');
export const tenantConfig = JSON.parse(el.textContent ?? '') as TenantConfig;
```

Any panel can now read `tenantConfig.latestSnapshotDate` synchronously and pass it into `queryKeys.snapshot(...)`.

---

## 10. Caching layers, summarized

The big-picture diagram in §3 had 5 layers. Here's a reference table for each one's job and lifetime:

| Layer | Lifetime | Invalidates when | Who controls it |
|---|---|---|---|
| R2 | Forever (per dated URL) | Never. New date = new URL = new file. | The nightly pipeline. |
| Cloudflare edge cache | Per `Cache-Control` (effectively forever for dated URLs; ~5–15 min for HTML) | TTL expiry; explicit purge from Cloudflare API. | The Worker, via `Cache-Control` headers. |
| Browser HTTP cache | Per `Cache-Control` | TTL expiry; user hard-refresh; URL change. | Same `Cache-Control` headers. |
| TanStack Query in-memory | While at least one component observes the key, plus `gcTime` after the last unmount. | Manual `invalidateQueries`; `staleTime` expiry; calling `queryClient.clear()`. | The React app. |
| React component state | While the component is mounted. | Component unmount. | The component. |

Debugging skill: when something looks wrong, ask "which layer is showing the wrong value?" The browser DevTools network tab tells you if the HTTP cache served the response (size column "(disk cache)" / "(memory cache)"). TanStack Query DevTools tells you if the in-memory cache served the component. Eliminate layer by layer.

---

## 11. Authentication on fetch

The data is private — only Acme employees should see Acme's numbers. Auth required.

### 11.1 The cookie pattern (recommended)

The Worker sets a session cookie at login with three flags:

- **`HttpOnly`** — JS can't read it. Stops XSS-based session theft.
- **`Secure`** — only sent over HTTPS.
- **`SameSite=Lax`** — only sent on same-site requests except top-level navigations. Blocks most CSRF for free.

Browser sends the cookie automatically on same-site requests. The Worker reads it, validates the session, and returns data or 401.

In the React fetch wrapper:

```ts
// src/data/fetchSnapshot.ts (sketch)
export async function fetchSnapshot(slug: string, module: string, date: string) {
  const url = `/api/tenants/${slug}/snapshots/${date}/${module}.json`;
  const res = await fetch(url, { credentials: 'same-origin' });
  // ...handle status, parse JSON, return
}
```

`credentials: 'same-origin'` = "send cookies on same-origin URLs only." With our same-domain URL design, that's the whole client-side auth story.

### 11.2 The bearer token pattern (skip)

A token in `Authorization: Bearer <token>` headers. Necessary for: native mobile apps, third-party API consumers, some cross-origin setups. None apply at MVP. Cookies are simpler and safer for browser apps.

---

## 12. CORS rule of thumb

- **Same domain → no CORS.** `acme.app.example.com` calling `acme.app.example.com/api/...` is same-origin. Cookies flow. No `Access-Control-*` headers needed. No preflight.

- **Different subdomain → cross-origin.** `acme.app.example.com` calling `api.app.example.com` is cross-origin (yes, even sharing `app.example.com`). Preflight `OPTIONS` first. API needs `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials`, `Access-Control-Allow-Methods`. Cookies don't flow without `credentials: 'include'` and a matching server header.

Rule: **don't split the API onto a different domain unless you have a real reason.** "API as a separate concern" feels clean but the CORS overhead and the per-fetch "is this cross-origin" mental load cost more than it buys. Keep `/api/*` on the same domain.

---

## 13. Stale data UX

Data is at-most-24-hours-old by design. Communicating that is a real UX requirement.

### 13.1 "Last updated" indicator

Show `Last updated: 2026-05-07 02:14 UTC` in the header or footer. Three reasons:

1. **Trust.** Users know they're not looking at live data.
2. **Debugging.** When a customer says "numbers are wrong," asking "what does Last updated say?" gets you to the answer in one round trip.
3. **Failed-run detection.** If it says yesterday, the user knows the run failed before you do.

### 13.2 What to show when last night's run failed

| State | Show |
|---|---|
| Last night succeeded | Latest data, normal timestamp. |
| Last night failed, previous succeeded | Previous night's data + amber banner: "Last night's data refresh failed. Showing data from May 6." |
| No snapshots ever | Empty state with onboarding hint. |
| Network/5xx during fetch | Toast with retry button. Keep last good data on screen if any. |

Principle: **never show a blank screen if you have yesterday's data.** The Worker can detect "most recent R2 date is >24 hours old" when computing `latestSnapshotDate`, or the client can compare `latestSnapshotDate` to today.

---

## 14. Error handling table

Centralize in the fetch wrapper, not in components. Components only deal with `isError`/`error` from `useQuery`.

| Status | Meaning | What to do |
|---|---|---|
| 401 | Session expired or no cookie | Throw `UnauthorizedError`. Global handler (`QueryClient` `onError`) redirects to login. |
| 403 | Authenticated but not allowed | Throw `ForbiddenError`. Show "you don't have access" page. |
| 404 | Dated snapshot doesn't exist | Throw `SnapshotNotFoundError`. Component falls back to most recent date with staleness banner. |
| 5xx | Worker or R2 error | TanStack Query default retry (3, exponential backoff) handles transient. Toast if ultimately fails. |
| Network / offline | No connectivity | `onlineManager` pauses queries. Offline banner; auto-resume on reconnect. |

Wrapper sketch:

```ts
// src/data/fetchSnapshot.ts
export class UnauthorizedError extends Error {}
export class ForbiddenError extends Error {}
export class SnapshotNotFoundError extends Error {}

export async function fetchSnapshot(slug: string, module: string, date: string) {
  const url = `/api/tenants/${slug}/snapshots/${date}/${module}.json`;
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) throw new UnauthorizedError();
  if (res.status === 403) throw new ForbiddenError();
  if (res.status === 404) throw new SnapshotNotFoundError();
  if (!res.ok) throw new Error(`Snapshot fetch failed: ${res.status}`);
  return res.json();
}
```

- Three typed errors so the global handler and components can `instanceof`-branch.
- URL built from parameters; no query strings.
- `credentials: 'same-origin'` — see §11.
- Status checks ordered: auth, not-found, other non-2xx, then return parsed JSON.
- TanStack Query catches the throw, sets `isError: true`, exposes the error to the component. Retry logic in defaults handles 5xx.

---

## 15. Mutations (minor at MVP)

The dashboard is read-only at MVP. The only mutations will be tenant config edits (post-MVP) and maybe a user pref. The pattern:

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';

const queryClient = useQueryClient();

const mutation = useMutation({
  mutationFn: (newConfig: TenantConfig) =>
    fetch(`/api/tenants/${slug}/config`, {
      method: 'PATCH',
      credentials: 'same-origin',
      body: JSON.stringify(newConfig),
    }).then(r => r.json()),

  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tenantConfig(slug) });
  },
});

// Trigger:
mutation.mutate(newConfig);
```

- `useMutation` is `useQuery`'s cousin for changes. Returns `{ mutate, isPending, isError, ... }`.
- `mutationFn` does the POST/PATCH/DELETE.
- `onSuccess` runs after server confirmation; we invalidate the relevant key; observers refetch automatically.
- `mutation.mutate(newConfig)` from a button click.

### 15.1 Skip optimistic updates

Optimistic updates (write cache before confirm, roll back on reject) feel snappier but the rollback logic is a beginner trap. At MVP, show a "Saving..." indicator and refetch on success. Add optimistic later if a specific flow demands it.

---

## 16. Loading states

Two valid patterns; pick one and stick with it.

### 16.1 `isPending` flag (recommended for beginners)

```tsx
const { data, isPending } = useQuery(...);
if (isPending) return <Skeleton />;
return <Chart points={data.points} />;
```

Inline, explicit, easy to reason about. The component owns its loading slot.

### 16.2 Suspense + `useSuspenseQuery`

```tsx
<Suspense fallback={<PanelSkeleton />}>
  <InspectionsPanel />
</Suspense>

// Inside InspectionsPanel:
const { data } = useSuspenseQuery(...);  // never returns isPending; suspends instead
return <Chart points={data.points} />;
```

Cleaner for whole-section loading; less granular control.

### 16.3 The trap: mixing them

Mixing `useQuery` and `useSuspenseQuery` haphazardly causes flicker and hydration warnings. Pick one approach per panel. As a beginner, default to `isPending`.

### 16.4 Skeleton vs spinner

Skeletons (gray placeholder shapes) for any container loading >~200 ms. Spinners only for quick actions (button submits, modals). Whole-page spinners are the worst of both worlds.

---

## 17. Per-module fetching — why one mega-fetch is wrong

Tempting to have the pipeline produce one `dashboard.json` (~1.6 MB) and fetch it on boot. Don't.

| Approach | Verdict |
|---|---|
| One mega-fetch (1.6 MB) | Bad. Blocks first paint. Can't lazy-load tabs. One slow module poisons the screen. |
| One JSON per module | Good. Each `useQuery` runs in parallel. Off-screen modules don't fetch until visited. HTTP/2 multiplexes. |
| One JSON per chart | Overkill. More requests, more headers, more Worker CPU. |

Right granularity: per module. ~5–10 files per tenant per night. Each panel mounts its own `useQuery`. Browsers fetch in parallel over one HTTP/2 connection.

For off-screen tabs, just mount the `useQuery` inside the tab component (or use `enabled` to gate on visibility). Time loads instantly when clicked, doesn't slow initial paint.

---

## 18. Recommended `QueryClient` defaults

Here's the configuration block to set up once, at the root of your app:

```tsx
// src/main.tsx (excerpt)
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      gcTime: 30 * 60 * 1000,           // 30 minutes
      retry: 3,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
  },
});

// Wrap your app
<QueryClientProvider client={queryClient}>
  <App />
</QueryClientProvider>
```

Line by line:

- `staleTime: Infinity` — data is **never** automatically stale. Each date has its own URL; "fresh" means "we already have today's data," which won't change during the session. You might wonder if `Infinity` is dangerous — the answer is no, because the `queryKey` includes the date. When the date changes, you have a different key, a different query, a fresh fetch. Manual invalidation still works (mutations).

- `gcTime: 30 * 60 * 1000` — 30 min in ms. After a component unmounts, cache lingers 30 min. Navigate Time → Estimating → Time within 30 min: Time renders instantly from cache. After 30 min idle, dropped to free memory.

- `retry: 3` — on a thrown error from `queryFn` (any non-OK status if the wrapper throws), retry up to 3 times. Default, but explicit is clearer.

- `retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000)` — exponential backoff: 2s, 4s, 8s, capped 30s. Prevents hammering a flaky server.

- `refetchOnWindowFocus: false` — by default, TanStack Query refetches on tab refocus. For nightly data that's pointless noise. Off.

- `refetchOnReconnect: true` — refetch when the network recovers. Real signal worth a fetch.

That's the whole config. Set once, never touched. Per-query overrides are rare; if you find yourself overriding `staleTime` per query, something else is wrong.

### 18.1 Adding a global error handler (optional)

```tsx
import { QueryCache } from '@tanstack/react-query';

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof UnauthorizedError) {
        window.location.href = '/login';
      }
    },
  }),
  // ...defaultOptions as above
});
```

`queryCache.onError` fires after retries exhaust. Use for global concerns ("log out on 401"). Component-level errors still go through `isError`/`error`.

---

## 19. Five things NOT to do

Each is a real failure mode.

1. **Don't omit the tenant slug from `queryKey`.** Cross-tenant data leak. Use the `queryKeys` factory; never construct keys inline.
2. **Don't put `today` or `latest` in URLs.** Breaks immutable HTTP caching, creates race conditions. Date in the path, always.
3. **Don't fetch the whole dashboard as one JSON.** Per-module is strictly better. One slow module shouldn't block the others.
4. **Don't roll your own cache with React Context.** You'll rebuild a worse TanStack Query and ship a multi-tenant data leak. Use the library.
5. **Don't enable `refetchOnWindowFocus` for nightly data.** Pointless flickers, zero benefit when data updates at 2 AM.

---

## 20. By the end of this doc you should know

- The five caching layers (R2 → Worker → edge cache → browser HTTP cache → TanStack Query) and each one's job.
- What a `queryKey` and `queryFn` are.
- Why TanStack Query v5 is the pick over native `fetch`+`use()`, SWR, and Context-based wrappers.
- How to write a complete `useQuery` panel.
- The tenant-cache-scoping rule (`tenantSlug` in every `queryKey`) and how the `queryKeys` factory enforces it.
- Why `/api/tenants/<slug>/snapshots/<date>/<module>.json` lets us cache forever.
- Why "today" or "latest" in URLs causes cache-poisoning bugs.
- How the client gets the date (inlined `latestSnapshotDate` in the tenant config script tag).
- Why we inline tenant config but client-fetch the snapshot data.
- The cookie-based auth pattern (`HttpOnly`, `Secure`, `SameSite=Lax`).
- The CORS rule of thumb (same domain = no CORS).
- What to show when last night's run failed.
- The error-handling table for 401 / 403 / 404 / 5xx / network.
- The mutation pattern (`useMutation` → `invalidateQueries`).
- Why to default to `isPending` over Suspense as a beginner.
- Why per-module fetching beats one mega-fetch.
- The `QueryClient` defaults block, line by line.
- The five things not to do.

If any are still fuzzy, re-read the relevant section.

---

**Next:** Phase 2 starts at `10-auth.md` (coming next) — how `HttpOnly` cookies are actually set by the Worker, how sessions are validated on every request, and how a tenant-scoped login flow works end-to-end.
