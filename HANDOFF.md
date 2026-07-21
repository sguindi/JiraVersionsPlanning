# planJira — Claude Handoff Summary
**Last updated:** 2026-07-14 | **Deployed version:** v2.65.0

---

## What This Project Is

**planJira** is a visual project planning app built on **Atlassian Forge** (Custom UI). It runs as a global page inside Jira. Tech stack: React 18, Recharts, date-fns v3, `@forge/bridge` for Jira API calls (no backend resolver).

**Repo root:** `c:\Users\sharonc\OneDrive - SYM SERVICIOS INTEGRALES SA DE CV\Myapps\planJira`  
**App entry:** `static/app/src/App.js`  
**Deploy command:** `cd static/app && npm run build && cd ../.. && forge deploy`

---

## Key Files

| File | Purpose |
|---|---|
| `static/app/src/components/VersionPlanningView.js` | Main planning view — all Gantt/timeline logic |
| `static/app/src/utils/planning.js` | Pure utility functions: `cascadePlan`, `detectConflicts`, `calcEndDate`, `calcDays`, `calcQaBugFixDays`, `findCriticalPath`, `addWorkingDays`, `buildWorkingDays` |
| `static/app/src/components/TimelineView.js` | Gantt chart (Recharts) for viewing issue timelines |
| `static/app/src/components/CalendarView.js` | Drag-to-schedule calendar view |
| `static/app/src/components/TeamView.js` | Developer workload heatmap |
| `static/app/src/__tests__/utils.test.js` | 23 unit tests for planning utils |
| `static/app/src/__tests__/components.test.js` | 10 smoke tests for components |

---

## Current State of VersionPlanningView

### Planning Modes
The view has **three planning modes** toggled in the toolbar:

**Draft mode (purple):**
- Work at the **epic level** — drag epics onto the timeline
- Duration = `roughEst (hours) ÷ assignedDevs ÷ HOURS_PER_DAY`
- Auto-dependency: assigning the same developer to multiple epics auto-creates a dependency chain
- Each epic bar shows 3 segments: dev bar (developer colors) + QA bar (yellow) + bug-fix bar (orange)
- Code Freeze line + stabilization shaded region + Delivery line auto-computed on the SVG

**Final mode (blue):**
- Work at the **story/task level** — drag individual stories
- Uses rough estimates or "Children Sum" (sum of child original estimates)
- Epic rows show a summary bar spanning all placed stories, plus QA + bugfix extension bars

**Epic Timeline mode (green):**
- Pick one epic from the toolbar dropdown (`focusEpicKey` state) — the table/timeline narrows to just that epic
- 3-level hierarchy: epic (summary bar, read-only) → stories (draggable, expandable via `expandedStories` state) → subtasks (draggable, revealed when a story is expanded)
- Subtasks are fully schedulable like stories: own bar, editable Est, assignable devs — `getBarProps`/`updateIssueEntry`/`roughMap` are all generic per-issue-key so no special-casing was needed there
- Reuses the Final mode's Rough Est / Children Sum toggle, resizable/sortable columns, and deferred Est-save
- `getSubtasksForStories` (bridge.js) now also fetches the Rough Estimation custom field, and `buildRoughMap`/`buildMissingEstMap` include subtask-level estimates
- **Auto dev assignment from Jira assignee**: a `useEffect` (keyed on `focusEpicKey`/`storiesByEpic`/`subtasksByStory`/`plan.issues`) walks every story+subtask under the focused epic and, if it isn't already assigned a dev placeholder, creates/reuses one from its Jira `fields.assignee` via `ensurePlaceholderForAssignee(accountId, displayName)` (useVersionPlan.js) — that placeholder's `id` is deterministic (`'acc_' + accountId`), so it can be used immediately without waiting on the state update to land. Never overrides a manual assignment. If a subtask has no assignee of its own, it inherits the parent story's assignee and gets `entry.borrowedFromParent = true` — rendered at reduced opacity (chip in the Assigned column + Gantt bar) so it reads as "not really assigned to them."
- **Cascading subtask scheduling**: dropping a story/task with subtasks onto the timeline (`placeOnTimeline` in `handleTimelineClick` and the right-panel `onDrop`) routes to `placeStoryAndSubtasks(storyKey, startDate)`, which places the story, then chains its subtasks back-to-back — each starting at `nextWorkDay(prevEnd)`, each depending on the previous one (`dependencies: [prevKey]`), each using its own Jira assignee or the parent story's (flagged `borrowedFromParent`) if unassigned. Re-dropping the story re-runs the whole cascade from the new date.
- **Issue type icon + status badge**: the Key cell now shows the Jira issue-type icon (`fields.issuetype.iconUrl`) and a small colored status-initials badge (`statusInitials`/`statusColors`, keyed off `fields.status.statusCategory.key`) next to every row's key, in all three planning modes.
- **Status-driven auto-timeline** (Epic Timeline mode only): a `useEffect` scans every story+subtask under the focused epic; any issue whose status is NOT in `NOT_STARTED_STATUSES` (`reopened`/`to do`/`blocked`) and doesn't already have a `startDate` gets its changelog fetched once (`getIssueChangelog`, bridge.js — cached in `changelogCache` state to avoid refetching) and parsed (`extractStatusDates`) for the first transition into "In Progress" (→ `startDate`) and the first "Ready for Deployment" after it (→ `entry.actualEndDate`). `getBarProps` renders a bar with `entry.actualEndDate` as a fixed end instead of an estimate-based duration, marked with a green border + "✓" and `bar.isActual = true`. Never overrides an already-placed issue.

