# 09 — Data Fetching: From the React Component to the Gateway and Back

> **Prerequisites:** read `00-start-here.md`, `05-cloudflare-architecture.md` (Tauri architecture), `06-customer-data-ingest.md`, and `07-nightly-data-pipeline.md` (so you understand why we're "live" instead of snapshot-based).

> **By the end of this doc you will know:** the complete path a single number takes — from a React metric component, through a Tauri command, through Rust's HTTP client, to the gateway, to the customer's database, and back. What TanStack Query is and why we use it for client-side caching. How errors propagate so the user sees a useful message, not a white screen. What to do when the gateway is unreachable. Retry strategy. The five things not to do.

This is a long one. It's the layer that makes the difference between a dashboard that *technically works* and one that *feels live*.

---

## 1. The hook

Docs 00–08 covered who is who, what config decides what renders, and where the gateway lives. This doc covers the boring middle bit: how a React component actually *asks for* a number and *gets one*. We'll trace the call top-to-bottom, layer by layer, and then add the things you need to make it production-grade — caching, retries, loading states, error handling, and what happens when the gateway is having a bad day.

---

## 2. Vocabulary primer

You'll see all of these terms in this doc. Skim now, refer back as you read.

- **Query** — in TanStack Query, "a query" is one piece of data you've asked for (not a SQL query). "Time module's monthly-hours" is one query. Multiple components asking for the same query share one cache entry.

- **Cache** — short-term storage of fetched data. We have several stacked: TanStack Query's in-memory cache inside the webview, an optional TTL cache inside the gateway, and the database's own buffer cache. We'll say which one when it matters.

- **Stale** — TanStack Query's word for "older than `staleTime`; refetch in the background next time someone asks." Stale data still renders; the refetch is invisible. Stale ≠ wrong.

- **Fresh** — the opposite. Younger than `staleTime`. Will not be refetched, even when new components mount. This is what makes 5 components asking for the same data cost 1 network request.

- **`gcTime`** ("garbage collection time") — how long unused cache entries linger after the last observer unmounts. After `gcTime` with no observers, the entry is dropped.

- **Tauri command** — a Rust function exposed to React via `invoke(name, args)`. (See doc 05 §3.2.) The bridge through which all data fetching travels.

- **Bearer token** — a long random string the desktop app sends in the `Authorization` header on every gateway call. The gateway only accepts requests with the right token. (See doc 08 §2.4.)

---

## 3. The full call path, in one picture

```
   ┌───────────────────────────────────────────────────────────────┐
   │ React component: <MonthlyHours />                             │
   │                                                               │
   │   const { data, isLoading, error } = useQuery({              │
   │     queryKey: ['metric', 'time.monthly-hours'],              │
   │     queryFn: () => fetchMetric('time.monthly-hours'),        │
   │   });                                                         │
   └─────────────────────────────┬─────────────────────────────────┘
                                 │ TanStack Query checks its cache.
                                 │ Cache miss → call queryFn.
                                 ▼
   ┌───────────────────────────────────────────────────────────────┐
   │ fetchMetric() — a thin wrapper around invoke()                │
   │                                                               │
   │   import { invoke } from '@tauri-apps/api/core';             │
   │   return invoke('fetch_metric', { id: 'time.monthly-hours' });│
   └─────────────────────────────┬─────────────────────────────────┘
                                 │ Tauri sends the call to Rust.
                                 ▼
   ┌───────────────────────────────────────────────────────────────┐
   │ Rust: #[tauri::command] async fn fetch_metric(id: String)     │
   │                                                               │
   │  1. Read activation.json → get gateway_url + bearer_token    │
   │  2. HTTP GET {gateway_url}/metrics/{module}/{id_suffix}      │
   │     with Authorization: Bearer {bearer_token}                │
   │  3. Parse JSON, return to React                              │
   └─────────────────────────────┬─────────────────────────────────┘
                                 │ HTTPS over the LAN.
                                 ▼
   ┌───────────────────────────────────────────────────────────────┐
   │ Gateway: FastAPI route GET /metrics/time/monthly-hours       │
   │                                                               │
   │  1. Verify bearer token                                       │
   │  2. Acquire DB connection from pool                          │
   │  3. Execute SQL query                                        │
   │  4. Shape rows into JSON                                     │
   │  5. Return                                                   │
   └─────────────────────────────┬─────────────────────────────────┘
                                 │ SQL over the LAN.
                                 ▼
   ┌───────────────────────────────────────────────────────────────┐
   │ Customer's database: SQL Server / MySQL / Postgres            │
   │  Runs the query, returns rows.                                │
   └───────────────────────────────────────────────────────────────┘
```

Six hops, but every hop is short and over a LAN (except the React → Rust hop which is in-process). The total latency budget for a typical metric is a few hundred milliseconds — about as fast as a button press.

---

## 4. The React side: TanStack Query

We use **TanStack Query** (formerly React Query) to manage the client-side cache. Why:

- It handles the awkward states (loading, error, success) so each metric component is ~5 lines.
- It dedupes — if 3 components ask for the same metric in the same render, only 1 network call goes out.
- It caches in memory, so re-mounting a panel doesn't refetch from scratch.
- It auto-refreshes when the window regains focus (great for "I just came back from lunch — show me current numbers").
- The API is small. Read the [Quick Start](https://tanstack.com/query/latest/docs/framework/react/quick-start) and you've seen 80% of it.

### 4.1 Setup

```tsx
// src/main.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import App from './App';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,           // data is "fresh" for 30 seconds
      gcTime: 5 * 60_000,          // keep in cache 5 mins after unmount
      retry: 2,                    // retry failed calls twice
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
      refetchOnWindowFocus: true,  // refetch when window regains focus
      refetchOnReconnect: true,    // refetch after a network blip
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);
```

Walking each option:

- **`staleTime: 30_000`** — once a metric is fetched, treat it as fresh for 30 seconds. If a user clicks around and the same metric is referenced from multiple panels, that's one fetch, not many. After 30 seconds it becomes "stale," meaning *the next time someone observes it*, refetch in the background while showing the stale value.

- **`gcTime: 5 * 60_000`** — keep cache entries around for 5 minutes after no one is observing them. Means switching between panels and back doesn't re-fetch.

- **`retry: 2` + exponential backoff** — for transient blips. If the gateway returns a 500 once, try again in 1s, then 2s.

- **`refetchOnWindowFocus`** — when a user tabs back to the app after lunch, refresh the data. Cheap and a nice "feels live" moment.

- **`refetchOnReconnect`** — when the LAN comes back after a hiccup, refetch.

These are reasonable defaults. Specific queries can override them when they want.

### 4.2 The metric component

```tsx
// src/panels/time/MonthlyHours.tsx
import { useQuery } from '@tanstack/react-query';
import { fetchMetric } from '../../api/fetchMetric';
import { Chart, Skeleton, ErrorTile } from '../../ui';

export default function MonthlyHours() {
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['metric', 'time.monthly-hours'],
    queryFn: () => fetchMetric('time.monthly-hours'),
  });

  if (isLoading) return <Skeleton />;
  if (error) return <ErrorTile message={String(error)} />;

  return (
    <div className="metric">
      <h3>Monthly Hours {isFetching && <RefreshDot />}</h3>
      <Chart data={data.monthly} />
    </div>
  );
}
```

Five things to notice:

1. **`queryKey: ['metric', 'time.monthly-hours']`** — the cache key. TanStack Query uses array equality (deep) to look up entries. Any component asking for the same key shares the same cache entry.

2. **`queryFn`** — the function that actually fetches. Returns a Promise.

3. **`isLoading`** — true only on the *first* fetch when no cached value exists. After data lands, `isLoading` becomes false forever; subsequent refetches show `isFetching` instead.

4. **`isFetching`** — true any time a fetch is in progress (initial OR background refresh). The `<RefreshDot />` is a tiny visual hint that "we're updating this number in the background." Nice touch.

5. **`error`** — present when the latest fetch failed. We show an error tile. The user can scroll past it; the rest of the dashboard still works (TanStack Query isolates failures to the metric that fails — neighbor metrics keep showing their numbers).

### 4.3 A note on query keys (much simpler than the old plan)

In the old web plan, every query key had to start with the tenant slug, because the in-memory cache could otherwise serve Acme's data to a BigShop session after a "switch tenant" event. That was the whole point of doc 09 in the old plan.

In the new plan, **each install only ever serves one tenant** (the activation flow locks it). There's no "switch tenant" in normal use. So the cache key only needs to encode "which metric," not "which tenant."

```ts
// Old (web): tenant required in every key
queryKey: ['tenant', tenantSlug, 'metric', 'time.monthly-hours']

// New (desktop): tenant implicit
queryKey: ['metric', 'time.monthly-hours']
```

Less ceremony. If you ever add a "switch tenant" feature, you'd reintroduce the tenant prefix and clear the cache on switch.

### 4.4 The query-keys factory

To keep keys consistent and discoverable, define them in one place:

```ts
// src/api/queryKeys.ts
export const queryKeys = {
  metric: (id: string) => ['metric', id] as const,
  module: (id: string) => ['module', id] as const,
  health: () => ['health'] as const,
};
```

Use it like:

```ts
useQuery({
  queryKey: queryKeys.metric('time.monthly-hours'),
  queryFn: () => fetchMetric('time.monthly-hours'),
});
```

When you invalidate a metric (force refresh after some action), it's:

```ts
queryClient.invalidateQueries({ queryKey: queryKeys.metric('time.monthly-hours') });
```

Centralizing the keys makes "what's currently in the cache?" easy to enumerate when debugging.

---

## 5. The bridge: `fetchMetric` (TypeScript)

The thin wrapper between TanStack Query and Tauri:

```ts
// src/api/fetchMetric.ts
import { invoke } from '@tauri-apps/api/core';

export type MetricResponse = {
  metric: string;
  data: unknown;          // shape depends on the metric
  fetched_at: string;     // ISO 8601 timestamp from the gateway
};

export async function fetchMetric(id: string): Promise<MetricResponse> {
  return await invoke<MetricResponse>('fetch_metric', { id });
}
```

`invoke` returns a Promise. If the Rust command returns `Err(...)`, the Promise rejects with that string. TanStack Query catches the rejection and surfaces it as `error`.

`MetricResponse.data` is `unknown` here because each metric has its own shape. You can narrow it per-metric:

```ts
type MonthlyHoursData = { monthly: Array<{ month: string; hours: number }> };

const { data } = useQuery<MetricResponse & { data: MonthlyHoursData }>({
  queryKey: queryKeys.metric('time.monthly-hours'),
  queryFn: () => fetchMetric('time.monthly-hours') as Promise<MetricResponse & { data: MonthlyHoursData }>,
});
```

That cast is fine because the gateway controls the response shape and the dashboard versions move in lockstep with the gateway (doc 11).

---

## 6. The Rust side: `fetch_metric`

The Tauri command:

```rust
// src-tauri/src/commands.rs
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct MetricResponse {
    metric: String,
    data: serde_json::Value,
    fetched_at: String,
}

#[derive(Deserialize)]
struct Activation {
    tenant: String,
    gateway_url: String,
    bearer_token: String,
    exp: u64,
}

fn read_activation(app: &tauri::AppHandle) -> Result<Activation, String> {
    let path = app.path().app_data_dir().unwrap().join("activation.json");
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let act: Activation = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(act)
}

#[tauri::command]
async fn fetch_metric(
    app: tauri::AppHandle,
    id: String,
) -> Result<MetricResponse, String> {
    let act = read_activation(&app)?;

    // Map "time.monthly-hours" -> "/metrics/time/monthly-hours"
    let path = id.replace('.', "/");
    let url = format!("{}/metrics/{}", act.gateway_url, path);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .bearer_auth(&act.bearer_token)
        .send()
        .await
        .map_err(|e| format!("gateway unreachable: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("gateway returned {}", response.status()));
    }

    let json: MetricResponse = response
        .json()
        .await
        .map_err(|e| format!("gateway sent malformed JSON: {}", e))?;

    Ok(json)
}
```

Walking through:

- **Read activation.json on every call.** We could cache it in memory, but reading a small file on every call is a few microseconds and saves us cache-invalidation headaches when the user re-activates.
- **`reqwest::Client` with a 10-second timeout.** If the gateway hangs, give up after 10s and surface "gateway unreachable" to React. (We don't want to leave the user staring at a spinner forever.)
- **`bearer_auth`** — sets the `Authorization: Bearer <token>` header. The gateway requires it.
- **Error formatting.** Each error path produces a string suitable for showing to a non-technical user. "Gateway unreachable" is meaningful; "reqwest::Error { os_error: 111 }" is not.

The `app: tauri::AppHandle` parameter is injected automatically by Tauri at call time. You don't pass it from React.

---

## 7. What the user sees during each state

| State | What's happening | What to show |
|---|---|---|
| First fetch in progress | TanStack: `isLoading=true` | Skeleton placeholder. Don't show numbers from elsewhere; show the metric's "shape" with no data. |
| Background refetch | `isLoading=false`, `isFetching=true` | Show the previous numbers + a small refresh indicator. Don't blank the UI. |
| Success | `data` populated | Render normally. |
| Error after at least one success | `error` set, `data` still populated (stale) | Show the data with a warning ("last updated 12 min ago"). |
| Error with no previous success | `error` set, `data === undefined` | Show an error tile with the message. Don't try to render an empty chart. |
| Gateway unreachable for > 30 seconds | Repeated failures | Show a global banner: "Can't reach the data gateway. Check that the gateway machine is running." Other metrics keep trying in the background. |

That last one — the global banner — is worth a small piece of code:

```tsx
// src/components/GatewayHealthBanner.tsx
import { useQuery } from '@tanstack/react-query';
import { fetchHealth } from '../api/fetchHealth';

export function GatewayHealthBanner() {
  const { error } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    refetchInterval: 30_000,         // poll health every 30s
    retry: false,                    // health is binary; no retries
  });

  if (!error) return null;

  return (
    <div className="banner-error">
      Can't reach the data gateway. Numbers may be out of date.
      Ask your IT person to check the gateway machine.
    </div>
  );
}
```

`fetchHealth` calls a `/health` endpoint on the gateway that just returns `{ ok: true }`. Cheap and tells us whether the gateway is up.

---

## 8. Retries and timeouts (the layer of "transient bumps")

A metric fetch can fail for a bunch of reasons. Some are transient (a packet got dropped, the gateway briefly maxed out connections); some are real (the gateway is down). TanStack Query's retry layer hides the transient ones from the user.

Defaults from §4.1: `retry: 2`, exponential backoff. So a failing fetch is retried twice with delays of 1s and 2s before surfacing the error. Most flakes go away.

**Don't retry forever.** A user with a permanently-down gateway shouldn't see endless spinners; they should see "gateway unreachable" so they can call IT. Two retries is plenty.

**Don't retry 4xx errors.** TanStack Query's default `retry` is "retry on failure"; override it for specific cases:

```ts
const { data } = useQuery({
  queryKey: queryKeys.metric(id),
  queryFn: () => fetchMetric(id),
  retry: (failureCount, error) => {
    // Don't retry 4xx — those are programmer errors, not transient blips.
    if (String(error).match(/gateway returned 4\d\d/)) return false;
    return failureCount < 2;
  },
});
```

---

## 9. Offline behavior

Tauri apps can run on laptops that briefly lose LAN connectivity. What should the dashboard do?

### 9.1 Read-through cache

TanStack Query already has the answer: cached data is shown while fetches fail. Use it. Set `staleTime` modestly (30s default is fine) and `gcTime` longer (5 minutes default). Users coming back from a 2-minute network blip see the last good values, plus a refresh indicator.

### 9.2 Don't pretend you're online

If the gateway has been unreachable for a while, surface that clearly (the health banner from §7). Don't show stale numbers without a warning — users will trust them.

### 9.3 Don't persist cache to disk

It's tempting to persist TanStack Query's cache to disk so the dashboard "boots fast" with last-known numbers. Don't, for the same reason: stale numbers without context are dangerous. If you want a startup boost, run a single quick `/health` check and lazy-load metrics as they're scrolled into view.

### 9.4 The activation isn't tied to gateway availability

Even if the gateway is unreachable, the user can still open the app. They'll just see error tiles. They shouldn't be re-prompted to activate. The activation only depends on the local `activation.json` file (and the public key baked in).

---

## 10. Five things not to do

### 10.1 Don't fetch from React's `useEffect`

```tsx
// BAD
useEffect(() => {
  fetch('http://10.0.5.20:8080/metrics/time/monthly-hours').then(...);
}, []);
```

Two reasons: (1) Tauri apps can't easily make raw HTTP calls without going through Rust (CORS, certificate trust, bearer-token storage), and (2) you've reinvented half of TanStack Query, badly. Always go through `invoke` and `useQuery`.

### 10.2 Don't forget to handle the loading state

```tsx
// BAD
const { data } = useQuery(...);
return <Chart data={data.monthly} />;  // crashes when data is undefined
```

The first render always has `data === undefined`. Handle `isLoading` and `error` before touching `data`.

### 10.3 Don't put the gateway URL or bearer token in React

Those live in `activation.json`, read only by Rust. The React side never sees them. If you find yourself thinking "let me just pass the gateway URL to React for one call" — don't. It leaks into devtools, into source maps, into screenshots customers send for support.

### 10.4 Don't prefetch all 80 metrics on app boot

(Doc 07 §8.2 said this; saying it again.) Fetch on demand. Users who never open Inventory shouldn't load Inventory metrics.

### 10.5 Don't share one query for two different shapes of data

If two components display the same metric but one shows a chart and the other shows a single number, they're the same query. They share a cache entry. They render their own derivations of `data`. Don't make two queries with overlapping keys.

---

## 11. By the end of this doc you should know

- The full path of a data fetch: React → `invoke` → Rust → `reqwest` → gateway → DB → back.
- Why TanStack Query is the right tool for the React-side cache.
- The `staleTime` / `gcTime` / `retry` defaults and what each does.
- The `queryKeys` factory pattern (and why it's simpler than the old web plan — no tenant prefix needed).
- The Rust-side `fetch_metric` command, line by line.
- What the user sees in each loading / error / offline state.
- The retry and timeout policy.
- The five things not to do.

If TanStack Query is new, build a single metric component end-to-end and watch it work; it makes the rest of these concepts click.

---

**Next:** [`10-auth.md`](./10-auth.md) — license-key auth as the default, and what optional per-user auth looks like if you need it later.
