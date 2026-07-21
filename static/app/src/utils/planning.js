import { format, parseISO, addDays, getDay } from 'date-fns';

export const HOURS_PER_DAY = 6;

export function isWeekend(d) { const w = getDay(d); return w === 0 || w === 6; }

export function addWorkingDays(startStr, n) {
  let cur = parseISO(startStr);
  let cnt = 0;
  while (cnt < n) { cur = addDays(cur, 1); if (!isWeekend(cur)) cnt++; }
  return format(cur, 'yyyy-MM-dd');
}

export function nextWorkDay(dateStr) { return addWorkingDays(dateStr, 1); }

// Returns dateStr unchanged if it's already a working day, otherwise forward-skips to the next one.
export function snapToWorkingDay(dateStr) {
  if (!dateStr) return dateStr;
  return isWeekend(parseISO(dateStr)) ? nextWorkDay(dateStr) : dateStr;
}

export function calcDays(roughHours, devCount) {
  if (!roughHours || !devCount) return 1;
  return Math.max(1, Math.ceil(roughHours / (devCount * HOURS_PER_DAY)));
}

export function calcEndDate(startStr, roughHours, devCount) {
  if (!startStr) return null;
  const extra = calcDays(roughHours, devCount) - 1;
  return extra === 0 ? startStr : addWorkingDays(startStr, extra);
}

// Returns the QA days, bug-fix days, and their sum for a given epic.
// qaHours: hours the QA team needs (not divided by devCount — QA is a separate team)
// bugFixPct: percentage of dev time that developers spend fixing bugs after QA
export function calcQaBugFixDays(roughHours, devCount, qaHours, bugFixPct) {
  const devs = devCount || 1;
  const qaDays = qaHours ? Math.ceil(qaHours / HOURS_PER_DAY) : 0;
  const bugFixHours = roughHours && bugFixPct ? roughHours * bugFixPct / 100 : 0;
  const bugFixDays = bugFixHours ? calcDays(bugFixHours, devs) : 0;
  return { qaDays, bugFixDays, totalExtra: qaDays + bugFixDays };
}

export function buildWorkingDays(fromStr, count) {
  const days = [];
  let cur = parseISO(fromStr);
  while (days.length < count) {
    if (!isWeekend(cur)) days.push(format(cur, 'yyyy-MM-dd'));
    cur = addDays(cur, 1);
  }
  return days;
}

// opts: { qaMap: { [issueKey]: qaHours }, bugFixPct: number, bufferDays: number }
// bufferDays — extra working days inserted after a dependency ends before its dependent
// can start (on top of the normal next-working-day gap) — an Epic Timeline mode setting,
// analogous to Draft mode's QA/bug-fix/code-freeze buffers.
export function cascadePlan(plan, roughMap, opts = {}) {
  if (!plan?.issues) return plan;
  const qaMap = opts.qaMap || {};
  const bugFixPct = opts.bugFixPct || 0;
  const bufferDays = opts.bufferDays || 0;
  const issues = { ...plan.issues };
  const dependents = {};
  for (const [key, e] of Object.entries(issues)) {
    for (const dep of (e.dependencies || [])) {
      if (!dependents[dep]) dependents[dep] = [];
      dependents[dep].push(key);
    }
  }
  const inDeg = {};
  for (const k of Object.keys(issues)) inDeg[k] = (issues[k].dependencies || []).length;
  const queue = Object.keys(issues).filter(k => !inDeg[k]);
  const order = [];
  while (queue.length) {
    const k = queue.shift(); order.push(k);
    for (const dep of (dependents[k] || [])) { inDeg[dep]--; if (!inDeg[dep]) queue.push(dep); }
  }
  const newIssues = {};
  for (const k of Object.keys(issues)) newIssues[k] = { ...issues[k] };
  for (const k of order) {
    const e = newIssues[k];
    if (!(e.dependencies || []).length) continue;
    let latestEnd = null;
    for (const depKey of e.dependencies) {
      const de = newIssues[depKey];
      if (!de?.startDate) continue;
      const devs = (de.assignedPlaceholders || []).length || 1;
      // A locked issue's real end date is a fact — never replace it with an estimate.
      const devEnd = de.actualEndDate || calcEndDate(de.startDate, roughMap[depKey], devs);
      if (!devEnd) continue;
      const { totalExtra } = calcQaBugFixDays(roughMap[depKey], devs, qaMap[depKey] || 0, bugFixPct);
      const end = totalExtra > 0 ? addWorkingDays(devEnd, totalExtra) : devEnd;
      if (!latestEnd || end > latestEnd) latestEnd = end;
    }
    if (latestEnd) newIssues[k] = { ...e, startDate: addWorkingDays(latestEnd, 1 + bufferDays) };
  }
  return { ...plan, issues: newIssues };
}

