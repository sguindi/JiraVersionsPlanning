export const ISSUE_TYPE_COLORS = {
  Epic: '#6554C0',
  Story: '#0052CC',
  Task: '#00B8D9',
  Bug: '#FF5630',
};

export const ISSUE_STATUS_COLORS = {
  new: '#B3BAC5',
  indeterminate: '#0052CC',
  done: '#36B37E',
};

export function issueColor(type) {
  return ISSUE_TYPE_COLORS[type] || '#B3BAC5';
}

export function issueStatusColor(statusKey) {
  return ISSUE_STATUS_COLORS[statusKey] || '#B3BAC5';
}

export function buildRow(issue, windowStartMs, windowEndMs, startDateField) {
  if (!issue || !issue.fields) return null;
  const f = issue.fields || {};
  const startStr = f[startDateField] || f.duedate;
  const endStr = f.duedate;
  const startMs = startStr ? new Date(startStr + 'T12:00:00').getTime() : windowStartMs;
  const endMs = endStr ? new Date(endStr + 'T12:00:00').getTime() : startMs + 7 * 86400000;
  const clampedStart = Math.max(startMs, windowStartMs);
  const clampedEnd = Math.min(Math.max(endMs, startMs + 86400000), windowEndMs);
  const offset = Math.max(0, clampedStart - windowStartMs);
  const duration = Math.max(86400000, clampedEnd - clampedStart);
  return {
    key: issue.key,
    name: `${issue.key}`,
    label: `${issue.key}: ${(f.summary || '').slice(0, 45)}`,
    offset,
    duration,
    color: issueColor(f.issuetype?.name),
    statusKey: f.status?.statusCategory?.key || 'new',
    isEpic: f.issuetype?.name === 'Epic',
    parentKey: f.parent?.key || null,
    summary: (f.summary || '').slice(0, 60),
    startMs: clampedStart,
    endMs: clampedEnd,
  };
}
