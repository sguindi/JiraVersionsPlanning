import { buildRow, issueColor, issueStatusColor } from '../utils/timeline';
import { computeSplit, dayLoadPct, DAY_CAPACITY_SECONDS } from '../utils/scheduling';
import { cascadePlan, calcEndDate, detectConflicts, findCriticalPath } from '../utils/planning';

// ── timeline utils ────────────────────────────────────────────────────────────

describe('issueColor', () => {
  it('returns correct colors for known types', () => {
    expect(issueColor('Epic')).toBe('#6554C0');
    expect(issueColor('Bug')).toBe('#FF5630');
    expect(issueColor('Story')).toBe('#0052CC');
  });

  it('returns fallback for unknown type', () => {
    expect(issueColor('SubTask')).toBe('#B3BAC5');
    expect(issueColor(undefined)).toBe('#B3BAC5');
  });
});

describe('issueStatusColor', () => {
  it('returns done color', () => expect(issueStatusColor('done')).toBe('#36B37E'));
  it('returns in-progress color', () => expect(issueStatusColor('indeterminate')).toBe('#0052CC'));
  it('returns fallback for unknown', () => expect(issueStatusColor('whatever')).toBe('#B3BAC5'));
});

describe('buildRow', () => {
  const windowStartMs = new Date('2025-01-01T00:00:00').getTime();
  const windowEndMs = new Date('2025-01-31T23:59:59').getTime();

  it('returns null for issues with no fields', () => {
    expect(buildRow(null, windowStartMs, windowEndMs, 'customfield_start')).toBeNull();
    expect(buildRow({ key: 'T-1' }, windowStartMs, windowEndMs, 'customfield_start')).toBeNull();
  });

  it('builds a row with valid start and end dates', () => {
    const issue = {
      key: 'T-1',
      fields: {
        summary: 'Test issue',
        duedate: '2025-01-15',
        customfield_start: '2025-01-10',
        issuetype: { name: 'Story' },
        status: { statusCategory: { key: 'indeterminate' } },
      },
    };
    const row = buildRow(issue, windowStartMs, windowEndMs, 'customfield_start');
    expect(row).not.toBeNull();
    expect(row.key).toBe('T-1');
    expect(row.offset).toBeGreaterThanOrEqual(0);
    expect(row.duration).toBeGreaterThan(0);
    expect(row.color).toBe('#0052CC');
    expect(row.statusKey).toBe('indeterminate');
  });

  it('falls back to duedate when start field is absent', () => {
    const issue = {
      key: 'T-2',
      fields: {
        summary: 'No start date',
        duedate: '2025-01-20',
        issuetype: { name: 'Task' },
        status: { statusCategory: { key: 'new' } },
      },
    };
    const row = buildRow(issue, windowStartMs, windowEndMs, 'customfield_start');
    expect(row).not.toBeNull();
    expect(row.offset).toBeGreaterThanOrEqual(0);
  });

  it('handles issue outside window gracefully', () => {
    const issue = {
      key: 'T-3',
      fields: {
        summary: 'Outside window',
        duedate: '2024-12-01',
        issuetype: { name: 'Task' },
        status: { statusCategory: { key: 'new' } },
      },
    };
    const row = buildRow(issue, windowStartMs, windowEndMs, 'customfield_start');
    // Should still build (clamped), offset will be 0
    if (row !== null) {
      expect(row.offset).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── scheduling utils ──────────────────────────────────────────────────────────

describe('computeSplit', () => {
  const assigneeId = 'user1';
  const monday = new Date('2025-01-06T12:00:00');
  const friday = new Date('2025-01-03T12:00:00');

  it('returns single segment for estimate that fits in one day', () => {
    const segments = computeSplit(DAY_CAPACITY_SECONDS, assigneeId, monday, []);
    expect(segments).toHaveLength(1);
    expect(segments[0].date).toBe('2025-01-06');
    expect(segments[0].seconds).toBe(DAY_CAPACITY_SECONDS);
  });

  it('splits across multiple days for large estimate', () => {
    const twoAndHalfDays = DAY_CAPACITY_SECONDS * 2.5;
    const segments = computeSplit(twoAndHalfDays, assigneeId, monday, []);
    expect(segments.length).toBeGreaterThanOrEqual(3);
  });

  it('skips weekends', () => {
    const segments = computeSplit(DAY_CAPACITY_SECONDS * 2, assigneeId, friday, []);
    const dates = segments.map(s => s.date);
    const hasSaturday = dates.some(d => d === '2025-01-04');
    const hasSunday = dates.some(d => d === '2025-01-05');
    expect(hasSaturday).toBe(false);
    expect(hasSunday).toBe(false);
  });

  it('returns single placeholder segment for zero estimate', () => {
    const segments = computeSplit(0, assigneeId, monday, []);
    expect(segments).toHaveLength(1);
    expect(segments[0].seconds).toBe(0);
  });
});

describe('dayLoadPct', () => {
  it('returns 0 when no issues on that day', () => {
    expect(dayLoadPct([], '2025-01-10')).toBe(0);
  });

  it('returns 0.5 for half-capacity day (fraction, not percent)', () => {
    const issues = [
      { fields: { duedate: '2025-01-10', timeoriginalestimate: DAY_CAPACITY_SECONDS / 2, assignee: null } },
    ];
    expect(dayLoadPct(issues, '2025-01-10')).toBeCloseTo(0.5);
  });

  it('returns > 1 for overloaded day', () => {
    const issues = [
      { fields: { duedate: '2025-01-10', timeoriginalestimate: DAY_CAPACITY_SECONDS * 2, assignee: null } },
    ];
    expect(dayLoadPct(issues, '2025-01-10')).toBeGreaterThan(1);
  });
});

// ── planning utils ────────────────────────────────────────────────────────────

describe('cascadePlan', () => {
  it('returns plan unchanged when no dependencies', () => {
    const plan = {
      issues: {
        'T-1': { startDate: '2025-01-06', dependencies: [] },
        'T-2': { startDate: '2025-01-10', dependencies: [] },
      },
    };
    const roughMap = { 'T-1': 8, 'T-2': 16 };
    const result = cascadePlan(plan, roughMap);
    expect(result.issues['T-1'].startDate).toBe('2025-01-06');
    expect(result.issues['T-2'].startDate).toBe('2025-01-10');
  });

  it('pushes dependent issue start after predecessor end', () => {
    const plan = {
      issues: {
        'T-1': { startDate: '2025-01-06', dependencies: [], assignedPlaceholders: ['ph1'] },
        'T-2': { startDate: '2025-01-06', dependencies: ['T-1'], assignedPlaceholders: ['ph1'] },
      },
    };
    const roughMap = { 'T-1': 8, 'T-2': 8 }; // 8h each = 1 working day
    const result = cascadePlan(plan, roughMap);
    // T-2 should start after T-1 ends
    expect(result.issues['T-2'].startDate > result.issues['T-1'].startDate).toBe(true);
  });

  it('does not crash when a dependency key is missing', () => {
    const plan = {
      issues: {
        'T-1': { startDate: '2025-01-06', dependencies: ['MISSING-99'] },
      },
    };
    expect(() => cascadePlan(plan, {})).not.toThrow();
  });
});

describe('calcEndDate', () => {
  it('returns startDate for single-day task', () => {
    expect(calcEndDate('2025-01-06', 6, 1)).toBe('2025-01-06');
  });

  it('returns null for missing start', () => {
    expect(calcEndDate(null, 8, 1)).toBeNull();
  });

  it('spans across a weekend', () => {
    // Friday 2025-01-03 + 1 extra working day → Monday 2025-01-06 (skips Sat+Sun)
    const end = calcEndDate('2025-01-03', 12, 1); // 12h / 6h_per_day = 2 days → extra=1
    expect(end).toBe('2025-01-06');
  });
});

describe('detectConflicts', () => {
  it('returns empty array when no conflicts', () => {
    const plan = {
      placeholders: [{ id: 'ph1' }],
      issues: {
        'T-1': { startDate: '2025-01-06', assignedPlaceholders: ['ph1'] },
        'T-2': { startDate: '2025-01-20', assignedPlaceholders: ['ph1'] },
      },
    };
    const roughMap = { 'T-1': 6, 'T-2': 6 };
    expect(detectConflicts(plan, roughMap)).toHaveLength(0);
  });

  it('detects overlapping assignments for same placeholder', () => {
    const plan = {
      placeholders: [{ id: 'ph1' }],
      issues: {
        'T-1': { startDate: '2025-01-06', assignedPlaceholders: ['ph1'] },
        'T-2': { startDate: '2025-01-06', assignedPlaceholders: ['ph1'] },
      },
    };
    const roughMap = { 'T-1': 12, 'T-2': 6 };
    const conflicts = detectConflicts(plan, roughMap);
    expect(conflicts.length).toBeGreaterThan(0);
  });
});

describe('findCriticalPath', () => {
  it('returns empty set for empty plan', () => {
    expect(findCriticalPath({ issues: {} }, {}).size).toBe(0);
  });

  it('identifies a single chain as critical', () => {
    const plan = {
      issues: {
        'T-1': { startDate: '2025-01-06', dependencies: [], assignedPlaceholders: ['ph1'] },
        'T-2': { startDate: '2025-01-07', dependencies: ['T-1'], assignedPlaceholders: ['ph1'] },
      },
    };
    const roughMap = { 'T-1': 6, 'T-2': 6 };
    const cp = findCriticalPath(plan, roughMap);
    expect(cp.size).toBeGreaterThan(0);
  });
});
