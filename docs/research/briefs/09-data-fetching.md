# Research Brief — Data Fetching for PowerFab Dashboard (for `09-data-fetching.md`)

Audience: solo dev, new to multi-tenant SaaS. App is read-mostly, refreshes once per night, ~1.6 MB JSON per tenant per night, served from R2 through a Cloudflare Worker, must hold up to ~200 tenants.

---

## 1. Native `fetch` + React 19 `use()` + Suspense

React 19 lets you pass a promise to `use()` inside a component, and Suspense unwraps it. The mental shift: instead of `useEffect` + `useState` + `isLoading`, you write code that *reads* data synchronously and lets the framework handle the waiting.

### What you get for free
- Promise unwrapping inside the render tree.
- `<Suspense fallback={...}>` for declarative loading UI.
- `<ErrorBoundary>` (still your code, but the pattern is clean).

### What you have to build yourself
| Capability | Built-in? | Notes |
|---|---|---|
| Caching across components | No | Two components calling the same fetch = two requests unless you memoize the promise. |
| Request deduplication | No | Same as above. |
| Stale-while-revalidate | No | Manual. |
| Refetch on focus/reconnect | No | Manual event listeners. |
| Retry on 5xx | No | Manual. |
| DevTools | No | `console.log` is your debugger. |
| Mutation + invalidate pattern | No | Manual. |

### When this alone is enough
A genuinely tiny read-only app: one or two fetches, no tenant scoping complexity, no mutations. PowerFab Dashboard is past that line because it has multiple modules per dashboard, multiple tenants, and "last updated" UX requirements.

### Tradeoff summary
Smallest bundle, most hand-rolling. Beginners often build a half-broken cache and waste a week. Skip.

---

## 2. TanStack Query v5

In 2026 this is still the default answer for server-state in React. SWR is alive but TanStack Query has more momentum, more docs, better DevTools, and broader plugin support.

### Mental model
- `queryKey`: a serializable array that uniquely identifies the data. Example: `['snapshot', tenantSlug, 'inspections', '2026-05-07']`.
- `queryFn`: an async function returning the data.
- `staleTime`: how long the cached data is considered "fresh." Fresh data is never refetched.
- `gcTime` (formerly `cacheTime`): how long unused cache entries linger before garbage collection.
- `useQuery`: the hook.

### Why it fits PowerFab
Data refreshes once per night. Set `staleTime: Infinity` and the snapshot will never auto-refetch during a session. Invalidate manually only when:
- The user explicitly hits a refresh control (post-MVP).
- A mutation changes server state (tenant config edits).
- The app detects a new snapshot date is available (optional polling of a tiny pointer file).

### Tenant cache scoping
The tenant slug **must** be the second element in every queryKey. If a user switches tenants (or an admin views another tenant), TanStack Query treats them as separate cache entries automatically. Without this, you will leak data across tenants on tenant switch — a multi-tenant SaaS bug that's easy to ship and hard to spot.

### DevTools
The DevTools panel shows every active query, its status, its data, its key, and a refetch button. For a beginner this is the single biggest reason to pick TanStack Query — you can *see* your cache.

### Bundle size cost
~13 KB gzipped for the core. Negligible against a 1.6 MB snapshot.

### Hard parts beginners trip over
| Pitfall | Fix |
|---|---|
| Forgetting tenant slug in queryKey | Centralize key construction in a `queryKeys.ts` factory. |
| Mixing `staleTime: 0` (default) with frequent refetches | Set sane defaults app-wide via `QueryClient` defaults. |
| Calling `useQuery` conditionally | Use the `enabled` option. |
| Treating queries like state (calling `setQueryData` everywhere) | Don't. Mutate the server, then invalidate. |
| Not handling `isPending` vs `isFetching` distinction | `isPending` = no data yet; `isFetching` = a refetch in flight. |

---

## 3. SWR

From Vercel. Lighter (~5 KB gzipped). Hooks-only. Same stale-while-revalidate model.

