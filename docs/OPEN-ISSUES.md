# Open Issues — PowerFab Dashboard

Snapshot as of 2026-05-05. Every open GitHub issue, organized by module. For each: what the issue is, current state, and any commentary that has accrued.

---

## Time module

The Time module had a gold-standard parity push (umbrella #39) that shipped TIME-A through TIME-E. The remaining issues here are follow-ups from that push: backend cleanup, the daily-Δ badge wiring (TIME-F), the setup-data conversation for Ricky, and the lower-level TIME-D ticket.

### #52 — TimeModule.cs cleanup: dataAnchorDate + productionEstimatedHours + honest coverage
**Labels:** none
**Status:** Filed, low priority, not started

**What it is:** Three client-side workarounds in `Time.tsx` that should be honest in the backend instead. Each works fine, but they accumulate as load-bearing comments and the next person touching the panel risks repeating the underlying mistakes. Filed as out-of-scope follow-up from umbrella #39 (TIME-A through TIME-F).

The three pieces:
1. **Emit `dataAnchorDate` from actual event coverage.** `time.json`'s `dataQuality.firstDate`/`lastDate` are wall-clock-derived (today − 5y → today), not from event data. The bucketed feeds lag this by a year-plus, so default range = last30 resolves to a window with no data. Workaround: `Time.tsx:154` `computeDataAnchor()` anchors picker on `max(monthlyHours.month)` (~15 LOC). Fix: emit `dataQuality.dataAnchorDate` server-side, mirroring Inspections' `kpis.dataAnchorDate`.
2. **Emit `productionEstimatedHours` per project.** `perProject.estimatedHours` is full-BOM lifetime (all labor categories); `perProject.actualHours` is production-station-only, post-2023-01. Computing variance off the diff is incoherent — empirically 96% of projects show <20% consumption. Workaround: separate `EstVsActualPanel` consumes a `estimated-vs-actual.json` (legacy lane) plus a memory file warning future sessions not to paint variance off `perProject`. Fix: emit `perProject.productionEstimatedHours` alongside existing `estimatedHours` — sum of `perProjectStation.estimatedHoursAllocated` per project.
3. **Fix the misleading 100% coverage figure** (umbrella #39 flag). `dataQuality.coveragePct` is mathematically forced to ~100% because `totalEvents` and `eventsWithHours` come from the same API filter. Δ-vs-yesterday on this would always be 0. Workaround: coverage Δ intentionally absent from TIME-F's state-KPI strip. Fix: compute coverage against the un-filtered universe (`COUNT(*)` on raw `productioncontrolitemstations` from the DB lane, like the old `_archive/time_metrics.py`), or remove the field if it can't be made honest.

**Open questions:**
1. Replace `dataQuality.lastDate` semantics or add a new `dataAnchorDate` field alongside? (lean: add new)
2. `productionEstimatedHours` per `perProject` row, or a separate top-level array? (lean: per row)
3. Is fixing coverage in scope, or split it to its own ticket? (lean: split)
4. DB-lane sidecar or in-module C# computation? (lean: pieces 1+2 in-module, piece 3 needs DB lane)

**Comments:** none.

---

### #50 — [TIME-F] Daily-Δ badges on Time panel state KPIs (#39)
**Labels:** none
**Status:** Filed with all decisions resolved (2026-05-05); will branch off main after #49 lands

**What it is:** Mirror the Inspections pilot from #46 — add "vs yesterday" badges to the Time panel's all-time/state KPIs so managers can see whether anything changed since yesterday's regen. Closes Gap F under umbrella #39.

UI-only change to `app/src/pages/Time.tsx`:
1. Swap `useData<TimeData>("time.json")` → `useSnapshot<TimeData>("time.json")`
2. Add a `STATE_KPIS` const map listing the 3 lifetime metrics that get badges
3. Render a `<StateKpiStrip today yesterday />` section above `<DateRangePicker />` — same "Today's snapshot · all-time, vs yesterday" header as Inspections
4. Range-aware KPI grid stays unchanged

Pattern source: `Inspections.tsx:117–121` (STATE_KPIS), `Inspections.tsx:883–924` (StateKpiStrip).

**Decisions resolved (2026-05-05):**
- KPIs that get Δ badges: **Total hours logged (lifetime)**, **Total estimated hours (lifetime)**, **Avg hrs/event (lifetime)**. Skip range-aware metrics.
- Strip placement: **above the date picker** (same as Inspections)
- New `kpis.totalHoursLogged` field upstream? **No — derive client-side** for v1
- Include "Hours coverage" in the strip? **Skip for now** (gated on coverage-calc fix in #52)
- DeltaBadge format for "Avg hrs/event": **add a `decimal` format** (~5 LOC)
- Bundling: **single small PR** off a fresh branch off main once #49 lands

**Out of scope:** upstream `kpis.totalHoursLogged` field (rolled into TimeModule cleanup #52), coverage Δ (gated on coverage-calc fix), polarity coloring on DeltaBadge.

**Comments:** none.

---

### #47 — Setup review (Ricky): Labor Group → Station mapping for accurate by-station estimates
**Labels:** module:time
**Status:** Filed, awaiting Ricky's review (this is a flag, not a bug)

**What it is:** While building "estimated hrs by station" (#45), discovered that PowerFab's setup data has a population gap that blocks the most-accurate path. Issue is filed for Ricky to confirm whether the setup needs cleanup, or whether we accept current state.

**Two approaches tried:**
- **Approach 1 — Labor Group → Station setup link.** Most "intentional" path: take each estimate operation, look at its Labor Group, look at which Station(s) that Labor Group is configured for in Stations setup. Didn't work — only 3 stations have any Labor Groups linked (Final QC: 21, Voortman: 1, b-Erected: 1). Every other production station has zero. Plus, of the 22 Labor Groups defined, only 5 show up on real estimates, and "Other" carries 96% of all BOM hours by itself — and "Other" is linked only to Final QC. Running Approach 1 as designed would dump basically every estimated hour onto Final QC.
- **Approach 2 — per-item shop routing.** Skip the Labor Group bridge; just split estimated hours equally across the stations on each item's route. Less precise but uses populated data. **This is what shipped in #45.**

**The three scenarios Ricky needs to pick from:**
1. **Setup just hasn't been filled in.** A one-time pass through Stations setup + estimating templates would let us switch back to Approach 1 (BOM-based) for much better accuracy.
2. **Setup IS what's actually used at this shop.** Approach 2 (route-based equal split) stays as the long-term answer; no setup work to do.
3. **There's a different path we're missing.** Maybe a setup screen we haven't looked at, or a different mapping that explains how the shop intends estimated hours to flow to stations.

**What's currently on the dashboard:** Approach 2 (route-based equal split). Caveats: equal split isn't most accurate, accuracy improves as more items have routes set (~78% do today), and some ratios look dramatic (e.g. 1-Cut/Saw shows 250× more estimated than actual — likely because cut work isn't being clocked there).

**Comments:** none.

---

### #45 — TIME-D: Estimated hrs by station + project×station via BOM β-strategy
**Labels:** module:time, type:task
**Status:** Shipped via Option B (route-based) instead of original β-strategy; #47 flagged for Ricky

**What it is:** Sub-issue under umbrella #39, closes Gap D (gold standard #2 + #3). Populate two empty fields: `perStation[].estimatedHours` (new) and `perProjectStation[].estimatedHoursAllocated` (currently always `null`).

**Original plan:** β-strategy from estimating BOM via the join chain `estimateitemoperations.ManHours → operations.LaborGroupID → stationlaborgroups → stations`. Allocation rule: equal split (lean v1). Bridge documented in `docs/analysis/verified-fks.md:401`.

**Build-time decisions recorded 2026-05-04:** equal-split fan-out for many-to-many; only PC-linked estimates for `perStation` totals; production-only station filter; drop unmapped operations (count in diagnostics, log warning); bundle perStation + perProjectStation; print station-level est/actual ratio table at end-of-run.

**Comments:**

**Comment 1 — found a setup gap that blocks the original plan:** Labor Group → Station setup isn't populated the way the calculation needs. Only 3 stations have Labor Groups linked; "Other" Labor Group carries 96% of BOM hours and only links to Final QC. Running β as designed would dump everything on Final QC. Five options laid out (A: allocate proportionally by actual mix; B: look for different bridge; C: drop the metric; D: ship as-is with warning; E: clean up setup in PowerFab). Recommended A or C; B worth ≤1 hour.

**Comment 2 — Option B worked, routes were the right bridge.** Walked every item in production control (each carries an estimated ManHours value and a Route from PowerFab) and split each item's hours equally across the stations on its route (CFQ, CFQOE, VFQ, VQ, etc.). 87% of items routable (46,995/54,028); 74% of ManHours routable (56,795/76,756); production stations get 40,485 hrs, field stations drop 16,309 hrs (correctly excluded), unrouted drops 19,961 hrs. Sum reconciles cleanly. 5 of 6 stations got estimated hours patched in. Ratios run high (5-10× on most stations, 250× on 1-Cut/Saw) because estimates are full-lifecycle and actuals are partial — these are data observations, not bugs. Files landed: `time_estimated_by_station.py`, `TimeEstimatedByStationSidecar.cs`, `TimeData.cs` updates, `TimeModule.cs` patches. Next: file #47 for Ricky's review of Labor Group → Station setup.

---

### #39 — [PLAN] Time module — gold-standard parity (hours over time, by project, by employee, est-vs-actual by station)
**Labels:** module:time, type:plan
**Status:** Plan; sub-issues TIME-A/B/C/D shipped, E embedded, F = #50 filed, cleanup = #52 filed

**What it is:** Umbrella plan to close gaps in the Time module against the gold-standard spec. 3 of 6 gold-standard metrics were missing or partial: estimated-vs-actual by station, by project×station, hours over time, hours by project over time, hours by employee over time.

**Guiding principle:** reuse, don't rebuild. Lift working pieces from `_archive/time_metrics.py` (the previous DB-backed implementation) rather than redesign.

**Decomposition (6 sub-issues):**
1. **TIME-A** (#41 ✅) — `monthlyHours` API pull (Gap A). Pilot.
2. **TIME-B** (#42 ✅) — Per-project monthly hours (Gap B). Code-only change.
3. **TIME-C** (#44 ✅) — Hours-by-employee feed (Gap C). DB-direct via Python lane sidecar.
4. **TIME-D** (#45 — shipped via Approach 2) — Estimated-by-station allocation. Ended up route-based, not BOM-β.
5. **TIME-E** (#48 ✅) — Time panel UI extension. Wired all four data feeds + DateRangePicker.
6. **TIME-F** (#50 — open) — Time panel daily-Δ indicators.

**Decisions log (curated):**
- 2026-04-29: Physical Station only on by-station rollups, not Pay Category (Ricky)
- 2026-04-29: Shop hours exclude Field-type stations (Ricky)
- 2026-05-01: API multi-axis `GroupBy` (e.g. `Job#,Station`) is rejected
- 2026-05-04: DB fallback acceptable when old Python SQL already proves the metric
- 2026-05-04: Hours-by-employee leaderboard shows both portfolio-wide and per-project
- 2026-05-04: Estimated-by-station: option β (later overridden to Approach 2 — see #45)
- 2026-05-04: UI shipping cadence eventually batched into TIME-E (not incremental as originally planned)
- 2026-05-04: TIME-C goes DB-direct without an API probe step

**Cross-cutting flags:** existing 100% coverage figure is misleading (tracked in #52); field-type station exclusion enforced; Pay Category not used; DB orchestration via Python lane sidecar pattern.

**Comments:**

1. **Resolution pass 2026-05-04** — Q1/Q2/Q4 resolved. Q1 (estimated-by-station) → β. Q2 (UI cadence) → incremental (later changed). Q4 (API probe for TIME-C) → skipped.
2. **Progress update 2026-05-04** — TIME-A and TIME-B data feeds shipped on `time-a-monthly-hours`. Sum cross-check matched exactly. UI cadence adjusted: chart wiring batched into TIME-E rather than per data feed (3 reasons: cleaner panel pass, all 4 feeds simultaneously means fewer placeholders, user closed #41 + #42 on this basis).
3. **Progress note 2026-05-04** — TIME-C shipped (#44). Cross-source check: Σ DB perEmployee hours ≡ Σ API monthlyHours over same window (exact match at 1951.7791h). `perStation.distinctEmployees` patched from DB sidecar (was hardcoded 0). Up next: TIME-D.
4. **Bucket-shape pattern is the cross-module template** — pinning for future reference: per-row bucket pattern Time emits is reusable architecture for every other panel under #38. `monthlyXxx[]` for >90-day windows, `dailyXxx[]` for short/recent. Plus page-level `kpis.dataAnchorDate`. Wiring boilerplate is ~80 lines of `useMemo` over per-row buckets — reference: `Inspections.tsx` (`aggregateOverall`, `aggregateRowInRange`, `buildChartData`).
5. **Cross-link #46 filed** — Time's state KPIs get Δ-since-yesterday badges for free once #46 lands. Pilot is Inspections; Time wiring is follow-up (now #50).

---

## Cross-cutting / dashboard-wide

Issues that span multiple panels or are architectural rather than scoped to a single module.

### #46 — Daily snapshots pipeline (#38 sub-issue 2)
**Labels:** module:cross-cutting, needs:implementation, type:task
**Status:** Implemented on branch `time-a-monthly-hours` (unmerged at time of comment); subsequently merged via PR #46

**What it is:** Sub-issue 2 of umbrella #38. Builds the snapshot pipeline once + the FE reader hook + Δ-badge component, then wires Inspections as the pilot. State-KPI Δ badges need a prior-day reference, but PowerFab doesn't retain state history. Dashboard has to capture its own daily snapshots.

**Design doc:** `docs/api/daily-snapshots-plan.md`.

**Decisions locked from design doc:**
1. Snapshot the **full panel JSON** (not a state-KPI subset) — schema-flexible
2. Layout: `snapshots/yesterday/<panel>.json` + `snapshots/history/{date}/` ring buffer (7 days)
3. Capture **at start of regen** — Step 0 of `regen-data.cmd` rotates files before they're overwritten
4. **Manual scheduler for now** — automated cron is a v2 follow-up
5. State-KPI registry as **TS const map per page** (colocated with KPI strip)
6. Day-0 fallback: render `—` instead of Δ when no prior snapshot exists

**Scope (S1–S5):**
- S1: `scripts/snapshot_rotate.py` — rotation script
- S2: `regen-data.cmd` Step 0 wiring
- S3: `useSnapshot<T>` hook returning `{today, yesterday, loading, error}`
- S4: `<DeltaBadge>` component rendering `↑ +N` / `↓ -N` / `—`
- S5: Inspections pilot

**Out of scope:** wiring Δ on other panels (each rolls into own sub-issue), Inventory snapshots (separate per-piece pipeline), automated scheduler, "this week" 7-day Δ, URL-persisted as-of date, history compression.

**Comments:**

**Implementation landed on `time-a-monthly-hours`** — two commits (`c767faa` rotation pipeline + Inspections pilot S1–S5; `0738854` day-0 fix on `useSnapshot`). Day-0 fix: Vite dev server returns SPA `index.html` with 200 for missing snapshot paths; hook now sniffs Content-Type before parsing. Open Qs resolved with leaned answers: per-panel rotation, standalone script, no test fixtures, stdout banners. Acceptance status: 7/10 boxes checked; 3 require manual verification (≥2 regens to populate `yesterday/`, ≥8 regens for history cap, storage measurement). Notes for future panels using `useSnapshot`: hook handles SPA fallback internally, `app/public/data/snapshots/` is gitignored, `STATE_KPIS` const map per page declares state metrics, `<DeltaBadge>` is polarity-neutral (slate for both arrows).

---

### #38 — [PLAN] Time-based filtering and daily-change indicators across the dashboard
**Labels:** module:cross-cutting, type:plan
**Status:** Active umbrella; sub-issues 1, 2, 7 closed; 6 in flight via #39; 3, 4, 5, 8 not filed; 9 deferred

**What it is:** ~70% of gold-standard metrics are flow-based (only meaningful over a time period). Dashboard renders most as snapshots, mismatches original intent. Deeper goal: a dashboard managers/PMs/superintendents open every morning and see *what changed*. A snapshot dashboard doesn't earn that habit.

**Two mechanisms:**
1. **Date-range filter** — user-facing date picker filters flow metrics on a panel. Presets (Today, Yesterday, 7d, **30d default**, MTD, QTD, YTD, etc.) + custom. Auto-granularity: ≤14d daily, ≤90d weekly, else monthly. One picker per panel. No URL persistence in v1, no comparison-period in v1.
2. **Daily-change indicators** — small Δ-since-yesterday and "this week" badges on state KPIs and table cells. Requires prior-day snapshots (sub-issue 2).

**KPI rule:** flow KPIs respect the picker (value reflects window); state KPIs stay "as of now" with Δ-since-yesterday badge. Strip therefore always shows something moving.

**Other rules:** project lists don't change with filter (filter changes values, not what's on the page); untimed metrics remain unfiltered with no Δ; 12-month history working assumption.

**Scope by module (capsule view):**
- **Estimating** — pure flow, simplest pattern, original pilot
- **Production Control** — flow + state mix; depends on #33/#36 for jobsite-only shipped tons
- **Project Management** — one flow metric, lots of state with Δ; high-value daily-Δ surface
- **Time** — flow + cumulative; carries the est-vs-actual design question (now in #39)
- **Inspections** — highest-value daily-Δ target ("passes/fails yesterday"). Pilot in practice.
- **Purchasing** — two flow KPIs + state Δ; coordinates with #8 (KPI relabel)
- **Inventory** — out of scope v1 (state-only metrics; PowerFab doesn't retain inventory state history; needs separate per-piece daily-snapshots pipeline)

**Decomposition (9 sub-issues):**
1. Shared `<DateRangePicker />` + panel filter context — **#43 ✅ closed**
2. Daily snapshots pipeline — **#46 ✅ implemented**
3. Estimating panel filtering — not filed; original pilot, superseded by Inspections
4. Production Control panel filtering — not filed; blocked on #33/#36
5. PM panel filtering — not filed; high-value daily-Δ surface
6. Time panel filtering — promoted to umbrella **#39**
7. Inspections panel filtering — **#40 ✅ closed**; actual pilot
8. Purchasing panel filtering — not filed; coordinates with #8
9. Inventory snapshots + filtering — **🚫 deferred** (separate per-piece state-history pipeline)

**Open questions:**
- Q1: Time panel — "actual" lifetime-cumulative or window-bounded? `needs:ricky-decision`
- Q2: Daily-Δ noise — every state KPI or only meaningful ones? Initial: ship everywhere, tune later
- Q3: Production by employee — shop only or all stations? `needs:ricky-decision`
- Q4: Filter persistence within session — reset or persist? Lean: reset
- Q5: Cross-panel sync — propagate? Lean: no

**Comments:**
1. Cross-link: Time panel filtering promoted to its own umbrella #39 (Time was a superset).
2. Inspections panel filtering filed as #40 (also closes gold-standard parity gap on the same panel).
3. Sub-issue 1 filed as #43.
4. Sub-issue 2 filed as #46 with design doc at `docs/api/daily-snapshots-plan.md`.
5. **Status snapshot 2026-05-04** — cold-pickup view of all 9 sub-issues. Done end-to-end: picker foundation (#43) + Inspections pilot (#40). Pattern proven. Next priority: #46, #39 sub-tasks, then sub-issues 3/5/8 on demand.
6. **Sub-issue 2 status delta 2026-05-04** — #46 moved from "filed, not started" → "implemented on branch (unmerged)." Two commits on `time-a-monthly-hours`. 4 open Qs in #46 resolved with leaned answers. Manual verification still needed.

---

### #17 — API limitations on PowerFab GO 2025i SP2 (umbrella tracker)
**Labels:** module:cross-cutting, api-limitation
**Status:** Stays open as documentation; closes only if SKU upgrades or workarounds get dropped

**What it is:** Single tracker for every documented API gap on this PowerFab install, the workaround in place, and the trigger that would re-open the discussion. Per project policy, NOT opening a Tekla support ticket — this is a debugging-starts-here index.

**Items tracked (P-series gaps):**

| ID | Gap | Workaround | Trigger to revisit |
|----|-----|------------|-------------------|
| P0 | Silent-empty `Get*` family (`GetProjectStatus`, `GetTFSDetails`, `GetProductionShippingStatus`) | Routed via `ProductionShippingProductivity_Get` per-job filters | Version upgrade or PowerFab GO → full SKU |
| P1 | Estimating enumeration gap (no list-of-estimates command) | DB fallback (UI-verified canonical 2026-04-30) | Same; hypothesis is GO license gate |
| P2 | `GetInventorySummary` returns garbled multi-envelope output | DB fallback (UI-verified canonical 2026-04-30) | Same |
| P3 | Paging gaps on `GetInventory` + `GetStations` (no `<Limit>`/`<Offset>`) | Per-job filtered calls; nightly aggregation for largest projects | Tekla adds paging |
| P4 | kg/lbs UOM mismatch | `/0.45359237` at SQL boundary; Module 02/06 audit pending | Tekla honors display UOM |
| P5 | Undocumented fields on PCJ (`<ProjectID>`, `<JobStatus>`) | Using anyway; ~100% populated live | Tekla upgrades XSD |
| P6 | Documentation gaps (4 sub-items) | Probed and documented | Tekla updates docs |
| P7 | No `<Totals>` block on `fsresProductionControlJob` | C10 sums per-piece weights from `GetStations` deduped; nightly aggregation for biggest jobs | Tekla adds Totals block |
| P8 | No route enumeration command | DB query helper (separate `needs:implementation` issue — #11) | Tekla adds `fsreqGetRoutes` |

**PowerFab GO hypothesis:** Ricky confirmed 2026-04-30 that this install runs PowerFab GO, not full PowerFab. Greyed-out Estimate Summary modal is a confirmed license gate. Plausible P0/P1/C2 are the same license gate rather than bugs (commands exist in XSD but reject every body or return empty). SKU upgrade = trigger to re-test the whole list.

**Comments:** none.

---

### #16 — Per-shop dashboard config layer (FA3)
**Labels:** module:cross-cutting, deferred
**Status:** Deferred; design doc + inventory complete; implementation ships when 2nd shop signs on

**What it is:** Config layer so each per-shop decision (TFS station per route, JobStatus values, custom inspection types, "production complete" station, etc.) doesn't require a code change per tenant. 2026-04-29 walkthrough alone produced multiple per-shop choices (TFS station per fabricator, CO open-rule, inspection test-type granularity). Ricky raised this himself near end of call.

**Plan locked 2026-04-29:** post-MVP architectural item. Build MVP with hardcoded defaults sourced from this shop's data; design + ship the config layer when second shop signs on (closes alongside #15/FA2).

**Comments:**

1. **Inventory complete** — captured in `docs/api/per-shop-config-inventory.md` (commit `9188a93` on branch `claude/issue-management-setup-Lnk2g`). Summary: ~28 hardcoded shop-specific decisions across ~10 files. Categories: JobStatus/Purpose filters (4), TFS station per route (4), "production complete" station (1), inspection test-type granularity (1), conversion factors/units (6), magic numbers/IDs (5), hardcoded names (0), time windows/thresholds (4), display-string policy (3). Biggest concentrations: `ProductionControlModule.cs` (TFS/Load/Jobsite logic, 5y window, Top 12 cap), `InspectionsModule.cs` (chunk sizing, thresholds, TestTitle rollup), `scripts/categories/*.py` (kg→lbs at 6 sites — collapse to single helper regardless). Categories 1–4, 9 are natural inputs for config schema (per-shop policy). Categories 5, 6, 8 are softer (tunable defaults rather than overrides); category 5 deserves refactor regardless.
2. **Design doc drafted** — `docs/api/per-shop-config-design.md` (commit `7389b05`). Three buckets: A. Per-shop policy (JobStatus filters, station ID, "production complete," inspection rollup field, display labels); B. Tunable defaults (display caps, time windows, chunk sizing); C. Code-quality smells (kg→lbs conversion at 6 sites, refactor independently). Single config file: `config/shop.json` + `shop.schema.json`. Camel-case keys, defaults match current shop, fail-loud validation on load. Three loaders one file: Python (`_config.py`), C# (`ShopConfig.cs` injected via `Program.cs`), TypeScript (build-time copy + typed import). Per-file migration table — every bucket-A/B finding mapped to its config replacement, current value preserved as schema default. Open questions: multi-shop-per-install, frontend reload semantics, whether inspection chunk sizing is policy or default. Status: design only — implementation ships when 2nd shop signs on.

---

### #15 — Custom JobStatus support for multi-tenant rollout (FA2)
**Labels:** module:cross-cutting, deferred
**Status:** Deferred; tracker so it doesn't get forgotten when 2nd shop signs on

**What it is:** Dashboard correctly handles intermediate JobStatus values (Hold, Bidding, Awarded, Lost, Archived, etc.) when we onboard a non-binary shop. This shop only uses Open + Closed for production jobs (probe-confirmed: only IDs 1=Open and 2=Closed used; IDs 3/4/5 are estimating-only). So `JobStatus.Purpose==0/10` is the right rule for binary, and that's what walkthrough A1 locked.

But Ricky said on the 2026-04-29 call: "people can put in there whatever they want — bidding, awarded, lost, whatever — but open and closed will always be in there." When we onboard a second shop with a third bucket, the binary filter breaks. Should "Hold" projects appear on the per-project progress table, on the dead-stock view, both, or neither? Per-shop decision.

**Plan locked 2026-04-29:** defer to multi-tenant rollout. Keep `Purpose==0/10` for MVP. Add per-shop config knob when first non-binary tenant onboards. Closes alongside #16.

**Comments:** none.

---

## Production Control

### #36 — Fix pctProductionComplete denominator: per-station weight inflates by station count, breaks comparability with pctShipped
**Labels:** module:production, needs:implementation
**Status:** Open; awaiting Ricky decision on metric semantics (α vs β)

**What it is:** `pctProductionComplete` and `pctShipped` are not on the same scale. After fixing pctShipped (#33), 18 of 112 projects show `pctShipped > pctProductionComplete` — physically impossible.

**Root cause (verified on PCJ 124):** Two metrics divide by different denominators:
- **pctShipped** (canonical, after #33): `SUM(t.Quantity * a.AssemblyWeightEach)` / `SUM(AssemblyWeightEach * AssemblyQuantity)` — per-piece physical weight basis.
- **pctProductionComplete** (current C6): `SUM(s.QuantityCompleted * s.ProductionWeightEach)` / `SUM(s.TotalQuantity * s.ProductionWeightEach)` from `productioncontrolitemstationsummary` — per-piece-per-station weight basis. A piece routed through 5 stations contributes 5× its weight to denominator.

PCJ 124 example: C10 denominator 21,898 kg vs C6 denominator 104,664 kg (~5×).

**Original framing — two options:**
- **Option A:** physical-weight basis with binary completion (`SUM(weight * (all_stations_done)) / SUM(weight)`). Simple, comparable to pctShipped. Coarser — partway pieces count as 0.
- **Option B:** physical-weight basis with fractional completion (`SUM(weight * stations_done/stations_total) / SUM(weight)`). Granular. More complex subquery.

**Comments:**

**Comment 1 — Investigation update flagging for @rickysteckline.** Picture is more complicated than original A-vs-B. Probed against DB and PowerFab UI ground-truth exports for Job 23015 (PCJ 124, Luxe Garage Screens). Coverage probe, per-piece station-count distribution, side-by-side formula comparison plus a new Option C (last-station-done), pulled PowerFab Station Summary + Station Completed reports. Probe at `scripts/verify/02_production_control_pctcomplete_probe.py`.

| PCJ | Current C6 | Opt A (all stations) | Opt B (fractional) | Opt C (last station) | pctShipped |
|---|---|---|---|---|---|
| 124 (Luxe Garage) | 37.86% | 0.54% | 32.94% | 92.92% | 87.61% |
| 146 (Shamrock) | 32.59% | 9.43% | 34.36% | 53.83% | 53.91% |
| 110 (Douglas) | 42.24% | 14.55% | 32.21% | 42.47% | 30.41% |

Coverage hypothesis was mostly wrong (only PCJ 124 had a meaningful gap, 5/90 missing). Smoking gun: on PCJ 124, every piece routes through 5 shop stations and 87% have shipped, but only 0.54% have all 5 stations individually marked done. Pieces ship without upstream stations being flagged complete. Option C reports 93% (only checks final station).

**PowerFab UI for Job 23015** (Station Summary): Total % Completed = 40.86% = simple average of per-station %s including jobsite stations. **It is less than pctShipped (87.61%) on the same project.** "Shipped > complete" is baked into PowerFab's own definition. Final QC at 97.82% is the cleanest physical meaning ("made it through the shop") but depends on naming consistency across shops.

**Decision Ricky needs to make:**
- **Option α:** Match PowerFab UI literally (averaged-stations). Matches what user already sees in PowerFab. Keeps "shipped > complete" inconsistency on projects like 124.
- **Option β:** Define a physically-honest metric (Option C — last-shop-station-done on a physical-weight basis). Tracks pctShipped closely (PCJ 124: 92.92% vs 87.61%). Cross-metric consistency restored. But dashboard number deliberately differs from PowerFab UI's headline (fab managers may ask "why does dashboard say 93% when PowerFab says 41%?").

**Other context:** original-intent statement for shipping is "% shipping completed by project (open projects) — calculated by weight of pieces shipped" + "Tons shipping completed (jobsite only) over a time period." pctShipped (after #33) matches the first exactly. The "(jobsite only)" qualifier suggests "shipped" means arrived-at-jobsite. If that's the bar, "% production complete" should mean "ready to ship to jobsite" — closest to Option β / Final-QC semantics.

**Bonus question for the same review** — the `IntermediateShippingFirmID` jobsite-only filter on shipping. Current pctShipped filters to final-leg trucks. That's almost "jobsite-only" but a final-leg truck could deliver to a warehouse / holding yard. If "jobsite only" is the bar, may need a tighter filter on destination firm (firm type code? address match?).

**Comment 2** — Cross-link: the `IntermediateShippingFirmID` jobsite-only filter decision is a dependency for "Tons shipping completed (jobsite only) over a time period" in umbrella plan #38 (Production Control module).

---

### #34 — Generalize 'Jobsite' station-name hardcode in C# data-gen
**Labels:** module:production, needs:implementation
**Status:** Open, lower priority than pctShipped

**What it is:** Stop relying on the literal station name "Jobsite" in C# data-gen for shipping rollups. Use `stations.StationType = 1` (PowerFab's tinyint flag for jobsite-side stations) instead.

`scripts/api/data-gen/Modules/ProductionControlModule.cs` hardcodes the name in:
- `Meta.JobsiteStation: "Jobsite"` — emitted into JSON, used as sub-label on KPI tiles
- "Tons shipped (recent)" KPI — filters `ProductionShippingProductivity_Get StatusType=last-shipping-destination, GroupBy=Destination` to Destination=="Jobsite" buckets only
- `monthlyTons.shipped` column on trend chart — same filter

Works on this shop because they happen to have a station literally named "Jobsite". Other PowerFab installs name jobsite-side stations differently (this DB has "a-On site", "b-Erected", "c-Completed", all `StationType=1`, none named "Jobsite").

Fix: pull list of jobsite station names from `stations` where `StationType = 1` at data-gen time, filter the response to that union instead of literal "Jobsite". Portable across installs.

**Lower priority because** (a) on this shop the hardcode happens to work, and (b) the pctShipped truck-load fix uses a totally different table that doesn't depend on station names at all.

**Comments:** none.

---

### #14 — Audit productioncontroljobitems for per-record-total semantics
**Labels:** module:production, needs:implementation
**Status:** Probably resolvable as resolved-by-#9; defaulted to staying open

**What it is:** Confirm whether `productioncontroljobitems.Weight` and any cost columns are **row-totals** (already × Quantity) or **per-piece** values — same shape that broke `inventoryitems`.

2026-04-30 verification surfaced that `inventoryitems.Weight` and `inventoryitems.Valuation` are stored as row totals, not per-piece. Pre-fix dashboard multiplied by Quantity and double-counted every Qty>1 row. Inventory pre/post-fix: $809M → $11M (74× over-count); 68M lbs → 6.3M lbs (compounded with kg-as-lbs).

**Comments:**

**Partial answer from #9 work — `productioncontrolassemblies` audited.** Findings:
- **kg vs lbs:** `AssemblyWeightEach` is in kg (P4 holds). Apply `/0.45359237` at SQL boundary.
- **Per-instance vs row-total:** `AssemblyWeightEach` is **per-instance / per-assembly** (NOT row-total like `inventoryitems.Weight`). The `× AssemblyQuantity` multiplier IS needed. "Each" suffix is the correct tell.
- **Verified:** `SUM(AssemblyWeightEach × AssemblyQuantity) / 0.45359237` matches PowerFab UI exports to 0.000% on PCJ 146 (Shamrock 19,406 lbs) and PCJ 202 (Plenum #22 17,150 lbs).

Original framing of FC7 named `productioncontroljobitems` as audit candidate. That table doesn't actually exist in this DB — relevant table is `productioncontrolassemblies` (now done). If other multi-piece-row tables get touched in future, same audit pattern applies. Issue can probably close as resolved-by-#9.

---

### #12 — FC3: Module 02 perf strategy for largest projects
**Labels:** module:production, needs:implementation
**Status:** Open, design doc + PR pending

**What it is:** Module 02 metrics that compute correctly within reasonable time for **PCJ 83** (largest job at this shop, 549 cut lists).

Phase 0c probe P0-2 ran `GetStations` with `IncludeRemaining=true + IncludeCompleted=true`:
- **PCJ 146** (1 cut list, 71 pieces, 556 KB): completed in ~2 sec.
- **PCJ 83** (549 cut lists, 6.5 MB Completed-only baseline): killed at 14 min. Extrapolated full response ~20 MB.

API path scales fine for typical jobs but not the biggest. Three options:
1. **Per-cut-list fanout** — call `GetStations` once per CutListID via `<Filters>` scope. Slower per project but bounded per call.
2. **Nightly aggregation** — backend job walks all open projects, caches per-project metrics in DB, dashboard reads cache.
3. **DB fallback for biggest projects** — if API call exceeds threshold, fall back to SQL.

**Recommendation per FC3:** option 2 (nightly aggregation). Keep dashboard fast; refresh once a day; document that "% complete is computed nightly; intra-day events not reflected."

**Affected metrics:** 02 C6 (% complete by project), 02 C10 (total tons per project), every per-project rollup that fans out to `GetStations` on largest jobs.

**Comments:** none.

---

### #11 — FC2: Route enumeration interim strategy (DB query for MVP)
**Labels:** module:production, needs:implementation
**Status:** Open, awaiting helper PR

**What it is:** Dashboard enumerates all routes without an API enumeration command (no `GetRoutes` exists on this install — see #17 P8).

`GetRouteDetails` works for known RouteID or Route name, but no command lists all routes. Three options:
1. **DB query** — read `routes` table directly. DB connectivity already exists.
2. **Iterate 1..N** — call `GetRouteDetails` with RouteID=1, 2, … until response returns `Successful=0` or empty. Cache results.
3. **Discover from data** — every active route shows up as `<Route>` on `GetStations` per-piece entries. Build route set lazily by walking PCJ data.

**Recommendation per FC2:** option 1 (DB) — cheapest, fastest, already-connected. Switch to API enumeration if Tekla ships `fsreqGetRoutes`.

**Affected metrics:** per-route TFS lookup powering 02 C3 (TFS station per fabricator) and 02 C5 (TFS axis on trend chart).

**Comments:** none.

---

## Project Management

### #35 — Invoicing source: orderinvoices vs projectbudgetinvoices (per-shop)
**Labels:** module:project-management, needs:ricky-decision
**Status:** Open, awaiting Ricky decision; ties to per-shop config (#16)

**What it is:** Decide which invoicing table the dashboard should read, populate the **Invoiced $** column on the PM panel, and fix the misleading "module not in use" banner.

Discovered during #5 verification. PowerFab has **two distinct invoicing models**:

| Model | Table | Schema | What it represents | Rows here |
|---|---|---|---|---|
| Order-based / sales-order | `orderinvoices` | OrderID, Material, Labor, Tax, Charges, Discounts | "We sold $X of parts to a customer" | **1** |
| Project / progress (AIA G702/G703) | `projectbudgetinvoices` | ProjectID, ApplicationNumber, ContractAmount, CompletedWorkAmount, StoredMaterialsAmount, Retainage, PaymentAmount | Monthly Application for Payment per project — standard construction billing | **326** across 58 projects (with 2,476 line items) |

Current dashboard:
- Reads neither; `InvoicingModuleInUse` hardcoded `false` in `ProjectManagementModule.cs`.
- Banner says "PowerFab's invoicing module is not in use at this shop (0 rows in `orderinvoices`)" — true for orderinvoices but wrong for the shop's actual billing flow via projectbudgetinvoices.
- **Invoiced $** column null for everyone.

**Multi-tenant concern (links to #16):** different shops use different models. Construction fab → projectbudgetinvoices; sales-driven → orderinvoices; mixed → both; some → neither (QuickBooks/Sage). Don't hardcode — make source configurable in per-shop config.

**Questions for Ricky:**
1. Confirm this shop uses `projectbudgetinvoices` (G702-style), not `orderinvoices`?
2. What does "Invoiced $" mean — total billed (sum `PaymentAmount`)? Total earned (sum `CompletedWorkAmount`)? Net of retainage?
3. For projects with active progress billing, should **Contract $** prefer live `projectbudgetinvoices.ContractAmount` (reflects approved COs) over original `estimatesummaries.TotalCost` (the bid)? Currently #5 shipped with bid value.
4. How should dashboard handle projects with neither — leave Invoiced $ blank with no banner, or surface "not yet invoiced"?

**Comments:** none.

---

## Purchasing

### #31 — Workflow finding: 118/226 production projects have no estimate in the system
**Labels:** module:purchasing, needs:ricky-decision, phase-3-followup
**Status:** Deferred — known data-entry gap, not a code defect

**What it is:** DB probe 2026-05-01 of project ↔ estimate linkage:

| Bucket | Count |
|---|---|
| Projects total | 226 |
| Projects with PCJ that links to EstimateID | 96 |
| Projects with PCJ but **no EstimateID set** | 119 |
| Projects with no PCJ at all | 11 |

Of the 119 unlinked PCJ projects: **118** have no matching estimate in `estimates` even by JobNumber (truly never entered into estimating); **1** has an estimate with same JobNumber but `pcj.EstimateID IS NULL` (orphaned FK, fixable).

**Why it surfaced:** Purchasing's "Est. material" column shows blank for ~137/191 rows even after #29 + #30. Gaps trace back to this — Python sidecar (`_estimating-rollup-by-project.json`) only writes a row when there's a chain `productioncontroljobs.EstimateID → estimatesummaries.SummaryJSON → Materials.Totals.Cost`. With 118 PCJs missing EstimateID, chain breaks for over half the project list.

**Two paths to "fix":**
1. **Workflow fix at source (Ricky):** are these 118 jobs intentionally non-estimated (T&M / cost-plus / repeat / migrated), or is estimating module skipped systematically? Drives whether to fix at workflow level, code level, or surface as coverage banner.
2. **Code fix (small effort, partial coverage):** sidecar fall back to JobNumber match when `pcj.EstimateID IS NULL`. Worth ~1 additional project per probe — almost nothing. Not worth implementing unless Ricky says he expected them linked.

**Affected metrics:** 06 Purchasing **Est. material** (137/191 blank), 06 **VAR %** (only computes when both sides exist), 04 Time **Estimated h** (same sidecar source — 59/156 missing per #25), 02 Production Control **Estimated tons/hours** (TBD).

**Comments:**

**Status: deferred — known data-entry gap, not a code defect.** The 118 unlinked PCJs aren't a missing-data mystery. Expectation is most projects *do* have an estimate; operators just didn't link it via `EstimateID` on the PCJ when the job was set up. They can go back and link retroactively in PowerFab UI, and dashboard's columns will populate automatically on the next data-gen run — no code change required. **No action on our side until Ricky says otherwise.** If he later confirms most *should* be linked but operators won't do it, the JobNumber-fallback code fix in `scripts/categories/estimating.py::_emit_sidecar` is a ~30-minute change.

---

### #8 — FA6: On-order $ vs PO-committed $ scope confirmation
**Labels:** module:purchasing, module:inventory, module:cross-cutting, needs:ricky-decision
**Status:** Open, awaiting Ricky decision; reframed for him

**What it is:** One-line confirmation that "On Order $" (Inventory) and "$ committed on POs" (Purchasing) are intentionally distinct numbers — not the same metric on two panels.

On 2026-04-29 call Ricky said he didn't recognize "PO committed"; defaulted to "on-order" for Inventory. Need explicit confirmation that:
- **Inventory On Order** = sum `Valuation` where `OnOrder=1` on inventory records (stock-trackable items only). At this shop: $6,608,983.
- **Purchasing $ committed** = sum `Total.Cost` on PO line items (everything on a PO including non-tracked services).

Same direction, different scope. Risk: a user comparing thinks they should match and sees a discrepancy when they're measuring different populations.

**Comments:**

**Comment 1 — reframing for Ricky in PowerFab terms.** Original write-up leaned on DB/API jargon. Reframed:
- **Inventory panel "Total $ on order"** — open Inventory module, filter to On Order, add up dollars. Counts only **trackable stock material**. Today: ~$6.6M.
- **Purchasing panel "Total $ on POs"** — open every active PO, add up every line item. Includes non-stock lines (outside services like galv/paint/machining, freight, shop supplies, anything you put on a PO but never receive into inventory).

Same direction (committed spend), different scope. Counts raw stock material on PO — both yes. Counts services / freight / non-stock — Inventory no, Purchasing yes. Purchasing number basically always bigger.

**Risk:** similar-sounding labels lead users to think they should match.

**Two paths:**
- **Option A — keep both with clearer labels.** Inventory: "On order — stock material only"; Purchasing: "Committed on POs — includes services & freight." Both stay; users can tell at a glance they're not the same population.
- **Option B — drop the Purchasing one.** If "total $ on POs" isn't a number Ricky uses, remove it from Purchasing panel; only "money committed outward" is the Inventory "on order" one.

**Comment 2** — Cross-link: scope/relabel question is also referenced in umbrella #38 (Purchasing module section). Resolution can land independently.

---

## Estimating

### #20 — 01 Estimating: page-enhancement options (charts / leaderboards)
**Labels:** module:estimating, needs:implementation, phase-3-followup
**Status:** Open, awaiting Nick to pick 2-3 candidates

**What it is:** Estimating page to feel less "table-only" — pick which proposed visualizations to add. During Phase 3 UI review 2026-05-01, page flagged as feeling boring (mostly tables, light visual signal).

**Candidates (all use existing `estimating.json`, no new API/DB work):**
1. **Monthly bid-value trend** — sum of `totalCost` by month, last 24 months. Shows pipeline rhythm.
2. **Estimator leaderboard with conversion** — bid count + win rate + avg bid size per estimator. *Win rate piece blocked by #1.*
3. **Bid-size distribution histogram** — sub-$100K vs $1M+ buckets. Shows where work concentrates.
4. **Pipeline by status donut** — Open / Closed / In production share.
5. **Recent big bids alert** — "Last 7 days: 4 estimates totaling $X.XM."
6. **Customer / firm leaderboard** — top 10 firms by bid value.

**Comments:** none.

---

### #1 — 01 Win rate: verbal sanity check + C9 redefinition
**Labels:** module:estimating, needs:ricky-decision
**Status:** Open, awaiting Ricky verbal confirmation

**What it is:** A "% of estimates won" KPI on the Estimating panel. PowerFab API has no won/lost signal at all. DB linkage exists via `productioncontroljobs.EstimateID` and computes ~36 won of 835 total estimates at this shop (~4%).

**Two things still needed:**
1. **Ricky verbal sanity-check on magnitude.** Does 36/835 (~4%) look right? If reality is closer to 30%, linkage is broken or counting wrong thing.
2. **C9 redefinition.** Confirm metric becomes "% of estimates that became a production-control job" with no lost/pending split (this shop doesn't track lost).

Sole remaining 🟡 metric on the Estimating panel; everything else flipped ✅ via 2026-04-30 DB verification.

**Comments:** none.

---

## Inventory

### #21 — 07 Inventory: page-enhancement options (aging / top-10 / ratios)
**Labels:** module:inventory, needs:implementation, phase-3-followup
**Status:** Open, awaiting conversation with Ricky/Jason then pick 2-3

**What it is:** Inventory page surfaces more decision-useful signal — pick which proposed views to add. During Phase 3 UI review 2026-05-01, Inventory flagged as feeling spartan (mostly tables, no visual signal).

**Candidates:**
1. **Dead-stock aging chart** — histogram of dead-stock dollars by age bucket (0-6mo / 6-12mo / 12-24mo / 2yr+). Uses `oldestReserveDate` already in JSON.
2. **Top 10 dead-stock projects by $** — quick-wins for cleanup.
3. **In-stock vs on-order ratio per project** — surface over-ordered projects.
4. **Allocated-but-stale warning list** — projects with stock allocated whose last activity is >6 months old (broader than current dead-stock metric, which keys on `JobStatusID=2`/Closed).
5. **Material breakdown** — by category/grade, if exposed (probe needed).
6. **Stock turnover ratio** — total $ inventoried vs total $ used in production over a window (cross-module from Production).

**Comments:** none.

---

## API Limitations

(Note: see also umbrella #17 in Cross-cutting for the full P-series tracker.)

### #28 — Project_Get empty body intermittently rejected with 'JobStatus - Element is required'
**Labels:** api-limitation, phase-3-followup
**Status:** Open; workaround in place; surface to Tekla if it persists

**What it is:** `Project_Get` with empty body (the schema-allowed form, all fields `required: false`) returns `<Successful>0</Successful><ErrorMessage>JobStatus - Element is required</ErrorMessage>`. Intermittent — earlier on 2026-05-01 it worked fine (returned 226 projects); subsequent runs fail. Affects both `PurchasingModule.cs` and `ProjectManagementModule.cs`.

**Probed alternate envelope shapes 2026-05-01:**

| Body | Result |
|---|---|
| `<Project_Get />` | rejected: JobStatus required |
| `<Project_Get><GetOptions/></Project_Get>` | rejected: same |
| `<Project_Get><GetOptions><Limit>5</Limit></GetOptions></Project_Get>` | works |
| `<Project_Get><ProjectID>132</ProjectID></Project_Get>` | works |

Both modules now retry with `<GetOptions><Limit>10000</Limit></GetOptions>` after empty form fails. Pre-existing fallback wrapped `<JobStatus><Description>Open</Description></JobStatus>` directly inside `Project_Get` — isn't in catalog schema and also fails.

**Why open:** empty form is the schema-canonical call. Server-side `JobStatus required` rule is undocumented and contradicts catalog. Worth surfacing to Tekla if persists. For now `Limit` workaround is good enough.

**Comments:** none.

---

## Quick reference — cross-issue dependency map

- **#39** (Time umbrella) → spawned **#41 ✅, #42 ✅, #44 ✅, #45 (shipped via Approach 2), #48 ✅, #50 (open), #52 (open)**
- **#39** depends on **#38** sub-issue 1 (#43 ✅) and sub-issue 2 (#46 ✅)
- **#38** (cross-cutting umbrella) → sub-issues **#43 ✅, #46 ✅, #40 ✅**; remaining 3/4/5/8 not filed; 9 deferred
- **#46** unblocks Δ-badge wiring on every state-KPI panel; **#50** is the Time wiring
- **#36** (pctProductionComplete fix) and **#33 ✅** (pctShipped) — companion fixes; #36 has bonus jobsite-only filter question for Ricky
- **#34** (jobsite station-name hardcode) lower priority; pctShipped truck-load fix uses different table
- **#15** (custom JobStatus) and **#16** (per-shop config) close together when 2nd shop signs on
- **#35** (invoicing source) ties to per-shop config (#16) — different shops use different invoicing models
- **#31** (118 unlinked PCJs) blocks **#25-style** coverage on Purchasing/Time/Production estimated columns until operators link estimates retroactively in PowerFab
- **#20** candidate 2 (estimator leaderboard with conversion) blocked by **#1** (win rate redefinition)
- **#17** is documentation umbrella; only closes if SKU upgrades or workarounds dropped
- **#11**, **#12**, **#14** are all `needs:implementation` and not blocked on outside decisions

## Quick reference — what's blocked on whom

**Awaiting Ricky:**
- #1 (win rate magnitude sanity-check)
- #8 (on-order vs PO-committed scope decision)
- #31 (workflow expectation on 118 unlinked PCJs)
- #35 (invoicing source + 3 sub-questions)
- #36 (production-complete metric semantics α vs β + jobsite-only filter)
- #47 (Labor Group → Station setup direction)

**Awaiting Nick:**
- #20 (pick 2-3 Estimating enhancements)
- #21 (pick 2-3 Inventory enhancements after conversation with Ricky/Jason)

**Awaiting implementation work:**
- #11 (route enumeration helper)
- #12 (perf strategy for largest projects — design doc + PR)
- #14 (audit; probably resolved-by-#9, can close)
- #34 (generalize Jobsite station-name hardcode)
- #50 (TIME-F daily-Δ badges, after #49 lands)
- #52 (TimeModule.cs cleanup, low priority)

**Deferred / multi-tenant:**
- #15 (custom JobStatus)
- #16 (per-shop config layer — design doc complete)

**Tracker / documentation only:**
- #17 (API limitations umbrella)
- #28 (Project_Get empty body — workaround in place)

**Active umbrellas (status only):**
- #38 (cross-cutting time filtering + daily-Δ)
- #39 (Time gold-standard parity)