### Left Table (Key / Summary / Est / Assigned / QA d / Days)
- **Resizable**: drag the right edge of any header cell (`ColResizer` component, module-level) — widths live in `colWidths` state.
- **Sortable**: click a header to sort by that column (`sortCol`/`sortDir` state, `getSortValue` module-level fn). In Final mode, epics sort as groups and each epic's expanded child stories sort among themselves — hierarchy is preserved, not flattened. `sortedRows` (derived from `rows`) drives both the left table and the right timeline/arrows so row order stays in sync.
- **Est editing**: clicking Est opens an inline input. On blur/Enter it updates `localRoughEst` + marks the key in `dirtyEstKeys` (● shown next to the value) but does **not** call the Jira API. Pending edits are only pushed via `updateRoughEstimation` when the user clicks "Save to Jira" (`handleSave`), which then clears `dirtyEstKeys`.

### Key State Variables (in the main component)
```js
planningMode       // 'draft' | 'final'
bugFixPct          // % of dev time for bug fixes (default 20)
codeFreezeDays     // working days from last epic end to code freeze (default 5)
stabilizationDays  // working days of stabilization after code freeze (default 10)
qaMap              // { [epicKey]: qaHours } — QA hours per epic (input by PM)
colWidths          // { key, summary, est, assigned, qa, days } — resizable column widths
dirtyEstKeys       // Set of issue keys with unsaved Est edits (localRoughEst), pending "Save to Jira"
```

### Auto-computed dates (Draft mode only)
```js
lastEffectiveEnd    // last epic's dev+QA+bugfix end date
codeFreezeDate      // lastEffectiveEnd + codeFreezeDays
stabilizationEndDate // codeFreezeDate + stabilizationDays (= Final Delivery)
```

### Bar Rendering Architecture
- **Draft epics:** `getBarProps(key)` → own startDate + devs. Then IIFE computes `_qaDays`/`_bfDays` via `calcQaBugFixDays`. Renders 3 `<div>`s inside a React fragment.
- **Final epics:** `getEpicSummaryBarProps(key, ...)` → spans placed stories. Same IIFE pattern adds QA+bugfix divs after.
- **Stories/tasks:** `getBarProps(key)` → standard draggable bar.
- **Dependency arrows:** SVG `<path>` elements. In Draft mode, arrows leave from end of QA+bugfix bar: `sourceBar.left + (durationDays + qaDays + bugFixDays) * DAY_WIDTH - 2`.

### SVG Overlay Layer (Draft mode)
Rendered after all bars, before `</svg>`:
1. Blue shaded `<rect>` for stabilization region
2. Dark dashed `<line>` + label for Code Freeze
3. Green dashed `<line>` + label for Delivery

### DeliveryReport Component
```jsx
<DeliveryReport
  computedPlan={computedPlan}
  roughMap={roughMap}
  planName={...}
  mode={planningMode}
  codeFreezeDate={planningMode === 'draft' ? codeFreezeDate : null}
  finalDeliveryDate={planningMode === 'draft' ? stabilizationEndDate : null}
/>
```
Shows: Start / Dev Complete / Duration / Code Freeze / Final Delivery cards + milestones + team utilization % bars + critical path chain.  
Has a **"⎘ Copy" button** that copies a Markdown-formatted report to clipboard (turns green "✓ Copied" for 2 seconds).

---

## Constants
```js
HOURS_PER_DAY = 6    // working hours per day (in planning.js)
DAY_WIDTH = 50       // pixels per working day (in VersionPlanningView.js)
ROW_HEIGHT           // height of each Gantt row
HEADER_H             // SVG header height
```