### When you'd pick it over TanStack Query
- You're already deep in the Vercel/Next ecosystem and want consistency.
- You truly only fetch and never mutate.
- Bundle size is critical (it isn't, here).

### Caveats
- DevTools are weaker.
- Mutation patterns are simpler but less expressive.
- Smaller community for advanced patterns (suspense, infinite queries, paginated mutations).

For PowerFab there's no compelling reason to pick SWR over TanStack Query.

---

## 4. Custom fetch wrapper + React Context

A `DataProvider` that fetches all snapshots on mount and stuffs them in context. Tempting because it feels "simple."

### When this is actually right
- Truly static data fetched once per page load.
- No staleness story needed.
- Single user, single dataset, no tenant switching.

### Why it's wrong for PowerFab
- You will reinvent dedup, retry, invalidation, and error handling — badly.
- Context re-renders the whole subtree when the value changes; you'll fight performance.
- No DevTools.
- Switching tenants requires manual cache resets.

Skip unless you enjoy debugging your own framework.

---

## 5. SSR vs Client Fetch

The Worker already injects tenant config as `<script type="application/json" id="tenant-config">...</script>`. Question: should it also inject the dashboard snapshot?

### Pros of inlining the snapshot
- Zero client-side fetch on first paint. Time-to-interactive improves.
- One round trip instead of HTML + JSON.

### Cons
| Issue | Detail |
|---|---|
| HTML bloat | 1.6 MB inline blows up first-byte latency and breaks streaming HTML benefits. |
| Cache invalidation | Inlined data ages with the HTML. If the snapshot updates mid-day, the inlined HTML is wrong unless you bust the HTML cache too. |
| Per-module fetching impossible | You can't lazy-load a module's data if it's already in the page. |
| Worker CPU | Reading 1.6 MB from R2 and templating it into HTML on every cold load uses Worker CPU time. |

### Recommendation for MVP
Inject **tenant config** (small, used immediately, set on every page) into HTML.
Fetch **snapshot data** client-side via TanStack Query against an immutable URL (browser HTTP cache will cover repeat loads — see section 7).

Revisit only if Lighthouse / Real User Metrics shows TTI is unacceptable.

---

## 6. Authentication on Fetch

### Cookie pattern (recommended)
- Session cookie set by the Worker on login.
- Flags: `HttpOnly` (JS can't read it, so XSS can't steal it), `Secure` (HTTPS only), `SameSite=Lax`.
- Browser sends it automatically with `fetch(url, { credentials: 'include' })` (or `same-origin` if same domain).
- Worker reads cookie, validates session, returns data or 401.

### Bearer token pattern
- Token stored in JS memory or `localStorage`.
- Sent as `Authorization: Bearer <token>` header.
- Necessary for: native mobile apps, third-party API consumers, some cross-origin setups.
- Not necessary for same-origin browser dashboards. Don't introduce it at MVP.

### CORS rule of thumb
Same domain (e.g., `acme.powerfab.app` calling `acme.powerfab.app/api/...`) → no CORS preflight, no `Access-Control-*` headers needed.

CORS becomes a problem the moment you split the API onto a different domain (`api.powerfab.app` calling from `acme.powerfab.app` is **cross-origin** — different subdomains count). Avoid this split until you have a real reason.

---

## 7. Caching Layers — Where Data Actually Lives

```
R2 -> Worker -> Cloudflare edge cache -> Browser HTTP cache -> TanStack Query in-memory
```

### Each layer's job
| Layer | Lifetime | Invalidates when |
|---|---|---|
| R2 | Forever (snapshots are immutable per date) | Never — you write a new file. |
| Cloudflare edge cache | `Cache-Control` directive | TTL expiry or purge. |
| Browser HTTP cache | `Cache-Control` directive | TTL expiry, hard refresh, URL change. |
| TanStack Query | `gcTime` after unobserved | Manual `invalidateQueries` or `staleTime` expiry. |

### URL must include the date
`/api/snapshots/2026-05-07/inspections.json` — yes.
`/api/snapshots/today/inspections.json` — no.

The dated URL lets you serve `Cache-Control: public, max-age=31536000, immutable`. Browsers and Cloudflare will cache it forever. The next day's data lives at a new URL — no purge needed, no race conditions.

### "What's the latest date?" pointer
You still need a way to know which date to fetch. Two options:

| Option | How | Pros | Cons |
|---|---|---|---|
| Small KV pointer | `tenants/<slug>/latest.json` → `{ "date": "2026-05-07" }` | Cheap, fast, easy to update | One extra fetch on page load |
| Inline in tenant config | Worker reads KV at HTML render and inlines `latestSnapshotDate` | Zero client fetch | Couples HTML cache to snapshot freshness |

Recommendation: inline the latest date into the tenant config script tag. HTML cache TTL becomes the freshness ceiling — set it to 5–15 minutes. The dated snapshot URL is then immutable forever.

---

## 8. Stale Data UX

### "Last updated" indicator
Show `Last updated: 2026-05-07 02:14 UTC` in a header or footer. Three reasons:
1. Trust — users know they're not looking at live data.
2. Debugging — when a customer says "the numbers are wrong," they can read the timestamp to you.
3. Failed run detection — if it says yesterday, the user knows.

### When the most recent night's run fails
| State | Show |
|---|---|
| Last night succeeded | Latest data, normal timestamp. |
| Last night failed, previous night succeeded | Previous night's data + amber banner: "Last night's data refresh failed. Showing data from <date>." |
| No snapshots ever | Empty state with onboarding hint. |
| Fetch error (network/5xx) | Toast + retry button, keep last good data on screen if any. |

Never show a blank screen on failed refresh when you have yesterday's data.

---

## 9. Error Handling

| Status | UX | TanStack Query option |
|---|---|---|
| 401 / 403 | Redirect to login. | Global `onError` in `QueryClient` defaults. |
| 404 (no snapshot that date) | Fall back to most recent date, banner about staleness. | Throw a typed error, catch in component to refetch with prior date. |
| 5xx | Toast + auto-retry with exponential backoff. | Default retry: 3 with backoff. Tune per-query. |
| Network error / offline | Persistent offline banner; pause queries. | `onlineManager` from TanStack Query handles this. |

Centralize 401 handling in a `fetch` wrapper that throws a typed `UnauthorizedError`. Don't sprinkle redirects through components.

---

## 10. Mutations (minor at MVP)

Use case: tenant config edits, user prefs.

### Pattern
1. `useMutation({ mutationFn })` to POST/PATCH.
2. On success, call `queryClient.invalidateQueries({ queryKey: ['tenantConfig', tenantSlug] })`.
3. The invalidated query refetches automatically because a component is observing it.

### Optimistic updates
Skip at MVP. The UX is nicer but the rollback logic is a beginner trap. Add later if a specific flow demands it.

---

## 11. Loading States

### Two valid patterns
| Pattern | When |
|---|---|
| `isPending` flag returned by `useQuery` | Inline within a small component, simple skeleton. |
| Suspense boundary + `useSuspenseQuery` | Whole-page or whole-section fallback. |

### Beginner recommendation
Start with `isPending` flags. Add Suspense boundaries only once your component tree is stable and you understand both. Mixing the two haphazardly causes flicker and hydration warnings.

### Skeleton vs spinner
Skeletons (gray placeholder boxes shaped like the real UI) for any container loading more than 200 ms. Spinners only for quick actions (button submits, modal opens). A whole-page spinner is the worst of both worlds.

---

## 12. Per-Module Fetching

Total payload ~1.6 MB across modules. Splitting strategy:

| Approach | Verdict |
|---|---|
| One mega-fetch (`dashboard.json`, 1.6 MB) | Bad: blocks first paint, can't lazy-load tabs, one slow module poisons all. |
| One JSON per module (`inspections.json`, `time.json`, etc.) | Good. Each module's `useQuery` runs in parallel. Modules off-screen (other tabs) don't fetch until visited. |
| One JSON per chart | Overkill: more requests, more headers, more Worker CPU. |

### Right split
Per module. Roughly 5–10 module-level JSON files per tenant per night. Each `useQuery` keyed by `['snapshot', tenantSlug, moduleName, date]`. HTTP/2 multiplexes the parallel fetches efficiently.

For tabs/routes that aren't on-screen, defer the query with `enabled: isTabActive` or just mount the query inside the tab's component.

---

## 13. Recommendation Block

### Primary tool
**TanStack Query v5.** It's the 2026 default for React server-state. The bundle cost is a rounding error against the data payload. The DevTools alone justify the choice for a solo beginner.

### Recommended config
```
QueryClient defaults:
  staleTime: Infinity         // data is immutable per date
  gcTime: 30 minutes          // keep cache around when modules unmount
  retry: 3 with exp backoff   // for 5xx
  refetchOnWindowFocus: false // pointless for nightly data
  refetchOnReconnect: true    // recover from network blips
```

### Recommended URL structure
```
/api/tenants/<slug>/snapshots/<YYYY-MM-DD>/<module>.json
```
- Tenant slug in path → easy Worker routing.
- Date in path → immutable, infinitely cacheable.
- Module in path → per-module fetch, parallel, lazy.

Latest-date pointer: inline `latestSnapshotDate` in the tenant config script tag. HTML cache TTL 5–15 minutes.

### Five things a beginner should NOT do
1. **Don't omit the tenant slug from `queryKey`.** You will leak cross-tenant data.
2. **Don't use `today` or `latest` in URLs.** Breaks immutable HTTP caching and creates race conditions.
3. **Don't fetch the whole dashboard as one JSON.** Per-module is strictly better.
4. **Don't roll your own cache with React Context.** You'll rebuild TanStack Query, badly.
5. **Don't enable `refetchOnWindowFocus` for nightly data.** Pointless requests, scary "loading" flickers, no benefit.
