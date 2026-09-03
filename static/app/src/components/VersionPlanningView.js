import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { format, parseISO, addDays, getDay, isAfter } from 'date-fns';
import { useEpicHierarchy } from '../hooks/useEpicHierarchy';
import { useSprints } from '../hooks/useSprints';
import { useVersionPlan } from '../hooks/useVersionPlan';
import { resolveRoughEstField, resolveStartDateField, updateIssueDueDate, updateRoughEstimation, getIssueChangelog } from '../api/bridge';
import IssueDetailPane from './IssueDetailPane';
import { cascadePlan, detectConflicts, calcEndDate, calcDays, nextWorkDay, addWorkingDays, subWorkingDays, buildWorkingDays, findCriticalPath, calcQaBugFixDays, HOURS_PER_DAY, isWeekend, snapToWorkingDay, effectiveDevCount } from '../utils/planning';

// ── Constants ─────────────────────────────────────────────────────────────────
const BASE_DAY_WIDTH = 50;  // default px per working day — shrunk to fit when the scheduled span is wider than the panel
const MIN_DAY_WIDTH = 10;   // never shrink past this — bars stay clickable
const ROW_HEIGHT = 38;
const HEADER_H = 50;
const MILESTONE_COLORS = ['#0052CC', '#FF991F', '#6554C0', '#00875A', '#FF5630', '#00B8D9'];
const TODAY_STR = format(new Date(), 'yyyy-MM-dd');

// Statuses that mean "not actually started" — issues in any other status get their
// timeline auto-derived from Jira status-change history (Epic Timeline mode only).
// Compared via normalizeStatusName(), which strips ALL whitespace — some Jira workflows
// name this status "To Do", others "ToDo"; both must match the same 'todo' entry here.
const NOT_STARTED_STATUSES = ['reopened', 'todo', 'blocked'];
// Statuses that mean "don't plan this at all" — excluded from scheduling, dev
// auto-assignment, and status-history placement entirely.
const IGNORED_STATUSES = ['knownissue', 'removed'];
const IN_PROGRESS_STATUS = 'inprogress';
const IN_REVIEW_STATUS = 'inreview';

// Gantt bar border color by status — lets you tell an issue's real-world state apart from
// its dev assignment (the bar's fill) at a glance. Statuses not listed here (To Do, In
// Progress, In Review, …) keep no status border at all, so the bar's own dev-colored
// border/outline (locked/conflict/critical-path) shows through unobstructed.
const STATUS_BORDER_COLORS = {
  done: '#97A0AF',               // grey
  readyfordeployment: '#0052CC', // blue
  readyfortest: '#0052CC',       // blue
  blocked: '#DE350B',            // red
  monitoring: '#DE350B',         // red
  validation: '#DE350B',         // red
};
function statusBorderColor(statusName) {
  return STATUS_BORDER_COLORS[normalizeStatusName(statusName)] || null;
}

// Reserved plan names for "Final" plans — there is exactly one per scope, auto-created
// on demand, always saved straight to Jira, never shown in the Draft plan picker.
// Top-level Final mode gets one per version; Epic Timeline's own Final choice gets one
// per epic (so drilling into one epic's Final schedule doesn't fight with another epic's).
const FINAL_PLAN_NAME = 'Final';
function finalPlanName(epicKey) {
  return epicKey ? `Final — ${epicKey}` : FINAL_PLAN_NAME;
}
function isReservedFinalPlanName(name) {
  return name === FINAL_PLAN_NAME || name.startsWith('Final — ');
}

// Normalizes a Jira status name for comparison: trims, lowercases, and strips ALL
// internal whitespace — so "To Do" / "ToDo" / "to  do" are all treated as identical.
function normalizeStatusName(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, '');
}

// An issue's committed date window from JIRA'S OWN fields. The DUE DATE is what makes a window
// exist — it's the commitment. The Start date custom field is used when present; when it isn't,
// the start is derived by counting `durationDays` working days BACKWARD from the due date, so
// the work lands finishing exactly on its commitment rather than starting on it.
// Returns null when there's no due date (nothing committed) — that issue schedules normally.
function jiraDateWindow(issue, startFieldId, durationDays) {
  const f = issue?.fields || {};
  const rawEnd = f.duedate;
  if (!rawEnd) return null;
  const end = String(rawEnd).slice(0, 10);
  const rawStart = startFieldId ? f[startFieldId] : null;
  if (rawStart) {
    const start = String(rawStart).slice(0, 10);
    if (start <= end) return { start, end, derivedStart: false };
  }
  const days = Math.max(1, durationDays || 1);
  return { start: days > 1 ? subWorkingDays(end, days - 1) : end, end, derivedStart: true };
}

// Two-letter initials for a developer — first letters of the first two words ("Sharon
// Cohen" → "SC"), or the first two characters of a single-word name ("sharonc" → "SH").
function devInitials(name) {
  var parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function statusInitials(name) {
  if (!name) return '';
  return name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 4);
}

function statusColors(categoryKey) {
  if (categoryKey === 'done') return { bg: '#E3FCEF', fg: '#00875A' };
  if (categoryKey === 'indeterminate') return { bg: '#DEEBFF', fg: '#0052CC' };
  return { bg: '#EBECF0', fg: '#42526E' }; // 'new' or unknown
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function isIgnoredStatus(row) {
  return IGNORED_STATUSES.includes(normalizeStatusName(row.fields?.status?.name));
}

// "Dev done" — the development work itself is finished, even if QA/deployment isn't.
// Used to compute an epic's REMAINING DEV estimate: once a child story's dev work is done,
// its hours no longer count toward how much dev time the epic still needs.
const DEV_DONE_STATUSES = ['inreview', 'readyfortesting', 'readyfordeployment', 'done'];
function isDevDoneStatus(row) {
  return DEV_DONE_STATUSES.includes(normalizeStatusName(row?.fields?.status?.name));
}

// "Done" — truly finished, QA included. Deliberately narrower than DEV_DONE_STATUSES:
// dev work sitting in In Review / Ready for Testing / Ready for Deployment has NOT been
// signed off by QA yet, so it still needs bug-fix budget reserved against it. Only Done
// work is exempt from the QA/bug-fix buffer.
function isDoneStatus(row) {
  return normalizeStatusName(row?.fields?.status?.name) === 'done';
}

// Rolls an epic up from its child stories' estimates, skipping ignored children plus any
// the caller's `shouldExclude` predicate rejects. Every non-epic key passes through
// unchanged from roughMap, so callers can swap roughMap for the result at any scheduling
// call site without special-casing which row is an epic. Two maps are built from this:
//  • remainingEstMap  (excludes isDevDoneStatus) — drives BAR DURATION: how much dev time
//    is genuinely left, so a mostly-finished epic doesn't block the timeline for its full
//    original size.
//  • bugFixBaseMap    (excludes isDoneStatus)    — drives the QA/BUG-FIX BUFFER: work that's
//    dev-complete but not QA-signed-off still needs rework time reserved, so those hours
//    must stay in this base even though they've dropped out of the duration above.
function buildEpicRollupMap(epics, storiesByEpic, roughMap, shouldExclude) {
  const map = { ...roughMap };
  epics.forEach(epic => {
    const childStories = storiesByEpic[epic.key] || [];
    if (!childStories.length) return;
    let sum = 0;
    childStories.forEach(story => {
      if (isIgnoredStatus(story) || shouldExclude(story)) return;
      sum += roughMap[story.key] || 0;
    });
    map[epic.key] = sum;
  });
  return map;
}

// The QA/bug-fix base, built on top of the rollup above. The story-level rollup alone isn't
// enough: an epic can have every one of its stories already signed off as Done while the EPIC
// itself still sits in In Review / Ready for Testing / Ready for Deployment — it's in QA right
// now. The rollup returns 0 for it, which zeroed the rework budget and rendered a bare 1-day
// bar with no QA/Fix tail at all. Rework is proportional to the code that was WRITTEN, not to
// the zero dev hours left, so fall back to the epic's own total whenever the epic itself
// hasn't reached Done. Only a genuinely Done (or ignored) epic gets no buffer.
function buildBugFixBaseMap(epics, storiesByEpic, roughMap) {
  const map = buildEpicRollupMap(epics, storiesByEpic, roughMap, isDoneStatus);
  epics.forEach(epic => {
    if (isIgnoredStatus(epic) || isDoneStatus(epic)) return;
    if (!(map[epic.key] > 0)) map[epic.key] = roughMap[epic.key] || 0;
  });
  return map;
}

// Estimate COVERAGE per epic — how many of its (non-ignored) child stories actually have a
// usable estimate, counting a story as estimated when roughMap has a value for it (so its
// own estimate OR a rolled-up sum from its leaf children both qualify). An epic's total can
// look healthy while covering a fraction of its real scope: 10 stories with only 1 estimated
// rolls up a number that represents 10% of the work. Surfaced as a per-epic badge so a
// misleadingly-small total is obvious instead of silently under-planning the timeline.
// Counts only REAL estimates (storyRealHours — the story's own value or a sum of its
// subtasks' own values), never a share inherited from the epic. Otherwise the badge would
// read 100% for exactly the epics this is meant to flag: ones estimated as a single lump
// whose individual stories were never sized.
function buildEstCoverageMap(epics, storiesByEpic, subtasksByStory, mode, fieldId) {
  const map = {};
  epics.forEach(epic => {
    const childStories = (storiesByEpic[epic.key] || []).filter(s => !isIgnoredStatus(s));
    if (!childStories.length) return;
    const estimated = childStories.filter(s => storyRealHours(s, subtasksByStory, mode, fieldId) > 0).length;
    map[epic.key] = {
      total: childStories.length,
      estimated,
      pct: Math.round((estimated / childStories.length) * 100),
    };
  });
  return map;
}

// Finds the timestamp of the first transition INTO "In Progress", and the first
// transition into "In Review" that happens after it, from a changelog's history
// entries (module-level, pure — see getIssueChangelog in bridge.js).
function extractStatusDates(histories) {
  const sorted = [...(histories || [])].sort((a, b) => new Date(a.created) - new Date(b.created));
  let inProgressDate = null;
  let reviewDate = null;
  for (const h of sorted) {
    for (const item of (h.items || [])) {
      if (item.field !== 'status') continue;
      const to = normalizeStatusName(item.toString);
      if (!inProgressDate && to === IN_PROGRESS_STATUS) inProgressDate = h.created;
      else if (inProgressDate && !reviewDate && to === IN_REVIEW_STATUS) reviewDate = h.created;
    }
  }
  return { inProgressDate, readyDate: reviewDate };
}

// ── Est value computation (module-level to avoid TDZ in minified output) ──────

// An issue's OWN estimate in hours, per mode — the Rough Estimation custom field in
// 'rough' mode, Jira's native Original Estimate (stored in seconds) in 'children' mode.
// Returns 0 when absent/unusable so callers can just compare against 0.
function ownEstHours(issue, mode, fieldId) {
  if (!issue || !issue.key) return 0;
  if (mode === 'rough') {
    if (!fieldId) return 0;
    var val = issue.fields && issue.fields[fieldId];
    var n = Number(val);
    return (val != null && !isNaN(n) && n > 0) ? n : 0;
  }
  var secs = issue.fields && issue.fields.timeoriginalestimate;
  return secs > 0 ? secs / 3600 : 0;
}

// Children frequently carry no estimate of their own while their parent does — a team
// estimates at epic or story level and breaks the work into unestimated children. Rather
// than treating those children (and therefore any total rolled up FROM them) as
// unestimated, spread the parent's UNACCOUNTED hours evenly over the children that lack a
// value: remainder = parentHours - (sum of children that DO have one), never below 0. The
// children then sum to max(parentHours, knownSum) — the parent's number is honored, and
// estimates already entered are never overwritten or double-counted.
// `childHours` reads a child's own value, so real data always wins over an inherited share.
function distributeParentEst(parentHours, children, childHours, map) {
  if (!(parentHours > 0) || !children || !children.length) return;
  var unknown = children.filter(function(c) { return childHours(c) <= 0; });
  if (!unknown.length) return;
  var knownSum = children.reduce(function(t, c) { return t + childHours(c); }, 0);
  var remainder = Math.max(0, parentHours - knownSum);
  if (remainder <= 0) return;
  var share = remainder / unknown.length;
  unknown.forEach(function(c) { map[c.key] = share; });
}

// A story's estimate with NO inheritance from its epic — its own value, or failing that the
// sum of its subtasks' own values. This is the "does this story really carry an estimate?"
// test, used both to decide which stories should inherit a share of their epic's total and
// to compute the coverage badge (which must stay honest: a story that only has an inherited
// share must NOT count as estimated, or the badge would report 100% coverage for an epic
// whose stories were never estimated at all).
function storyRealHours(story, subtasksByStory, mode, fieldId) {
  var own = ownEstHours(story, mode, fieldId);
  if (own > 0) return own;
  var subs = (subtasksByStory && subtasksByStory[story.key]) || [];
  return subs.reduce(function(t, s) { return t + ownEstHours(s, mode, fieldId); }, 0);
}

function buildRoughMap(mode, epics, storiesByEpic, subtasksByStory, fieldId) {
  const map = {};
  // Every issue's own estimate first (all three levels), in either mode.
  const allStories = Object.values(storiesByEpic).flat();
  const allSubtasks = Object.values(subtasksByStory).flat();
  [].concat(epics, allStories, allSubtasks).forEach(function(issue) {
    var own = ownEstHours(issue, mode, fieldId);
    if (own > 0) map[issue.key] = own;
  });

  // Epic → stories: an epic estimated as a single number (very common in 'rough' mode)
  // whose stories carry nothing of their own would otherwise roll up to 0 and lose its real
  // total entirely. Give each unestimated story a share, so per-story scheduling and the
  // status-aware rollups below have something truthful to work with.
  epics.forEach(function(epic) {
    distributeParentEst(
      ownEstHours(epic, mode, fieldId),
      storiesByEpic[epic.key] || [],
      function(s) { return storyRealHours(s, subtasksByStory, mode, fieldId); },
      map
    );
  });

  // Story → subtasks: same idea one level down. Uses the story's EFFECTIVE hours (possibly
  // just inherited from its epic above) so the share reaches all the way to the leaves.
  allStories.forEach(function(story) {
    var subs = (subtasksByStory && subtasksByStory[story.key]) || [];
    distributeParentEst(
      map[story.key] || 0,
      subs,
      function(s) { return ownEstHours(s, mode, fieldId); },
      map
    );
  });

  if (mode === 'children') {
    // A story's total rolls up from its subtasks — but never below what it already has, so a
    // story whose subtasks are all unestimated still reports the hours it was estimated at
    // (previously this summed to 0 and silently zeroed out the story AND its epic).
    allStories.forEach(function(story) {
      var subs = (subtasksByStory && subtasksByStory[story.key]) || [];
      if (!subs.length) return; // no children — its own estimate (set above) stands
      var subSum = subs.reduce(function(t, sub) { return t + (map[sub.key] || 0); }, 0);
      var total = Math.max(subSum, map[story.key] || 0);
      if (total > 0) map[story.key] = total;
    });
    // epics: sum stories, but never drop below the epic's own estimate — otherwise an epic
    // whose stories are all unestimated reports 0h and gets scheduled as a single day.
    epics.forEach(function(epic) {
      var childStories = storiesByEpic[epic.key] || [];
      var epicSum = childStories.reduce(function(t, s) { return t + (map[s.key] || 0); }, 0);
      var total = Math.max(epicSum, map[epic.key] || 0);
      if (total > 0) map[epic.key] = total;
    });
  }
  return map;
}

// Flagged = "we cannot compute a duration for this row", which is exactly
// `roughMap[key] <= 0`. Deliberately keyed off the already-built roughMap rather than
// re-reading raw fields, so every fallback roughMap applies (a story falling back to its
// own estimate when its subtasks are unestimated, a subtask inheriting a share of its
// parent's, an epic rolling up from its stories) automatically counts as estimated here
// too — otherwise rows we CAN schedule would still be reported as missing estimates.
// A parent with children never needs its own estimate: its rolled-up total is what matters.
function buildMissingEstMap(epics, storiesByEpic, subtasksByStory, roughMap) {
  var missing = {};
  var flag = function(issue) {
    if (!issue || !issue.key) return;
    if (!(roughMap && roughMap[issue.key] > 0)) missing[issue.key] = true;
  };
  epics.forEach(flag);
  Object.values(storiesByEpic).flat().forEach(flag);
  Object.values(subtasksByStory).flat().forEach(flag);
  return missing;
}

// Computes the pixel span covering a set of already-placed "child" issues — shared by a
// story-with-subtasks container bar and by the epic summary bar (for a story's
// contribution, whether it's a container itself or a plain leaf). A parent must always
// start/end exactly with its children, never with its own independent date/history.
function computeChildSpan(childKeys, computedPlan, roughMap, workingDays, dayWidth) {
  var leftMin = Infinity, rightMax = -Infinity, placed = 0, minStartIdx = Infinity, maxEndIdx = -Infinity;
  childKeys.forEach(function(key) {
    var entry = computedPlan.issues && computedPlan.issues[key];
    if (!entry || !entry.startDate) return;
    var startIdx = workingDays.indexOf(snapToWorkingDay(entry.startDate));
    if (startIdx < 0) return;
    var endIdx = startIdx;
    if (entry.actualEndDate) {
      var ei = workingDays.indexOf(snapToWorkingDay(entry.actualEndDate));
      if (ei > startIdx) endIdx = ei;
    } else {
      var devs = effectiveDevCount(entry.assignedPlaceholders, computedPlan.placeholders);
      endIdx = startIdx + calcDays(roughMap[key], devs) - 1;
    }
    placed++;
    if (startIdx < minStartIdx) minStartIdx = startIdx;
    if (endIdx > maxEndIdx) maxEndIdx = endIdx;
    var left = startIdx * dayWidth;
    var right = (endIdx + 1) * dayWidth;
    if (left < leftMin) leftMin = left;
    if (right > rightMax) rightMax = right;
  });
  if (placed === 0) return null;
  return { left: leftMin, width: Math.max(dayWidth, rightMax - leftMin) - 2, startIdx: minStartIdx, endIdx: maxEndIdx, placed: placed };
}

// ── Epic summary bar (spans all placed stories) ───────────────────────────────
function getEpicSummaryBarProps(epicKey, storiesByEpic, subtasksByStory, computedPlan, roughMap, workingDays, dayWidth) {
  var stories = storiesByEpic[epicKey] || [];
  var leftMin = Infinity;
  var rightMax = -Infinity;
  var placed = 0;
  stories.forEach(function(story) {
    var subs = (subtasksByStory && subtasksByStory[story.key]) || [];
    var childKeys = subs.length > 0 ? subs.map(function(s) { return s.key; }) : [story.key];
    var span = computeChildSpan(childKeys, computedPlan, roughMap, workingDays, dayWidth);
    if (!span) return;
    placed++;
    if (span.left < leftMin) leftMin = span.left;
    var right = span.left + span.width + 2;
    if (right > rightMax) rightMax = right;
  });
  if (placed === 0) return null;
  return {
    left: leftMin,
    width: Math.max(dayWidth, rightMax - leftMin) - 2,
    placedStories: placed,
    totalStories: stories.length,
  };
}

// ── saveEst — module-level to avoid TDZ ──────────────────────────────────────
// Called from the component's inline edit handler; setLocalRoughEst + setEditingEstKey
// are passed as arguments to keep this pure. Only updates local state — the value is
// persisted to Jira later, when the user clicks "Save to Jira" (see handleSave).
function saveEstFn(issueKey, value, setLocalRoughEst, setEditingEstKey, setDirtyEstKeys) {
  var hours = parseFloat(value);
  if (isNaN(hours) || hours < 0) return;
  setLocalRoughEst(function(prev) { return Object.assign({}, prev, { [issueKey]: hours }); });
  setDirtyEstKeys(function(prev) { var n = new Set(prev); n.add(issueKey); return n; });
  setEditingEstKey(null);
}

// ── Column resize handle — module-level, drives colWidths state via drag ────────
function ColResizer({ colKey, setColWidths, min }) {
  return (
    <div
      onMouseDown={e => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        let startWidth = 0;
        setColWidths(prev => { startWidth = prev[colKey]; return prev; });
        function onMove(ev) {
          const delta = ev.clientX - startX;
          setColWidths(prev => ({ ...prev, [colKey]: Math.max(min || 30, startWidth + delta) }));
        }
        function onUp() {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        }
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      }}
      onClick={e => e.stopPropagation()}
      style={{ position: 'absolute', right: -4, top: 0, bottom: 0, width: 8, cursor: 'col-resize', zIndex: 6 }}
    />
  );
}

// ── Sort value extraction — module-level, pure ───────────────────────────────
// roughMap = the TRUE total estimate (Total Est column); schedMap = whatever's actually
// used for scheduling duration (Draft mode: remaining estimate; everything else: same as
// roughMap) — 'days' sorts by schedMap so it matches what's rendered on the Gantt, while
// 'est'/'remaining' each sort by their own always-true value regardless of mode.
function getSortValue(row, col, roughMap, schedMap, computedPlan, rawRoughMap) {
  var f = row.fields || {};
  var entry = (computedPlan.issues && computedPlan.issues[row.key]) || {};
  switch (col) {
    case 'key': return row.key;
    case 'summary': return (f.summary || '').toLowerCase();
    case 'est': { var h = roughMap[row.key]; return h == null ? -Infinity : h; }
    case 'rough': { var rr = (rawRoughMap || {})[row.key]; return rr == null ? -Infinity : rr; }
    case 'remaining': { var rem = schedMap[row.key]; return rem == null ? -Infinity : rem; }
    case 'assigned': return (entry.assignedPlaceholders || []).length;
    case 'qa': return entry.qaHours || 0;
    case 'days': {
      var devs = entry.assignedPlaceholders?.length ? effectiveDevCount(entry.assignedPlaceholders, computedPlan.placeholders) : 0;
      var rh = schedMap[row.key];
      return rh && devs ? calcDays(rh, devs) : -Infinity;
    }
    default: return 0;
  }
}

// ── Critical path & summary helpers (module-level to avoid TDZ) ──────────────

function computeProjectSpan(computedPlan, roughMapArg) {
  var earliest = null, latest = null;
  Object.entries(computedPlan.issues || {}).forEach(function(entry) {
    var key = entry[0], e = entry[1];
    if (!e.startDate) return;
    var devs = effectiveDevCount(e.assignedPlaceholders, computedPlan.placeholders);
    var end = calcEndDate(e.startDate, roughMapArg[key], devs) || e.startDate;
    if (!earliest || e.startDate < earliest) earliest = e.startDate;
    if (!latest || end > latest) latest = end;
  });
  return { start: earliest, end: latest };
}

function computeUnscheduledItems(rows, computedPlan, roughMapArg) {
  return rows.filter(function(r) {
    return !r._isEpic && !(computedPlan.issues && computedPlan.issues[r.key] && computedPlan.issues[r.key].startDate);
  }).map(function(r) {
    return { key: r.key, hours: roughMapArg[r.key] || 0 };
  });
}

function computeCriticalPath(computedPlan, roughMapArg) {
  var issues = computedPlan.issues || {};
  var endDates = {};
  Object.entries(issues).forEach(function(entry) {
    var key = entry[0], e = entry[1];
    if (!e.startDate) return;
    var devs = effectiveDevCount(e.assignedPlaceholders, computedPlan.placeholders);
    endDates[key] = calcEndDate(e.startDate, roughMapArg[key], devs) || e.startDate;
  });
  var keys = Object.keys(endDates);
  if (!keys.length) return [];
  var projectEnd = keys.reduce(function(max, k) { return endDates[k] > max ? endDates[k] : max; }, '');
  var critical = new Set();
  function trace(key) {
    if (critical.has(key)) return;
    critical.add(key);
    var deps = (issues[key] && issues[key].dependencies) || [];
    var latest = null;
    deps.forEach(function(d) {
      if (endDates[d] && (!latest || endDates[d] >= endDates[latest])) latest = d;
    });
    if (latest) trace(latest);
  }
  keys.filter(function(k) { return endDates[k] === projectEnd; }).forEach(trace);
  return Array.from(critical);
}

function computeDevUtilization(computedPlan, roughMapArg) {
  var utils = {};
  var phById = {};
  (computedPlan.placeholders || []).forEach(function(p) { phById[p.id] = p; });
  Object.entries(computedPlan.issues || {}).forEach(function(entry) {
    var key = entry[0], e = entry[1];
    if (!e.startDate) return;
    var hours = roughMapArg[key] || 0;
    var phs = e.assignedPlaceholders || [];
    // Split hours proportionally to each assigned dev's capacity — a dev at 50%
    // capacity takes on proportionally less of the work than a full-time dev.
    var capSum = phs.reduce(function(s, id) {
      var ph = phById[id];
      var pct = ph && typeof ph.capacityPct === 'number' ? ph.capacityPct : 100;
      return s + pct;
    }, 0) || 1;
    phs.forEach(function(phId) {
      var ph = phById[phId];
      var pct = ph && typeof ph.capacityPct === 'number' ? ph.capacityPct : 100;
      if (!utils[phId]) utils[phId] = 0;
      utils[phId] += hours * (pct / capSum);
    });
  });
  return utils;
}

function workingDaysBetween(startStr, endStr) {
  if (!startStr || !endStr || startStr > endStr) return 0;
  var count = 0;
  var cur = parseISO(startStr);
  var end = parseISO(endStr);
  while (!isAfter(cur, end)) {
    if (!isWeekend(cur)) count++;
    cur = addDays(cur, 1);
  }
  return count;
}