---

## Key Utility Functions (planning.js)

```js
calcQaBugFixDays(roughHours, devCount, qaHours, bugFixPct)
  → { qaDays, bugFixDays, totalExtra }
  // qaHours → ceil(qaHours / HOURS_PER_DAY) = QA days
  // bugFixPct → (roughHours * pct/100) / devs / HOURS_PER_DAY = bugfix days

cascadePlan(plan, roughMap, opts = { qaMap, bugFixPct })
  // Topological sort, propagates start dates using EFFECTIVE end dates
  // (dev + QA + bugfix time) when chaining dependencies
  // GOTCHA: for ANY issue with a non-empty `dependencies` array, cascadePlan
  // unconditionally overwrites its startDate from the dependency's end date on
  // every call — it does not know the difference between "not yet placed" and
  // "user just manually moved/removed this". Any code path that lets a user
  // directly set/clear an issue's startDate (× remove, drag-to-date, click-to-place)
  // MUST also clear that issue's own `dependencies` in the same updateIssueEntry call,
  // or the manual change is silently overwritten on the next render. See
  // placeOnTimeline() and the two "Remove from timeline" × buttons in
  // VersionPlanningView.js for the pattern.

detectConflicts(plan, roughMap, opts = { qaMap, bugFixPct })
  // Returns array of { placeholder, source, target } for overlapping epic assignments

addWorkingDays(dateStr, n)  // skip weekends
buildWorkingDays(fromStr, count)  // returns array of working day strings
```

---

## Version History (this session)

