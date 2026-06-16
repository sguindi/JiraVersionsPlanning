import { format, getDay, addDays } from 'date-fns';

export const DAY_CAPACITY_SECONDS = 6 * 3600;

export function computeDayCapacity(issues, dateStr) {
  const byPerson = {};
  for (const issue of issues) {
    if (!issue || !issue.fields) continue;
    const f = issue.fields;
    if (f.duedate !== dateStr) continue;
    const id = f.assignee?.accountId || '__unassigned__';
    if (!byPerson[id]) byPerson[id] = { used: 0, assignee: f.assignee };
    byPerson[id].used += f.timeoriginalestimate || 0;
  }
  return byPerson;
}

export function dayLoadPct(issues, dateStr) {
  const cap = computeDayCapacity(issues, dateStr);
  const loads = Object.values(cap).map(p => p.used / DAY_CAPACITY_SECONDS);
  return loads.length ? Math.max(...loads) : 0;
}

export function computeSplit(estimateSeconds, assigneeId, dropDate, displayedIssues) {
  if (!estimateSeconds) return [{ date: format(dropDate, 'yyyy-MM-dd'), seconds: 0 }];
  const segments = [];
  let remaining = estimateSeconds;
  let current = dropDate;
  let guard = 0;
  while (remaining > 0 && guard++ < 30) {
    const dow = getDay(current);
    if (dow === 0 || dow === 6) { current = addDays(current, 1); continue; }
    const used = computeDayCapacity(displayedIssues, format(current, 'yyyy-MM-dd'))[assigneeId]?.used || 0;
    const avail = Math.max(0, DAY_CAPACITY_SECONDS - used);
    if (avail > 0) {
      const slot = Math.min(remaining, avail);
      segments.push({ date: format(current, 'yyyy-MM-dd'), seconds: slot });
      remaining -= slot;
    }
    current = addDays(current, 1);
  }
  return segments.length ? segments : [{ date: format(dropDate, 'yyyy-MM-dd'), seconds: Math.min(estimateSeconds, DAY_CAPACITY_SECONDS) }];
}
