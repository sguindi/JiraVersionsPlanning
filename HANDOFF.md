# planJira — Claude Handoff Summary
**Last updated:** 2026-07-06 | **Deployed version:** v2.29.0

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
The view has **two planning modes** toggled in the toolbar:

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

### Key State Variables (in the main component)
```js
planningMode       // 'draft' | 'final'
bugFixPct          // % of dev time for bug fixes (default 20)
codeFreezeDays     // working days from last epic end to code freeze (default 5)
stabilizationDays  // working days of stabilization after code freeze (default 10)
qaMap              // { [epicKey]: qaHours } — QA hours per epic (input by PM)
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