| Version | What changed |
|---|---|
| v2.24.0 | Initial commit (Calendar, Timeline, Team, basic Version Planning) |
| v2.25.0 | Draft/Final planning modes, auto-dependency chaining, DeliveryReport |
| v2.26.0 | Fix: epic drag-and-drop not working in Draft mode |
| v2.27.0 | QA input column, QA+bugfix bar extensions on Draft epics, code freeze/stabilization SVG overlays, DeliveryReport date cards |
| v2.28.0 | Final mode QA+bugfix bars, dependency arrows from effective end, Copy Report button |
| v2.29.0 | QA fixes: arrow -2px alignment, console.warn for OOB stabilizationEndDate |
| v2.30.0 | Version selector dropdowns (both screens) now show only unreleased versions |
| v2.31.0 | Backlog panel's version filter dropdown (EpicHierarchyPanel) also filtered to unreleased-only |
| v2.32.0 | All version dropdowns also exclude archived versions (added `archived` field to bridge.js version fetch) |
| v2.33.0 | Left table columns (Key/Summary/Est/Assigned/QA/Days) are resizable (drag right edge) and sortable (click header); Est edits are held locally (● marks unsaved) and only persisted to Jira via "Save to Jira" |
| v2.34.0 | Tab order changed to Version Planning, Calendar, Timeline, Team; only Version Planning is enabled (default tab), the other three are grayed out/disabled ("Coming soon") until finished |
| v2.35.0 | New "Epic Timeline" planning mode: pick one epic from a dropdown and see just its stories (expandable to subtasks) on a dedicated timeline. Subtasks are fully schedulable (draggable bars, editable Est, assignable devs) — same resizable/sortable columns and deferred Est-save as Draft/Final. Subtasks now fetch the Rough Estimation field too. |
| v2.36.0 | Epic Timeline: dev placeholders now auto-derive from each issue's Jira assignee (never overrides a manual pick); dropping a story/task with subtasks on the timeline auto-schedules all its subtasks back-to-back, each depending on the previous one, each using its own assignee or falling back to the parent's — quick QA/dev scaffolding for one epic. |
| v2.37.0 | Issue-type icon + status-initials badge next to Key (all modes). Epic Timeline: subtasks that inherit the parent's assignee render at reduced opacity (chip + bar). New status-driven auto-timeline: issues past "not started" (not Reopened/To Do/Blocked) get real start/end dates pulled from Jira's changelog (In Progress → Ready for Deployment), rendered with a green border + ✓. |
| v2.38.0 | New "⤢ Maximize" toolbar button (`maximized` state) — overlays the whole planning view as `position: fixed` full-viewport, hiding the surrounding project-selector/tab chrome so the left table + timeline get the full screen to show all stories/subtasks. "⤡ Restore" toggles back to the normal in-page layout. |
| v2.39.0 | Epic Timeline: "Auto-schedule" now only touches issues still Reopened/To Do/Blocked (anything further along keeps its real status-history dates), processes them in **key order**, and chains a dependency onto the previous issue sharing the same assignee — so moving one shifts the rest of that dev's queue. Draft/Final mode's Auto-schedule behavior is unchanged. |
| v2.40.0 | "⤢ Maximize" now also hides the secondary panels (developer placeholders row, overlap/conflict/missing-estimate banners, milestones list, Delivery Report) so the left table + timeline take the full maximized screen. "⤡ Restore" brings them all back. |
| v2.41.0 | Fixed root cause of "× doesn't work" / "can't move a placed bar": `cascadePlan` always recomputes `startDate` from `dependencies`, so any manual removal or re-drag was immediately overwritten by the dependency chain. Both × buttons and `placeOnTimeline`'s manual-placement path now also clear `dependencies` on that issue, so manual actions win. Left-table rows for issues already on the timeline now get a light green background (`#E3FCEF`). |
| v2.42.0 | Issues with real dates from Jira status history (`entry.actualEndDate` set) are now locked — not draggable (left-table row or Gantt bar), not clickable-to-place, shown with a 🔒 instead of the row expand caret area / bar's ✓ badge, cursor `not-allowed`. `placeOnTimeline` itself also refuses placement for locked issues as a defense-in-depth check. Removing via × still works (clears startDate but not actualEndDate). |
| v2.43.0 | Fixed Epic Timeline "Auto-schedule" building its candidate list from `rows` — which only contains subtasks of *currently expanded* stories — so collapsed stories' subtasks were silently skipped from assignee-based dependency chaining. Now builds candidates directly from `storiesByEpic`/`subtasksByStory` for the focused epic, regardless of expand state. |
| v2.44.0 | New "Clear all" toolbar button (`clearAllScheduling`) — unschedules everything in the current view (clears `startDate`/`dependencies`/`actualEndDate`, and the `changelogCache` in Epic Timeline mode so status-driven dates can be re-derived) while keeping developer placeholders and milestones intact. Distinct from the existing destructive "Clear" (which wipes the whole plan). |
| v2.45.0 | Corrected the status-history end marker from "Ready for Deployment" to **"In Review"** (`IN_REVIEW_STATUS`) — many tickets never pass through Ready for Deployment, so their actual end date was never set. Added `IGNORED_STATUSES` ('known issue', 'removed') — skipped entirely by dev auto-assignment, status-history placement, and Auto-schedule. Rewrote Epic Timeline's Auto-schedule: (1) no longer skips unassigned issues — everything not-started now gets placed even with no dev; (2) stories that have subtasks no longer compete in their own assignee's queue (which was double-booking devs and causing the reported overlaps) — a container story's date is now just derived from its earliest-scheduled subtask. |
| v2.46.0 | Epic Timeline's Auto-schedule now resolves a subtask's dev placeholder itself (own Jira assignee, or the parent story's as a lighter-colored `borrowedFromParent` fallback) *before* chaining, instead of only relying on the separate passive auto-assign effect having already run — so a subtask with no assignee of its own still joins its parent's assignee queue and gets a proper dependency link, rather than sitting unscheduled or unchained at `planStart`. |
| v2.47.0 | **Root-caused and fixed the Auto-schedule "nothing appears" blackout**: `planStart` was used raw as the scheduling baseline, but `buildWorkingDays` skips weekends — if `planStart` landed on a Sat/Sun, every freshly-scheduled issue collided on that one invalid date and zero bars rendered (confirmed via simulation). Added `snapToWorkingDay()` (planning.js) and applied it at `planStart`'s init, its date-picker `onChange`, and defensively at every `workingDays.indexOf(...)` lookup (`getBarProps`, `getEpicSummaryBarProps`). Also: unassigned issues in Epic Timeline's Auto-schedule now advance a separate shared `unassignedCursor` instead of colliding with assigned issues on `planStart`; `autoScheduleAll` seeds from raw `plan.issues` instead of the cascaded `computedPlan.issues`; the story-as-container derivation now clears `dependencies` so `cascadePlan` can't silently override its derived date. **Missing-estimate banner**: `roughMap`/`missingEstMap` now use a new `epicScopedHierarchy` memo that narrows `epics`/`storiesByEpic`/`subtasksByStory` to just the focused epic in Epic Timeline mode (was previously computed over the whole version — hence "173 issues" while looking at one epic); `buildMissingEstMap`'s epic-level rollup now only flags an epic when its own derived total (`roughMap[epic.key]`) is unusable, not merely because some unrelated child story is flagged — matching the already-correct story-level rule ("a parent with children doesn't need its own estimate"). |
| v2.48.0 | **Found a second, likely primary cause of "Auto-schedule does nothing" + "can't scroll to past dates"**: `workingDays` only ever extended *forward* from `planStart` — any issue dated before it (e.g. real Jira status-history dates for work that already started) fell completely outside the array, so `getBarProps` silently returned `null` for it — invisible AND unscrollable-to. Added a `windowStart` memo that scans `computedPlan.issues` for the earliest known `startDate` and extends `workingDays` backward to cover it (via the existing `workingDaysBetween` helper), so historical dates are now visible and reachable by scrolling left. Added an auto-scroll-to-today effect (keyed on `selectedPlanId`/`focusEpicKey`) so the view still opens centered on "today" instead of the new, potentially much-earlier `workingDays[0]`. Also added temporary `console.log('[autoScheduleAll] ...')` debug output (candidate counts, per-leaf resolved dates, and whether each is inside the visible window) — check the browser DevTools console (F12) when clicking Auto-schedule to see exactly what it did; remove once the root cause is fully confirmed fixed. |
| v2.49.0 | **Consolidated scheduling so "Clear all → Auto-schedule" is a single deterministic action**: previously, already-started issues' real dates were only ever restored by a separate background `useEffect` racing against `changelogCache`/`plan.issues` changes — after Clear all wipes that cache, Auto-schedule (which only ever handled not-started issues) appeared to "do nothing" while the real repopulation silently happened moments later via the effect. `autoScheduleAll` is now `async`: it still chains not-started leaves synchronously, then directly resolves any "already started" leaf lacking a date (from `changelogCache` if already resolved, else a fresh `getIssueChangelog` fetch via `Promise.all`) *before* the container-story derivation and final `updatePlan`, so one click both schedules and restores history. The button shows "Scheduling…" and disables itself while awaiting (`autoScheduling` state). Also: Auto-schedule now auto-expands every story that has subtasks (`setExpandedStories`) so freshly-scheduled subtasks and their dependency arrows are actually visible without manual clicking — dependency arrows require BOTH endpoints to be present in `sortedRows`, which excludes subtasks of collapsed stories. `clearAllScheduling` now also seeds from raw `plan.issues` instead of `computedPlan.issues`, matching the same fix already applied to `autoScheduleAll`. **Auto zoom-to-fit**: `DAY_WIDTH` (renamed base constant to `BASE_DAY_WIDTH`) is now a computed value — a `ResizeObserver` measures the timeline panel, a `scheduledIndexRange` memo finds the day-index span actually covered by placed/scheduled rows, and day width shrinks (down to `MIN_DAY_WIDTH`) so that whole span fits without horizontal scrolling; never grows past the 50px default. `getEpicSummaryBarProps` now takes `dayWidth` as an explicit parameter since it's a module-level function that can't see the component-local computed value. |
| v2.50.0 | Epic Timeline: dragging/clicking a **started** issue (not To Do/Blocked/Reopened, not ignored) onto the timeline now snaps it to its REAL Jira dates (first In Progress transition → first In Review transition, via changelog fetch/cache in `placeOnTimeline`) instead of honoring the drop position — the drop just triggers placement. New derived **story-level dependency arrows**: when a subtask in story B depends on a subtask in story A, a dashed purple arrow is also drawn between the parent story bars (deduped per story pair, non-interactive), so chains stay visible at parent level and with subtasks collapsed. |
| v2.51.0 | **Epic Timeline: a parent story now ALWAYS spans exactly its subtasks** — a new module-level `computeChildSpan()` helper computes the min-start/max-end across a set of child issues; `getBarProps()` uses it for any story with subtasks (returning `bar.isContainer = true`, rendered as a non-draggable dashed-purple summary bar, no × button, instead of the story's own independent startDate/history), and `getEpicSummaryBarProps()` now also uses it per-story (so the epic bar starts when the first task started, not from a story's own possibly-later date). Refined the derived parent-level dependency arrows to skip drawing when both parent stories are already expanded (the real subtask-level arrow already shows the chain there, avoiding overlapping/confusing double arrows). Locked (real-history) bars now render a **bold 4px border** instead of 2px. |
| v2.52.0 | New **🐛 Debug panel** (Epic Timeline mode, toolbar toggle) — a raw data table of every story+subtask under the focused epic (`debugRows` memo): key, type, parent, status, Jira assignee, assigned dev(s), borrowed-from-parent flag, computed start/end date, actual-history flag, rough hours, dependencies. "⎘ Copy table" copies it as TSV to the clipboard for pasting into chat. Container bars (story spanning subtasks) now use the assignee's color as background (matching leaf bars) instead of a transparent/dashed-purple fill — dashed border kept only as the "this is derived" cue. |
| v2.53.0 | **Two root causes found via the debug table's real exported data**: (1) this Jira instance's "To Do" status is literally named `"ToDo"` (no space) — every status comparison did `.trim().toLowerCase()` only, so `'todo' !== 'to do'` and those issues were silently misclassified as "already started," found no real history (they never started), and got no date at all. Added `normalizeStatusName()` (strips ALL whitespace too) and switched every status comparison in the file to use it. (2) Issues that already had a `startDate` (even stale/wrong ones from before the real-dates fix, e.g. TMT0-41693's fabricated chain) were never re-verified against real Jira history, because every skip-guard checked "does it have *a* startDate" instead of "was this date *confirmed* from history." Added an explicit `entry.historyResolved` flag, set only when a fetch+apply completes for an already-started issue; all three resolution paths (`placeOnTimeline`, the background status-history effect, and `autoScheduleAll`) now key their skip-guard on this flag instead of on `startDate` presence, so any old/stale/manually-set date on a started issue gets corrected the next time it's touched. `clearAllScheduling` also resets the flag. Debug table gained a "Resolved?" column to verify this directly. |
| v2.54.0 | Fixed Auto-schedule's `nextAvail` dev-availability tracking starting empty every run — it only ever accounted for issues scheduled *within that same pass*, never issues already placed (including locked/real-history ones from a prior run), so a not-started leaf could get scheduled right on top of the same dev's already-fixed commitment (e.g. TMT0-40345 landing exactly on TMT0-41789's real DONE dates for the same assignee). `autoScheduleAll`'s epic branch now pre-seeds `nextAvail` from every already-placed leaf in the epic (locked or not) before scheduling anything new. Scoped to within the focused epic — cross-epic overlaps (same dev double-booked across two different epics) aren't covered, since `roughMap` is now epic-scoped and duration data for other epics' issues isn't available here. Existing already-scheduled bad pairs (like the TMT0-40345/41789 overlap) need one Clear all → Auto-schedule cycle to actually resolve, since already-placed not-started issues are otherwise left alone by design. |
| v2.55.0 | Found the v2.54 fix didn't actually prevent the reported overlap: the `nextAvail` pre-seed ran *before* the async real-history resolution block, so right after "Clear all" the soon-to-be-resolved locked issues had no `startDate` yet at pre-seed time and were invisible. Reordered `autoScheduleAllInner` so already-started issues are resolved against real Jira history FIRST, then `nextAvail` is pre-seeded, then not-started items are scheduled — so every dev's real commitments are known before anything new gets placed around them. Also fixed `detectConflicts` (planning.js): it never looked at `entry.actualEndDate`, so locked issues got an estimate-based end date instead of their real one, and it compared a container story's own vestigial stored dates against its own children (always "overlapping" by definition — a parent spans its kids). Added `opts.excludeKeys` (container story keys, now excluded in Epic Timeline mode) and `opts.skipLockedPairs` (drops a conflict where both sides are already real/immutable Jira-history dates — nothing about scheduling can fix two historical facts that already overlapped). |
| v2.56.0 | New `PLACEHOLDER_COLORS` palette (useVersionPlan.js) — 12 deliberately distinct hues with only one orange (old palette had `#FF5630` red-orange *and* `#FF991F` orange, easily confused). New `recolorPlaceholders()` action + "🎨 Fix colors" button reassigns every existing dev's color from the current palette in order, so plans created before this change get fixed too (colors are stored per-placeholder, so the palette change alone doesn't retroactively fix already-created devs). New click-to-focus: clicking a developer chip now toggles `focusDevId` and filters `rows` down to just that dev's rows (`filteredRows` memo — keeps epic rows for context, and a story row if any of its subtasks match even if the story itself doesn't) instead of opening rename; rename moved to a small "✎" icon next to the chip. `sortedRows` and all SVG-layer height/position math (today line, milestones, code-freeze overlay) now key off `filteredRows`/`sortedRows.length` instead of the unfiltered `rows`. |
| v2.57.0 | New "⬇ Export HTML" button (Epic Timeline mode) — `exportTimelineHtml()` builds a self-contained `.html` file (summary cards, a simple CSS-based Gantt scaled to the actual scheduled date range rather than the full padded `workingDays` window, milestones, critical path, team utilization bars, and the full debug table) and triggers a browser download via a `Blob`/`URL.createObjectURL` + programmatic `<a download>` click — no server round-trip. Reuses the existing module-level `computeProjectSpan`/`computeCriticalPath`/`computeDevUtilization`/`workingDaysBetween` helpers (same ones `DeliveryReport` uses) so the numbers match what's shown on-screen. New `escapeHtml()` helper guards against summary/label text breaking the generated markup. |
| v2.58.0 | Polished the HTML export: gradient banner header, card-hover elevation, zebra-striped debug table, week-tick date ruler above the Gantt. Story rows with subtasks are now native `<details>`/`<summary>` — collapsible with zero JS (works the same after the file is saved/reopened anywhere). Each bar's own text now shows `KEY · start → end` truncated via CSS `text-overflow:ellipsis`; the native `title` tooltip always carries the full key + summary + dates, so a too-narrow bar still reveals everything on hover with no JS measurement needed. |
| v2.59.0 | **Added the dependency arrows the export was missing** — each row now carries `data-row-key`/`data-deps` attributes, and a small embedded `<script>` (vanilla JS, since this is a plain downloaded HTML file, not the React app) draws a purple dashed SVG path from each dependency's bar to its dependent's bar via `getBoundingClientRect()`, re-running on every `<details>` `toggle` event (and on load/resize) so arrows stay correct as stories collapse/expand — a row hidden inside a collapsed story is skipped via an `isVisible()` walk up the `closest('details')` chain. Also added faint background gridlines (pure CSS, aligned to the same week ticks as the ruler) behind the bars. **Compacted** the whole layout: row height 36px→26px, bar height 22px→18px, label column 340px→280px, smaller fonts/paddings/margins throughout. |
| v2.65.0 | **THE actual root cause of the multi-day "can't drag/click anything already on the Gantt" bug** (v2.60/v2.61/v2.64 fixed real but secondary bugs — lock gating, container-bar not draggable, a milestone hit-rect — that never fully resolved it). The whole-grid `<svg>` overlay (today-line + dependency arrows + milestone lines, `VersionPlanningView.js` ~line 2777) is the LAST sibling rendered in the timeline stack, so it visually paints on top of every row's bar in every column. Its root `<svg>` tag itself never had `pointerEvents` set — and unlike pure-SVG-internal shapes, an inline `<svg>` positioned via CSS is hit-tested as a normal box by the browser (`pointer-events: auto` by default), meaning its ENTIRE bounding rectangle (the whole grid, every row/column, painted or not) swallowed every mousedown before it could ever reach a bar `<div>` or day-cell beneath it. Since the SVG is a *sibling* of the bars, not their ancestor, there was no draggable ancestor for the browser to fall back to — no real HTML5 drag ever started, matching the exact symptoms reported: zero console/debug output no matter how deep the tracing went, a native-looking "no-drop" cursor or rubber-band-style ghost box while attempting to drag, and the bar always snapping back on release. This also explains why dragging FROM THE LEFT LIST to place an issue for the first time kept working the whole time: that drop's `onDrop` handler lives on the right timeline's own scrollable container div, an ANCESTOR of the svg, and native `drop`/`dragover` events bubble up through ancestors regardless of which topmost element the pointer is over — so the ancestor-level handler still fired even though the svg sat on top of everything inside it. Root-caused by a dedicated Explore-agent deep read of the entire component plus every effect/state hook (ruled out re-render races, CSS ancestor issues, duplicate handlers, and stray `stopPropagation` calls first). Fixed with one line: `pointerEvents: 'none'` on the root `<svg>`'s style. Its interactive children (the milestone `<g>`, which now explicitly sets `pointerEvents: 'auto'` so its own subtree re-enables hit-testing despite the parent; the dependency-arrow `<path>`s, which already had their own explicit `pointerEvents: 'stroke'`) continue to work unaffected, since CSS lets a descendant re-opt-in to pointer events even under a `none` ancestor. |
| v2.64.0 | **Fixed the real root cause of "once a task is on the timeline, dragging or clicking it does nothing"** (v2.60/v2.61 fixed the lock/container gating, but a separate bug remained). The SVG dependency/milestone overlay layer (rendered once, after ALL row bars, so it visually sits on top of every bar in the Gantt) drew an invisible hit-rectangle at each milestone's date column to make its thin dashed line easier to click — but that rect spanned `y=0` to the FULL height of every row (`HEADER_H + sortedRows.length * ROW_HEIGHT`), not just the milestone label area. Any bar sitting in the same date column as a milestone had this transparent-but-painted rect on top of it, silently swallowing every mousedown before it ever reached the bar's own `onDragStart`/the day-cell's `onClick` — no console error, no React state change, nothing to see except the browser's native "no valid drag source under cursor" cursor and (misleadingly) a native rubber-band-selection box while dragging, which looked like a stuck ghost image. Root-caused via a temporary on-screen debug readout (bypassing the Jira Custom-UI iframe's console-context confusion) that proved `onDragStart` genuinely never fired for already-placed bars, which narrowed it to a stacking/hit-testing problem rather than anything in the placement logic itself. Fixed by shrinking the invisible hit-rect to just the label-pill area near the header (`y = HEADER_H - 20`, height `24`) instead of the full column, and giving the visible dashed line itself `pointer-events: stroke` so its own thin visible line stays clickable without needing a giant invisible hit box behind it. Milestones are still easy to click (near their label); they no longer block anything underneath them. |
| v2.61.0 | **Fixed root cause of "TMT0-41700 shows a 🚫 no-drop cursor, nothing happens when dragged"**: that issue is a story with subtasks, which Epic Timeline mode always renders as a "container" bar (`bar.isContainer`, `getBarProps` line ~1491) whose span is derived from its children via `computeChildSpan` rather than its own stored date. The container-bar JSX block (the `bar?.isContainer` branch) never had `draggable`/`onDragStart` at all — a separate code path from the individual-bar fix in v2.60.0 — so attempting to drag it hit the browser's native "no valid drop target" cursor (`onDragOver`'s `preventDefault` only fires when `window.__versionPlanDrag` is set, which never happened since no `onDragStart` ever set it). Fixed by adding the same `draggable`/`onDragStart`/`onDragEnd` wiring used by the standard bar branch, plus `cursor: 'grab'`, and removing the leftover `pointerEvents: 'none'` (which is now unnecessary — bars in general already only block clicks passing through to the day-cell layer directly under their own width, matching the standard bar's existing behavior). Dropping a container bar routes through the existing `placeOnTimeline` → `placeStoryAndSubtasks(storyKey, day)` path, which reschedules the story and all of its subtasks back-to-back from the new date (each subtask still chains off the previous one's end + buffer), so moving the story now correctly moves its subtasks/dependents together. |
| v2.60.0 | **Locked (real-Jira-history) bars are now manually movable** — reverses the v2.42.0 "locked = not draggable" design per direct user request. All three locked-bar gates (left-table row drag, day-cell click, Gantt bar drag) were removed; tooltips/🔒 titles now read "drag to override" instead of "locked". `placeOnTimeline` was drastically simplified: the old async "snap to real Jira dates on drop" branch (and its now-dead `findEpicIssueRow` helper) is gone, since the background status-history effect already handles that proactively — placement now unconditionally sets `{ startDate, dependencies: [], actualEndDate: undefined, historyResolved: true }`, so a manual drag always wins and can never be silently reverted by that effect or a future Auto-schedule run. Also removed the now-pointless `async` keyword from `placeOnTimeline` (no `await` remained after the branch removal; both call sites already didn't await it). **Fixed a real cascade bug**: `cascadePlan` and `autoScheduleAllInner` computed a dependency's end date with `calcEndDate` (an *estimate* from rough hours) even when the dependency was locked and had a real `entry.actualEndDate` — so moving/resolving a locked source task didn't correctly cascade to its dependents. Both now prefer `de.actualEndDate` over the estimate, matching the same fix already applied to `detectConflicts` in v2.55.0. **New Buffer setting** (Epic Timeline mode only): a "Buffer: [N] d" numeric input in the toolbar (next to where Draft mode shows Bug fix/Freeze/Stab) sets extra working days inserted after a dependency's end before its dependent can start — threaded through `cascadePlan`'s `opts.bufferDays`, `placeStoryAndSubtasks`'s subtask cascade, and `autoScheduleAllInner`'s pre-seed/not-started-scheduling/`nextAvail`/`unassignedCursor` logic (all via `addWorkingDays(end, 1 + bufferDays)` instead of `nextWorkDay(end)`), analogous to Draft mode's existing QA/bug-fix/freeze buffers. |
---

## Tests
```bash
cd static/app && npm test -- --watchAll=false
# 33 tests, all passing
```

---

## Known Limitations / Next Ideas
- Export to PDF (currently only Markdown copy)
- Final mode code freeze / stabilization lines (currently Draft mode only)
- The "⎘ Copy" button uses `navigator.clipboard` — may fail in some Jira iframe contexts; no fallback yet
- `workingDays` array is built with 150 + codeFreezeDays + stabilizationDays days from planStart — if epics are scheduled far enough out, dates could fall outside this window (console.warn added)

---

## How to Deploy
```bash
cd "static/app"
npm run build
cd ../..
forge deploy
# forge install  (first time only)
```