// ── Summary panel content (rendered inside the right-hand side panel) ─────────
// Combines what used to be four separate always-visible banners (collapsible
// summary bar, missing-estimate warning, conflict list, draft-mode caption)
// into one panel opened on demand via the "📊 Summary" toolbar button.
function SummaryPanelContent({ computedPlan, roughMapArg, rows, conflicts, missingEstMap, estSource, planningMode, updateIssueEntry }) {
  var span = computeProjectSpan(computedPlan, roughMapArg);
  var unscheduled = computeUnscheduledItems(rows, computedPlan, roughMapArg);
  var critPath = computeCriticalPath(computedPlan, roughMapArg);
  var devUtils = computeDevUtilization(computedPlan, roughMapArg);
  var totalDays = workingDaysBetween(span.start, span.end);
  var unschHours = unscheduled.reduce(function(s, u) { return s + u.hours; }, 0);
  var placeholders = computedPlan.placeholders || [];
  var missingCount = Object.keys(missingEstMap || {}).length;
  var hasData = span.start || unscheduled.length > 0 || conflicts.length > 0 || missingCount > 0;

  if (!hasData && planningMode !== 'draft') {
    return <div style={{ padding: 16, fontSize: 12, color: '#97A0AF' }}>Nothing to report yet — schedule some work to see the summary here.</div>;
  }

  return (
    <div style={{ padding: 14, fontSize: 11 }}>
      {planningMode === 'draft' && (
        <div style={{ marginBottom: 10, padding: '6px 10px', background: '#EAE6FF', borderRadius: 4, color: '#403294' }}>
          <strong>Draft mode:</strong> Epics only · Duration = rough est ÷ devs · Assigning the same developer to multiple epics auto-creates dependencies
        </div>
      )}

      {/* Span */}
      {span.start && (
        <div style={{ marginBottom: 8, color: '#172B4D' }}>
          📅 <strong>{span.start}</strong> → <strong>{span.end}</strong>
          {totalDays > 0 && <span style={{ color: '#5E6C84' }}> · {totalDays} working days</span>}
        </div>
      )}

      {/* Unscheduled */}
      {unscheduled.length > 0 && (
        <div style={{ marginBottom: 8, color: '#974F0C' }}>
          ⚠ {unscheduled.length} stor{unscheduled.length === 1 ? 'y' : 'ies'} not yet scheduled
          {unschHours > 0 && <span> ({unschHours.toFixed(0)}h of work)</span>}
        </div>
      )}

      {/* Missing estimates */}
      {missingCount > 0 && (
        <div style={{ marginBottom: 8, color: '#974F0C' }}>
          ⚠ {missingCount} issue(s) have missing or incomplete estimates
          {estSource === 'children' ? ' (some tasks/subtasks have no Original Estimate)' : ' (Rough Estimation field not set)'}.
          Duration calculations for those rows may be inaccurate.
        </div>
      )}

      {/* Conflicts */}
      {conflicts.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ color: '#DE350B', fontWeight: 700, marginBottom: 4 }}>🔴 {conflicts.length} conflict{conflicts.length !== 1 ? 's' : ''}</div>
          {conflicts.map((c, i) => (
            <div key={i} style={{ color: '#974F0C', marginBottom: 3 }}>
              {c.placeholder.name}: {c.source} ↔ {c.target} overlap —
              <button onClick={() => {
                updateIssueEntry(c.target, {
                  dependencies: [...new Set([...(computedPlan.issues?.[c.target]?.dependencies || []), c.source])],
                });
              }} style={{ marginLeft: 4, fontSize: 10, border: '1px solid #FFD700', background: '#FFF0B3', borderRadius: 3, padding: '1px 6px', cursor: 'pointer', color: '#974F0C' }}>
                Auto-chain
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Critical path */}
      {critPath.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <span style={{ color: '#DE350B', fontWeight: 700 }}>🔴 Critical path</span>
          <div style={{ color: '#5E6C84', marginTop: 2 }}>
            {critPath.map(function(k) {
              var e = computedPlan.issues && computedPlan.issues[k];
              var devs = (e && e.assignedPlaceholders ? e.assignedPlaceholders.length : 0) || 1;
              var d = calcDays(roughMapArg[k], devs);
              return k + ' (' + d + 'd)';
            }).join(' → ')}
          </div>
          <div style={{ color: '#97A0AF', marginTop: 2 }}>— any delay here pushes the end date</div>
        </div>
      )}

      {/* Developer utilization */}
      {placeholders.length > 0 && Object.keys(devUtils).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 700, color: '#172B4D', marginBottom: 6 }}>Developer utilization</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {placeholders.map(function(ph) {
              var hours = devUtils[ph.id] || 0;
              var capacityPct = typeof ph.capacityPct === 'number' ? ph.capacityPct : 100;
              var cap = totalDays > 0 ? totalDays * HOURS_PER_DAY * (capacityPct / 100) : 1;
              var pct = Math.min(hours / cap, 1);
              var barColor = pct > 1 ? '#FF5630' : pct > 0.8 ? '#FF991F' : ph.color;
              return (
                <div key={ph.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontWeight: 600, color: ph.color, width: 70, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>{ph.name}{capacityPct < 100 ? ` (${capacityPct}%)` : ''}</span>
                  <div style={{ flex: 1, height: 6, background: '#DFE1E6', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: barColor, borderRadius: 3, width: (pct * 100) + '%' }} />
                  </div>
                  <span style={{ color: '#5E6C84', whiteSpace: 'nowrap', flexShrink: 0 }}>{hours.toFixed(0)}h</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Toolbar button that opens/closes a right-hand side panel tab ──────────────
function PanelToggleBtn({ icon, label, active, badge, badgeColor, onClick }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', fontSize: 11, fontWeight: 600,
      cursor: 'pointer', borderRadius: 4, border: `1.5px solid ${active ? '#0052CC' : '#DFE1E6'}`,
      background: active ? '#0052CC' : '#fff', color: active ? '#fff' : '#42526E',
    }}>
      <span>{icon}</span>
      <span>{label}</span>
      {!!badge && (
        <span style={{
          fontSize: 10, fontWeight: 700, borderRadius: 8, padding: '0 5px', minWidth: 15, textAlign: 'center',
          background: active ? 'rgba(255,255,255,0.25)' : (badgeColor || '#DE350B'), color: active ? '#fff' : '#fff',
        }}>{badge}</span>
      )}
    </button>
  );
}

// ── Right-hand side panel shell — one tab's content at a time ─────────────────
function SidePanel({ title, onClose, children }) {
  return (
    <div style={{ width: 340, flexShrink: 0, borderLeft: '1px solid #DFE1E6', background: '#fff', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid #DFE1E6', background: '#FAFBFC', flexShrink: 0 }}>
        <strong style={{ fontSize: 13, color: '#172B4D' }}>{title}</strong>
        <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#5E6C84', fontSize: 16, lineHeight: 1, padding: 2 }}>×</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {children}
      </div>
    </div>
  );
}

// ── Plan dialog modal (replaces window.prompt/confirm — blocked in Forge iframes) ─
function PlanDialogModal({ dialog, onClose, onCreate, onSaveAs, onRename, onDelete, onClear, onClearAllScheduling }) {
  var [nameValue, setNameValue] = React.useState(dialog.defaultName || '');
  var [busy, setBusy] = React.useState(false);
  var isNameType = dialog.type === 'new' || dialog.type === 'saveas' || dialog.type === 'rename';
  var isClearAllScheduling = dialog.type === 'clearAllScheduling';
  var titles = { new: 'New plan', saveas: 'Save plan as…', rename: 'Rename plan', delete: 'Delete plan', clear: 'Clear plan', clearAllScheduling: 'Clear all scheduling' };
  var labels = { new: 'Create', saveas: 'Save', rename: 'Rename', delete: 'Delete', clear: 'Clear' };
  var isDanger = dialog.type === 'delete' || dialog.type === 'clear';
  async function handleConfirm() {
    if (isNameType && !nameValue.trim()) return;
    setBusy(true);
    try {
      if (dialog.type === 'new') { await onCreate(nameValue.trim()); }
      else if (dialog.type === 'saveas') { await onSaveAs(nameValue.trim()); }
      else if (dialog.type === 'rename') { await onRename(nameValue.trim()); }
      else if (dialog.type === 'delete') { await onDelete(); }
      else if (dialog.type === 'clear') { await onClear(); }
    } catch (e) {
      // swallow error — always close the modal
    } finally {
      setBusy(false);
      onClose();
    }
  }
  async function handleClearAllScheduling(removeJiraDueDates) {
    setBusy(true);
    try {
      await onClearAllScheduling(removeJiraDueDates);
    } catch (e) {
      // swallow error — always close the modal
    } finally {
      setBusy(false);
      onClose();
    }
  }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(9,30,66,0.54)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={function(e) { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 8, padding: 24, width: isClearAllScheduling ? 380 : 320, boxShadow: '0 8px 32px rgba(0,0,0,0.22)' }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: '#172B4D', marginBottom: 14 }}>{titles[dialog.type]}</div>
        {isNameType && (
          <input autoFocus value={nameValue} onChange={function(e) { setNameValue(e.target.value); }}
            onKeyDown={function(e) { if (e.key === 'Enter') handleConfirm(); if (e.key === 'Escape') onClose(); }}
            placeholder="Plan name"
            style={{ width: '100%', padding: '8px 10px', border: '2px solid #DFE1E6', borderRadius: 4, fontSize: 13, outline: 'none', boxSizing: 'border-box', marginBottom: 16 }} />
        )}
        {!isNameType && !isClearAllScheduling && (
          <p style={{ fontSize: 13, color: '#5E6C84', marginBottom: 16 }}>
            {dialog.type === 'delete' ? 'This plan and all its data will be permanently deleted.' : 'All assignments, placeholders, and milestones will be cleared.'}
          </p>
        )}
        {isClearAllScheduling && (
          <p style={{ fontSize: 13, color: '#5E6C84', marginBottom: 16 }}>
            This clears every scheduled date in view. Do you also want to remove the matching due dates already saved on these issues in Jira?
          </p>
        )}
        {!isClearAllScheduling && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={onClose} style={{ padding: '6px 14px', borderRadius: 4, border: '1.5px solid #DFE1E6', background: '#F4F5F7', color: '#42526E', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
            <button onClick={handleConfirm} disabled={busy || (isNameType && !nameValue.trim())}
              style={{ padding: '6px 14px', borderRadius: 4, border: 'none', background: isDanger ? '#DE350B' : '#0052CC', color: '#fff', fontSize: 12, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', opacity: (isNameType && !nameValue.trim()) ? 0.5 : 1 }}>
              {busy ? '…' : labels[dialog.type]}
            </button>
          </div>
        )}
        {isClearAllScheduling && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={onClose} disabled={busy} style={{ padding: '6px 14px', borderRadius: 4, border: '1.5px solid #DFE1E6', background: '#F4F5F7', color: '#42526E', fontSize: 12, fontWeight: 600, cursor: busy ? 'wait' : 'pointer' }}>Cancel</button>
            <button onClick={() => handleClearAllScheduling(false)} disabled={busy} style={{ padding: '6px 14px', borderRadius: 4, border: '1.5px solid #FFD700', background: '#FFF0B3', color: '#974F0C', fontSize: 12, fontWeight: 600, cursor: busy ? 'wait' : 'pointer' }}>
              {busy ? '…' : 'Clear only'}
            </button>
            <button onClick={() => handleClearAllScheduling(true)} disabled={busy} style={{ padding: '6px 14px', borderRadius: 4, border: 'none', background: '#DE350B', color: '#fff', fontSize: 12, fontWeight: 600, cursor: busy ? 'wait' : 'pointer' }}>
              {busy ? '…' : 'Clear + remove Jira due dates'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Small reusable UI pieces ───────────────────────────────────────────────────
// `initials` turns the plain color dot into a labelled avatar (2-letter initials) — used for
// developer chips, where a bare dot made it hard to tell who's who at a glance.
function Chip({ label, color, onRemove, onClick, selected, initials }) {
  return (
    <span onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: selected ? color + '33' : '#F4F5F7',
      border: `1.5px solid ${selected ? color : '#DFE1E6'}`,
      borderRadius: 12, padding: '2px 8px 2px 4px',
      fontSize: 11, fontWeight: 600, cursor: onClick ? 'pointer' : 'default',
      color: selected ? color : '#42526E',
    }}>
      {initials ? (
        <span style={{
          width: 18, height: 18, borderRadius: '50%', background: color, flexShrink: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 8, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em',
        }}>{initials}</span>
      ) : (
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0, marginLeft: 2 }} />
      )}
      {label}
      {onRemove && (
        <span onClick={e => { e.stopPropagation(); onRemove(); }}
          style={{ marginLeft: 2, color: '#97A0AF', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>×</span>
      )}
    </span>
  );
}

// ── Delivery Report ───────────────────────────────────────────────────────────
function DeliveryReport({ computedPlan, roughMap, planName, mode, codeFreezeDate, finalDeliveryDate }) {
  var [open, setOpen] = React.useState(true);
  var [copied, setCopied] = React.useState(false);
  var span = computeProjectSpan(computedPlan, roughMap);
  var critPath = computeCriticalPath(computedPlan, roughMap);
  var devUtils = computeDevUtilization(computedPlan, roughMap);
  var milestones = (computedPlan.milestones || []).slice().sort(function(a, b) { return a.date.localeCompare(b.date); });
  var totalDays = workingDaysBetween(span.start, span.end);
  var placeholders = computedPlan.placeholders || [];
  if (!span.end) return null;

  var accentColor = mode === 'draft' ? '#6554C0' : '#0052CC';
  var accentLight = mode === 'draft' ? '#EAE6FF' : '#E9F2FF';
  var deliveryLabel = mode === 'draft' ? 'Draft Delivery' : 'Committed Delivery';

  function buildReportText() {
    var lines = [];
    lines.push('# ' + (mode === 'draft' ? 'Draft Delivery Estimate' : 'Final Delivery Report') + (planName ? ': ' + planName : ''));
    lines.push('');
    lines.push('| | |');
    lines.push('|---|---|');
    lines.push('| Start | ' + (span.start || '—') + ' |');
    lines.push('| Dev Complete | ' + (span.end || '—') + ' |');
    if (codeFreezeDate) lines.push('| Code Freeze | ' + codeFreezeDate + ' |');
    if (finalDeliveryDate) lines.push('| Final Delivery | ' + finalDeliveryDate + ' |');
    lines.push('| Duration | ' + totalDays + ' working days |');
    if (milestones.length > 0) {
      lines.push(''); lines.push('## Milestones');
      milestones.forEach(function(m) { lines.push('- **' + m.label + '** — ' + m.date); });
    }
    if (critPath.length > 0) {
      lines.push(''); lines.push('## Critical Path');
      lines.push(critPath.map(function(k) { var d = calcDays(roughMap[k], 1); return k + ' (' + d + 'd)'; }).join(' → '));
    }
    if (placeholders.length > 0) {
      lines.push(''); lines.push('## Team');
      placeholders.forEach(function(ph) {
        var h = devUtils[ph.id] || 0;
        var capacityPct = typeof ph.capacityPct === 'number' ? ph.capacityPct : 100;
        var cap = totalDays > 0 ? totalDays * HOURS_PER_DAY * (capacityPct / 100) : 1;
        var pct = Math.round(h / cap * 100);
        var label = capacityPct < 100 ? ph.name + ' (' + capacityPct + '%)' : ph.name;
        lines.push('- **' + label + '**: ' + h.toFixed(0) + 'h / ' + cap.toFixed(0) + 'h (' + pct + '%)');
      });
    }
    return lines.join('\n');
  }

  function handleCopy() {
    try {
      navigator.clipboard.writeText(buildReportText());
      setCopied(true);
      setTimeout(function() { setCopied(false); }, 2000);
    } catch (e) { /* clipboard unavailable */ }
  }

  return (
    <div style={{ background: open ? accentLight : '#F4F5F7', borderTop: '2px solid ' + accentColor, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <button onClick={function() { setOpen(function(o) { return !o; }); }}
          style={{ flex: 1, textAlign: 'left', padding: '8px 16px', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
          <span style={{ fontSize: 10, color: accentColor }}>{open ? '▼' : '▶'}</span>
          <span style={{ fontWeight: 800, color: accentColor, fontSize: 13 }}>
            {mode === 'final' ? '📋 Final Delivery Report' : '📋 Draft Delivery Estimate'}
          </span>
          <span style={{ background: accentColor, color: '#fff', borderRadius: 12, padding: '2px 10px', fontSize: 12, fontWeight: 700 }}>
            🚀 {span.end}
          </span>
          {planName && <span style={{ color: '#5E6C84', fontSize: 11 }}>— {planName}</span>}
          {totalDays > 0 && <span style={{ color: '#5E6C84', fontSize: 11 }}>· {totalDays} working days</span>}
        </button>
        <button onClick={handleCopy} title="Copy report as Markdown"
          style={{ margin: '0 12px', padding: '4px 12px', background: copied ? '#36B37E' : '#fff', color: copied ? '#fff' : accentColor, border: '1px solid ' + accentColor, borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: 'pointer', flexShrink: 0, transition: 'background 0.2s, color 0.2s' }}>
          {copied ? '✓ Copied' : '⎘ Copy'}
        </button>
      </div>

      {open && (
        <div style={{ padding: '0 16px 16px', fontSize: 12 }}>
          {/* Key date cards */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap', paddingTop: 4 }}>
            <div style={{ background: '#fff', borderRadius: 6, padding: '8px 16px', textAlign: 'center', minWidth: 110, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
              <div style={{ fontSize: 10, color: '#5E6C84', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>Start</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#172B4D' }}>{span.start || '—'}</div>
            </div>
            <div style={{ background: accentColor, borderRadius: 6, padding: '10px 20px', textAlign: 'center', minWidth: 150, boxShadow: '0 2px 8px rgba(0,0,0,0.18)' }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.8)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>{deliveryLabel}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#fff', lineHeight: 1 }}>{span.end}</div>
            </div>
            <div style={{ background: '#fff', borderRadius: 6, padding: '8px 16px', textAlign: 'center', minWidth: 80, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
              <div style={{ fontSize: 10, color: '#5E6C84', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>Duration</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#172B4D' }}>{totalDays}d</div>
            </div>
            {codeFreezeDate && (
              <div style={{ background: '#fff', borderRadius: 6, padding: '8px 16px', textAlign: 'center', minWidth: 130, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', borderTop: '3px solid #172B4D' }}>
                <div style={{ fontSize: 10, color: '#5E6C84', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>Code Freeze</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#172B4D' }}>{codeFreezeDate}</div>
              </div>
            )}
            {finalDeliveryDate && (
              <div style={{ background: '#36B37E', borderRadius: 6, padding: '10px 20px', textAlign: 'center', minWidth: 150, boxShadow: '0 2px 8px rgba(0,0,0,0.18)' }}>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.8)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>Final Delivery</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#fff', lineHeight: 1 }}>{finalDeliveryDate}</div>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            {/* Milestones */}
            {milestones.length > 0 && (
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 10, color: '#5E6C84', fontWeight: 700, textTransform: 'uppercase', marginBottom: 6 }}>Milestones</div>
                {milestones.map(function(m) {
                  var afterDelivery = span.end && m.date > span.end;
                  var beforeStart = span.start && m.date < span.start;
                  return (
                    <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                      <span style={{ width: 10, height: 10, borderRadius: '50%', background: m.color, flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, color: '#172B4D', fontSize: 11 }}>{m.label}</span>
                      <span style={{ color: '#5E6C84', fontSize: 11 }}>{m.date}</span>
                      {afterDelivery && <span style={{ fontSize: 10, color: '#FF991F', fontWeight: 700 }}>⚠ after delivery</span>}
                      {beforeStart && <span style={{ fontSize: 10, color: '#DE350B', fontWeight: 700 }}>⚠ before start</span>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Team utilization */}
            {placeholders.length > 0 && (
              <div style={{ flex: 1, minWidth: 210 }}>
                <div style={{ fontSize: 10, color: '#5E6C84', fontWeight: 700, textTransform: 'uppercase', marginBottom: 6 }}>Team Utilization</div>
                {placeholders.map(function(ph) {
                  var hours = devUtils[ph.id] || 0;
                  var capacityPct = typeof ph.capacityPct === 'number' ? ph.capacityPct : 100;
                  var cap = totalDays > 0 ? totalDays * HOURS_PER_DAY * (capacityPct / 100) : 1;
                  var pct = hours / cap;
                  var overloaded = pct > 1;
                  var barColor = overloaded ? '#FF5630' : pct > 0.8 ? '#FF991F' : ph.color;
                  return (
                    <div key={ph.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ width: 76, fontSize: 11, fontWeight: 600, color: ph.color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>{ph.name}{capacityPct < 100 ? ` (${capacityPct}%)` : ''}</span>
                      <div style={{ width: 90, height: 7, background: '#DFE1E6', borderRadius: 4, overflow: 'hidden', flexShrink: 0 }}>
                        <div style={{ height: '100%', background: barColor, width: Math.min(pct, 1) * 100 + '%', borderRadius: 4 }} />
                      </div>
                      <span style={{ fontSize: 10, color: overloaded ? '#FF5630' : '#5E6C84', whiteSpace: 'nowrap', fontWeight: overloaded ? 700 : 400 }}>
                        {hours.toFixed(0)}h / {cap.toFixed(0)}h {overloaded ? '⚠ over' : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Critical path */}
            {critPath.length > 0 && (
              <div style={{ flex: 2, minWidth: 200 }}>
                <div style={{ fontSize: 10, color: '#5E6C84', fontWeight: 700, textTransform: 'uppercase', marginBottom: 6 }}>Critical Path</div>
                <div style={{ fontSize: 11, color: '#5E6C84', lineHeight: 2 }}>
                  {critPath.map(function(k, i) {
                    var e = computedPlan.issues && computedPlan.issues[k];
                    var devs = (e && e.assignedPlaceholders ? e.assignedPlaceholders.length : 0) || 1;
                    var d = calcDays(roughMap[k], devs);
                    return (
                      <span key={k}>
                        <span style={{ fontWeight: 700, color: '#DE350B', background: '#FFF0B3', borderRadius: 3, padding: '0 4px' }}>{k}</span>
                        <span style={{ color: '#97A0AF' }}> ({d}d)</span>
                        {i < critPath.length - 1 && <span style={{ color: '#DFE1E6', margin: '0 4px' }}>→</span>}
                      </span>
                    );
                  })}
                </div>
                <div style={{ fontSize: 10, color: '#97A0AF', marginTop: 2 }}>Any delay on these issues extends the delivery date</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function VersionPlanningView({ projectKeys }) {
  const [selectedVersionId, setSelectedVersionId] = useState(null);
  const [roughEstFieldId, setRoughEstFieldId] = useState(null);
  const [startDateFieldId, setStartDateFieldId] = useState(null);
  const [estSource, setEstSource] = useState('rough'); // 'rough' | 'children'
  const [planningMode, setPlanningMode] = useState('draft'); // 'draft' | 'final' | 'epic'
  const [epicPlanKind, setEpicPlanKind] = useState('draft'); // Epic Timeline mode's own nested Draft/Final choice
  const [bugFixPct, setBugFixPct] = useState(20);      // % of dev time spent on bug fixes after QA
  const [bufferDays, setBufferDays] = useState(0);     // Epic Timeline mode: extra working days after each dependency ends
  const [autoDepByDev, setAutoDepByDev] = useState(true); // Draft mode: dropping an epic chains it behind the same dev's previous epic
  const [codeFreezeDays, setCodeFreezeDays] = useState(5);   // working days from last epic to code freeze
  const [stabilizationDays, setStabilizationDays] = useState(10); // working days of stabilization period
  const [planStart, setPlanStart] = useState(() => snapToWorkingDay(TODAY_STR));
  const [expandedEpics, setExpandedEpics] = useState(new Set());
  const [expandedStories, setExpandedStories] = useState(new Set()); // Epic Timeline mode: story -> subtasks
  const [focusEpicKey, setFocusEpicKey] = useState(null); // Epic Timeline mode: which epic is focused
  const [changelogCache, setChangelogCache] = useState({}); // issueKey -> { inProgressDate, readyDate } | { loading: true } | { error: true }
  const [autoScheduling, setAutoScheduling] = useState(false);
  const [focusDevId, setFocusDevId] = useState(null); // click a developer chip to show only their rows
  const [debugCopied, setDebugCopied] = useState(false);
  const [depsMode, setDepsMode] = useState(false);
  const [depsSource, setDepsSource] = useState(null);
  const [depNote, setDepNote] = useState(null); // transient feedback for reverse/remove dependency actions
  const [refreshNote, setRefreshNote] = useState(null); // transient feedback after "Refresh from Jira"
  const [refreshing, setRefreshing] = useState(false);
  const [shareNote, setShareNote] = useState(null); // transient feedback after "Share"
  const [editingMilestone, setEditingMilestone] = useState(null);
  const [saveStatus, setSaveStatus] = useState(null);
  const [newPhName, setNewPhName] = useState('');
  const [editingPhId, setEditingPhId] = useState(null);
  const [editingPhValue, setEditingPhValue] = useState('');
  const [updateDueDates, setUpdateDueDates] = useState(true);
  const [detailIssueKey, setDetailIssueKey] = useState(null);
  const [editingEstKey, setEditingEstKey] = useState(null);
  const [editingEstValue, setEditingEstValue] = useState('');
  const [localRoughEst, setLocalRoughEst] = useState({});
  const [dirtyEstKeys, setDirtyEstKeys] = useState(new Set());
  const [colWidths, setColWidths] = useState({ key: 140, summary: 114, est: 52, rough: 52, remaining: 60, assigned: 90, qa: 44, days: 40 });
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [autoSaveStatus, setAutoSaveStatus] = useState(null);
  const [maximized, setMaximized] = useState(false); // fullscreen-overlay the timeline panel
  const [selectedPlanId, setSelectedPlanId] = useState(null);
  const [planDialog, setPlanDialog] = useState(null);
  const [activePanel, setActivePanel] = useState(null); // null | 'summary' | 'settings' | 'team' | 'tools' | 'debug'
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const saveTimerRef = useRef(null);
  const initialLoadRef = useRef(false);
  const creatingFinalRef = useRef(false); // guards against double-creating the reserved Final plan
  const settingsSyncedForPlanRef = useRef(null); // which selectedPlanId the estSource/bugFixPct/etc state was last loaded from
  const skipNextSettingsWriteRef = useRef(false); // true right after syncing FROM a loaded plan, so that sync doesn't immediately write back

  const { epics, storiesByEpic, subtasksByStory, versions, loading: issuesLoading, error: issuesError, refetch: refetchHierarchy } = useEpicHierarchy(projectKeys, selectedVersionId);

  // Epics/stories are only fetched once on load — new epics added to (or removed from) this
  // version in Jira since then otherwise need a full page reload to show up. The hook's own
  // diff is computed on the raw whole-project fetch, before the version filter runs here — so
  // it only catches an epic vanishing from the project entirely, not one just untagged from
  // THIS version. Snapshot the current (already version-scoped) `epics` before refetching and
  // diff against the freshly filtered list once the refetch's state settles instead.
  const preRefreshEpicKeysRef = useRef(null);
  function refreshFromJira() {
    preRefreshEpicKeysRef.current = new Set(epics.map(e => e.key));
    setRefreshing(true);
    refetchHierarchy().finally(() => setRefreshing(false));
  }
  useEffect(() => {
    if (refreshing || !preRefreshEpicKeysRef.current) return;
    const prevKeys = preRefreshEpicKeysRef.current;
    preRefreshEpicKeysRef.current = null;
    const newKeys = new Set(epics.map(e => e.key));
    const added = [...newKeys].filter(k => !prevKeys.has(k));
    const removed = [...prevKeys].filter(k => !newKeys.has(k));
    if (!added.length && !removed.length) {
      setRefreshNote('✓ Up to date — no epic changes in this version');
    } else {
      const parts = [];
      if (added.length) parts.push(`+${added.length} new (${added.join(', ')})`);
      if (removed.length) parts.push(`−${removed.length} no longer in version (${removed.join(', ')})`);
      setRefreshNote(parts.join(' · '));
    }
  }, [refreshing, epics]);
  useEffect(() => {
    if (!refreshNote) return;
    const t = setTimeout(() => setRefreshNote(null), 8000);
    return () => clearTimeout(t);
  }, [refreshNote]);
  useEffect(() => {
    if (!shareNote) return;
    const t = setTimeout(() => setShareNote(null), 6000);
    return () => clearTimeout(t);
  }, [shareNote]);
  const { sprints, error: sprintsError } = useSprints(projectKeys);
  useEffect(() => {
    if (sprintsError) {
      // eslint-disable-next-line no-console
      console.warn('[planJira] Failed to load sprints:', sprintsError);
    }
  }, [sprintsError]);

  // Unreleased/unarchived versions, ordered (natural/numeric sort so "3.2.0" sorts after
  // "3.10.0" the way it should, not lexically) — used by every version <select> below.
  const selectableVersions = useMemo(() => {
    return versions
      .filter(v => !v.released && !v.archived)
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' }));
  }, [versions]);

  // Epic Timeline mode: narrow the hierarchy fed into the estimate/missing-estimate maps
  // down to just the focused epic — mirrors the storiesByEpic[focusEpicKey] narrowing
  // already used for `rows` and the epic-focused effects below. Without this, estimate
  // computations ran over the whole version's hierarchy even while only one epic is on
  // screen. Draft/Final modes get a pure passthrough (same object identities).
  const epicScopedHierarchy = useMemo(() => {
    if (planningMode !== 'epic' || !focusEpicKey) {
      return { epics, storiesByEpic, subtasksByStory };
    }
    const epic = epics.find(e => e.key === focusEpicKey);
    const scopedStories = storiesByEpic[focusEpicKey] || [];
    const scopedSubtasks = {};
    for (const story of scopedStories) {
      scopedSubtasks[story.key] = subtasksByStory[story.key] || [];
    }
    return {
      epics: epic ? [epic] : [],
      storiesByEpic: { [focusEpicKey]: scopedStories },
      subtasksByStory: scopedSubtasks,
    };
  }, [planningMode, focusEpicKey, epics, storiesByEpic, subtasksByStory]);
  const {
    plan, loading: planLoading, saving, planIndex, indexLoading,
    updateIssueEntry, updatePlan, addPlaceholder, removePlaceholder, renamePlaceholder, recolorPlaceholders,
    ensurePlaceholderForAssignee, setPlaceholderCapacity, pruneUnusedPlaceholders, resetDismissedAssignees,
    addMilestone, removeMilestone, clearPlan, savePlanToStorage,
    createPlan, renamePlanInIndex, deletePlanFromIndex,
  } = useVersionPlan(projectKeys[0] || null, selectedVersionId, selectedPlanId);

  useEffect(() => { resolveRoughEstField().then(setRoughEstFieldId); }, []);
  useEffect(() => { resolveStartDateField().then(setStartDateFieldId).catch(() => {}); }, []);

  // Every issue in scope, by key — so placement can read an issue's raw Jira date fields
  // without depending on it being one of the currently-visible rows.
  const issueByKey = useMemo(() => {
    const m = {};
    const all = [].concat(
      epicScopedHierarchy.epics,
      Object.values(epicScopedHierarchy.storiesByEpic).flat(),
      Object.values(epicScopedHierarchy.subtasksByStory).flat()
    );
    all.forEach(i => { if (i && i.key) m[i.key] = i; });
    return m;
  }, [epicScopedHierarchy]);

  // Reset the focused epic when the version changes, since epics are version-scoped
  useEffect(() => { setFocusEpicKey(null); setExpandedStories(new Set()); }, [selectedVersionId]);

  // "Final" context: top-level Final mode, or Epic Timeline's own nested Final choice.
  // There's exactly one reserved, auto-created plan per scope — no picker, no naming,
  // always saved straight to Jira. Everything else ("Draft") keeps the normal
  // multi-plan picker (New/Save as/Rename/Delete), with the reserved Final plan(s)
  // filtered out of that list so they can never be renamed/deleted by accident.
  const isFinalContext = planningMode === 'final' || (planningMode === 'epic' && epicPlanKind === 'final');
  const finalTargetName = planningMode === 'epic' ? finalPlanName(focusEpicKey) : FINAL_PLAN_NAME;
  const draftPlanIndex = useMemo(() => planIndex.filter(p => !isReservedFinalPlanName(p.name)), [planIndex]);

  // Auto-select (or auto-create) the right plan whenever version/mode/epic changes.
  useEffect(() => {
    if (!selectedVersionId) { setSelectedPlanId(null); initialLoadRef.current = false; return; }
    if (indexLoading) return;
    if (isFinalContext) {
      if (planningMode === 'epic' && !focusEpicKey) return; // wait for an epic to be chosen
      const existing = planIndex.find(p => p.name === finalTargetName);
      if (existing) {
        if (selectedPlanId !== existing.id) setSelectedPlanId(existing.id);
      } else if (!creatingFinalRef.current) {
        creatingFinalRef.current = true;
        createPlan(finalTargetName).then(newId => { creatingFinalRef.current = false; setSelectedPlanId(newId); });
      }
      return;
    }
    if (selectedPlanId && draftPlanIndex.some(p => p.id === selectedPlanId)) return;
    setSelectedPlanId(draftPlanIndex.length > 0 ? draftPlanIndex[0].id : null);
  }, [selectedVersionId, planIndex, indexLoading, isFinalContext, finalTargetName, planningMode, focusEpicKey, draftPlanIndex, selectedPlanId, createPlan]);

  // Final mode always writes due dates back to Jira — no opt-out.
  useEffect(() => { if (isFinalContext) setUpdateDueDates(true); }, [isFinalContext]);

  // Reset initialLoadRef when plan changes (new plan loaded)
  useEffect(() => { initialLoadRef.current = false; }, [selectedPlanId]);

  // Auto-save: debounced 1.5s after any plan change, skip the initial load
  useEffect(() => {
    if (!selectedVersionId || !selectedPlanId) return;
    if (!initialLoadRef.current) { initialLoadRef.current = true; return; } // skip initial load
    setAutoSaveStatus('pending');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(function() {
      setAutoSaveStatus('saving');
      savePlanToStorage(plan).then(function() {
        setAutoSaveStatus('saved');
        setTimeout(function() { setAutoSaveStatus(null); }, 2500);
      }).catch(function() { setAutoSaveStatus('error'); });
    }, 1500);
    return function() { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [plan, selectedVersionId]);

  // estSource/bugFixPct/bufferDays/autoDepByDev/codeFreezeDays/stabilizationDays used to be
  // plain component state with hardcoded defaults and were never persisted — every reload or
  // plan switch silently reset them, which read as "settings aren't being saved." They're now
  // read from (and written into) plan.settings, riding the existing autosave above. On a plan
  // switch, load them back out of the freshly-fetched plan once (not on every plan mutation,
  // or a user's own edit would immediately get overwritten by a stale closure).
  useEffect(() => {
    if (!selectedPlanId || planLoading) return;
    if (settingsSyncedForPlanRef.current === selectedPlanId) return;
    const s = plan.settings || {};
    setEstSource(s.estSource || 'rough');
    setBugFixPct(typeof s.bugFixPct === 'number' ? s.bugFixPct : 20);
    setBufferDays(typeof s.bufferDays === 'number' ? s.bufferDays : 0);
    setAutoDepByDev(typeof s.autoDepByDev === 'boolean' ? s.autoDepByDev : true);
    setCodeFreezeDays(typeof s.codeFreezeDays === 'number' ? s.codeFreezeDays : 5);
    setStabilizationDays(typeof s.stabilizationDays === 'number' ? s.stabilizationDays : 10);
    settingsSyncedForPlanRef.current = selectedPlanId;
    skipNextSettingsWriteRef.current = true;
  }, [selectedPlanId, planLoading, plan.settings]);

  useEffect(() => {
    if (skipNextSettingsWriteRef.current) { skipNextSettingsWriteRef.current = false; return; }
    if (!selectedPlanId || settingsSyncedForPlanRef.current !== selectedPlanId) return;
    updatePlan(prev => ({
      ...prev,
      settings: { ...prev.settings, estSource, bugFixPct, bufferDays, autoDepByDev, codeFreezeDays, stabilizationDays },
    }));
  }, [estSource, bugFixPct, bufferDays, autoDepByDev, codeFreezeDays, stabilizationDays]);

  // Build rough estimate map and missing-estimate map using module-level functions
  const roughMap = useMemo(
    () => Object.assign(
      {},
      buildRoughMap(estSource, epicScopedHierarchy.epics, epicScopedHierarchy.storiesByEpic, epicScopedHierarchy.subtasksByStory, roughEstFieldId),
      localRoughEst
    ),
    [estSource, epicScopedHierarchy, roughEstFieldId, localRoughEst]
  );

  const missingEstMap = useMemo(
    () => buildMissingEstMap(epicScopedHierarchy.epics, epicScopedHierarchy.storiesByEpic, epicScopedHierarchy.subtasksByStory, roughMap),
    [epicScopedHierarchy, roughMap]
  );

  // Draft mode: an epic's REMAINING dev estimate (total minus already-dev-done children) —
  // shown as its own column and used for scheduling duration instead of the full total, so
  // dragging an epic that's mostly dev-done doesn't block the timeline for its full original
  // size. schedMap is what every DURATION calculation should read from; it's identical to
  // roughMap in Final/Epic Timeline modes (this feature only applies to Draft mode's
  // epic-level scheduling) and for any non-epic row even within Draft mode.
  const remainingEstMap = useMemo(
    () => buildEpicRollupMap(epicScopedHierarchy.epics, epicScopedHierarchy.storiesByEpic, roughMap, isDevDoneStatus),
    [epicScopedHierarchy, roughMap]
  );
  const schedMap = planningMode === 'draft' ? remainingEstMap : roughMap;

  // Base hours for the QA/BUG-FIX BUFFER — excludes only genuinely Done children, so work
  // that's dev-complete but still awaiting QA sign-off (In Review / Ready for Testing /
  // Ready for Deployment) keeps its rework budget reserved. Must NOT use schedMap: that
  // strips every dev-done child, which silently zeroed the bug-fix days for exactly the
  // epics most likely to still generate bugs.
  const bugFixBaseMap = useMemo(
    () => buildBugFixBaseMap(epicScopedHierarchy.epics, epicScopedHierarchy.storiesByEpic, roughMap),
    [epicScopedHierarchy, roughMap]
  );
  const qaBaseMap = planningMode === 'draft' ? bugFixBaseMap : roughMap;

  // Dependency action feedback clears itself — it's a confirmation, not a persistent banner.
  useEffect(() => {
    if (!depNote) return;
    const t = setTimeout(() => setDepNote(null), 6000);
    return () => clearTimeout(t);
  }, [depNote]);

  // How many issues each dev is assigned to — shown next to their chip so it's obvious who
  // is actually carrying work vs. who was auto-detected from Jira and can be pruned.
  const assignedCountByDev = useMemo(() => {
    const counts = {};
    for (const e of Object.values(plan.issues || {})) {
      for (const id of (e.assignedPlaceholders || [])) counts[id] = (counts[id] || 0) + 1;
    }
    return counts;
  }, [plan.issues]);

  // The RAW Rough Estimation field per issue, independent of the Estimate-source toggle and
  // of every rollup/inheritance fallback — so the "Rough" column always shows the number
  // actually stored in Jira (or the pending inline edit), making it possible to compare it
  // against the Children Sum instead of only seeing whichever one estSource selected.
  const rawRoughMap = useMemo(() => {
    const m = {};
    const all = [].concat(
      epicScopedHierarchy.epics,
      Object.values(epicScopedHierarchy.storiesByEpic).flat(),
      Object.values(epicScopedHierarchy.subtasksByStory).flat()
    );
    all.forEach(i => { const v = ownEstHours(i, 'rough', roughEstFieldId); if (v > 0) m[i.key] = v; });
    return Object.assign(m, localRoughEst);
  }, [epicScopedHierarchy, roughEstFieldId, localRoughEst]);

  const estCoverageMap = useMemo(
    () => buildEstCoverageMap(epicScopedHierarchy.epics, epicScopedHierarchy.storiesByEpic, epicScopedHierarchy.subtasksByStory, estSource, roughEstFieldId),
    [epicScopedHierarchy, estSource, roughEstFieldId]
  );

  // QA hours per issue (sourced from plan.issues[key].qaHours)
  const qaMap = useMemo(() => {
    const m = {};
    for (const [key, entry] of Object.entries(plan.issues || {})) {
      if (entry.qaHours) m[key] = entry.qaHours;
    }
    return m;
  }, [plan.issues]);

  // Draft mode passes QA/bugfix context so cascadePlan uses effective end dates for dependency chaining
  const draftOpts = useMemo(() => {
    if (planningMode === 'draft') return { qaMap, bugFixPct, bugFixBaseMap: qaBaseMap };
    if (planningMode === 'epic') return { bufferDays };
    return {};
  }, [planningMode, qaMap, bugFixPct, bufferDays, qaBaseMap]);

  const computedPlan = useMemo(() => cascadePlan(plan, schedMap, draftOpts), [plan, schedMap, draftOpts]);

  // Epic Timeline mode: exclude container stories (their own stored dates are vestigial —
  // getBarProps always overrides them from their subtasks) from conflict detection, so a
  // parent never gets falsely flagged as "overlapping" its own children. Also don't flag a
  // conflict between two issues that BOTH have real, immutable Jira-history dates — nothing
  // about scheduling can fix two facts that already overlapped in reality.
  const conflictOpts = useMemo(() => {
    if (planningMode !== 'epic') return draftOpts;
    const containerKeys = (storiesByEpic[focusEpicKey] || [])
      .filter(story => (subtasksByStory[story.key] || []).length > 0)
      .map(story => story.key);
    return { ...draftOpts, excludeKeys: containerKeys, skipLockedPairs: true };
  }, [planningMode, draftOpts, storiesByEpic, subtasksByStory, focusEpicKey]);

  const conflicts = useMemo(() => detectConflicts(computedPlan, schedMap, conflictOpts), [computedPlan, schedMap, conflictOpts]);

  const conflictingKeys = useMemo(function() {
    var s = new Set();
    conflicts.forEach(function(c) { s.add(c.source); s.add(c.target); });
    return s;
  }, [conflicts]);

  // Critical path keys — placed after conflictingKeys to avoid TDZ
  const criticalPathKeys = useMemo(function() {
    return new Set(computeCriticalPath(computedPlan, schedMap));
  }, [computedPlan, schedMap]);


  const rows = useMemo(() => {
    if (planningMode === 'epic') {
      const epic = epics.find(e => e.key === focusEpicKey);
      if (!epic) return [];
      const result = [{ ...epic, _isEpic: true }];
      for (const story of (storiesByEpic[epic.key] || [])) {
        result.push({ ...story, _isEpic: false, _isStory: true });
        if (expandedStories.has(story.key)) {
          for (const sub of (subtasksByStory[story.key] || [])) {
            result.push({ ...sub, _isEpic: false, _isStory: false, _isSubtask: true });
          }
        }
      }
      return result;
    }
    // Draft AND Final both list epics with their child stories under an expandable caret.
    // They differ in how each SAVES (Draft keeps many named plans, Final is one committed
    // plan written straight to Jira) and in what the epic's own bar means (Draft schedules at
    // epic level with QA/Fix extensions; Final derives a summary bar from its placed stories)
    // — not in the row hierarchy, so the same shape is built for both.
    const result = [];
    for (const epic of epics) {
      result.push({ ...epic, _isEpic: true });
      if (expandedEpics.has(epic.key)) {
        for (const story of (storiesByEpic[epic.key] || [])) {
          result.push({ ...story, _isEpic: false, _isStory: true });
        }
      }
    }
    return result;
  }, [planningMode, epics, storiesByEpic, subtasksByStory, expandedEpics, focusEpicKey, expandedStories]);

  // Click a developer chip to show only their rows — keeps epic rows (context) and any
  // story whose subtasks include the focused dev (so a filtered subtask still has its
  // parent row above it), even if the story itself isn't directly assigned that dev.
  const filteredRows = useMemo(() => {
    if (!focusDevId) return rows;
    return rows.filter(row => {
      if (row._isEpic) return true;
      const entry = computedPlan.issues?.[row.key];
      if ((entry?.assignedPlaceholders || []).includes(focusDevId)) return true;
      if (row._isStory) {
        return (subtasksByStory[row.key] || []).some(
          s => (computedPlan.issues?.[s.key]?.assignedPlaceholders || []).includes(focusDevId)
        );
      }
      return false;
    });
  }, [rows, focusDevId, computedPlan.issues, subtasksByStory]);

  // Epic Timeline mode: auto-assign the dev placeholder from the issue's Jira assignee
  // wherever it hasn't been assigned yet (manual assignment is never overridden). Runs
  // over the whole focused epic's stories + subtasks, not just the currently expanded ones.
  useEffect(() => {
    if (planningMode !== 'epic' || !focusEpicKey) return;
    for (const story of (storiesByEpic[focusEpicKey] || [])) {
      const storyEntry = plan.issues[story.key];
      if (!isIgnoredStatus(story) && (!storyEntry || !(storyEntry.assignedPlaceholders || []).length)) {
        const assignee = story.fields?.assignee;
        if (assignee?.accountId) {
          const phId = ensurePlaceholderForAssignee(assignee.accountId, assignee.displayName);
          if (phId) updateIssueEntry(story.key, { assignedPlaceholders: [phId] });
        }
      }
      for (const sub of (subtasksByStory[story.key] || [])) {
        if (isIgnoredStatus(sub)) continue;
        const subEntry = plan.issues[sub.key];
        if (subEntry && (subEntry.assignedPlaceholders || []).length) continue;
        const ownAssignee = sub.fields?.assignee;
        const assignee = ownAssignee || story.fields?.assignee;
        if (assignee?.accountId) {
          const phId = ensurePlaceholderForAssignee(assignee.accountId, assignee.displayName);
          if (phId) updateIssueEntry(sub.key, { assignedPlaceholders: [phId], borrowedFromParent: !ownAssignee });
        }
      }
    }
  }, [planningMode, focusEpicKey, storiesByEpic, subtasksByStory, plan.issues]);

  // Draft mode: an epic's dev roster is the UNION of its own Jira assignee and every
  // assignee across its child stories — since an epic is scheduled as one block here, all
  // the people actually working on it should show as its assigned devs (and their combined
  // capacity then drives its duration). Only fills in epics with nothing assigned yet, so a
  // manual assignment is never overridden. Ignored-status children don't contribute.
  useEffect(() => {
    if (planningMode !== 'draft') return;
    for (const epic of epics) {
      const epicEntry = plan.issues[epic.key];
      if (epicEntry && (epicEntry.assignedPlaceholders || []).length) continue;
      const accounts = new Map(); // accountId → displayName (dedupes an assignee on several children)
      const epicAssignee = epic.fields?.assignee;
      if (epicAssignee?.accountId) accounts.set(epicAssignee.accountId, epicAssignee.displayName);
      for (const story of (storiesByEpic[epic.key] || [])) {
        if (isIgnoredStatus(story)) continue;
        const a = story.fields?.assignee;
        if (a?.accountId) accounts.set(a.accountId, a.displayName);
      }
      if (!accounts.size) continue;
      const phIds = [];
      for (const [accountId, displayName] of accounts) {
        const phId = ensurePlaceholderForAssignee(accountId, displayName);
        if (phId) phIds.push(phId);
      }
      if (phIds.length) updateIssueEntry(epic.key, { assignedPlaceholders: phIds });
    }
  }, [planningMode, epics, storiesByEpic, plan.issues]);

  // Epic Timeline mode: issues that have moved past "not started" (anything other than
  // Reopened/To Do/Blocked, and not Known Issue/Removed which are ignored entirely) get
  // their timeline auto-derived from real Jira status history instead of a rough-estimate
  // projection — start = when it entered In Progress, end = when it entered In Review.
  // Never overrides an already-placed issue, and each issue's changelog is fetched at
  // most once (cached in changelogCache).
  useEffect(() => {
    if (planningMode !== 'epic' || !focusEpicKey) return;
    const candidates = [];
    for (const story of (storiesByEpic[focusEpicKey] || [])) {
      candidates.push(story);
      for (const sub of (subtasksByStory[story.key] || [])) candidates.push(sub);
    }
    candidates.forEach(issue => {
      const statusName = normalizeStatusName(issue.fields?.status?.name);
      if (NOT_STARTED_STATUSES.includes(statusName) || IGNORED_STATUSES.includes(statusName)) return;
      if (changelogCache[issue.key]) return;
      // Only skip if this issue's date was previously confirmed against real Jira
      // history (`historyResolved`) — NOT merely because it already has SOME startDate.
      // Older/manually-set dates predating this check must still get corrected.
      if (plan.issues[issue.key]?.historyResolved) return;
      setChangelogCache(prev => ({ ...prev, [issue.key]: { loading: true } }));
      getIssueChangelog(issue.key).then(histories => {
        const { inProgressDate, readyDate } = extractStatusDates(histories);
        setChangelogCache(prev => ({ ...prev, [issue.key]: { inProgressDate, readyDate } }));
        const patch = { historyResolved: true, dependencies: [] };
        if (inProgressDate) {
          patch.startDate = inProgressDate.slice(0, 10);
          if (readyDate) patch.actualEndDate = readyDate.slice(0, 10);
        }
        updateIssueEntry(issue.key, patch);
      }).catch(() => {
        setChangelogCache(prev => ({ ...prev, [issue.key]: { error: true } }));
      });
    });
  }, [planningMode, focusEpicKey, storiesByEpic, subtasksByStory, plan.issues, changelogCache]);

  // Sortable table — in Final mode, epics are sorted as groups and each epic's
  // (expanded) child stories are sorted among themselves, preserving the hierarchy.
  const sortedRows = useMemo(() => {
    if (!sortCol) return filteredRows;
    function cmp(a, b) {
      var va = getSortValue(a, sortCol, roughMap, schedMap, computedPlan, rawRoughMap);
      var vb = getSortValue(b, sortCol, roughMap, schedMap, computedPlan, rawRoughMap);
      var result = (typeof va === 'string' || typeof vb === 'string')
        ? String(va).localeCompare(String(vb))
        : va - vb;
      return sortDir === 'asc' ? result : -result;
    }
    // Draft used to be a flat epics-only list and could sort flat; now that it carries child
    // stories it must use the same epic-grouped sort as Final, or sorting would interleave
    // stories with unrelated epics and destroy the hierarchy.
    if (planningMode === 'epic') {
      if (filteredRows.length === 0) return filteredRows;
      var epicRow = filteredRows[0];
      var storyGroups = [];
      var scur = null;
      for (var i = 1; i < filteredRows.length; i++) {
        var r2 = filteredRows[i];
        if (r2._isStory) { scur = { story: r2, children: [] }; storyGroups.push(scur); }
        else if (scur) scur.children.push(r2);
      }
      storyGroups.sort(function(ga, gb) { return cmp(ga.story, gb.story); });
      var eout = [epicRow];
      storyGroups.forEach(function(g) {
        eout.push(g.story);
        g.children.sort(cmp);
        eout.push.apply(eout, g.children);
      });
      return eout;
    }
    var groups = [];
    var current = null;
    filteredRows.forEach(function(r) {
      if (r._isEpic) { current = { epic: r, children: [] }; groups.push(current); }
      else if (current) current.children.push(r);
    });
    groups.sort(function(ga, gb) { return cmp(ga.epic, gb.epic); });
    var out = [];
    groups.forEach(function(g) {
      out.push(g.epic);
      g.children.sort(cmp);
      out.push.apply(out, g.children);
    });
    return out;
  }, [filteredRows, sortCol, sortDir, roughMap, schedMap, rawRoughMap, computedPlan, planningMode]);

  function handleSort(col) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }

  function sortIndicator(col) {
    if (sortCol !== col) return null;
    return <span style={{ marginLeft: 3, fontSize: 8 }}>{sortDir === 'asc' ? '▲' : '▼'}</span>;
  }

  const totalLeftWidth = colWidths.key + colWidths.summary + colWidths.est + colWidths.rough + colWidths.assigned
    + (planningMode === 'draft' ? colWidths.qa + colWidths.remaining : 0) + colWidths.days;

  // The window must also reach backward to cover any issue already dated before planStart
  // (e.g. real Jira status-history dates for work that started in the past) — otherwise
  // those bars fall outside `workingDays` entirely and silently fail to render/scroll to.
  const windowStart = useMemo(() => {
    let earliest = planStart;
    for (const entry of Object.values(computedPlan.issues || {})) {
      if (entry.startDate && entry.startDate < earliest) earliest = entry.startDate;
    }
    return earliest;
  }, [planStart, computedPlan.issues]);

  // Extend window to cover code freeze + stabilization period beyond the last epic
  const workingDays = useMemo(() => {
    const backDays = windowStart < planStart ? workingDaysBetween(windowStart, planStart) - 1 : 0;
    return buildWorkingDays(windowStart, backDays + 150 + codeFreezeDays + stabilizationDays);
  }, [windowStart, planStart, codeFreezeDays, stabilizationDays]);

  // Measure the visible timeline panel so we can auto-shrink day width to fit — the
  // window itself is deliberately padded far wider than any realistic schedule, so
  // fitting to workingDays.length would make every bar illegibly thin for no reason.
  const [panelWidth, setPanelWidth] = useState(0);
  useEffect(() => {
    if (!rightRef.current) return;
    const el = rightRef.current;
    const update = () => setPanelWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Day-index (not pixel) span actually covered by scheduled/placed rows in the current view.
  const scheduledIndexRange = useMemo(() => {
    let minIdx = Infinity, maxIdx = -Infinity;
    for (const row of rows) {
      const entry = computedPlan.issues?.[row.key];
      if (!entry?.startDate) continue;
      const startIdx = workingDays.indexOf(snapToWorkingDay(entry.startDate));
      if (startIdx < 0) continue;
      let endIdx = startIdx;
      if (entry.actualEndDate) {
        const ei = workingDays.indexOf(snapToWorkingDay(entry.actualEndDate));
        if (ei > startIdx) endIdx = ei;
      } else {
        const devs = effectiveDevCount(entry.assignedPlaceholders, computedPlan.placeholders);
        endIdx = startIdx + calcDays(schedMap[row.key], devs) - 1;
      }
      if (startIdx < minIdx) minIdx = startIdx;
      if (endIdx > maxIdx) maxIdx = endIdx;
    }
    return maxIdx >= minIdx ? { minIdx, maxIdx } : null;
  }, [rows, computedPlan.issues, schedMap, workingDays]);

  // Auto-zoom: shrink day width so the whole scheduled span fits the panel without
  // horizontal scrolling. Never grows past BASE_DAY_WIDTH, never shrinks past MIN_DAY_WIDTH.
  const DAY_WIDTH = useMemo(() => {
    if (!scheduledIndexRange || panelWidth <= 0) return BASE_DAY_WIDTH;
    const spanDays = scheduledIndexRange.maxIdx - scheduledIndexRange.minIdx + 3; // small padding
    const requiredWidth = spanDays * BASE_DAY_WIDTH;
    if (requiredWidth <= panelWidth) return BASE_DAY_WIDTH;
    return Math.max(MIN_DAY_WIDTH, Math.floor(panelWidth / spanDays));
  }, [scheduledIndexRange, panelWidth]);

  const totalTimelineWidth = workingDays.length * DAY_WIDTH;

  // Auto-computed draft-mode phase dates (code freeze + stabilization)
  const lastEffectiveEnd = useMemo(() => {
    if (planningMode !== 'draft') return null;
    let latest = null;
    for (const [key, entry] of Object.entries(computedPlan.issues || {})) {
      if (!entry.startDate) continue;
      const devs = effectiveDevCount(entry.assignedPlaceholders, computedPlan.placeholders);
      const devEnd = calcEndDate(entry.startDate, schedMap[key], devs);
      if (!devEnd) continue;
      const { totalExtra } = calcQaBugFixDays(qaBaseMap[key], devs, qaMap[key] || 0, bugFixPct);
      const effEnd = totalExtra > 0 ? addWorkingDays(devEnd, totalExtra) : devEnd;
      if (!latest || effEnd > latest) latest = effEnd;
    }
    return latest;
  }, [planningMode, computedPlan.issues, schedMap, qaMap, bugFixPct]);

  const codeFreezeDate = useMemo(() => {
    if (!lastEffectiveEnd || !codeFreezeDays) return null;
    return addWorkingDays(lastEffectiveEnd, codeFreezeDays);
  }, [lastEffectiveEnd, codeFreezeDays]);

  const stabilizationEndDate = useMemo(() => {
    if (!codeFreezeDate || !stabilizationDays) return null;
    return addWorkingDays(codeFreezeDate, stabilizationDays);
  }, [codeFreezeDate, stabilizationDays]);

  // Sync vertical scroll between left and right panels
  function onLeftScroll(e) { if (rightRef.current) rightRef.current.scrollTop = e.target.scrollTop; }
  function onRightScroll(e) { if (leftRef.current) leftRef.current.scrollTop = e.target.scrollTop; }

  const phMap = useMemo(() => {
    const m = {};
    for (const ph of (plan.placeholders || [])) m[ph.id] = ph;
    return m;
  }, [plan.placeholders]);

  // Debug table (Epic Timeline mode) — every story + subtask under the focused epic with
  // exactly what the app currently thinks its schedule is, for copy/paste diagnosis.
  const debugRows = useMemo(() => {
    if (planningMode !== 'epic' || !focusEpicKey) return [];
    function buildRow(issue, type, parentKey) {
      const entry = computedPlan.issues?.[issue.key] || {};
      const devs = effectiveDevCount(entry.assignedPlaceholders, computedPlan.placeholders);
      const assignedDevNames = (entry.assignedPlaceholders || []).map(id => phMap[id]?.name).filter(Boolean).join(', ');
      let endDate = '';
      if (entry.actualEndDate) endDate = entry.actualEndDate;
      else if (entry.startDate) endDate = calcEndDate(entry.startDate, roughMap[issue.key], devs) || '';
      return {
        key: issue.key,
        type,
        parentKey: parentKey || '',
        summary: issue.fields?.summary || '',
        status: issue.fields?.status?.name || '',
        jiraAssignee: issue.fields?.assignee?.displayName || '',
        assignedDevs: assignedDevNames,
        borrowedFromParent: !!entry.borrowedFromParent,
        startDate: entry.startDate || '',
        endDate,
        isActual: !!entry.actualEndDate,
        historyResolved: !!entry.historyResolved,
        roughHours: roughMap[issue.key] ?? '',
        dependencies: (entry.dependencies || []).join(', '),
      };
    }
    const out = [];
    const epic = epics.find(e => e.key === focusEpicKey);
    if (epic) out.push(buildRow(epic, 'Epic'));
    for (const story of (storiesByEpic[focusEpicKey] || [])) {
      out.push(buildRow(story, 'Story'));
      for (const sub of (subtasksByStory[story.key] || [])) {
        out.push(buildRow(sub, 'Subtask', story.key));
      }
    }
    return out;
  }, [planningMode, focusEpicKey, epics, storiesByEpic, subtasksByStory, computedPlan.issues, roughMap, phMap]);

  // Self-contained HTML export: summary cards, a simple Gantt visualization scaled to the
  // actual scheduled date range (not the full padded workingDays window), milestones,
  // critical path, team utilization, and the full debug table — everything needed to
  // review/share the timeline outside the app. Downloads as a .html file via a Blob URL.
  function exportTimelineHtml() {
    if (planningMode !== 'epic' || !focusEpicKey) return;
    const datedRows = debugRows.filter(r => r.startDate);
    if (datedRows.length === 0) return;

    const toTime = d => parseISO(d).getTime();
    const minStart = Math.min(...datedRows.map(r => toTime(r.startDate)));
    const maxEnd = Math.max(...datedRows.map(r => toTime(r.endDate || r.startDate)));
    const totalMs = Math.max(maxEnd - minStart + 86400000, 86400000);

    const phByName = {};
    for (const ph of Object.values(phMap)) phByName[ph.name] = ph.color;

    const span = computeProjectSpan(computedPlan, roughMap);
    const totalDays = workingDaysBetween(span.start, span.end);
    const critPath = computeCriticalPath(computedPlan, roughMap);
    const devUtils = computeDevUtilization(computedPlan, roughMap);
    const milestones = (computedPlan.milestones || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const cap = totalDays > 0 ? totalDays * HOURS_PER_DAY : 1;

    // Week-start tick marks along the same left% axis as the bars, for visual scale.
    const weekTicks = [];
    for (let t = minStart; t <= maxEnd; t += 7 * 86400000) {
      weekTicks.push({ leftPct: ((t - minStart) / totalMs) * 100, label: format(new Date(t), 'MMM d') });
    }

    // A bar shows "KEY — dates" as its own label when there's room (CSS truncates with an
    // ellipsis when there isn't); the native `title` tooltip always has the full text,
    // covering the "if it doesn't fit, just hover" case with zero JS measurement needed.
    function renderBar(r) {
      if (!r.startDate) return '<span class="unscheduled">not scheduled</span>';
      const startMs = toTime(r.startDate);
      const endMs = toTime(r.endDate || r.startDate) + 86400000;
      const leftPct = ((startMs - minStart) / totalMs) * 100;
      const widthPct = Math.max(((endMs - startMs) / totalMs) * 100, 0.6);
      const color = phByName[(r.assignedDevs || '').split(',')[0].trim()] || '#97A0AF';
      const fullTitle = `${r.key} — ${r.summary || ''}\n${r.startDate} → ${r.endDate}`
        + (r.isActual ? ' (locked, real Jira dates)' : '');
      return `<div class="track">`
        + `<div class="bar${r.isActual ? ' locked' : ''}" data-bar-key="${escapeHtml(r.key)}" `
        + `style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;background:${color}" `
        + `title="${escapeHtml(fullTitle)}">`
        + `<span class="bar-text">${escapeHtml(r.key)} · ${r.startDate} → ${r.endDate}${r.isActual ? ' 🔒' : ''}</span>`
        + `</div></div>`;
    }

    function renderRowLine(r, extraClass) {
      const indent = r.type === 'Subtask' ? 22 : r.type === 'Story' ? 8 : 0;
      const deps = (r.dependencies || '').split(',').map(d => d.trim()).filter(Boolean);
      return `<div class="row${extraClass ? ' ' + extraClass : ''}" data-row-key="${escapeHtml(r.key)}" data-deps="${escapeHtml(deps.join(','))}">`
        + `<div class="label" style="padding-left:${indent}px">`
        + `<span class="key">${escapeHtml(r.key)}</span> <span class="summary">${escapeHtml(r.summary)}</span>`
        + `<span class="meta">${escapeHtml(r.status)} · ${escapeHtml(r.assignedDevs || '—')}</span>`
        + `</div>${renderBar(r)}</div>`;
    }

    // Group rows by story so each story (with subtasks) becomes a native <details> —
    // collapsible with zero JS, works the same after the file is saved/reopened anywhere.
    const groups = [];
    let current = null;
    for (const r of debugRows) {
      if (r.type === 'Epic') { groups.push({ kind: 'epic', row: r }); continue; }
      if (r.type === 'Story') { current = { kind: 'story', row: r, subs: [] }; groups.push(current); continue; }
      if (current) current.subs.push(r);
    }
    const ganttHtml = groups.map(g => {
      if (g.kind === 'epic') return renderRowLine(g.row, 'epic-row');
      if (g.subs.length === 0) return renderRowLine(g.row, 'story-row leaf');
      return `<details class="story-group" open>`
        + `<summary>${renderRowLine(g.row, 'story-row')}</summary>`
        + `<div class="subtasks">${g.subs.map(s => renderRowLine(s)).join('')}</div>`
        + `</details>`;
    }).join('');

    // Faint background gridlines behind the bars, aligned to the same week ticks as the
    // ruler — pure CSS, computed once here (unlike the dependency arrows, these never need
    // to move when a story collapses/expands).
    const gridLinesHtml = weekTicks.map(t => `<div class="gridline" style="left:${t.leftPct.toFixed(2)}%"></div>`).join('');

    const rulerHtml = `<div class="ruler"><div class="ruler-spacer"></div><div class="ruler-track">`
      + weekTicks.map(t => `<span class="tick" style="left:${t.leftPct.toFixed(2)}%">${t.label}</span>`).join('')
      + `</div></div>`;

    const cols = ['key', 'type', 'parentKey', 'status', 'jiraAssignee', 'assignedDevs', 'borrowedFromParent', 'startDate', 'endDate', 'isActual', 'historyResolved', 'roughHours', 'dependencies'];
    const tableHead = cols.map(c => `<th>${escapeHtml(c)}</th>`).join('');
    const tableBody = debugRows.map(r => `<tr>${cols.map(c => `<td>${escapeHtml(r[c])}</td>`).join('')}</tr>`).join('');

    const milestonesHtml = milestones.length
      ? `<ul>${milestones.map(m => `<li><strong>${escapeHtml(m.label)}</strong> — ${m.date}</li>`).join('')}</ul>`
      : '<p class="muted">None</p>';
    const critPathHtml = critPath.length
      ? critPath.map(k => `${escapeHtml(k)} (${calcDays(roughMap[k], 1)}d)`).join(' → ')
      : '<span class="muted">None</span>';
    const devUtilHtml = (plan.placeholders || []).map(ph => {
      const h = devUtils[ph.id] || 0;
      const pct = Math.round(h / cap * 100);
      return `<div class="dev-bar"><span class="dev-name" style="color:${ph.color}">${escapeHtml(ph.name)}</span>`
        + `<div class="dev-track"><div class="dev-fill" style="width:${Math.min(pct, 100)}%;background:${ph.color}"></div></div>`
        + `<span class="dev-pct">${h.toFixed(0)}h (${pct}%)</span></div>`;
    }).join('');

    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(focusEpicKey)} — Timeline Export</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; margin: 0; color: #172B4D;
    background: #F7F8FA;
  }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px 44px; }
  .banner {
    background: linear-gradient(135deg, #0052CC 0%, #6554C0 100%); color: #fff;
    padding: 22px 24px; margin-bottom: 20px;
  }
  .banner-inner { max-width: 1120px; margin: 0 auto; }
  .banner h1 { font-size: 19px; margin: 0 0 3px; font-weight: 700; }
  .banner .meta-line { color: rgba(255,255,255,0.85); font-size: 11.5px; }
  h2 { font-size: 12px; margin: 26px 0 8px; color: #172B4D; letter-spacing: .03em; text-transform: uppercase; }
  h2::before { content: ''; display:inline-block; width:3px; height:11px; background:#6554C0; border-radius:2px; margin-right:6px; vertical-align:-1px; }
  .muted { color: #97A0AF; }
  .summary-cards { display:flex; gap:10px; flex-wrap:wrap; }
  .card {
    background:#fff; border-radius:8px; padding:9px 14px; min-width:110px;
    box-shadow: 0 1px 2px rgba(9,30,66,0.1), 0 0 1px rgba(9,30,66,0.15);
    transition: transform .15s ease, box-shadow .15s ease;
  }
  .card:hover { transform: translateY(-1px); box-shadow: 0 4px 10px rgba(9,30,66,0.14); }
  .card .label { font-size:9px; color:#5E6C84; text-transform:uppercase; letter-spacing:.05em; font-weight:600; }
  .card .value { font-size:15px; font-weight:700; margin-top:1px; }

  .gantt {
    background:#fff; border-radius:8px; overflow:hidden; position:relative;
    box-shadow: 0 1px 2px rgba(9,30,66,0.1), 0 0 1px rgba(9,30,66,0.2);
  }
  .ruler { display:flex; border-bottom: 1px solid #EBECF0; background:#FAFBFC; }
  .ruler-spacer { width:280px; flex-shrink:0; border-right:1px solid #EBECF0; }
  .ruler-track { position:relative; flex:1; height:20px; }
  .ruler-track .tick {
    position:absolute; top:4px; font-size:8.5px; color:#97A0AF; font-weight:600;
    transform: translateX(2px); padding-left: 3px; height: 12px;
  }
  .gantt-body { position:relative; }
  .gridline { position:absolute; top:0; bottom:0; width:1px; background:#F0F1F4; z-index:0; }
  .row { display:flex; align-items:center; min-height:26px; border-bottom:1px solid #F4F5F7; position:relative; z-index:1; }
  .row:hover { background: #FAFBFF; }
  .row.epic-row { background: linear-gradient(90deg, #EAE6FF, #fff 60%); font-weight: 700; }
  .row .label { width:280px; flex-shrink:0; font-size:10.5px; padding:2px 10px; border-right:1px solid #F4F5F7; overflow:hidden; background:#fff; z-index:1; white-space:nowrap; text-overflow:ellipsis; }
  .row .key { color:#0052CC; font-weight:700; }
  .row .summary { color:#42526E; }
  .row .meta { display:block; color:#97A0AF; font-size:8.5px; }
  .track { position:relative; flex:1; height:26px; }
  .bar {
    position:absolute; top:4px; height:18px; border-radius:4px; color:#fff; font-size:8.5px;
    display:flex; align-items:center; padding:0 5px; overflow:hidden;
    box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: filter .1s ease;
  }
  .bar:hover { filter: brightness(1.1); }
  .bar-text { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:600; }
  .bar.locked { outline: 2px solid #00875A; outline-offset: -2px; }
  .unscheduled { font-size:9.5px; color:#B3BAC5; padding-left:8px; }

  .story-group { border-bottom:1px solid #F4F5F7; }
  .story-group summary { list-style:none; cursor:pointer; display:block; }
  .story-group summary::-webkit-details-marker { display:none; }
  .story-group summary .row { border-bottom:none; }
  .story-group summary .label::before {
    content: '▶'; display:inline-block; font-size:7px; color:#6554C0; margin-right:5px; transition: transform .12s ease;
  }
  .story-group[open] summary .label::before { transform: rotate(90deg); }
  .story-group .subtasks .row:last-child { border-bottom:none; }
  .row.leaf .label::before { content: ''; display:inline-block; width:12px; }

  .deps-svg { position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:2; }

  table { border-collapse:collapse; width:100%; font-size:10px; background:#fff; border-radius:8px; overflow:hidden; box-shadow: 0 1px 2px rgba(9,30,66,0.1); }
  th, td { padding:4px 7px; text-align:left; white-space:nowrap; border-bottom:1px solid #F4F5F7; }
  th { background:#F4F5F7; color:#42526E; font-weight:700; position:sticky; top:0; }
  tbody tr:nth-child(even) { background:#FAFBFC; }
  tbody tr:hover { background:#EAE6FF33; }

  .dev-bar { display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:10.5px; }
  .dev-name { width:120px; flex-shrink:0; font-weight:600; }
  .dev-track { flex:1; background:#F4F5F7; border-radius:5px; height:9px; overflow:hidden; }
  .dev-fill { height:100%; border-radius:5px; }
  .dev-pct { width:90px; flex-shrink:0; text-align:right; color:#5E6C84; }
  .footnote { font-size:9.5px; color:#97A0AF; margin-top:8px; }
</style></head>
<body>
  <div class="banner"><div class="banner-inner">
    <h1>${escapeHtml(focusEpicKey)} — Epic Timeline</h1>
    <div class="meta-line">Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · Plan: ${escapeHtml(planIndex.find(p => p.id === selectedPlanId)?.name || '—')}</div>
  </div></div>

  <div class="wrap">
    <div class="summary-cards">
      <div class="card"><div class="label">Start</div><div class="value">${span.start || '—'}</div></div>
      <div class="card"><div class="label">Dev Complete</div><div class="value">${span.end || '—'}</div></div>
      <div class="card"><div class="label">Duration</div><div class="value">${totalDays} working days</div></div>
    </div>

    <h2>Timeline</h2>
    <div class="gantt">
      ${rulerHtml}
      <div class="gantt-body">
        ${gridLinesHtml}
        ${ganttHtml}
        <svg class="deps-svg" id="depsSvg"></svg>
      </div>
    </div>
    <p class="footnote">🔒 = locked, real dates from Jira status history. Other bars are estimate-based. Purple dashed lines are dependencies. Click a story's row to collapse/expand its subtasks. Hover any bar for full key, summary, and dates.</p>

    <h2>Milestones</h2>
    ${milestonesHtml}

    <h2>Critical Path</h2>
    <p>${critPathHtml}</p>

    <h2>Team Utilization</h2>
    ${devUtilHtml || '<p class="muted">No developers assigned</p>'}

    <h2>Debug Data</h2>
    <table><thead><tr>${tableHead}</tr></thead><tbody>${tableBody}</tbody></table>
  </div>
  <script>
  (function () {
    function isVisible(el) {
      var d = el.closest('details');
      while (d) {
        if (!d.open) return false;
        var p = d.parentElement;
        d = p ? p.closest('details') : null;
      }
      return true;
    }
    function redraw() {
      var svg = document.getElementById('depsSvg');
      var gantt = document.querySelector('.gantt');
      if (!svg || !gantt) return;
      var ganttRect = gantt.getBoundingClientRect();
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      var defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      var marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      marker.setAttribute('id', 'arrowHead');
      marker.setAttribute('markerWidth', '6');
      marker.setAttribute('markerHeight', '6');
      marker.setAttribute('refX', '5');
      marker.setAttribute('refY', '3');
      marker.setAttribute('orient', 'auto');
      var arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      arrowPath.setAttribute('d', 'M0,0 L6,3 L0,6 Z');
      arrowPath.setAttribute('fill', '#6554C0');
      marker.appendChild(arrowPath);
      defs.appendChild(marker);
      svg.appendChild(defs);
      var rows = document.querySelectorAll('.row[data-row-key]');
      var byKey = {};
      rows.forEach(function (r) { byKey[r.getAttribute('data-row-key')] = r; });
      rows.forEach(function (r) {
        var depsAttr = r.getAttribute('data-deps') || '';
        var deps = depsAttr.split(',').filter(Boolean);
        if (!deps.length || !isVisible(r)) return;
        var targetBar = r.querySelector('.bar');
        if (!targetBar) return;
        var tRect = targetBar.getBoundingClientRect();
        deps.forEach(function (depKey) {
          var depRow = byKey[depKey];
          if (!depRow || !isVisible(depRow)) return;
          var sourceBar = depRow.querySelector('.bar');
          if (!sourceBar) return;
          var sRect = sourceBar.getBoundingClientRect();
          var sx = sRect.right - ganttRect.left;
          var sy = sRect.top - ganttRect.top + sRect.height / 2;
          var tx = tRect.left - ganttRect.left;
          var ty = tRect.top - ganttRect.top + tRect.height / 2;
          var cx = sx + (tx - sx) / 2;
          var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', 'M ' + sx + ' ' + sy + ' C ' + cx + ' ' + sy + ' ' + cx + ' ' + ty + ' ' + tx + ' ' + ty);
          path.setAttribute('stroke', '#6554C0');
          path.setAttribute('stroke-width', '1.5');
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke-dasharray', '4 2');
          path.setAttribute('opacity', '0.85');
          path.setAttribute('marker-end', 'url(#arrowHead)');
          svg.appendChild(path);
        });
      });
    }
    document.querySelectorAll('details').forEach(function (d) { d.addEventListener('toggle', redraw); });
    window.addEventListener('resize', redraw);
    window.addEventListener('load', redraw);
    redraw();
  })();
  </script>
</body></html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${focusEpicKey}-timeline-${TODAY_STR}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Plans are stored centrally in Jira (project properties), not per-user — any teammate with
  // access to this project who opens K1-Planner and picks the same Project/Version/Plan is
  // looking at, and can edit, this exact same stored plan (not a copy). That's already true
  // with zero extra work; what's missing is a fast way to tell them WHICH one to pick, so this
  // copies a plain-text pointer rather than a magic auto-loading link — Forge strips URL query
  // parameters/hash fragments on a fresh (cold) load from a shared link, so a one-click deep
  // link into this exact plan isn't reliably possible on the platform today.
  function sharePlan() {
    const ver = versions.find(v => v.id === selectedVersionId);
    const planName = planIndex.find(p => p.id === selectedPlanId)?.name || '(unnamed plan)';
    const modeLabel = planningMode === 'draft' ? 'Draft' : planningMode === 'final' ? 'Final' : 'Epic Timeline';
    const epicLine = planningMode === 'epic' && focusEpicKey ? `\nEpic: ${focusEpicKey}` : '';
    const text = [
      `K1-Planner — shared plan`,
      `Project: ${projectKeys.join(', ')}`,
      `Version: ${ver ? ver.name : selectedVersionId}`,
      `Mode: ${modeLabel}${epicLine}`,
      `Plan: "${planName}"`,
      ``,
      `To open it: Jira → Apps → K1-Planner, then select the project/version/mode/plan above. You'll see and can edit the exact same plan — it's stored in Jira, not just on this device.`,
    ].join('\n');
    navigator.clipboard.writeText(text)
      .then(() => setShareNote('📋 Copied — paste it in Slack, email, wherever your teammate will see it'))
      .catch(() => setShareNote("✗ Couldn't copy to clipboard — your browser may be blocking it"));
  }

  // Full structured dump of the current plan — dates, assignees, capacities, estimates,
  // conflicts, everything the app itself knows — as JSON. Unlike exportTimelineHtml (Epic
  // Timeline mode only, one epic, styled for reading), this works in every mode and is meant
  // to be handed to someone (or something) else for analysis, e.g. a dashboard built from it,
  // or to paste back into a conversation for debugging a number that looks wrong on screen.
  function exportPlanJson() {
    const ver = versions.find(v => v.id === selectedVersionId);
    const devUtils = computeDevUtilization(computedPlan, roughMap);
    const span = computeProjectSpan(computedPlan, roughMap);
    const critPath = computeCriticalPath(computedPlan, roughMap);
    const totalDays = workingDaysBetween(span.start, span.end);

    // Every epic + story in the current version, regardless of what's currently expanded/
    // scrolled into view in the UI — the export is meant to be complete, not a screenshot of
    // whatever happens to be on screen right now. Subtasks only when in Epic Timeline mode,
    // where they're independently schedulable; Draft/Final plan at the story level or above.
    const allIssues = [];
    epics.forEach(e => allIssues.push({ ...e, _type: 'Epic' }));
    Object.values(storiesByEpic).flat().forEach(s => allIssues.push({ ...s, _type: 'Story' }));
    if (planningMode === 'epic') {
      Object.values(subtasksByStory).flat().forEach(st => allIssues.push({ ...st, _type: 'Subtask' }));
    }

    const developers = (plan.placeholders || []).map(ph => {
      const capacityPct = typeof ph.capacityPct === 'number' ? ph.capacityPct : 100;
      const hoursAssigned = devUtils[ph.id] || 0;
      // Same "capacity-adjusted cap" math as the Summary panel's utilization bars — a dev at
      // 50% capacity has HALF the working hours to compare their assigned hours against, so
      // their bar (and this ratio) reads as more heavily loaded for the same hour count.
      const capacityHours = totalDays > 0 ? totalDays * HOURS_PER_DAY * (capacityPct / 100) : null;
      return {
        id: ph.id,
        name: ph.name,
        accountId: ph.accountId || null,
        capacityPct,
        hoursAssigned: Number(hoursAssigned.toFixed(2)),
        capacityHoursOverPlanSpan: capacityHours != null ? Number(capacityHours.toFixed(2)) : null,
        utilizationPct: capacityHours ? Number(((hoursAssigned / capacityHours) * 100).toFixed(1)) : null,
        assignedIssueCount: Object.values(computedPlan.issues || {}).filter(e => (e.assignedPlaceholders || []).includes(ph.id)).length,
      };
    });

    const issues = allIssues.map(issue => {
      const entry = computedPlan.issues?.[issue.key] || {};
      const assignedDevIds = entry.assignedPlaceholders || [];
      const devs = effectiveDevCount(assignedDevIds, computedPlan.placeholders);
      const endDate = entry.actualEndDate || (entry.startDate ? calcEndDate(entry.startDate, schedMap[issue.key], devs) : null);
      return {
        key: issue.key,
        type: issue._type,
        summary: issue.fields?.summary || '',
        status: issue.fields?.status?.name || '',
        parentKey: issue.fields?.parent?.key || null,
        jiraAssignee: issue.fields?.assignee?.displayName || null,
        assignedDevs: assignedDevIds.map(id => phMap[id]?.name).filter(Boolean),
        assignedDevCapacityPct: assignedDevIds.map(id => (phMap[id] && typeof phMap[id].capacityPct === 'number') ? phMap[id].capacityPct : 100),
        startDate: entry.startDate || null,
        endDate: endDate || null,
        totalEstimateHours: roughMap[issue.key] ?? null,
        remainingEstimateHours: remainingEstMap[issue.key] ?? null,
        qaHours: entry.qaHours || 0,
        dependencies: entry.dependencies || [],
        jiraLocked: !!entry.jiraLocked,
        actualEndDateFromJira: entry.actualEndDate || null,
        historyResolved: !!entry.historyResolved,
        borrowedDevFromParent: !!entry.borrowedFromParent,
      };
    });

    const data = {
      exportedAt: new Date().toISOString(),
      app: 'planJira (K1-Planner)',
      planningMode,
      project: { keys: projectKeys, versionId: selectedVersionId, versionName: ver ? `${ver.projectKey} · ${ver.name}` : null },
      plan: { id: selectedPlanId, name: planIndex.find(p => p.id === selectedPlanId)?.name || null },
      settings: {
        estSource, bugFixPct, codeFreezeDays, stabilizationDays,
        bufferDays: planningMode === 'epic' ? bufferDays : undefined,
        autoDepByDev: planningMode === 'draft' ? autoDepByDev : undefined,
      },
      developers,
      issues,
      milestones: computedPlan.milestones || [],
      sprints,
      summary: {
        projectSpanStart: span.start,
        projectSpanEnd: span.end,
        projectSpanWorkingDays: totalDays,
        criticalPath: critPath,
        conflicts: conflicts.map(c => ({ developer: c.placeholder.name, source: c.source, target: c.target })),
        missingEstimateIssueCount: Object.keys(missingEstMap).length,
      },
    };

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `planJira-${planningMode}-${(planIndex.find(p => p.id === selectedPlanId)?.name || 'plan').replace(/[^\w-]+/g, '_')}-${TODAY_STR}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function getBarProps(issueKey) {
    // Draft mode: an epic with ANY child story locked to real Jira dates is itself shown
    // locked — grey, 🔒, spanning the earliest locked child's start to the latest locked
    // child's end — so a committed date discovered at the story level is never hidden behind
    // the epic's own estimate-based placement. This overrides the epic's own stored
    // startDate the same way an Epic Timeline container overrides its own subtasks' parent;
    // clicking the epic's 🔒 bulk-unlocks every locked child (see the render code) rather
    // than trying to "unlock" a date the epic doesn't actually own.
    if (planningMode === 'draft') {
      const childStories = storiesByEpic[issueKey];
      if (childStories && childStories.length > 0) {
        const lockedChildren = childStories.filter(s => computedPlan.issues?.[s.key]?.jiraLocked);
        if (lockedChildren.length > 0) {
          let minStart = null, maxEnd = null;
          lockedChildren.forEach(s => {
            const e = computedPlan.issues[s.key];
            if (!e?.startDate) return;
            if (!minStart || e.startDate < minStart) minStart = e.startDate;
            const end = e.actualEndDate || e.startDate;
            if (!maxEnd || end > maxEnd) maxEnd = end;
          });
          const startIdx = minStart ? workingDays.indexOf(snapToWorkingDay(minStart)) : -1;
          if (startIdx >= 0) {
            const endIdx = maxEnd ? workingDays.indexOf(snapToWorkingDay(maxEnd)) : startIdx;
            const durationDays = Math.max(1, (endIdx >= startIdx ? endIdx : startIdx) - startIdx + 1);
            return {
              left: startIdx * DAY_WIDTH,
              width: durationDays * DAY_WIDTH - 2,
              durationDays,
              startDate: minStart,
              endDate: maxEnd || minStart,
              jiraLocked: true,
              lockedChildKeys: lockedChildren.map(s => s.key),
            };
          }
        }
      }
    }
    // Epic Timeline mode: a story with subtasks is a container, not independently-booked
    // work — it must always start/end exactly with its children, regardless of its own
    // startDate/history/manual placement, so the parent never drifts out of sync.
    if (planningMode === 'epic') {
      const subs = subtasksByStory[issueKey];
      if (subs && subs.length > 0) {
        const span = computeChildSpan(subs.map(s => s.key), computedPlan, roughMap, workingDays, DAY_WIDTH);
        if (!span) return null;
        return {
          left: span.left,
          width: span.width,
          durationDays: span.endIdx - span.startIdx + 1,
          startDate: workingDays[span.startIdx],
          endDate: workingDays[span.endIdx],
          isContainer: true,
          placedSubtasks: span.placed,
          totalSubtasks: subs.length,
        };
      }
    }
    const entry = computedPlan.issues?.[issueKey];
    if (!entry?.startDate) return null;
    const startIdx = workingDays.indexOf(snapToWorkingDay(entry.startDate));
    if (startIdx < 0) return null;
    // Epic Timeline mode: issues placed from real Jira status history (In Progress →
    // Ready for Deployment) get a fixed end date instead of an estimate-based duration.
    if (entry.actualEndDate) {
      const endIdx = workingDays.indexOf(snapToWorkingDay(entry.actualEndDate));
      const durationDays = endIdx > startIdx ? (endIdx - startIdx + 1) : 1;
      return {
        left: startIdx * DAY_WIDTH,
        width: durationDays * DAY_WIDTH - 2,
        durationDays,
        endDate: entry.actualEndDate,
        startDate: entry.startDate,
        isActual: true,
      };
    }
    const devs = effectiveDevCount(entry.assignedPlaceholders, computedPlan.placeholders);
    const hours = schedMap[issueKey];
    const durationDays = calcDays(hours, devs);
    return {
      left: startIdx * DAY_WIDTH,
      width: durationDays * DAY_WIDTH - 2,
      durationDays,
      endDate: calcEndDate(entry.startDate, hours, devs),
      startDate: entry.startDate,
    };
  }

  function handleRowClick(issueKey) {
    if (!depsMode) return;
    if (!depsSource) {
      setDepsSource(issueKey);
    } else if (depsSource !== issueKey) {
      updateIssueEntry(issueKey, {
        dependencies: [...new Set([...(computedPlan.issues?.[issueKey]?.dependencies || []), depsSource])],
      });
      setDepsMode(false); setDepsSource(null);
    }
  }

  // Epic Timeline mode: placing a story/task with subtasks on the timeline schedules
  // all its subtasks right after one another (each depending on the previous one), using
  // each subtask's own Jira assignee, or the parent story's assignee if it has none.
  function placeStoryAndSubtasks(storyKey, startDate) {
    const story = (storiesByEpic[focusEpicKey] || []).find(s => s.key === storyKey);
    const subs = subtasksByStory[storyKey] || [];

    let storyPhs = (plan.issues[storyKey]?.assignedPlaceholders) || [];
    if (!storyPhs.length && story?.fields?.assignee?.accountId) {
      const phId = ensurePlaceholderForAssignee(story.fields.assignee.accountId, story.fields.assignee.displayName);
      if (phId) storyPhs = [phId];
    }
    updateIssueEntry(storyKey, { startDate, assignedPlaceholders: storyPhs });

    let cursor = startDate;
    let prevKey = null;
    for (const sub of subs) {
      let phs = (plan.issues[sub.key]?.assignedPlaceholders) || [];
      let borrowed = false;
      if (!phs.length) {
        const ownAssignee = sub.fields?.assignee;
        const assignee = ownAssignee || story?.fields?.assignee;
        if (assignee?.accountId) {
          const phId = ensurePlaceholderForAssignee(assignee.accountId, assignee.displayName);
          if (phId) { phs = [phId]; borrowed = !ownAssignee; }
        }
      }
      const devs = effectiveDevCount(phs, plan.placeholders);
      updateIssueEntry(sub.key, { startDate: cursor, assignedPlaceholders: phs, dependencies: prevKey ? [prevKey] : [], borrowedFromParent: borrowed });
      const endDate = calcEndDate(cursor, roughMap[sub.key], devs);
      if (endDate) cursor = addWorkingDays(endDate, 1 + bufferDays);
      prevKey = sub.key;
    }
  }


  function placeOnTimeline(issueKey, day) {
    // Manual placement (drag or click) ALWAYS wins, even over a previously-locked
    // (real Jira history) date — the user is now the source of truth for this issue.
    // Automatic "snap to real Jira dates" for an issue that's started but not yet
    // resolved is handled proactively by the background status-history effect, so this
    // function no longer needs to duplicate that lookup — it only has to respect it,
    // which it does by always clearing dependencies/actualEndDate and setting
    // historyResolved so neither that effect nor a future Auto-schedule run silently
    // reverts this choice.
    // An issue that already carries a committed Due date in Jira is already scheduled —
    // dropping it honors that date rather than the cursor position, and locks the bar
    // (grey + 🔒) so a stray drag can't silently contradict Jira. With a Start date custom
    // field too, both ends are real; with only a Due date, the start is derived by counting
    // the issue's estimated duration backward from it, so the work finishes exactly on its
    // commitment. Click the 🔒 to unlock; `jiraUnlocked` then persists that choice so it
    // won't re-lock on the next drop.
    const issueForWindow = issueByKey[issueKey];
    const devsForWindow = effectiveDevCount(plan.issues?.[issueKey]?.assignedPlaceholders, plan.placeholders);
    const durationForWindow = calcDays(schedMap[issueKey], devsForWindow);
    const jiraWin = jiraDateWindow(issueForWindow, startDateFieldId, durationForWindow);
    const entryNow = plan.issues?.[issueKey];
    if (jiraWin && !entryNow?.jiraUnlocked) {
      updateIssueEntry(issueKey, {
        startDate: jiraWin.start, actualEndDate: jiraWin.end,
        dependencies: [], historyResolved: true, jiraLocked: true,
      });
      setDepNote(jiraWin.derivedStart
        ? `${issueKey} has a Jira Due date (${jiraWin.end}) — placed to finish there (start derived from its estimate) and locked. Click its 🔒 to unlock.`
        : `${issueKey} has Jira Start/Due dates (${jiraWin.start} → ${jiraWin.end}) — placed there and locked. Click its 🔒 to unlock and move it freely.`);
      return;
    }
    if (planningMode === 'epic' && (subtasksByStory[issueKey] || []).length > 0) {
      placeStoryAndSubtasks(issueKey, day);
      return;
    }
    // Draft mode + "Auto-dep by dev": dropping an epic next to another one that shares a
    // developer chains it behind that epic instead of leaving them to overlap — one person
    // can't work two epics at once. The chosen predecessor is the LATEST-ENDING already-placed
    // epic that shares a dev and starts at/before the drop point, so the drop position still
    // decides WHERE in that dev's queue this lands. cascadePlan then owns the exact date (it
    // always recomputes startDate from dependencies), so the bar snaps to just after that
    // predecessor rather than sitting exactly where the cursor was released.
    const autoDeps = autoDepOnDrop(issueKey, day);
    updateIssueEntry(issueKey, { startDate: day, dependencies: autoDeps, actualEndDate: undefined, historyResolved: true });
  }

  // Returns the dependency list a freshly-dropped issue should get — [] unless Draft mode's
  // auto-dependency-by-developer setting is on and a shared-dev predecessor exists.
  function autoDepOnDrop(issueKey, day) {
    if (planningMode !== 'draft' || !autoDepByDev) return [];
    const phs = plan.issues?.[issueKey]?.assignedPlaceholders || [];
    if (!phs.length) return [];
    let best = null, bestEnd = null;
    for (const [key, e] of Object.entries(computedPlan.issues || {})) {
      if (key === issueKey || !e.startDate) continue;
      if (e.startDate > day) continue; // sits after the drop point — don't chain behind it
      if (!(e.assignedPlaceholders || []).some(id => phs.includes(id))) continue;
      const devs = effectiveDevCount(e.assignedPlaceholders, computedPlan.placeholders);
      const end = e.actualEndDate || calcEndDate(e.startDate, schedMap[key], devs) || e.startDate;
      if (!bestEnd || end > bestEnd) { best = key; bestEnd = end; }
    }
    return best ? [best] : [];
  }

  function handleTimelineClick(issueKey, dayIdx) {
    if (depsMode) { handleRowClick(issueKey); return; }
    const day = workingDays[dayIdx];
    if (!day) return;
    placeOnTimeline(issueKey, day);
  }

  // Releases a bar pinned to Jira's own Start/Due dates. Keeps the current start (so it
  // doesn't jump on unlock) but drops the fixed end so its duration reverts to the
  // estimate-based one, and records `jiraUnlocked` so future drops respect the cursor
  // instead of snapping back to Jira's dates.
  function unlockJiraDates(issueKey) {
    updateIssueEntry(issueKey, { jiraLocked: false, jiraUnlocked: true, actualEndDate: undefined });
    setDepNote(`${issueKey} unlocked from its Jira dates — you can drag it anywhere now.`);
  }

  // For an epic whose bar is shown locked because one or more of its child stories are —
  // there's no date on the epic itself to unlock, so this unlocks every locked child instead.
  function unlockAllChildren(childKeys) {
    childKeys.forEach(unlockJiraDates);
    setDepNote(`Unlocked ${childKeys.length} stor${childKeys.length === 1 ? 'y' : 'ies'} — the epic will return to its own estimate-based schedule.`);
  }

  function removeDependency(sourceKey, targetKey) {
    const e = computedPlan.issues?.[targetKey];
    if (!e) return;
    updateIssueEntry(targetKey, { dependencies: (e.dependencies || []).filter(d => d !== sourceKey) });
  }

  // Flips a dependency's direction: the issue that was waiting becomes the predecessor.
  // For when something was dropped after another epic but actually has to precede it —
  // otherwise the only route was "click the arrow to delete, then redraw it by hand in
  // dependency mode", which auto-chaining tends to undo on the next drop.
  // Both sides are rewritten in ONE updatePlan call so cascadePlan never observes an
  // intermediate state where the edge exists in both directions.
  // Refuses when the flip would create a cycle: cascadePlan topologically sorts, and a
  // cycle silently drops every issue in it from scheduling (its queue never drains).
  function reverseDependency(sourceKey, targetKey) {
    const issues = computedPlan.issues || {};
    // After the flip, sourceKey depends on targetKey. Walk targetKey's remaining dependency
    // chain (ignoring the edge being removed) — if it leads back to sourceKey, that's a cycle.
    const seen = new Set();
    const stack = [targetKey];
    while (stack.length) {
      const k = stack.pop();
      if (k === sourceKey) {
        setDepNote(`Can't reverse ${sourceKey} → ${targetKey}: ${targetKey} already depends on ${sourceKey} through another chain, so flipping it would create a loop.`);
        return;
      }
      if (seen.has(k)) continue;
      seen.add(k);
      for (const d of (issues[k]?.dependencies || [])) {
        if (k === targetKey && d === sourceKey) continue; // the edge we're about to remove
        stack.push(d);
      }
    }
    updatePlan(prev => {
      const next = { ...(prev.issues || {}) };
      const t = next[targetKey];
      if (t) next[targetKey] = { ...t, dependencies: (t.dependencies || []).filter(d => d !== sourceKey) };
      const s = next[sourceKey] || { startDate: null, assignedPlaceholders: [], dependencies: [] };
      next[sourceKey] = { ...s, dependencies: [...new Set([...(s.dependencies || []), targetKey])] };
      return { ...prev, issues: next };
    });
    setDepNote(`Reversed: ${targetKey} now runs before ${sourceKey}.`);
  }

  function togglePlaceholder(issueKey, phId) {
    const entry = computedPlan.issues?.[issueKey] || { assignedPlaceholders: [] };
    const current = entry.assignedPlaceholders || [];
    const isRemoving = current.includes(phId);
    const updated = isRemoving ? current.filter(id => id !== phId) : [...current, phId];
    let newDeps = entry.dependencies || [];
    if (!isRemoving && planningMode === 'draft') {
      // Auto-chain: find the last epic before this one that already has this developer
      const currentEpicIdx = epics.findIndex(e => e.key === issueKey);
      const prevEpicsWithDev = epics
        .slice(0, currentEpicIdx)
        .filter(e => (computedPlan.issues?.[e.key]?.assignedPlaceholders || []).includes(phId));
      if (prevEpicsWithDev.length > 0) {
        const lastEpic = prevEpicsWithDev[prevEpicsWithDev.length - 1];
        if (!newDeps.includes(lastEpic.key)) newDeps = [...newDeps, lastEpic.key];
      }
    }
    updateIssueEntry(issueKey, { assignedPlaceholders: updated, dependencies: newDeps });
  }

  async function autoScheduleAll() {
    setAutoScheduling(true);
    try {
      await autoScheduleAllInner();
    } finally {
      setAutoScheduling(false);
    }
  }

  async function autoScheduleAllInner() {
    const newIssues = {};
    for (const [k, e] of Object.entries(plan.issues || {})) newIssues[k] = { ...e };

    if (planningMode !== 'epic') {
      // Draft/Final modes — original behavior: rows order, no status filtering.
      // Draft schedules at EPIC level (that's the mode's whole premise: duration = rough est
      // ÷ devs, with QA/Fix extensions on the epic's own bar), so its newly-visible child
      // story rows are context for reading the epic's numbers — not extra work to place.
      // Without this filter, expanding an epic would start double-booking its devs against
      // both the epic and its own stories.
      const candidates = rows.filter(row =>
        !newIssues[row.key]?.startDate && (planningMode !== 'draft' || row._isEpic)
      );
      const nextAvail = {}; // phId → next available date
      for (const row of candidates) {
        const entry = newIssues[row.key] || { startDate: null, assignedPlaceholders: [], dependencies: [] };
        const phs = entry.assignedPlaceholders || [];
        if (!phs.length) continue;
        let start = snapToWorkingDay(planStart);
        for (const phId of phs) {
          if (nextAvail[phId] && nextAvail[phId] > start) start = nextAvail[phId];
        }
        for (const depKey of (entry.dependencies || [])) {
          const de = newIssues[depKey];
          if (de?.startDate) {
            const devs = effectiveDevCount(de.assignedPlaceholders, plan.placeholders);
            const depEnd = calcEndDate(de.startDate, schedMap[depKey], devs);
            if (depEnd) { const after = nextWorkDay(depEnd); if (after > start) start = after; }
          }
        }
        const devs = effectiveDevCount(phs, plan.placeholders);
        const endDate = calcEndDate(start, schedMap[row.key], devs);
        newIssues[row.key] = { ...entry, startDate: start };
        for (const phId of phs) { if (endDate) nextAvail[phId] = nextWorkDay(endDate); }
      }
      updatePlan(prev => ({ ...prev, issues: newIssues }));
      return;
    }

    // Epic Timeline mode — every story and subtask must end up on the timeline:
    //  - Known Issue / Removed issues are skipped entirely (never scheduled).
    //  - Issues still "not started" (Reopened/To Do/Blocked) are the leaves that actually
    //    get chained: processed in key order, one after another per assignee (even issues
    //    with no assignee are still placed, just without a chain to wait on).
    //  - Anything further along already has real dates from Jira status history (see the
    //    status-driven auto-timeline effect) and is left untouched.
    //  - A story that HAS subtasks is a container, not independently-booked work — it does
    //    not compete in its own assignee's queue; its position is simply derived from
    //    whichever of its subtasks currently has a date (freshly scheduled or historical).
    const stories = storiesByEpic[focusEpicKey] || [];
    const storySubtasks = {};
    for (const story of stories) {
      storySubtasks[story.key] = (subtasksByStory[story.key] || []).filter(sub => !isIgnoredStatus(sub));
    }

    let leaves = [];
    const parentOf = {}; // subtask key → its parent story (for assignee fallback)
    for (const story of stories) {
      if (isIgnoredStatus(story)) continue;
      const subs = storySubtasks[story.key];
      if (subs.length === 0) leaves.push(story);
      else for (const sub of subs) { leaves.push(sub); parentOf[sub.key] = story; }
    }
    const notStartedLeaves = leaves.filter(row => {
      if (newIssues[row.key]?.startDate) return false;
      const statusName = normalizeStatusName(row.fields?.status?.name);
      return NOT_STARTED_STATUSES.includes(statusName);
    }).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));

    // Resolve "already started" issues' real dates FIRST, before anything below reads their
    // startDate/actualEndDate — this must run before the dev-availability pre-seed and the
    // not-started scheduling loop, or a dev's real, already-placed-but-not-yet-resolved
    // commitments (e.g. right after "Clear all") are invisible when scheduling everything
    // else, and a not-started item can land right on top of them.
    // Only skip an "already started" leaf if its date was previously CONFIRMED against
    // real Jira history (`historyResolved`) — not merely because some startDate exists.
    // Older/manually-set/stale dates (e.g. from before this check existed) must still be
    // re-verified and corrected every time, since real history is the single source of
    // truth for anything that isn't still To Do/Blocked/Reopened.
    const alreadyStartedUnresolved = leaves.filter(row => {
      if (newIssues[row.key]?.historyResolved) return false;
      const statusName = normalizeStatusName(row.fields?.status?.name);
      return !NOT_STARTED_STATUSES.includes(statusName);
    });
    if (alreadyStartedUnresolved.length > 0) {
      const results = await Promise.all(alreadyStartedUnresolved.map(async row => {
        const cached = changelogCache[row.key];
        if (cached && !cached.loading && !cached.error) return { key: row.key, ...cached };
        try {
          const histories = await getIssueChangelog(row.key);
          return { key: row.key, ...extractStatusDates(histories) };
        } catch (e) {
          return { key: row.key, error: true };
        }
      }));
      const cachePatch = {};
      for (const r of results) {
        cachePatch[r.key] = r.error ? { error: true } : { inProgressDate: r.inProgressDate, readyDate: r.readyDate };
        if (r.error) continue;
        const patch = { historyResolved: true, dependencies: [] };
        if (r.inProgressDate) {
          patch.startDate = r.inProgressDate.slice(0, 10);
          if (r.readyDate) patch.actualEndDate = r.readyDate.slice(0, 10);
        }
        newIssues[r.key] = { ...(newIssues[r.key] || { assignedPlaceholders: [], dependencies: [] }), ...patch };
      }
      setChangelogCache(prev => ({ ...prev, ...cachePatch }));
    }

    const nextAvail = {};    // phId → next available date
    const lastKeyForPh = {}; // phId → most recently scheduled issue key sharing that dev
    let unassignedCursor = snapToWorkingDay(planStart); // shared lane for issues with no resolvable assignee at all

    // Seed each dev's next-available slot from every leaf ALREADY placed in this epic —
    // including locked/real-history ones, now fully resolved above — before scheduling
    // anything new. Otherwise a not-started item could land right on top of a dev's
    // already-fixed commitment, producing exactly the kind of overlap Auto-schedule is
    // supposed to guarantee zero of.
    for (const row of leaves) {
      const e = newIssues[row.key];
      if (!e?.startDate) continue;
      const devs = effectiveDevCount(e.assignedPlaceholders, plan.placeholders);
      const end = e.actualEndDate || calcEndDate(e.startDate, roughMap[row.key], devs);
      if (!end) continue;
      const after = addWorkingDays(end, 1 + bufferDays);
      for (const phId of (e.assignedPlaceholders || [])) {
        if (!nextAvail[phId] || after > nextAvail[phId]) nextAvail[phId] = after;
      }
    }

    for (const row of notStartedLeaves) {
      let entry = newIssues[row.key] || { startDate: null, assignedPlaceholders: [], dependencies: [] };
      let phs = entry.assignedPlaceholders || [];

      // No dev yet? Resolve from this issue's own Jira assignee, or — for a subtask —
      // fall back to its parent story's assignee (shown in a lighter color elsewhere),
      // so it still joins that dev's chain instead of sitting unscheduled on its own.
      if (!phs.length) {
        const parent = parentOf[row.key];
        const ownAssignee = row.fields?.assignee;
        const assignee = ownAssignee || parent?.fields?.assignee;
        if (assignee?.accountId) {
          const phId = ensurePlaceholderForAssignee(assignee.accountId, assignee.displayName);
          if (phId) {
            phs = [phId];
            entry = { ...entry, assignedPlaceholders: phs, borrowedFromParent: !ownAssignee && !!parent };
          }
        }
      }

      const chainDeps = phs.map(phId => lastKeyForPh[phId]).filter(Boolean);
      const deps = [...new Set([...(entry.dependencies || []), ...chainDeps])];

      // Real assignee: advance that dev's own queue. No resolvable assignee at all:
      // advance a separate shared lane instead of colliding on planStart — still placed
      // on the timeline (never skipped), just sequenced by key order rather than by
      // developer, and never falsely chained to unrelated unassigned issues.
      let start;
      if (phs.length) {
        start = snapToWorkingDay(planStart);
        for (const phId of phs) {
          if (nextAvail[phId] && nextAvail[phId] > start) start = nextAvail[phId];
        }
      } else {
        start = unassignedCursor;
      }
      for (const depKey of deps) {
        const de = newIssues[depKey];
        if (de?.startDate) {
          const devs = effectiveDevCount(de.assignedPlaceholders, plan.placeholders);
          // A locked dependency's real end date is a fact — never replace it with an estimate.
          const depEnd = de.actualEndDate || calcEndDate(de.startDate, roughMap[depKey], devs);
          if (depEnd) { const after = addWorkingDays(depEnd, 1 + bufferDays); if (after > start) start = after; }
        }
      }
      const devs = effectiveDevCount(phs, plan.placeholders);
      const endDate = calcEndDate(start, roughMap[row.key], devs);
      newIssues[row.key] = { ...entry, startDate: start, dependencies: deps };
      if (phs.length) {
        for (const phId of phs) {
          if (endDate) nextAvail[phId] = addWorkingDays(endDate, 1 + bufferDays);
          lastKeyForPh[phId] = row.key;
        }
      } else if (endDate) {
        unassignedCursor = addWorkingDays(endDate, 1 + bufferDays);
      }
    }

    for (const story of stories) {
      if (isIgnoredStatus(story)) continue;
      const subs = storySubtasks[story.key];
      if (subs.length === 0 || newIssues[story.key]?.startDate) continue;
      const placedStarts = subs.map(s => newIssues[s.key]?.startDate).filter(Boolean).sort();
      if (placedStarts.length > 0) {
        newIssues[story.key] = {
          ...(newIssues[story.key] || { assignedPlaceholders: [], dependencies: [] }),
          startDate: placedStarts[0],
          // A container story's position is derived purely from its subtasks — any
          // inherited dependency must not survive, or cascadePlan will unconditionally
          // recompute (and silently override) this startDate on the next render.
          dependencies: [],
        };
      }
    }

    // Auto-expand every story that has subtasks, so freshly-scheduled subtasks and their
    // dependency arrows are actually visible without the user having to click each caret.
    setExpandedStories(prev => {
      const next = new Set(prev);
      for (const story of stories) if (storySubtasks[story.key].length > 0) next.add(story.key);
      return next;
    });


    updatePlan(prev => ({ ...prev, issues: newIssues }));
  }

  // Unschedules everything in the current view — clears startDate/dependencies/actualEndDate
  // but keeps the developer roster and milestones intact. In Epic Timeline mode this is
  // scoped to the focused epic's stories+subtasks (and their changelog cache, so the
  // status-driven auto-timeline can re-derive fresh dates); Draft/Final clear all visible rows.
  // removeJiraDueDates — when true, also PUTs a null due date to Jira for every issue that
  // was actually scheduled (had a startDate), undoing whatever a prior "Save to Jira" wrote.
  // This talks to real Jira issues, so the caller must have gotten explicit confirmation first.
  async function clearAllScheduling(removeJiraDueDates) {
    let keys;
    if (planningMode === 'epic') {
      keys = [];
      for (const story of (storiesByEpic[focusEpicKey] || [])) {
        keys.push(story.key);
        for (const sub of (subtasksByStory[story.key] || [])) keys.push(sub.key);
      }
    } else {
      keys = rows.map(r => r.key);
    }
    const newIssues = { ...(plan.issues || {}) };
    const keysToUnschedule = keys.filter(key => newIssues[key]?.startDate);
    for (const key of keys) {
      if (!newIssues[key]) continue;
      newIssues[key] = { ...newIssues[key], startDate: null, dependencies: [], actualEndDate: undefined, historyResolved: false };
    }
    updatePlan(prev => ({ ...prev, issues: newIssues }));
    if (planningMode === 'epic') {
      setChangelogCache(prev => {
        const next = { ...prev };
        for (const key of keys) delete next[key];
        return next;
      });
    }
    if (removeJiraDueDates && keysToUnschedule.length > 0) {
      await Promise.all(keysToUnschedule.map(key => updateIssueDueDate(key, null).catch(() => {})));
    }
  }

  async function handleSave() {
    setSaveStatus('saving');
    try {
      const planToSave = computedPlan;
      await savePlanToStorage(planToSave);
      if (updateDueDates) {
        for (const [key, entry] of Object.entries(planToSave.issues || {})) {
          if (!entry.startDate) continue;
          const devs = effectiveDevCount(entry.assignedPlaceholders, planToSave.placeholders);
          const endDate = calcEndDate(entry.startDate, schedMap[key], devs);
          if (endDate) await updateIssueDueDate(key, endDate);
        }
      }
      for (const key of dirtyEstKeys) {
        const hours = localRoughEst[key];
        if (hours != null) await updateRoughEstimation(key, hours);
      }
      setDirtyEstKeys(new Set());
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (e) {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus(null), 5000);
    }
  }

  const todayIdx = workingDays.indexOf(TODAY_STR);

  // Since the window can now extend backward to cover past dates, re-center the view on
  // "today" (with a little back-context) whenever the plan or focused epic changes —
  // otherwise the default scroll position (0) would show the earliest historical date.
  useEffect(() => {
    if (!rightRef.current) return;
    const idx = workingDays.indexOf(TODAY_STR);
    if (idx > 0) rightRef.current.scrollLeft = Math.max(0, (idx - 3) * DAY_WIDTH);
  }, [selectedPlanId, focusEpicKey]);

  if (!selectedVersionId) {
    return (
      <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #DFE1E6', padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#172B4D', marginBottom: 12 }}>Version Planning</div>
        <p style={{ color: '#5E6C84', fontSize: 13, marginBottom: 16 }}>Select a version to start planning your timeline.</p>
        <select onChange={e => setSelectedVersionId(e.target.value || null)}
          style={{ padding: '8px 12px', fontSize: 13, border: '2px solid #DFE1E6', borderRadius: 6, minWidth: 240 }}>
          <option value="">— Choose a version —</option>
          {selectableVersions.map(v => <option key={v.id} value={v.id}>{v.projectKey} · {v.name}</option>)}
        </select>
        {issuesLoading && <div style={{ marginTop: 12, color: '#97A0AF', fontSize: 12 }}>Loading versions…</div>}
      </div>
    );
  }

  return (
    <div style={maximized ? {
      background: '#fff', border: '1px solid #DFE1E6', overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000,
    } : {
      background: '#fff', borderRadius: 8, border: '1px solid #DFE1E6', boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
      overflow: 'hidden', display: 'flex', flexDirection: 'column', height: 'calc(100vh - 180px)',
    }}>

      {/* ── Top toolbar — minimum required controls only; everything else lives in the
          right-hand side panel (opened via the buttons in the second row below) ── */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #DFE1E6', background: '#FAFBFC', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Version selector */}
          <select value={selectedVersionId || ''} onChange={e => { setSelectedVersionId(e.target.value || null); setSelectedPlanId(null); }}
            style={{ padding: '5px 10px', fontSize: 12, border: '1.5px solid #DFE1E6', borderRadius: 4, fontWeight: 600 }}>
            <option value="">— Choose version —</option>
            {selectableVersions.map(v => <option key={v.id} value={v.id}>{v.projectKey} · {v.name}</option>)}
          </select>

          {/* Plan selector — Draft only. Final is a single reserved plan with no picker. */}
          {selectedVersionId && !isFinalContext && (
            <>
              <span style={{ fontSize: 11, color: '#5E6C84', fontWeight: 600 }}>Plan:</span>
              <select value={selectedPlanId || ''} onChange={e => { if (e.target.value) setSelectedPlanId(e.target.value); }}
                style={{ padding: '4px 10px', fontSize: 12, border: '1.5px solid #DFE1E6', borderRadius: 4, minWidth: 120 }}>
                {draftPlanIndex.length === 0 && <option value="">No plans yet</option>}
                {draftPlanIndex.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button onClick={() => {
                const ver = versions.find(x => x.id === selectedVersionId);
                const versionLabel = ver ? `${ver.projectKey} · ${ver.name}` : 'Draft';
                const context = planningMode === 'epic' && focusEpicKey ? `${versionLabel} · ${focusEpicKey}` : versionLabel;
                setPlanDialog({ type: 'new', defaultName: `${context} Draft ${draftPlanIndex.length + 1}` });
              }} style={btnStyle('#F4F5F7', '#42526E', '#DFE1E6')}>+ New</button>
            </>
          )}
          {selectedVersionId && isFinalContext && (
            <span style={{ fontSize: 11, color: '#0052CC', fontWeight: 600, background: '#E9F2FF', border: '1.5px solid #B3D4FF', borderRadius: 4, padding: '4px 10px' }}>
              🔒 Final plan — saved directly to Jira
            </span>
          )}

          {/* Planning mode toggle */}
          <div style={{ display: 'flex', border: '2px solid #DFE1E6', borderRadius: 4, overflow: 'hidden' }}>
            <button onClick={() => setPlanningMode('draft')} style={{
              padding: '4px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              background: planningMode === 'draft' ? '#6554C0' : '#fff',
              color: planningMode === 'draft' ? '#fff' : '#42526E', border: 'none',
            }} title="Draft: epics only, duration = rough est ÷ devs, auto-dependency when same dev on multiple epics">
              Draft
            </button>
            <button onClick={() => setPlanningMode('final')} style={{
              padding: '4px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              background: planningMode === 'final' ? '#0052CC' : '#fff',
              color: planningMode === 'final' ? '#fff' : '#42526E',
              border: 'none', borderLeft: '1px solid #DFE1E6',
            }} title="Final: stories/tasks, rough or original estimates, committed delivery report">
              Final
            </button>
            <button onClick={() => setPlanningMode('epic')} style={{
              padding: '4px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              background: planningMode === 'epic' ? '#00875A' : '#fff',
              color: planningMode === 'epic' ? '#fff' : '#42526E',
              border: 'none', borderLeft: '1px solid #DFE1E6',
            }} title="Epic Timeline: focus on one epic — stories and their subtasks, all schedulable">
              Epic Timeline
            </button>
          </div>

          {/* Epic selector — Epic Timeline mode only */}
          {planningMode === 'epic' && (
            <select value={focusEpicKey || ''} onChange={e => setFocusEpicKey(e.target.value || null)}
              style={{ padding: '4px 10px', fontSize: 12, border: '1.5px solid #DFE1E6', borderRadius: 4, fontWeight: 600, minWidth: 160 }}>
              <option value="">— Choose an epic —</option>
              {epics.map(e => <option key={e.key} value={e.key}>{e.key} · {e.fields?.summary}</option>)}
            </select>
          )}

          {/* Epic Timeline's own nested Draft/Final choice — separate from the top-level
              toggle. Final here means "this one epic's committed schedule", saved straight
              to Jira with no plan picker; Draft allows multiple named what-if schedules. */}
          {planningMode === 'epic' && (
            <div style={{ display: 'flex', border: '1.5px solid #DFE1E6', borderRadius: 4, overflow: 'hidden' }}>
              <button onClick={() => setEpicPlanKind('draft')} style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                background: epicPlanKind === 'draft' ? '#6554C0' : '#fff',
                color: epicPlanKind === 'draft' ? '#fff' : '#42526E', border: 'none',
              }} title="Draft: multiple named what-if schedules for this epic">
                Draft
              </button>
              <button onClick={() => setEpicPlanKind('final')} style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                background: epicPlanKind === 'final' ? '#0052CC' : '#fff',
                color: epicPlanKind === 'final' ? '#fff' : '#42526E',
                border: 'none', borderLeft: '1px solid #DFE1E6',
              }} title="Final: this epic's one committed schedule, saved directly to Jira">
                Final
              </button>
            </div>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={() => setMaximized(m => !m)}
              title={maximized ? 'Restore' : 'Maximize — see all stories and subtasks'}
              style={btnStyle(maximized ? '#0052CC' : '#F4F5F7', maximized ? '#fff' : '#42526E', maximized ? 'transparent' : '#DFE1E6')}>
              {maximized ? '⤡ Restore' : '⤢ Maximize'}
            </button>
            <button onClick={autoScheduleAll} disabled={autoScheduling} style={btnStyle('#E9F2FF', '#0052CC', '#B3D4FF')}>
              {autoScheduling ? 'Scheduling…' : 'Auto-schedule'}
            </button>
            <button onClick={refreshFromJira} disabled={refreshing || issuesLoading}
              title="Re-fetch epics/stories from Jira — picks up epics added to or removed from this version since the page loaded"
              style={btnStyle('#F4F5F7', '#42526E', '#DFE1E6')}>
              {refreshing || issuesLoading ? '↻ Refreshing…' : '↻ Refresh from Jira'}
            </button>
            {refreshNote && (
              <span style={{
                fontSize: 11, padding: '3px 8px', borderRadius: 3,
                background: refreshNote.startsWith('✓') ? '#E3FCEF' : '#FFF0B3',
                color: refreshNote.startsWith('✓') ? '#00875A' : '#974F0C',
              }}>{refreshNote}</span>
            )}
            <label style={{ fontSize: 11, color: isFinalContext ? '#97A0AF' : '#5E6C84', display: 'flex', alignItems: 'center', gap: 4 }}
              title={isFinalContext ? 'Final plans always write due dates back to Jira' : undefined}>
              <input type="checkbox" checked={isFinalContext ? true : updateDueDates} disabled={isFinalContext}
                onChange={e => setUpdateDueDates(e.target.checked)} />
              Update Jira due dates
            </label>
            {autoSaveStatus && (
              <span style={{ fontSize: 11, color: autoSaveStatus === 'saved' ? '#00875A' : autoSaveStatus === 'error' ? '#DE350B' : '#97A0AF' }}>
                {autoSaveStatus === 'pending' ? '● unsaved' : autoSaveStatus === 'saving' ? '↻ saving…' : autoSaveStatus === 'saved' ? '✓ saved' : '✗ save error'}
              </span>
            )}
            <button onClick={handleSave} disabled={saving} style={btnStyle(
              saveStatus === 'saved' ? '#E3FCEF' : saveStatus === 'error' ? '#FFEBE6' : '#0052CC',
              saveStatus === 'saved' ? '#00875A' : saveStatus === 'error' ? '#DE350B' : '#fff',
              'transparent', true
            )}>
              {saving ? 'Saving…' : saveStatus === 'saved' ? '✓ Saved' : saveStatus === 'error' ? '✗ Error' : 'Save to Jira'}
            </button>
          </div>
        </div>

        {/* Panel-toggle row — everything that used to be a permanent banner or a
            secondary settings row now lives behind one of these, in the right panel */}
        {selectedPlanId && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
            <PanelToggleBtn icon="📊" label="Summary"
              badge={(conflicts.length + Object.keys(missingEstMap).length) || null}
              active={activePanel === 'summary'}
              onClick={() => setActivePanel(p => p === 'summary' ? null : 'summary')} />
            <PanelToggleBtn icon="⚙" label="Settings"
              active={activePanel === 'settings'}
              onClick={() => setActivePanel(p => p === 'settings' ? null : 'settings')} />
            <PanelToggleBtn icon="👥" label="Team"
              badge={(plan.placeholders || []).length || null} badgeColor="#0052CC"
              active={activePanel === 'team'}
              onClick={() => setActivePanel(p => p === 'team' ? null : 'team')} />
            <PanelToggleBtn icon="🔗" label="Tools"
              active={activePanel === 'tools'}
              onClick={() => setActivePanel(p => p === 'tools' ? null : 'tools')} />
            {planningMode === 'epic' && (
              <PanelToggleBtn icon="🐛" label="Debug"
                active={activePanel === 'debug'}
                onClick={() => setActivePanel(p => p === 'debug' ? null : 'debug')} />
            )}
            {depNote && (
              <span style={{
                marginLeft: 'auto', fontSize: 11, fontWeight: 600, padding: '4px 8px', borderRadius: 4,
                background: depNote.startsWith("Can't") ? '#FFEBE6' : '#E3FCEF',
                color: depNote.startsWith("Can't") ? '#DE350B' : '#00875A',
              }}>{depNote}</span>
            )}
          </div>
        )}
      </div>

      {selectedVersionId && !selectedPlanId && !indexLoading && planIndex.length === 0 && (
        <div style={{ padding: 32, textAlign: 'center', fontSize: 13, color: '#5E6C84' }}>
          No plans yet for this version.{' '}
          <button onClick={() => setPlanDialog({ type: 'new', defaultName: 'Plan 1' })}
            style={{ ...btnStyle('#0052CC', '#fff', 'transparent'), fontSize: 13, padding: '6px 16px' }}>
            + Create first plan
          </button>
        </div>
      )}
      {selectedVersionId && !selectedPlanId && !indexLoading && planIndex.length > 0 && (
        <div style={{ padding: 32, textAlign: 'center', fontSize: 13, color: '#97A0AF' }}>
          Select a plan above to start editing.
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {(!selectedVersionId || !selectedPlanId) ? null : issuesLoading || planLoading ? (
        <div style={{ padding: 32, textAlign: 'center', color: '#97A0AF', fontSize: 13 }}>Loading…</div>
      ) : issuesError ? (
        <div style={{ padding: 16, color: '#DE350B', fontSize: 13 }}>Error: {issuesError}</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: '#97A0AF', fontSize: 13 }}>
          {planningMode === 'epic' ? 'Choose an epic above to see its timeline.' : 'No epics found for this version.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* ── Left table ── */}
          <div ref={leftRef} onScroll={onLeftScroll}
            style={{ width: totalLeftWidth, flexShrink: 0, overflowY: 'auto', overflowX: 'hidden', borderRight: '1px solid #DFE1E6' }}>
            {/* Column headers — click to sort, drag right edge to resize */}
            <div style={{ position: 'sticky', top: 0, zIndex: 10, background: '#F4F5F7', borderBottom: '1px solid #DFE1E6', display: 'flex', height: HEADER_H, alignItems: 'center' }}>
              <div onClick={() => handleSort('key')} style={{ ...cellStyle, width: colWidths.key, fontWeight: 700, position: 'relative', cursor: 'pointer', userSelect: 'none' }}>
                Key{sortIndicator('key')}
                <ColResizer colKey="key" setColWidths={setColWidths} min={50} />
              </div>
              <div onClick={() => handleSort('summary')} style={{ ...cellStyle, width: colWidths.summary, fontWeight: 700, position: 'relative', cursor: 'pointer', userSelect: 'none' }}>
                Summary{sortIndicator('summary')}
                <ColResizer colKey="summary" setColWidths={setColWidths} min={80} />
              </div>
              <div onClick={() => handleSort('est')} style={{ ...cellStyle, width: colWidths.est, fontWeight: 700, textAlign: 'right', position: 'relative', cursor: 'pointer', userSelect: 'none' }}
                title={planningMode === 'draft' ? 'Total estimate — full original size, ignoring status' : undefined}>
                {planningMode === 'draft' ? 'Total Est' : 'Est'}{sortIndicator('est')}
                <ColResizer colKey="est" setColWidths={setColWidths} min={36} />
              </div>
              <div onClick={() => handleSort('rough')} style={{ ...cellStyle, width: colWidths.rough, fontWeight: 700, textAlign: 'right', position: 'relative', cursor: 'pointer', userSelect: 'none', color: '#6554C0' }}
                title="The Rough Estimation field's own value in Jira — shown regardless of the Estimate-source setting, with no rollup or inherited share applied">
                Rough{sortIndicator('rough')}
                <ColResizer colKey="rough" setColWidths={setColWidths} min={36} />
              </div>
              {planningMode === 'draft' && (
                <div onClick={() => handleSort('remaining')} style={{ ...cellStyle, width: colWidths.remaining, fontWeight: 700, textAlign: 'right', position: 'relative', cursor: 'pointer', userSelect: 'none' }}
                  title="Total minus already dev-done children (In Review / Ready for Testing / Ready for Deployment / Done) — this is what's actually scheduled on the timeline">
                  Remaining{sortIndicator('remaining')}
                  <ColResizer colKey="remaining" setColWidths={setColWidths} min={40} />
                </div>
              )}
              <div onClick={() => handleSort('assigned')} style={{ ...cellStyle, width: colWidths.assigned, fontWeight: 700, position: 'relative', cursor: 'pointer', userSelect: 'none' }}>
                Assigned{sortIndicator('assigned')}
                <ColResizer colKey="assigned" setColWidths={setColWidths} min={50} />
              </div>
              {planningMode === 'draft' && (
                <div onClick={() => handleSort('qa')} style={{ ...cellStyle, width: colWidths.qa, fontWeight: 700, textAlign: 'center', color: '#FF991F', position: 'relative', cursor: 'pointer', userSelect: 'none' }} title="QA testing days for this epic">
                  QA d{sortIndicator('qa')}
                  <ColResizer colKey="qa" setColWidths={setColWidths} min={32} />
                </div>
              )}
              <div onClick={() => handleSort('days')} style={{ ...cellStyle, width: colWidths.days, fontWeight: 700, textAlign: 'right', cursor: 'pointer', userSelect: 'none' }}>
                Days{sortIndicator('days')}
              </div>
            </div>
            {sortedRows.map(row => {
              const f = row.fields || {};
              const roughH = roughMap[row.key];
              const remainingH = remainingEstMap[row.key];
              const entry = computedPlan.issues?.[row.key] || {};
              const devs = entry.assignedPlaceholders?.length ? effectiveDevCount(entry.assignedPlaceholders, computedPlan.placeholders) : 0;
              const days = schedMap[row.key] && devs ? calcDays(schedMap[row.key], devs) : null;
              const isEpic = row._isEpic;
              const isDepsTarget = depsMode && depsSource && depsSource !== row.key;
              const isDepsSrc = depsMode && !depsSource;
              const isLocked = !!entry.actualEndDate; // real dates from Jira status history — still movable, but moving it overrides the real date
              const estCoverage = estCoverageMap[row.key];
              // Very light status tint on the row itself (this table only, never the Gantt):
              // red for Validation (needs attention), green once dev work is finished.
              const _rowStatus = normalizeStatusName(f.status?.name);
              const rowStatusTint = _rowStatus === 'validation' ? '#FFF5F4'
                : DEV_DONE_STATUSES.includes(_rowStatus) ? '#F3FCF7'
                : null;
              return (
                <div key={row.key}
                  draggable
                  onDragStart={e => { window.__versionPlanDrag = { issueKey: row.key }; e.dataTransfer.effectAllowed = 'move'; }}
                  onDragEnd={() => { window.__versionPlanDrag = null; }}
                  onClick={() => handleRowClick(row.key)}
                  title={isLocked ? 'Dates are from Jira status history (In Progress → In Review) — drag to override with a manual date' : undefined}
                  style={{
                    display: 'flex', alignItems: 'center', height: ROW_HEIGHT,
                    borderBottom: '1px solid #F4F5F7',
                    background: depsSource === row.key ? '#FFF0B3' : isDepsTarget ? '#E9F2FF'
                      : rowStatusTint ? rowStatusTint
                      : entry.startDate ? '#E3FCEF' : isEpic ? '#EAE6FF22' : '#fff',
                    cursor: depsMode ? 'crosshair' : 'grab',
                  }}>
                  {/* Key */}
                  <div style={{ ...cellStyle, width: colWidths.key, paddingLeft: isEpic ? 8 : row._isSubtask ? 32 : 20 }}>
                    {isLocked && <span title="Dates are from Jira status history — drag to override with a manual date" style={{ fontSize: 9, marginRight: 3, flexShrink: 0 }}>🔒</span>}
                    {/* Carets render only when there's actually something to expand — an
                        arrow that opens to nothing reads as a bug (and was one: see the
                        version-inheritance fix in useEpicHierarchy). */}
                    {isEpic && (planningMode === 'final' || planningMode === 'draft') && (
                      (storiesByEpic[row.key] || []).length > 0 ? (
                        <span onClick={e => { e.stopPropagation(); setExpandedEpics(prev => { const n = new Set(prev); n.has(row.key) ? n.delete(row.key) : n.add(row.key); return n; }); }}
                          title={`${(storiesByEpic[row.key] || []).length} stor${(storiesByEpic[row.key] || []).length === 1 ? 'y' : 'ies'} in this version`}
                          style={{ cursor: 'pointer', fontSize: 9, marginRight: 4, color: '#6554C0' }}>
                          {expandedEpics.has(row.key) ? '▼' : '▶'}
                        </span>
                      ) : (
                        <span title="No stories in this version — the epic carries the version but has no child stories tagged to it (or none at all)"
                          style={{ fontSize: 9, marginRight: 4, color: '#DFE1E6' }}>·</span>
                      )
                    )}
                    {row._isStory && planningMode === 'epic' && (
                      (subtasksByStory[row.key] || []).length > 0 ? (
                        <span onClick={e => { e.stopPropagation(); setExpandedStories(prev => { const n = new Set(prev); n.has(row.key) ? n.delete(row.key) : n.add(row.key); return n; }); }}
                          title={`${(subtasksByStory[row.key] || []).length} subtask(s)`}
                          style={{ cursor: 'pointer', fontSize: 9, marginRight: 4, color: '#0052CC' }}>
                          {expandedStories.has(row.key) ? '▼' : '▶'}
                        </span>
                      ) : (
                        <span title="No subtasks" style={{ fontSize: 9, marginRight: 4, color: '#DFE1E6' }}>·</span>
                      )
                    )}
                    <span
                      onClick={e => { e.stopPropagation(); setDetailIssueKey(row.key); }}
                      style={{ fontSize: 11, fontWeight: isEpic ? 700 : 400, color: isEpic ? '#6554C0' : '#0052CC', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}
                      title="Click to open details"
                    >
                      {f.issuetype?.iconUrl && (
                        <img src={f.issuetype.iconUrl} alt={f.issuetype.name || ''} title={f.issuetype.name}
                          style={{ width: 14, height: 14, flexShrink: 0 }} />
                      )}
                      <span style={{ textDecoration: 'underline', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.key}</span>
                      {f.status?.name && (() => {
                        var sc = statusColors(f.status.statusCategory?.key);
                        return (
                          <span title={f.status.name} style={{
                            fontSize: 8, fontWeight: 700, padding: '1px 3px', borderRadius: 3, flexShrink: 0,
                            background: sc.bg, color: sc.fg, textDecoration: 'none',
                          }}>{statusInitials(f.status.name)}</span>
                        );
                      })()}
                    </span>
                  </div>
                  {/* Summary — epics also carry an estimate-coverage badge when some of
                      their stories are unestimated, so a rolled-up total that only covers
                      part of the real scope can't be mistaken for a complete one. */}
                  <div style={{ ...cellStyle, width: colWidths.summary, fontSize: 11, color: '#172B4D', overflow: 'hidden', whiteSpace: 'nowrap', gap: 4 }} title={f.summary}>
                    {isEpic && estCoverage && estCoverage.pct < 100 && (
                      <span
                        title={estCoverage.estimated === 0
                          ? `None of this epic's ${estCoverage.total} stories carry their own estimate — the ${roughH != null ? roughH + 'h' : 'epic'} total is spread evenly across them for scheduling. Estimate the stories individually for an accurate plan.`
                          : `Only ${estCoverage.estimated} of ${estCoverage.total} stories carry their own estimate (${estCoverage.pct}%) — the rest share out the epic's remaining hours, so this plan is only as accurate as that split.`}
                        style={{
                          fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 3, flexShrink: 0,
                          background: estCoverage.pct < 50 ? '#FFEBE6' : '#FFFAE6',
                          color: estCoverage.pct < 50 ? '#DE350B' : '#974F0C',
                        }}>{estCoverage.pct}%</span>
                    )}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.summary}</span>
                  </div>
                  {/* Est — click to edit inline; only persisted to Jira on "Save to Jira" */}
                  <div
                    onClick={e => { e.stopPropagation(); setEditingEstKey(row.key); setEditingEstValue(roughH != null ? String(roughH) : ''); }}
                    title={dirtyEstKeys.has(row.key) ? 'Unsaved change — click Save to Jira to persist' : 'Click to edit estimate'}
                    style={{ ...cellStyle, width: colWidths.est, textAlign: 'right', fontSize: 11, cursor: 'pointer' }}
                  >
                    {editingEstKey === row.key ? (
                      <input
                        autoFocus
                        type="number"
                        value={editingEstValue}
                        onChange={e => setEditingEstValue(e.target.value)}
                        onBlur={() => saveEstFn(row.key, editingEstValue, setLocalRoughEst, setEditingEstKey, setDirtyEstKeys)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') saveEstFn(row.key, editingEstValue, setLocalRoughEst, setEditingEstKey, setDirtyEstKeys);
                          if (e.key === 'Escape') setEditingEstKey(null);
                        }}
                        onClick={e => e.stopPropagation()}
                        style={{ width: 44, fontSize: 10, border: '1.5px solid #0052CC', borderRadius: 3, textAlign: 'right', padding: '1px 3px' }}
                      />
                    ) : roughH != null ? (
                      <span style={{ color: dirtyEstKeys.has(row.key) ? '#FF991F' : '#0052CC', fontWeight: 600 }}>
                        {roughH % 1 === 0 ? roughH : roughH.toFixed(1)}h
                        {dirtyEstKeys.has(row.key) && <span title="Unsaved change" style={{ marginLeft: 2 }}>●</span>}
                        {missingEstMap[row.key] && <span title="Incomplete estimates" style={{ color: '#FF991F', marginLeft: 2 }}>⚠</span>}
                      </span>
                    ) : (
                      <span style={{ color: missingEstMap[row.key] ? '#FF5630' : '#97A0AF' }}>
                        {missingEstMap[row.key] ? '—⚠' : '—'}
                      </span>
                    )}
                  </div>
                  {/* Rough — the Rough Estimation field's raw value, always, so it can be
                      compared against whatever the Estimate-source toggle is currently using. */}
                  <div style={{ ...cellStyle, width: colWidths.rough, textAlign: 'right', fontSize: 11 }}
                    title={rawRoughMap[row.key] != null
                      ? `Rough Estimation field: ${rawRoughMap[row.key]}h`
                      : 'No Rough Estimation value set on this issue'}>
                    {rawRoughMap[row.key] != null ? (
                      <span style={{ color: '#6554C0', fontWeight: 600 }}>
                        {rawRoughMap[row.key] % 1 === 0 ? rawRoughMap[row.key] : rawRoughMap[row.key].toFixed(1)}h
                      </span>
                    ) : (
                      <span style={{ color: '#97A0AF' }}>—</span>
                    )}
                  </div>
                  {/* Remaining Est — Draft mode only: total minus already dev-done children.
                      This, not the total, is what actually drives the epic's bar duration when
                      you drag/schedule it (schedMap). Not directly editable — it's derived. */}
                  {planningMode === 'draft' && (
                    <div style={{ ...cellStyle, width: colWidths.remaining, textAlign: 'right', fontSize: 11 }}
                      title={remainingH !== roughH ? `${roughH ?? 0}h total, ${remainingH ?? 0}h remaining (some children are already dev-done)` : 'No children are dev-done yet — remaining equals total'}>
                      {remainingH != null ? (
                        <span style={{ color: remainingH < (roughH || 0) ? '#00875A' : '#42526E', fontWeight: 600 }}>
                          {remainingH % 1 === 0 ? remainingH : remainingH.toFixed(1)}h
                        </span>
                      ) : (
                        <span style={{ color: '#97A0AF' }}>—</span>
                      )}
                    </div>
                  )}
                  {/* Assigned placeholders — only the devs actually assigned to THIS row are
                      shown as solid dots (click to unassign); a large team roster (e.g. 11
                      devs) used to render every single placeholder here regardless of
                      assignment, wrapping to several lines that overflowed the row's fixed
                      height and visually bled into neighboring rows. Adding a dev now goes
                      through the compact "+" selector instead of needing all of them on screen
                      at once. */}
                  <div style={{ ...cellStyle, width: colWidths.assigned, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                    {(entry.assignedPlaceholders || []).map(phId => {
                      const ph = phMap[phId];
                      if (!ph) return null;
                      const borrowed = entry.borrowedFromParent;
                      const capLabel = typeof ph.capacityPct === 'number' && ph.capacityPct < 100 ? ` (${ph.capacityPct}% capacity)` : '';
                      return (
                        <span key={ph.id} onClick={e => { e.stopPropagation(); togglePlaceholder(row.key, ph.id); }}
                          title={(borrowed ? `${ph.name} (inherited from parent story) — click to remove` : `${ph.name} — click to remove`) + capLabel}
                          style={{
                            width: 17, height: 17, borderRadius: '50%', cursor: 'pointer',
                            background: ph.color, border: `1.5px solid ${ph.color}`,
                            opacity: borrowed ? 0.4 : 1,
                            flexShrink: 0,
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 7, fontWeight: 800, color: '#fff', letterSpacing: '-0.03em',
                          }}>{devInitials(ph.name)}</span>
                      );
                    })}
                    {(plan.placeholders || []).length > 0 && (
                      <select value="" onClick={e => e.stopPropagation()}
                        onChange={e => { if (e.target.value) togglePlaceholder(row.key, e.target.value); }}
                        title="Assign a developer"
                        style={{ fontSize: 9, border: '1.5px dashed #B3D4FF', borderRadius: 8, cursor: 'pointer', padding: '0 2px', height: 16, color: '#0052CC', background: '#fff', flexShrink: 0 }}>
                        <option value="">+</option>
                        {(plan.placeholders || [])
                          .filter(ph => !(entry.assignedPlaceholders || []).includes(ph.id))
                          .map(ph => <option key={ph.id} value={ph.id}>{ph.name}</option>)}
                      </select>
                    )}
                    {!(plan.placeholders || []).length && <span style={{ fontSize: 10, color: '#97A0AF' }}>add devs ↑</span>}
                  </div>
                  {/* QA days — Draft mode only */}
                  {planningMode === 'draft' && (
                    <div style={{ ...cellStyle, width: colWidths.qa, justifyContent: 'center' }}>
                      <input
                        type="number" min={0}
                        value={entry.qaHours ? Math.round(entry.qaHours / HOURS_PER_DAY) : ''}
                        placeholder="—"
                        onChange={e => {
                          const d = parseFloat(e.target.value);
                          updateIssueEntry(row.key, { qaHours: isNaN(d) || d <= 0 ? 0 : d * HOURS_PER_DAY });
                        }}
                        onClick={e => e.stopPropagation()}
                        title="QA testing days for this epic"
                        style={{
                          width: 32, fontSize: 10, border: '1.5px solid #FFD700', borderRadius: 3,
                          textAlign: 'center', padding: '1px 2px', color: '#974F0C', background: '#FFFAE6',
                        }}
                      />
                    </div>
                  )}
                  {/* Days */}
                  <div style={{ ...cellStyle, width: colWidths.days, textAlign: 'right', fontSize: 11 }}>
                    {days ? <strong>{days}d</strong> : <span style={{ color: '#97A0AF' }}>—</span>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── Right timeline ── */}
          <div ref={rightRef} onScroll={onRightScroll}
            onDragOver={e => { if (window.__versionPlanDrag) e.preventDefault(); }}
            onDrop={e => {
              var drag = window.__versionPlanDrag;
              if (!drag || !rightRef.current) return;
              e.preventDefault();
              var rect = rightRef.current.getBoundingClientRect();
              var relX = e.clientX - rect.left + rightRef.current.scrollLeft;
              var dayIdx = Math.max(0, Math.min(workingDays.length - 1, Math.floor(relX / DAY_WIDTH)));
              var day = workingDays[dayIdx];
              if (day) placeOnTimeline(drag.issueKey, day);
              window.__versionPlanDrag = null;
            }}
            style={{ flex: 1, overflowX: 'auto', overflowY: 'auto' }}>
            <div style={{ width: totalTimelineWidth, position: 'relative' }}>

              {/* Date headers */}
              <div style={{ position: 'sticky', top: 0, zIndex: 10, height: HEADER_H, display: 'flex', background: '#F4F5F7', borderBottom: '1px solid #DFE1E6' }}>
                {/* Sprint bands — a labeled colored strip across the header's bottom edge, so
                    sprints are obviously marked at a glance rather than relying only on the
                    thin dotted boundary lines further down in the Gantt body. Alternates two
                    colors by index so adjacent sprints are visually distinguishable; clipped
                    to the visible workingDays window (a sprint that starts/ends outside it
                    still shows the portion that overlaps). */}
                {sprints.map((sprint, i) => {
                  const startDateStr = sprint.startDate ? snapToWorkingDay(sprint.startDate.slice(0, 10)) : null;
                  const endDateStr = sprint.endDate ? snapToWorkingDay(sprint.endDate.slice(0, 10)) : null;
                  let startIdx = startDateStr ? workingDays.indexOf(startDateStr) : -1;
                  let endIdx = endDateStr ? workingDays.indexOf(endDateStr) : -1;
                  if (startIdx < 0 && endIdx < 0) return null;
                  if (startIdx < 0) startIdx = 0;
                  if (endIdx < 0) endIdx = workingDays.length - 1;
                  if (endIdx < startIdx) return null;
                  const left = startIdx * DAY_WIDTH;
                  const width = (endIdx - startIdx + 1) * DAY_WIDTH;
                  const color = i % 2 === 0 ? '#6554C0' : '#0052CC';
                  return (
                    <div key={sprint.id}
                      title={`${sprint.name}${sprint.state ? ` (${sprint.state})` : ''}: ${sprint.startDate?.slice(0, 10) || '?'} → ${sprint.endDate?.slice(0, 10) || '?'}`}
                      style={{
                        // Explicit z-index required: the day cells below are `position:
                        // relative` and rendered LATER in DOM order — per CSS stacking rules,
                        // same-layer (z-index:auto) positioned siblings paint in DOM order
                        // regardless of which is visually "behind", so without this the day
                        // cells painted over these bands and the colors never showed.
                        position: 'absolute', left, width: Math.max(width - 1, 2), bottom: 0, height: 14, zIndex: 1,
                        background: color, opacity: 0.85, borderRadius: '3px 3px 0 0',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                        fontSize: 8, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', pointerEvents: 'none',
                      }}>{sprint.name}</div>
                  );
                })}
                {workingDays.map((day, idx) => {
                  const d = parseISO(day);
                  const isToday = day === TODAY_STR;
                  const isMonday = getDay(d) === 1;
                  return (
                    <div key={day} onClick={() => setEditingMilestone({ id: null, label: '', date: day, color: MILESTONE_COLORS[0] })}
                      title="Click to add milestone"
                      style={{
                        width: DAY_WIDTH, flexShrink: 0, borderRight: isMonday ? '1px solid #DFE1E6' : '1px solid #F4F5F7',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                        fontSize: 9, color: isToday ? '#0052CC' : '#5E6C84',
                        fontWeight: isToday ? 800 : isMonday ? 600 : 400,
                        background: isToday ? '#E9F2FF' : 'transparent',
                        cursor: 'pointer', position: 'relative',
                      }}>
                      {isMonday || idx === 0 ? format(d, 'MMM d') : format(d, 'd')}
                    </div>
                  );
                })}

                {/* Milestone labels — live in the header's TOP strip (sprint bands own the
                    bottom strip) as plain positioned divs, not the SVG overlay below. They used
                    to be an SVG pill drawn at the same y-range as this sticky header — since the
                    header has its own z-index and (as of the sprint bands above) an opaque
                    background at the bottom, the SVG pill was rendering BEHIND it: invisible,
                    and unclickable, which is exactly what "I see the dot but no label and can't
                    edit it" was — the old fallback dot (in the day cell below) was the only
                    thing still visible. Multiple milestones sharing a date are staggered
                    horizontally so they don't sit exactly on top of each other. */}
                {(() => {
                  const byDate = {};
                  (computedPlan.milestones || []).forEach(m => { (byDate[m.date] = byDate[m.date] || []).push(m); });
                  return (computedPlan.milestones || []).map(m => {
                    const idx = workingDays.indexOf(m.date);
                    if (idx < 0) return null;
                    const siblings = byDate[m.date];
                    const pos = siblings.indexOf(m);
                    const pillWidth = Math.max(m.label.length * 5.5, 16);
                    const x = idx * DAY_WIDTH + DAY_WIDTH / 2 + pos * (pillWidth * 0.65);
                    return (
                      <div key={m.id} onClick={e => { e.stopPropagation(); setEditingMilestone({ ...m }); }}
                        title={`${m.label} — ${m.date}${siblings.length > 1 ? ` (${siblings.length} milestones this day — click to edit this one)` : ''} — click to edit`}
                        style={{
                          position: 'absolute', left: x, top: 1, transform: 'translateX(-50%)',
                          zIndex: 20 + pos, maxWidth: 100,
                          background: m.color, color: '#fff', fontSize: 8, fontWeight: 700,
                          padding: '2px 5px', borderRadius: 3, cursor: 'pointer',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                        }}>{m.label}</div>
                    );
                  });
                })()}
              </div>

              {/* Row bars */}
              {sortedRows.map((row, rowIdx) => {
                const bar = getBarProps(row.key);
                const entry = computedPlan.issues?.[row.key] || {};
                const phs = (entry.assignedPlaceholders || []).map(id => phMap[id]).filter(Boolean);
                return (
                  <div key={row.key} style={{ height: ROW_HEIGHT, borderBottom: '1px solid #F4F5F7', position: 'relative', background: rowIdx % 2 === 0 ? '#fff' : '#FAFBFC' }}>
                    {/* Click anywhere on row to place/move bar */}
                    <div style={{ position: 'absolute', inset: 0, display: 'flex' }}>
                      {workingDays.map((day, idx) => (
                        <div key={day} onClick={() => handleTimelineClick(row.key, idx)}
                          style={{ width: DAY_WIDTH, flexShrink: 0, height: '100%', borderRight: getDay(parseISO(day)) === 5 ? '1px solid #DFE1E6' : '1px solid #F4F5F7', cursor: depsMode ? 'crosshair' : 'pointer' }}
                          title={entry.actualEndDate ? `Override real Jira dates — set start: ${day}` : depsMode ? undefined : `Set start: ${day}`}
                        />
                      ))}
                    </div>

                    {/* Gantt bar:
                        - Draft mode epics: own bar (startDate + devs), same as story bar
                        - Final mode epics: summary bar spanning all placed stories
                        - Stories / tasks: standard draggable bar */}
                    {row._isEpic && planningMode === 'draft' ? (bar && (() => {
                      const _devs = phs.reduce((s, p) => s + (typeof p.capacityPct === 'number' ? p.capacityPct : 100) / 100, 0) || 1;
                      const { qaDays: _qaDays, bugFixDays: _bfDays } = calcQaBugFixDays(qaBaseMap[row.key], _devs, qaMap[row.key] || 0, bugFixPct);
                      const _statusBorder = statusBorderColor(row.fields?.status?.name);
                      // An epic can be locked two different ways: `bar.jiraLocked` (derived by
                      // getBarProps — a CHILD story carries the real Jira date, the epic's own
                      // entry has none) or `entry.jiraLocked` (the epic itself was dropped and
                      // has its OWN Jira Due date, set directly by placeOnTimeline). Only the
                      // first was ever checked here, so a directly-locked epic like this one
                      // silently rendered as a normal draggable bar with no 🔒 at all.
                      const _lockedByChildren = !!bar.jiraLocked;
                      const _lockedDirectly = !_lockedByChildren && !!entry.jiraLocked;
                      const _isLocked = _lockedByChildren || _lockedDirectly;
                      return (<>
                      <div
                        // Not draggable while locked: either the bar's span is computed from
                        // locked child stories (ignoring the epic's own entry, so a drag would
                        // set startDate but produce no visible change) or the epic's own entry
                        // is itself pinned to a real Jira date. Unlock via 🔒 first either way.
                        draggable={!_isLocked}
                        onDragStart={e => {
                          e.stopPropagation();
                          window.__versionPlanDrag = { issueKey: row.key };
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => { window.__versionPlanDrag = null; }}
                        style={{
                          position: 'absolute',
                          left: bar.left, top: 5,
                          width: bar.width, height: ROW_HEIGHT - 10,
                          // Locked because a child story carries a real Jira date → grey, not
                          // the developer's color: the span is the children's fact, not a plan
                          // choice, until every locked child is unlocked (see the 🔒 below).
                          background: _isLocked
                            ? '#8993A4'
                            : phs.length === 1 ? phs[0].color : phs.length > 1 ? `linear-gradient(90deg, ${phs.map(p => p.color).join(', ')})` : '#6554C0',
                          borderRadius: 4, cursor: _isLocked ? 'not-allowed' : 'grab', opacity: 0.88,
                          display: 'flex', alignItems: 'center', paddingLeft: 6, paddingRight: 18, gap: 4,
                          overflow: 'hidden', userSelect: 'none',
                          border: conflictingKeys.has(row.key) ? '2px solid #FF5630' : _isLocked ? '2px solid #5E6C84' : _statusBorder ? `3px solid ${_statusBorder}` : '2px solid rgba(255,255,255,0.25)',
                          outline: criticalPathKeys.has(row.key) && !conflictingKeys.has(row.key) ? '2px solid #FF991F' : 'none',
                          outlineOffset: 1,
                          boxShadow: conflictingKeys.has(row.key)
                            ? '0 0 0 2px rgba(255,86,48,0.25), 0 1px 4px rgba(0,0,0,0.18)'
                            : criticalPathKeys.has(row.key)
                            ? '0 0 0 2px rgba(255,153,31,0.3), 0 1px 4px rgba(0,0,0,0.18)'
                            : '0 1px 4px rgba(0,0,0,0.18)',
                        }} title={`${row.key}: ${bar.startDate} → ${bar.endDate} (${bar.durationDays}d)${
                          _lockedByChildren
                            ? ` — spans ${bar.lockedChildKeys.length} stor${bar.lockedChildKeys.length === 1 ? 'y' : 'ies'} locked to their Jira dates; click 🔒 to unlock them`
                            : _lockedDirectly
                            ? " — locked to Jira's Start/Due dates; click 🔒 to unlock and move it"
                            : remainingEstMap[row.key] === 0
                            ? ' — no dev hours left (all stories dev-done); shown as a 1-day marker, with QA/Fix time still reserved after it'
                            : ''
                        }${_isLocked ? '' : ' — drag to move'}`}>
                        {_lockedByChildren ? (
                          <span onClick={e => { e.stopPropagation(); unlockAllChildren(bar.lockedChildKeys); }}
                            title={`Locked by ${bar.lockedChildKeys.length} child stor${bar.lockedChildKeys.length === 1 ? 'y' : 'ies'} with Jira dates — click to unlock them`}
                            style={{ fontSize: 10, color: '#fff', flexShrink: 0, cursor: 'pointer' }}>🔒</span>
                        ) : _lockedDirectly && (
                          <span onClick={e => { e.stopPropagation(); unlockJiraDates(row.key); }}
                            title="Locked to Jira's Start/Due dates — click to unlock and drag freely"
                            style={{ fontSize: 10, color: '#fff', flexShrink: 0, cursor: 'pointer' }}>🔒</span>
                        )}
                        <span style={{ fontSize: 10, color: '#fff', fontWeight: 700, flexShrink: 0 }}>{bar.durationDays}d</span>
                        {phs.slice(0, 3).map(ph => (
                          <span key={ph.id} title={typeof ph.capacityPct === 'number' && ph.capacityPct < 100 ? `${ph.name} (${ph.capacityPct}% capacity)` : ph.name} style={{
                            width: 12, height: 12, borderRadius: '50%', background: 'rgba(255,255,255,0.35)',
                            border: typeof ph.capacityPct === 'number' && ph.capacityPct < 100 ? '1.5px dashed rgba(255,255,255,0.9)' : '1.5px solid rgba(255,255,255,0.7)',
                            flexShrink: 0, fontSize: 8,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
                          }}>{ph.name[0]}</span>
                        ))}
                        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          {row.key}
                        </span>
                        {/* Hidden while locked (either way): if locked-by-children, the bar's
                            span comes from those stories, not this epic's own entry, so
                            clearing the epic's entry would silently do nothing; if locked
                            directly, removing it here would just leave placeOnTimeline to
                            re-lock it on the very next drop. Unlock via the 🔒 above instead. */}
                        {!_isLocked && (
                          <button
                            onClick={e => { e.stopPropagation(); updateIssueEntry(row.key, { startDate: null, dependencies: [] }); }}
                            title="Remove from timeline"
                            style={{
                              position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)',
                              background: 'rgba(0,0,0,0.3)', border: 'none', borderRadius: '50%',
                              width: 14, height: 14, cursor: 'pointer', color: '#fff', fontSize: 10,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              lineHeight: 1, padding: 0,
                            }}
                          >×</button>
                        )}
                      </div>
                      {_qaDays > 0 && (
                        <div style={{
                          position: 'absolute',
                          left: bar.left + bar.durationDays * DAY_WIDTH,
                          top: 5, width: _qaDays * DAY_WIDTH - 2, height: ROW_HEIGHT - 10,
                          background: '#FFAB00', borderRadius: 4, opacity: 0.85,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 9, color: '#fff', fontWeight: 700, pointerEvents: 'none',
                        }} title={`QA testing: ${_qaDays}d`}>QA {_qaDays}d</div>
                      )}
                      {_bfDays > 0 && (
                        <div style={{
                          position: 'absolute',
                          left: bar.left + (bar.durationDays + _qaDays) * DAY_WIDTH,
                          top: 5, width: _bfDays * DAY_WIDTH - 2, height: ROW_HEIGHT - 10,
                          background: '#FF7452', borderRadius: 4, opacity: 0.85,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 9, color: '#fff', fontWeight: 700, pointerEvents: 'none',
                        }} title={`Bug fix time: ${_bfDays}d`}>Fix {_bfDays}d</div>
                      )}
                      </>);
                    })()) : row._isEpic ? (() => {
                      const isExpanded = expandedEpics.has(row.key);
                      const sb = getEpicSummaryBarProps(row.key, storiesByEpic, subtasksByStory, computedPlan, roughMap, workingDays, DAY_WIDTH);
                      if (!sb) return null;
                      const barColor = phs.length === 1 ? phs[0].color : '#6554C0';
                      const _fStories = (storiesByEpic[row.key] || []).filter(s => computedPlan.issues?.[s.key]?.startDate);
                      const _fTotalHours = _fStories.reduce((s, st) => s + (roughMap[st.key] || 0), 0);
                      const _fAvgDevs = _fStories.length > 0
                        ? Math.max(1, _fStories.reduce((s, st) => s + effectiveDevCount(computedPlan.issues?.[st.key]?.assignedPlaceholders, computedPlan.placeholders), 0) / _fStories.length)
                        : 1;
                      const { qaDays: _fqd, bugFixDays: _fbfd } = calcQaBugFixDays(_fTotalHours, _fAvgDevs, qaMap[row.key] || 0, bugFixPct);
                      const _fQaLeft = sb.left + sb.width + 2;
                      return (
                        <>
                        <div style={{
                          position: 'absolute',
                          left: sb.left, top: isExpanded ? 4 : 5,
                          width: sb.width, height: isExpanded ? 8 : ROW_HEIGHT - 10,
                          background: isExpanded ? 'transparent' : barColor,
                          border: isExpanded ? `2px solid ${barColor}` : 'none',
                          borderRadius: 4, opacity: 0.9,
                          display: 'flex', alignItems: 'center', paddingLeft: 6,
                          fontSize: 10, color: isExpanded ? barColor : '#fff', fontWeight: 700,
                          overflow: 'hidden', whiteSpace: 'nowrap', userSelect: 'none',
                          boxShadow: isExpanded ? 'none' : '0 1px 4px rgba(0,0,0,0.18)',
                          pointerEvents: 'none',
                        }} title={`${sb.placedStories}/${sb.totalStories} stories placed`}>
                          {!isExpanded && `${sb.placedStories}/${sb.totalStories} stories`}
                        </div>
                        {!isExpanded && _fqd > 0 && (
                          <div style={{
                            position: 'absolute',
                            left: _fQaLeft, top: 5, width: _fqd * DAY_WIDTH - 2, height: ROW_HEIGHT - 10,
                            background: '#FFAB00', borderRadius: 4, opacity: 0.85,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 9, color: '#fff', fontWeight: 700, pointerEvents: 'none',
                          }} title={`QA testing: ${_fqd}d`}>QA {_fqd}d</div>
                        )}
                        {!isExpanded && _fbfd > 0 && (
                          <div style={{
                            position: 'absolute',
                            left: _fQaLeft + _fqd * DAY_WIDTH, top: 5, width: _fbfd * DAY_WIDTH - 2, height: ROW_HEIGHT - 10,
                            background: '#FF7452', borderRadius: 4, opacity: 0.85,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 9, color: '#fff', fontWeight: 700, pointerEvents: 'none',
                          }} title={`Bug fix time: ${_fbfd}d`}>Fix {_fbfd}d</div>
                        )}
                        </>
                      );
                    })() : bar?.isContainer ? (
                      <div
                        draggable
                        onDragStart={e => {
                          e.stopPropagation();
                          window.__versionPlanDrag = { issueKey: row.key };
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => { window.__versionPlanDrag = null; }}
                        style={{
                          position: 'absolute',
                          left: bar.left, top: 6,
                          width: bar.width, height: ROW_HEIGHT - 12,
                          background: phs.length === 1 ? phs[0].color : phs.length > 1 ? `linear-gradient(90deg, ${phs.map(p => p.color).join(', ')})` : '#97A0AF',
                          border: '2px dashed rgba(255,255,255,0.75)', borderRadius: 4, opacity: 0.88,
                          display: 'flex', alignItems: 'center', paddingLeft: 6, cursor: 'grab',
                          fontSize: 9, color: '#fff', fontWeight: 700,
                          overflow: 'hidden', whiteSpace: 'nowrap', userSelect: 'none',
                        }}
                        title={`${row.key}: ${bar.startDate} → ${bar.endDate} — spans ${bar.placedSubtasks}/${bar.totalSubtasks} subtasks — drag to reschedule all subtasks from a new start date`}
                      >
                        {bar.placedSubtasks}/{bar.totalSubtasks} subtasks
                      </div>
                    ) : bar && (
                      <div
                        draggable
                        onDragStart={e => {
                          e.stopPropagation();
                          window.__versionPlanDrag = { issueKey: row.key };
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => { window.__versionPlanDrag = null; }}
                        style={{
                          position: 'absolute',
                          left: bar.left, top: 5,
                          width: bar.width, height: ROW_HEIGHT - 10,
                          // Pinned to Jira's own Start/Due dates → deliberately grey, not the
                          // developer's color: the bar's position is Jira's fact, not a plan choice.
                          background: entry.jiraLocked
                            ? '#8993A4'
                            : phs.length === 1 ? phs[0].color : phs.length > 1 ? `linear-gradient(90deg, ${phs.map(p => p.color).join(', ')})` : '#97A0AF',
                          borderRadius: 4, cursor: entry.jiraLocked ? 'not-allowed' : 'grab', opacity: entry.borrowedFromParent ? 0.45 : 0.88,
                          display: 'flex', alignItems: 'center', paddingLeft: 6, paddingRight: 18, gap: 4,
                          overflow: 'hidden', userSelect: 'none',
                          border: conflictingKeys.has(row.key) ? '2px solid #FF5630' : entry.jiraLocked ? '2px solid #5E6C84' : statusBorderColor(row.fields?.status?.name) ? `3px solid ${statusBorderColor(row.fields?.status?.name)}` : bar.isActual ? '4px solid #00875A' : 'none',
                          outline: criticalPathKeys.has(row.key) && !conflictingKeys.has(row.key) ? '2px solid #FF991F' : 'none',
                          outlineOffset: 1,
                          boxShadow: conflictingKeys.has(row.key)
                            ? '0 0 0 2px rgba(255,86,48,0.25), 0 1px 4px rgba(0,0,0,0.18)'
                            : criticalPathKeys.has(row.key)
                            ? '0 0 0 2px rgba(255,153,31,0.3), 0 1px 4px rgba(0,0,0,0.18)'
                            : '0 1px 4px rgba(0,0,0,0.18)',
                        }} title={`${row.key}: ${bar.startDate} → ${bar.endDate} (${bar.durationDays}d)${entry.jiraLocked ? " — locked to Jira's Start/Due dates; click the 🔒 to unlock and move it" : bar.isActual ? ' — actual dates from Jira status history' : ''}${entry.borrowedFromParent ? ' — dev inherited from parent story' : ''}${entry.jiraLocked ? '' : ' — drag to move'}`}>
                        {entry.jiraLocked ? (
                          <span onClick={e => { e.stopPropagation(); unlockJiraDates(row.key); }}
                            title="Locked to Jira's Start/Due dates — click to unlock and drag freely"
                            style={{ fontSize: 10, color: '#fff', flexShrink: 0, cursor: 'pointer' }}>🔒</span>
                        ) : bar.isActual && (
                          <span style={{ fontSize: 9, color: '#fff', flexShrink: 0 }} title="Actual dates from Jira status history — drag to override">🔒</span>
                        )}
                        <span style={{ fontSize: 10, color: '#fff', fontWeight: 700, flexShrink: 0 }}>{bar.durationDays}d</span>
                        {phs.slice(0, 3).map(ph => (
                          <span key={ph.id} title={typeof ph.capacityPct === 'number' && ph.capacityPct < 100 ? `${ph.name} (${ph.capacityPct}% capacity)` : ph.name} style={{
                            width: 12, height: 12, borderRadius: '50%', background: 'rgba(255,255,255,0.35)',
                            border: typeof ph.capacityPct === 'number' && ph.capacityPct < 100 ? '1.5px dashed rgba(255,255,255,0.9)' : '1.5px solid rgba(255,255,255,0.7)',
                            flexShrink: 0, fontSize: 8,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
                          }}>{ph.name[0]}</span>
                        ))}
                        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          {row.key}
                        </span>
                        <button
                          onClick={e => { e.stopPropagation(); updateIssueEntry(row.key, { startDate: null, dependencies: [] }); }}
                          title="Remove from timeline"
                          style={{
                            position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)',
                            background: 'rgba(0,0,0,0.3)', border: 'none', borderRadius: '50%',
                            width: 14, height: 14, cursor: 'pointer', color: '#fff', fontSize: 10,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            lineHeight: 1, padding: 0,
                          }}
                        >×</button>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* SVG layer: today line + dependency arrows + milestone lines.
                  pointerEvents 'none' on the ROOT svg is critical: this element is the last
                  sibling in the timeline stack, painted on top of every row's bar div beneath
                  it. Without this, the svg's own bounding box (the whole grid, every row/column)
                  swallows every mousedown/click before it ever reaches a bar or day-cell below —
                  no draggable ancestor to fall back to, so no drag ever starts and no click ever
                  fires, with zero errors. Individual children that need their own interactivity
                  (milestone line/label, dependency-arrow paths) already set their own explicit
                  pointerEvents value, which still works even though the parent is 'none'. */}
              <svg style={{ position: 'absolute', top: 0, left: 0, width: totalTimelineWidth, height: HEADER_H + sortedRows.length * ROW_HEIGHT, overflow: 'visible', pointerEvents: 'none' }}>
                <defs>
                  <marker id="arrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 Z" fill="#0052CC" />
                  </marker>
                </defs>

                {/* Today vertical line — non-interactive */}
                {todayIdx >= 0 && (
                  <line
                    x1={todayIdx * DAY_WIDTH + DAY_WIDTH / 2}
                    y1={HEADER_H}
                    x2={todayIdx * DAY_WIDTH + DAY_WIDTH / 2}
                    y2={HEADER_H + sortedRows.length * ROW_HEIGHT}
                    stroke="#FF5630" strokeWidth={1.5} strokeDasharray="4 3"
                    style={{ pointerEvents: 'none' }}
                  />
                )}

                {/* Sprint start/end lines — grey dotted, read-only reference pulled straight from
                    Jira's own sprint schedule for this project (useSprints), not editable here.
                    Drawn at the day-column edges (not the center, unlike today/milestone lines)
                    so they visually bracket the sprint's date range. */}
                {sprints.map(sprint => {
                  const startDateStr = sprint.startDate ? snapToWorkingDay(sprint.startDate.slice(0, 10)) : null;
                  const endDateStr = sprint.endDate ? snapToWorkingDay(sprint.endDate.slice(0, 10)) : null;
                  const startIdx = startDateStr ? workingDays.indexOf(startDateStr) : -1;
                  const endIdx = endDateStr ? workingDays.indexOf(endDateStr) : -1;
                  if (startIdx < 0 && endIdx < 0) return null;
                  const svgH = HEADER_H + sortedRows.length * ROW_HEIGHT;
                  return (
                    <g key={sprint.id} style={{ pointerEvents: 'none' }}>
                      {startIdx >= 0 && (<>
                        <line x1={startIdx * DAY_WIDTH} y1={HEADER_H} x2={startIdx * DAY_WIDTH} y2={svgH}
                          stroke="#97A0AF" strokeWidth={1.5} strokeDasharray="2 3" />
                        <text x={startIdx * DAY_WIDTH + 3} y={HEADER_H - 3} fontSize={8} fill="#97A0AF">{sprint.name}</text>
                      </>)}
                      {endIdx >= 0 && (
                        <line x1={(endIdx + 1) * DAY_WIDTH} y1={HEADER_H} x2={(endIdx + 1) * DAY_WIDTH} y2={svgH}
                          stroke="#97A0AF" strokeWidth={1.5} strokeDasharray="2 3" />
                      )}
                    </g>
                  );
                })}

                {/* Milestone vertical lines — the label pill itself now lives in the sticky
                    header above (see the block right after the date-header day cells) since it
                    was rendering BEHIND that header's own stacking context here — invisible and
                    unclickable. The dashed line down through the rows still lives here and is
                    independently clickable to edit, same as before. */}
                {(computedPlan.milestones || []).map(m => {
                  const idx = workingDays.indexOf(m.date);
                  if (idx < 0) return null;
                  const x = idx * DAY_WIDTH + DAY_WIDTH / 2;
                  return (
                    <line key={m.id} onClick={() => setEditingMilestone({ ...m })}
                      x1={x} y1={HEADER_H} x2={x} y2={HEADER_H + sortedRows.length * ROW_HEIGHT}
                      stroke={m.color} strokeWidth={2} strokeDasharray="5 3"
                      style={{ pointerEvents: 'stroke', cursor: 'pointer' }} />
                  );
                })}

                {/* Code freeze + stabilization overlay — Draft mode only */}
                {planningMode === 'draft' && codeFreezeDate && (() => {
                  const cfIdx = workingDays.indexOf(codeFreezeDate);
                  const seIdx = stabilizationEndDate ? workingDays.indexOf(stabilizationEndDate) : -1;
                  if (stabilizationEndDate && seIdx < 0) console.warn('[planJira] stabilizationEndDate', stabilizationEndDate, 'outside workingDays — delivery line hidden');
                  const svgH = HEADER_H + sortedRows.length * ROW_HEIGHT;
                  return (
                    <>
                      {cfIdx >= 0 && seIdx > cfIdx && (
                        <rect
                          x={cfIdx * DAY_WIDTH} y={HEADER_H}
                          width={(seIdx + 1 - cfIdx) * DAY_WIDTH} height={sortedRows.length * ROW_HEIGHT}
                          fill="rgba(0,82,204,0.06)" style={{ pointerEvents: 'none' }}
                        />
                      )}
                      {cfIdx >= 0 && (
                        <g style={{ pointerEvents: 'none' }}>
                          <line x1={cfIdx * DAY_WIDTH + DAY_WIDTH / 2} y1={HEADER_H}
                            x2={cfIdx * DAY_WIDTH + DAY_WIDTH / 2} y2={svgH}
                            stroke="#172B4D" strokeWidth={2} strokeDasharray="6 3" />
                          <rect x={cfIdx * DAY_WIDTH + DAY_WIDTH / 2 - 1} y={HEADER_H - 18}
                            width={80} height={16} fill="#172B4D" rx={3} />
                          <text x={cfIdx * DAY_WIDTH + DAY_WIDTH / 2 + 3} y={HEADER_H - 6}
                            fontSize={9} fill="#fff" fontWeight="bold">Code Freeze</text>
                        </g>
                      )}
                      {seIdx >= 0 && (
                        <g style={{ pointerEvents: 'none' }}>
                          <line x1={seIdx * DAY_WIDTH + DAY_WIDTH / 2} y1={HEADER_H}
                            x2={seIdx * DAY_WIDTH + DAY_WIDTH / 2} y2={svgH}
                            stroke="#36B37E" strokeWidth={2} strokeDasharray="6 3" />
                          <rect x={seIdx * DAY_WIDTH + DAY_WIDTH / 2 - 1} y={HEADER_H - 18}
                            width={58} height={16} fill="#36B37E" rx={3} />
                          <text x={seIdx * DAY_WIDTH + DAY_WIDTH / 2 + 3} y={HEADER_H - 6}
                            fontSize={9} fill="#fff" fontWeight="bold">Delivery</text>
                        </g>
                      )}
                    </>
                  );
                })()}

                {/* Dependency arrows */}
                {sortedRows.map((row, rowIdx) => {
                  const entry = computedPlan.issues?.[row.key] || {};
                  return (entry.dependencies || []).map(depKey => {
                    const depRowIdx = sortedRows.findIndex(r => r.key === depKey);
                    const sourceBar = getBarProps(depKey);
                    const targetBar = getBarProps(row.key);
                    if (depRowIdx < 0 || !sourceBar || !targetBar) return null;
                    // In draft mode, arrow leaves from end of QA+bugfix bar, not just dev bar
                    let arrowSrcX = sourceBar.left + sourceBar.width;
                    if (planningMode === 'draft') {
                      const _sDevs = effectiveDevCount(computedPlan.issues?.[depKey]?.assignedPlaceholders, computedPlan.placeholders);
                      const { qaDays: _sqd, bugFixDays: _sbfd } = calcQaBugFixDays(qaBaseMap[depKey], _sDevs, qaMap[depKey] || 0, bugFixPct);
                      arrowSrcX = sourceBar.left + (sourceBar.durationDays + _sqd + _sbfd) * DAY_WIDTH - 2;
                    }
                    const sx = arrowSrcX;
                    const sy = HEADER_H + depRowIdx * ROW_HEIGHT + ROW_HEIGHT / 2;
                    const tx = targetBar.left;
                    const ty = HEADER_H + rowIdx * ROW_HEIGHT + ROW_HEIGHT / 2;
                    const cx = sx + Math.abs(tx - sx) / 2;
                    // Midpoint of the cubic at t=0.5, for placing the ⇄ reverse handle.
                    const mx = 0.125 * sx + 0.375 * cx + 0.375 * cx + 0.125 * tx;
                    const my = 0.125 * sy + 0.375 * sy + 0.375 * ty + 0.125 * ty;
                    return (
                      <g key={`${depKey}->${row.key}`}>
                        <path
                          d={`M ${sx} ${sy} C ${cx} ${sy} ${cx} ${ty} ${tx} ${ty}`}
                          stroke="#0052CC" strokeWidth={1.5} fill="none" markerEnd="url(#arrow)"
                          style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                          onClick={e => { if (e.shiftKey) reverseDependency(depKey, row.key); else removeDependency(depKey, row.key); }}
                        >
                          <title>{`${depKey} → ${row.key}: click the line to remove, Shift+click (or the ⇄ handle) to reverse`}</title>
                        </path>
                        {/* ⇄ handle — reverses the direction. Needs pointerEvents 'auto'
                            because the whole SVG overlay is 'none' (see the root <svg>). */}
                        <g style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                          onClick={e => { e.stopPropagation(); reverseDependency(depKey, row.key); }}>
                          <title>{`Reverse: make ${row.key} run before ${depKey}`}</title>
                          <circle cx={mx} cy={my} r={7} fill="#fff" stroke="#0052CC" strokeWidth={1.25} />
                          <text x={mx} y={my + 3} textAnchor="middle" fontSize={9} fontWeight="bold" fill="#0052CC">⇄</text>
                        </g>
                      </g>
                    );
                  });
                })}

                {/* Derived parent (story-level) dependency arrows — Epic Timeline mode.
                    When a subtask in story B depends on a subtask in story A, draw a
                    dashed arrow between the parent story bars too, so the chain stays
                    visible even at the story level (or with subtasks collapsed). */}
                {planningMode === 'epic' && (() => {
                  const parentOfSub = {};
                  for (const story of (storiesByEpic[focusEpicKey] || [])) {
                    for (const sub of (subtasksByStory[story.key] || [])) parentOfSub[sub.key] = story.key;
                  }
                  const seenPairs = new Set();
                  const arrows = [];
                  for (const [key, entry] of Object.entries(computedPlan.issues || {})) {
                    const childParent = parentOfSub[key];
                    if (!childParent) continue;
                    for (const depKey of (entry.dependencies || [])) {
                      const depParent = parentOfSub[depKey];
                      if (!depParent || depParent === childParent) continue;
                      // If both parent stories are expanded, the real subtask-level arrow
                      // above already shows this exact chain — a second, story-level arrow
                      // drawn to the same (now-collapsed-summary) endpoints would just
                      // overlap it and look wrong. Only draw the derived one when at least
                      // one side is collapsed.
                      if (expandedStories.has(depParent) && expandedStories.has(childParent)) continue;
                      const pairId = depParent + '->' + childParent;
                      if (seenPairs.has(pairId)) continue;
                      seenPairs.add(pairId);
                      const srcIdx = sortedRows.findIndex(r => r.key === depParent);
                      const tgtIdx = sortedRows.findIndex(r => r.key === childParent);
                      const srcBar = getBarProps(depParent);
                      const tgtBar = getBarProps(childParent);
                      if (srcIdx < 0 || tgtIdx < 0 || !srcBar || !tgtBar) continue;
                      const sx = srcBar.left + srcBar.width;
                      const sy = HEADER_H + srcIdx * ROW_HEIGHT + ROW_HEIGHT / 2;
                      const tx = tgtBar.left;
                      const ty = HEADER_H + tgtIdx * ROW_HEIGHT + ROW_HEIGHT / 2;
                      const cx = sx + Math.abs(tx - sx) / 2;
                      arrows.push(
                        <path key={`story:${pairId}`}
                          d={`M ${sx} ${sy} C ${cx} ${sy} ${cx} ${ty} ${tx} ${ty}`}
                          stroke="#6554C0" strokeWidth={1.5} strokeDasharray="5 3" fill="none" markerEnd="url(#arrow)"
                          style={{ pointerEvents: 'none' }}
                        />
                      );
                    }
                  }
                  return arrows;
                })()}
              </svg>
            </div>
          </div>
        </div>
      )}
      </div>

      {/* ── Right-hand side panel — one tab open at a time ── */}
      {activePanel && selectedPlanId && (
        <SidePanel
          title={
            activePanel === 'summary' ? '📊 Summary' :
            activePanel === 'settings' ? '⚙ Settings' :
            activePanel === 'team' ? '👥 Team' :
            activePanel === 'tools' ? '🔗 Tools' :
            '🐛 Debug'
          }
          onClose={() => setActivePanel(null)}
        >
          {activePanel === 'summary' && (
            <SummaryPanelContent
              computedPlan={computedPlan}
              roughMapArg={schedMap}
              rows={rows}
              conflicts={conflicts}
              missingEstMap={missingEstMap}
              estSource={estSource}
              planningMode={planningMode}
              updateIssueEntry={updateIssueEntry}
            />
          )}

          {activePanel === 'settings' && (
            <div style={{ padding: 14, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                  <div style={{ fontWeight: 700, color: '#172B4D', marginBottom: 6 }}>Estimate source</div>
                  <div style={{ display: 'flex', border: '1.5px solid #DFE1E6', borderRadius: 4, overflow: 'hidden', width: 'fit-content' }}>
                    <button onClick={() => setEstSource('rough')} style={{
                      padding: '5px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      background: estSource === 'rough' ? '#0052CC' : '#fff',
                      color: estSource === 'rough' ? '#fff' : '#42526E', border: 'none',
                    }} title="Use the Rough Estimation custom field">Rough Est</button>
                    <button onClick={() => setEstSource('children')} style={{
                      padding: '5px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      background: estSource === 'children' ? '#0052CC' : '#fff',
                      color: estSource === 'children' ? '#fff' : '#42526E',
                      border: 'none', borderLeft: '1px solid #DFE1E6',
                    }} title={planningMode === 'draft' ? "Sum each epic's stories' original estimates" : "Sum children's (tasks/subtasks) original estimates"}>Children Sum</button>
                  </div>
                </div>

              {planningMode === 'draft' && (
                <div>
                  <div style={{ fontWeight: 700, color: '#172B4D', marginBottom: 6 }}>Dependencies</div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#42526E', cursor: 'pointer' }}
                    title="When you drop an epic, automatically chain it behind the latest epic before it that shares a developer — one person can't work two epics at once. The bar snaps to just after that epic rather than exactly where you released it.">
                    <input type="checkbox" checked={autoDepByDev} onChange={e => setAutoDepByDev(e.target.checked)} />
                    Auto-chain epics sharing a developer
                  </label>
                </div>
              )}

              {planningMode === 'draft' && (
                <div>
                  <div style={{ fontWeight: 700, color: '#172B4D', marginBottom: 6 }}>QA / bug-fix / stabilization</div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label style={{ color: '#5E6C84', fontWeight: 600 }}>Bug fix:</label>
                    <input type="number" value={bugFixPct} min={0} max={100}
                      onChange={e => setBugFixPct(Math.max(0, Math.min(100, Number(e.target.value))))}
                      title="% of dev time developers spend fixing bugs after QA"
                      style={{ width: 46, padding: '4px 6px', fontSize: 12, border: '1.5px solid #DFE1E6', borderRadius: 4, textAlign: 'center' }} />
                    <span style={{ color: '#5E6C84' }}>%</span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                    <label style={{ color: '#5E6C84', fontWeight: 600 }}>Freeze:</label>
                    <input type="number" value={codeFreezeDays} min={0}
                      onChange={e => setCodeFreezeDays(Math.max(0, Number(e.target.value)))}
                      title="Working days between last epic and code freeze"
                      style={{ width: 40, padding: '4px 6px', fontSize: 12, border: '1.5px solid #DFE1E6', borderRadius: 4, textAlign: 'center' }} />
                    <span style={{ color: '#5E6C84' }}>d</span>
                    <label style={{ color: '#5E6C84', fontWeight: 600, marginLeft: 6 }}>Stab:</label>
                    <input type="number" value={stabilizationDays} min={0}
                      onChange={e => setStabilizationDays(Math.max(0, Number(e.target.value)))}
                      title="Working days of stabilization after code freeze"
                      style={{ width: 40, padding: '4px 6px', fontSize: 12, border: '1.5px solid #DFE1E6', borderRadius: 4, textAlign: 'center' }} />
                    <span style={{ color: '#5E6C84' }}>d</span>
                  </div>
                </div>
              )}

              {planningMode === 'epic' && (
                <div>
                  <div style={{ fontWeight: 700, color: '#172B4D', marginBottom: 6 }}>Dependency buffer</div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <label style={{ color: '#5E6C84', fontWeight: 600 }}>Buffer:</label>
                    <input type="number" value={bufferDays} min={0}
                      onChange={e => setBufferDays(Math.max(0, Number(e.target.value)))}
                      title="Extra working days after a dependency ends before its dependent can start"
                      style={{ width: 40, padding: '4px 6px', fontSize: 12, border: '1.5px solid #DFE1E6', borderRadius: 4, textAlign: 'center' }} />
                    <span style={{ color: '#5E6C84' }}>d</span>
                  </div>
                </div>
              )}

              <div>
                <div style={{ fontWeight: 700, color: '#172B4D', marginBottom: 6 }}>Plan start date</div>
                <input type="date" value={planStart} onChange={e => setPlanStart(snapToWorkingDay(e.target.value))}
                  style={{ padding: '5px 8px', fontSize: 12, border: '1.5px solid #DFE1E6', borderRadius: 4 }} />
              </div>

              {selectedPlanId && !isFinalContext && (
                <div>
                  <div style={{ fontWeight: 700, color: '#172B4D', marginBottom: 6 }}>Plan management</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button onClick={() => setPlanDialog({ type: 'saveas', defaultName: (planIndex.find(p => p.id === selectedPlanId)?.name || '') + ' (copy)' })}
                      style={btnStyle('#E9F2FF', '#0052CC', '#B3D4FF')}>Save as…</button>
                    <button onClick={() => setPlanDialog({ type: 'rename', planId: selectedPlanId, defaultName: planIndex.find(p => p.id === selectedPlanId)?.name || '' })}
                      style={btnStyle('#F4F5F7', '#42526E', '#DFE1E6')}>Rename</button>
                    <button onClick={() => setPlanDialog({ type: 'delete', planId: selectedPlanId })}
                      style={btnStyle('#FFEBE6', '#DE350B', '#FF8F73')}>Delete</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {activePanel === 'team' && (
            <div style={{ padding: 14, fontSize: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(plan.placeholders || []).map(ph => (
                  <div key={ph.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {editingPhId === ph.id ? (
                      <input autoFocus value={editingPhValue}
                        onChange={e => setEditingPhValue(e.target.value)}
                        onBlur={() => { renamePlaceholder(ph.id, editingPhValue); setEditingPhId(null); }}
                        onKeyDown={e => { if (e.key === 'Enter') { renamePlaceholder(ph.id, editingPhValue); setEditingPhId(null); } }}
                        style={{ width: 120, fontSize: 12, border: `1.5px solid ${ph.color}`, borderRadius: 4, padding: '3px 6px' }}
                      />
                    ) : (
                      <>
                        <Chip label={ph.name} color={ph.color} initials={devInitials(ph.name)}
                          selected={focusDevId === ph.id}
                          onClick={() => setFocusDevId(prev => prev === ph.id ? null : ph.id)}
                          onRemove={() => removePlaceholder(ph.id)} />
                        <span style={{ fontSize: 10, color: '#97A0AF', flexShrink: 0 }}>
                          {assignedCountByDev[ph.id] || 0}
                        </span>
                        <span onClick={() => { setEditingPhId(ph.id); setEditingPhValue(ph.name); }}
                          title="Rename" style={{ cursor: 'pointer', fontSize: 11, color: '#97A0AF', padding: '0 2px' }}>✎</span>
                      </>
                    )}
                    <input type="number" min={1} max={100}
                      value={typeof ph.capacityPct === 'number' ? ph.capacityPct : 100}
                      onChange={e => setPlaceholderCapacity(ph.id, Number(e.target.value))}
                      title={`% of a full day this developer works on this plan — e.g. 80% = ${(HOURS_PER_DAY * 0.8).toFixed(1)}h/day instead of ${HOURS_PER_DAY}h/day`}
                      style={{ width: 42, marginLeft: 'auto', padding: '3px 5px', fontSize: 11, border: '1.5px solid #DFE1E6', borderRadius: 4, textAlign: 'center' }} />
                    <span style={{ fontSize: 11, color: '#5E6C84' }}>%</span>
                  </div>
                ))}
                {!(plan.placeholders || []).length && <span style={{ color: '#97A0AF' }}>No developers yet — add one below.</span>}
              </div>

              {focusDevId && (
                <button onClick={() => setFocusDevId(null)}
                  style={{ ...btnStyle('#FFEBE6', '#DE350B', '#FF8F73'), padding: '4px 10px', fontSize: 11, marginTop: 10 }}>
                  ✕ Show all (clear developer filter)
                </button>
              )}

              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 12 }}>
                <input value={newPhName} onChange={e => setNewPhName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && newPhName.trim()) { addPlaceholder(newPhName); setNewPhName(''); } }}
                  placeholder="+ Add developer"
                  style={{ fontSize: 12, border: '1.5px dashed #B3D4FF', borderRadius: 4, padding: '5px 8px', flex: 1, outline: 'none' }}
                />
                {newPhName.trim() && (
                  <button onClick={() => { addPlaceholder(newPhName); setNewPhName(''); }}
                    style={{ ...btnStyle('#E9F2FF', '#0052CC', '#B3D4FF'), padding: '4px 10px', fontSize: 11 }}>Add</button>
                )}
              </div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
                <button onClick={recolorPlaceholders} title="Reassign every developer's color from the current palette — fixes similar/duplicate colors"
                  style={{ ...btnStyle('#F4F5F7', '#42526E', '#DFE1E6'), padding: '4px 10px', fontSize: 11 }}>
                  🎨 Fix colors
                </button>
                <button onClick={pruneUnusedPlaceholders}
                  title="Remove every developer who isn't assigned to any issue in this plan. They won't be re-detected from Jira assignees afterwards — use ↺ Re-detect to undo."
                  style={{ ...btnStyle('#FFF0B3', '#974F0C', '#FFD700'), padding: '4px 10px', fontSize: 11 }}>
                  🧹 Keep only assigned
                </button>
                {(plan.dismissedAccountIds || []).length > 0 && (
                  <button onClick={resetDismissedAssignees}
                    title={`${(plan.dismissedAccountIds || []).length} removed developer(s) are being kept out of auto-detection — click to allow them back from Jira assignees`}
                    style={{ ...btnStyle('#E9F2FF', '#0052CC', '#B3D4FF'), padding: '4px 10px', fontSize: 11 }}>
                    ↺ Re-detect ({(plan.dismissedAccountIds || []).length})
                  </button>
                )}
              </div>
            </div>
          )}

          {activePanel === 'tools' && (
            <div style={{ padding: 14, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button onClick={() => { setDepsMode(m => !m); setDepsSource(null); }}
                style={btnStyle(depsMode ? '#FFF0B3' : '#F4F5F7', depsMode ? '#974F0C' : '#42526E', depsMode ? '#FFD700' : '#DFE1E6')}>
                {depsMode ? (depsSource ? `→ Click target` : '→ Click source') : '+ Dependency'}
              </button>
              <button onClick={() => setEditingMilestone({ id: null, label: '', date: workingDays[10] || TODAY_STR, color: MILESTONE_COLORS[0] })}
                style={btnStyle('#F4F5F7', '#42526E', '#DFE1E6')}>
                + Milestone
              </button>
              {planningMode === 'epic' && (
                <button onClick={exportTimelineHtml} title="Download a self-contained HTML report: summary, timeline, milestones, critical path, team utilization, and the full debug table"
                  style={btnStyle('#E9F2FF', '#0052CC', '#B3D4FF')}>
                  ⬇ Export HTML
                </button>
              )}
              <button onClick={exportPlanJson} disabled={!selectedPlanId}
                title="Download the full plan as JSON — dates, assignees, capacities, estimates, conflicts, everything the app knows. Works in every mode; handy for debugging a number that looks wrong, or feeding a dashboard."
                style={{ ...btnStyle('#EAE6FF', '#403294', '#C0B6F2'), opacity: selectedPlanId ? 1 : 0.5 }}>
                ⬇ Export JSON
              </button>
              <button onClick={sharePlan} disabled={!selectedPlanId}
                title="Copy a pointer to this exact plan for a teammate — they'll see and can edit the same stored plan, not a copy. Plans live in Jira, so anyone with access to this project can already open it; this just tells them which project/version/plan to pick."
                style={{ ...btnStyle('#E3FCEF', '#00875A', '#ABF5D1'), opacity: selectedPlanId ? 1 : 0.5 }}>
                🔗 Share plan
              </button>
              {shareNote && (
                <div style={{ fontSize: 11, color: shareNote.startsWith('✗') ? '#DE350B' : '#00875A', padding: '2px 2px 0' }}>
                  {shareNote}
                </div>
              )}
              <div style={{ borderTop: '1px solid #DFE1E6', marginTop: 4, paddingTop: 10 }}>
                <button onClick={() => setPlanDialog({ type: 'clearAllScheduling' })} title="Unschedule everything in view — keeps developers and milestones"
                  style={{ ...btnStyle('#FFF0B3', '#974F0C', '#FFD700'), width: '100%' }}>
                  Clear all scheduling
                </button>
                <button onClick={() => setPlanDialog({ type: 'clear' })}
                  style={{ ...btnStyle('#FFEBE6', '#DE350B', '#FF8F73'), width: '100%', marginTop: 8 }}>
                  Clear plan
                </button>
              </div>
            </div>
          )}

          {activePanel === 'debug' && planningMode === 'epic' && (
            <div style={{ fontSize: 11 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid #DFE1E6' }}>
                <strong style={{ color: '#172B4D' }}>{focusEpicKey || '(no epic selected)'} — {debugRows.length} rows</strong>
                <button
                  onClick={() => {
                    const cols = ['key', 'type', 'parentKey', 'status', 'jiraAssignee', 'assignedDevs', 'borrowedFromParent', 'startDate', 'endDate', 'isActual', 'historyResolved', 'roughHours', 'dependencies'];
                    const header = cols.join('\t');
                    const lines = debugRows.map(r => cols.map(c => String(r[c] ?? '')).join('\t'));
                    const text = [header, ...lines].join('\n');
                    navigator.clipboard.writeText(text).then(() => {
                      setDebugCopied(true);
                      setTimeout(() => setDebugCopied(false), 2000);
                    }).catch(() => {});
                  }}
                  style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', borderRadius: 4, border: '1px solid #DFE1E6', background: debugCopied ? '#00875A' : '#F4F5F7', color: debugCopied ? '#fff' : '#42526E' }}>
                  {debugCopied ? '✓ Copied' : '⎘ Copy table'}
                </button>
              </div>
              <div style={{ overflow: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                  <thead>
                    <tr style={{ background: '#F4F5F7' }}>
                      {['Key', 'Type', 'Parent', 'Status', 'Assignee', 'Dev(s)', 'Borrowed?', 'Start', 'End', 'Actual?', 'Resolved?', 'Hrs', 'Deps'].map(h => (
                        <th key={h} style={{ padding: '4px 6px', textAlign: 'left', borderBottom: '1px solid #DFE1E6', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {debugRows.map(r => (
                      <tr key={r.key} style={{ borderBottom: '1px solid #F4F5F7' }}>
                        <td style={{ padding: '3px 6px', whiteSpace: 'nowrap', fontWeight: r.type !== 'Subtask' ? 700 : 400 }}>{r.key}</td>
                        <td style={{ padding: '3px 6px' }}>{r.type}</td>
                        <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }}>{r.parentKey}</td>
                        <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }}>{r.status}</td>
                        <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }}>{r.jiraAssignee}</td>
                        <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }}>{r.assignedDevs}</td>
                        <td style={{ padding: '3px 6px' }}>{r.borrowedFromParent ? 'yes' : ''}</td>
                        <td style={{ padding: '3px 6px', whiteSpace: 'nowrap', color: '#0052CC' }}>{r.startDate}</td>
                        <td style={{ padding: '3px 6px', whiteSpace: 'nowrap', color: '#0052CC' }}>{r.endDate}</td>
                        <td style={{ padding: '3px 6px' }}>{r.isActual ? '🔒' : ''}</td>
                        <td style={{ padding: '3px 6px' }}>{r.historyResolved ? '✓' : ''}</td>
                        <td style={{ padding: '3px 6px' }}>{r.roughHours}</td>
                        <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }}>{r.dependencies}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </SidePanel>
      )}
      </div>

      {/* ── Milestone editor dialog ── */}
      {editingMilestone !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(9,30,66,0.54)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setEditingMilestone(null); }}>
          <div style={{ background: '#fff', borderRadius: 8, padding: 24, width: 320, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#172B4D', marginBottom: 16 }}>
              {editingMilestone.id ? 'Edit Milestone' : 'Add Milestone'}
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={labelSt}>Label</label>
              <input value={editingMilestone.label} onChange={e => setEditingMilestone(m => ({ ...m, label: e.target.value }))}
                placeholder="e.g. End of Development" autoFocus style={inputSt} />
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={labelSt}>Date</label>
              <input type="date" value={editingMilestone.date} onChange={e => setEditingMilestone(m => ({ ...m, date: e.target.value }))} style={inputSt} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={labelSt}>Color</label>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                {MILESTONE_COLORS.map(c => (
                  <button key={c} onClick={() => setEditingMilestone(m => ({ ...m, color: c }))} style={{
                    width: 24, height: 24, borderRadius: '50%', background: c, border: editingMilestone.color === c ? '3px solid #172B4D' : '3px solid transparent', cursor: 'pointer', padding: 0,
                  }} />
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div>
                {editingMilestone.id && (
                  <button onClick={() => { removeMilestone(editingMilestone.id); setEditingMilestone(null); }}
                    style={btnStyle('#FFEBE6', '#DE350B', '#FF8F73')}>Delete</button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setEditingMilestone(null)} style={btnStyle('#F4F5F7', '#42526E', '#DFE1E6')}>Cancel</button>
                <button onClick={() => {
                  if (!editingMilestone.label || !editingMilestone.date) return;
                  const ms = { ...editingMilestone, id: editingMilestone.id || `ms_${Date.now()}` };
                  addMilestone(ms); setEditingMilestone(null);
                }} style={btnStyle('#0052CC', '#fff', 'transparent', true)}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Existing milestones list — hidden while maximized */}
      {!maximized && (computedPlan.milestones || []).length > 0 && (
        <div style={{ padding: '6px 16px', borderTop: '1px solid #F4F5F7', background: '#FAFBFC', display: 'flex', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>
          {(computedPlan.milestones || []).map(m => (
            <Chip key={m.id} label={`${m.label} (${m.date})`} color={m.color}
              onClick={() => setEditingMilestone({ ...m })}
              onRemove={() => removeMilestone(m.id)} />
          ))}
        </div>
      )}

      {/* ── Delivery report — hidden while maximized ── */}
      {!maximized && selectedPlanId && (
        <DeliveryReport
          computedPlan={computedPlan}
          roughMap={schedMap}
          planName={planIndex.find(p => p.id === selectedPlanId)?.name}
          mode={planningMode}
          codeFreezeDate={planningMode === 'draft' ? codeFreezeDate : null}
          finalDeliveryDate={planningMode === 'draft' ? stabilizationEndDate : null}
        />
      )}

      {/* Plan dialog */}
      {planDialog && (
        <PlanDialogModal
          dialog={planDialog}
          onClose={() => setPlanDialog(null)}
          onCreate={async function(name) { var newId = await createPlan(name); setSelectedPlanId(newId); }}
          onSaveAs={async function(name) { var newId = await createPlan(name, computedPlan); setSelectedPlanId(newId); }}
          onRename={async function(name) { await renamePlanInIndex(planDialog.planId, name); }}
          onDelete={async function() {
            await deletePlanFromIndex(planDialog.planId);
            var remaining = planIndex.filter(function(p) { return p.id !== planDialog.planId; });
            setSelectedPlanId(remaining[0] ? remaining[0].id : null);
          }}
          onClear={async function() { clearPlan(); }}
          onClearAllScheduling={async function(removeJiraDueDates) { await clearAllScheduling(removeJiraDueDates); }}
        />
      )}

      {/* Issue detail pane */}
      <IssueDetailPane
        issueKey={detailIssueKey}
        onClose={() => setDetailIssueKey(null)}
        onAddMilestone={(key, date) => {
          setDetailIssueKey(null);
          setEditingMilestone({ id: null, label: '', date: date || workingDays[0] || TODAY_STR, color: MILESTONE_COLORS[0] });
        }}
      />
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────
const cellStyle = { padding: '0 8px', fontSize: 11, display: 'flex', alignItems: 'center', flexShrink: 0 };
const labelSt = { display: 'block', fontSize: 11, fontWeight: 700, color: '#5E6C84', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 };
const inputSt = { width: '100%', padding: '7px 10px', border: '2px solid #DFE1E6', borderRadius: 4, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
function btnStyle(bg, color, border, filled) {
  return {
    padding: '5px 12px', borderRadius: 4, border: `1.5px solid ${border}`,
    background: bg, color, fontSize: 12, fontWeight: 600, cursor: 'pointer',
  };
}