// opts: { qaMap: { [issueKey]: qaHours }, bugFixPct: number, excludeKeys: Iterable<string>,
//         skipLockedPairs: boolean }
// excludeKeys — issue keys to leave out entirely (e.g. a container story in Epic Timeline
// mode, whose own stored dates are vestigial and always "overlap" its own children by
// definition — that's not a real scheduling conflict).
// skipLockedPairs — when true, a conflict between two issues that BOTH have a real,
// immutable `actualEndDate` (Jira status history) is not reported, since nothing about
// scheduling can resolve two facts that already overlapped in reality.
export function detectConflicts(plan, roughMap, opts = {}) {
  const qaMap = opts.qaMap || {};
  const bugFixPct = opts.bugFixPct || 0;
  const excludeKeys = opts.excludeKeys ? new Set(opts.excludeKeys) : null;
  const result = [];
  for (const ph of (plan.placeholders || [])) {
    const assigned = Object.entries(plan.issues || {})
      .filter(([key, e]) => e.assignedPlaceholders?.includes(ph.id) && e.startDate && !(excludeKeys && excludeKeys.has(key)))
      .map(([key, e]) => {
        const devs = (e.assignedPlaceholders || []).length || 1;
        // A locked issue's real end date is a fact — never replace it with an estimate.
        const devEnd = e.actualEndDate || calcEndDate(e.startDate, roughMap[key], devs) || e.startDate;
        const { totalExtra } = calcQaBugFixDays(roughMap[key], devs, qaMap[key] || 0, bugFixPct);
        const endDate = (!e.actualEndDate && totalExtra > 0) ? addWorkingDays(devEnd, totalExtra) : devEnd;
        return { key, startDate: e.startDate, endDate, isLocked: !!e.actualEndDate };
      })
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    for (let i = 0; i < assigned.length - 1; i++) {
      if (assigned[i].endDate >= assigned[i + 1].startDate) {
        if (opts.skipLockedPairs && assigned[i].isLocked && assigned[i + 1].isLocked) continue;
        result.push({ placeholder: ph, source: assigned[i].key, target: assigned[i + 1].key });
      }
    }
  }
  return result;
}

// Returns a Set of issue keys that lie on the critical path (zero total float)
export function findCriticalPath(plan, roughMap) {
  if (!plan?.issues) return new Set();
  const issues = plan.issues;

  // Build forward end dates for each issue
  const endDates = {};
  for (const [k, e] of Object.entries(issues)) {
    if (!e.startDate) continue;
    const devs = (e.assignedPlaceholders || []).length || 1;
    endDates[k] = calcEndDate(e.startDate, roughMap[k], devs) || e.startDate;
  }

  // Project end = max end date across all issues
  const projectEnd = Object.values(endDates).reduce((max, d) => (!max || d > max ? d : max), null);
  if (!projectEnd) return new Set();

  // Late finish = project end for all issues (simple critical path without slack)
  // A critical path issue: its end date equals the latest possible end date in its chain
  const criticalKeys = new Set();

  // Walk backwards: an issue is critical if removing it would delay the project
  // Simplified: an issue is critical if endDates[k] === projectEnd OR
  // any issue that depends on it (directly or transitively) is critical and
  // the dependency is the binding one.
  const dependents = {};
  for (const [k, e] of Object.entries(issues)) {
    for (const dep of (e.dependencies || [])) {
      if (!dependents[dep]) dependents[dep] = [];
      dependents[dep].push(k);
    }
  }

  // Find all issues whose end date equals projectEnd — these are the final nodes
  for (const [k, end] of Object.entries(endDates)) {
    if (end === projectEnd) criticalKeys.add(k);
  }

  // Walk backwards through dependencies from critical nodes
  const toVisit = [...criticalKeys];
  while (toVisit.length) {
    const k = toVisit.pop();
    const e = issues[k];
    for (const depKey of (e?.dependencies || [])) {
      if (!criticalKeys.has(depKey) && endDates[depKey]) {
        // Check if this dep is the binding predecessor
        const depEnd = endDates[depKey];
        const myStart = issues[k]?.startDate;
        if (myStart && depEnd && nextWorkDay(depEnd) === myStart) {
          criticalKeys.add(depKey);
          toVisit.push(depKey);
        }
      }
    }
  }

  return criticalKeys;
}
