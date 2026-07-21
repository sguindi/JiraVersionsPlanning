import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { format, parseISO, addDays, getDay, isAfter } from 'date-fns';
import { useEpicHierarchy } from '../hooks/useEpicHierarchy';
import { useVersionPlan } from '../hooks/useVersionPlan';
import { resolveRoughEstField, updateIssueDueDate, updateRoughEstimation, getIssueChangelog } from '../api/bridge';
import IssueDetailPane from './IssueDetailPane';
import { cascadePlan, detectConflicts, calcEndDate, calcDays, nextWorkDay, addWorkingDays, buildWorkingDays, findCriticalPath, calcQaBugFixDays, HOURS_PER_DAY, isWeekend, snapToWorkingDay } from '../utils/planning';

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

// Normalizes a Jira status name for comparison: trims, lowercases, and strips ALL
// internal whitespace — so "To Do" / "ToDo" / "to  do" are all treated as identical.
function normalizeStatusName(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, '');
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

function buildRoughMap(mode, epics, storiesByEpic, subtasksByStory, fieldId) {
  const map = {};
  if (mode === 'rough') {
    const extract = (issue) => {
      if (!issue || !issue.key || !fieldId) return;
      const val = issue.fields && issue.fields[fieldId];
      if (val != null && !isNaN(Number(val)) && Number(val) > 0) {
        map[issue.key] = Number(val);
      }
    };
    epics.forEach(extract);
    Object.values(storiesByEpic).flat().forEach(extract);
    Object.values(subtasksByStory).flat().forEach(extract);
  } else {
    // children mode — subtasks are leaves, use their own timeoriginalestimate
    Object.values(subtasksByStory).flat().forEach(function(sub) {
      var own = sub.fields && sub.fields.timeoriginalestimate;
      if (own) map[sub.key] = own / 3600;
    });
    // stories: sum subtasks' timeoriginalestimate
    Object.values(storiesByEpic).flat().forEach(function(story) {
      var subs = (subtasksByStory && subtasksByStory[story.key]) || [];
      if (subs.length > 0) {
        var total = subs.reduce(function(t, sub) { return t + ((sub.fields && sub.fields.timeoriginalestimate) || 0); }, 0);
        if (total > 0) map[story.key] = total / 3600;
      } else {
        var own = story.fields && story.fields.timeoriginalestimate;
        if (own) map[story.key] = own / 3600;
      }
    });
    // epics: sum stories
    epics.forEach(function(epic) {
      var childStories = storiesByEpic[epic.key] || [];
      var epicSum = childStories.reduce(function(t, s) { return t + (map[s.key] || 0); }, 0);
      if (epicSum > 0) map[epic.key] = epicSum;
    });
  }
  return map;
}

function buildMissingEstMap(mode, epics, storiesByEpic, subtasksByStory, fieldId, roughMap) {
  var missing = {};
  if (mode === 'rough') {
    var checkIssue = function(issue) {
      if (!issue || !issue.key) return;
      var val = fieldId ? (issue.fields && issue.fields[fieldId]) : null;
      if (val == null || isNaN(Number(val)) || Number(val) <= 0) missing[issue.key] = true;
    };
    epics.forEach(checkIssue);
    Object.values(storiesByEpic).flat().forEach(checkIssue);
    Object.values(subtasksByStory).flat().forEach(checkIssue);
  } else {
    Object.values(subtasksByStory).flat().forEach(function(sub) {
      if (!(sub.fields && sub.fields.timeoriginalestimate)) missing[sub.key] = true;
    });
    Object.values(storiesByEpic).flat().forEach(function(story) {
      var subs = (subtasksByStory && subtasksByStory[story.key]) || [];
      if (subs.length > 0) {
        if (subs.some(function(s) { return !(s.fields && s.fields.timeoriginalestimate); })) {
          missing[story.key] = true;
        }
      } else if (!(story.fields && story.fields.timeoriginalestimate)) {
        missing[story.key] = true;
      }
    });
    epics.forEach(function(epic) {
      var childStories = storiesByEpic[epic.key] || [];
      if (childStories.length === 0) return;
      // A parent with children never needs its own estimate — only flag the epic when
      // its whole rolled-up total (buildRoughMap's own epic-sum) is unusable, not merely
      // because some individual child story happens to be flagged.
      if (!(roughMap && roughMap[epic.key] > 0)) missing[epic.key] = true;
    });
  }
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
      var devs = (entry.assignedPlaceholders || []).length || 1;
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
function getSortValue(row, col, roughMap, computedPlan) {
  var f = row.fields || {};
  var entry = (computedPlan.issues && computedPlan.issues[row.key]) || {};
  switch (col) {
    case 'key': return row.key;
    case 'summary': return (f.summary || '').toLowerCase();
    case 'est': { var h = roughMap[row.key]; return h == null ? -Infinity : h; }
    case 'assigned': return (entry.assignedPlaceholders || []).length;
    case 'qa': return entry.qaHours || 0;
    case 'days': {
      var devs = (entry.assignedPlaceholders || []).length || 0;
      var rh = roughMap[row.key];
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
    var devs = (e.assignedPlaceholders || []).length || 1;
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
    var devs = (e.assignedPlaceholders || []).length || 1;
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
  Object.entries(computedPlan.issues || {}).forEach(function(entry) {
    var key = entry[0], e = entry[1];
    if (!e.startDate) return;
    var hours = roughMapArg[key] || 0;
    var phs = e.assignedPlaceholders || [];
    phs.forEach(function(phId) {
      if (!utils[phId]) utils[phId] = 0;
      utils[phId] += hours / (phs.length || 1);
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

// ── Summary panel component ───────────────────────────────────────────────────
function SummaryPanel({ computedPlan, roughMapArg, rows, conflicts, planIndex, selectedPlanId }) {
  var [open, setOpen] = React.useState(false);
  var span = computeProjectSpan(computedPlan, roughMapArg);
  var unscheduled = computeUnscheduledItems(rows, computedPlan, roughMapArg);
  var critPath = computeCriticalPath(computedPlan, roughMapArg);
  var devUtils = computeDevUtilization(computedPlan, roughMapArg);
  var totalDays = workingDaysBetween(span.start, span.end);
  var unschHours = unscheduled.reduce(function(s, u) { return s + u.hours; }, 0);
  var placeholders = computedPlan.placeholders || [];
  var hasData = span.start || unscheduled.length > 0 || conflicts.length > 0;
  if (!hasData) return null;

  return (
    <div style={{ background: '#F4F5F7', borderBottom: '1px solid #DFE1E6', flexShrink: 0 }}>
      <button onClick={function() { setOpen(function(o) { return !o; }); }}
        style={{ width: '100%', textAlign: 'left', padding: '6px 16px', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
        <span style={{ fontSize: 10, color: '#5E6C84' }}>{open ? '▼' : '▶'}</span>
        <span style={{ fontWeight: 700, color: '#172B4D' }}>Summary</span>
        {span.start && <span style={{ color: '#5E6C84' }}>{span.start} → {span.end} · {totalDays}d</span>}
        {unscheduled.length > 0 && <span style={{ color: '#FF991F' }}>· {unscheduled.length} unscheduled ({(unschHours || 0).toFixed(0)}h)</span>}
        {conflicts.length > 0 && <span style={{ color: '#DE350B' }}>· {conflicts.length} conflict{conflicts.length !== 1 ? 's' : ''}</span>}
        {critPath.length > 0 && <span style={{ color: '#5E6C84', marginLeft: 'auto', fontSize: 11 }}>Critical path: {critPath.length} issues</span>}
      </button>

      {open && (
        <div style={{ padding: '0 16px 10px', fontSize: 11 }}>
          {/* Span */}
          {span.start && (
            <div style={{ marginBottom: 6, color: '#172B4D' }}>
              📅 <strong>{span.start}</strong> → <strong>{span.end}</strong>
              {totalDays > 0 && <span style={{ color: '#5E6C84' }}> · {totalDays} working days</span>}
            </div>
          )}

          {/* Unscheduled */}
          {unscheduled.length > 0 && (
            <div style={{ marginBottom: 6, color: '#974F0C' }}>
              ⚠ {unscheduled.length} stor{unscheduled.length === 1 ? 'y' : 'ies'} not yet scheduled
              {unschHours > 0 && <span> ({unschHours.toFixed(0)}h of work)</span>}
            </div>
          )}

          {/* Critical path */}
          {critPath.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <span style={{ color: '#DE350B', fontWeight: 700 }}>🔴 Critical path</span>
              <span style={{ color: '#5E6C84', marginLeft: 6 }}>
                {critPath.map(function(k) {
                  var e = computedPlan.issues && computedPlan.issues[k];
                  var devs = (e && e.assignedPlaceholders ? e.assignedPlaceholders.length : 0) || 1;
                  var d = calcDays(roughMapArg[k], devs);
                  return k + ' (' + d + 'd)';
                }).join(' → ')}
              </span>
              <span style={{ color: '#97A0AF', marginLeft: 8 }}>— any delay here pushes the end date</span>
            </div>
          )}

          {/* Developer utilization */}
          {placeholders.length > 0 && Object.keys(devUtils).length > 0 && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 4 }}>
              {placeholders.map(function(ph) {
                var hours = devUtils[ph.id] || 0;
                var cap = totalDays > 0 ? totalDays * HOURS_PER_DAY : 1;
                var pct = Math.min(hours / cap, 1);
                var barColor = pct > 1 ? '#FF5630' : pct > 0.8 ? '#FF991F' : ph.color;
                return (
                  <div key={ph.id} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 140 }}>
                    <span style={{ fontWeight: 600, color: ph.color, width: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ph.name}</span>
                    <div style={{ width: 80, height: 6, background: '#DFE1E6', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ height: '100%', background: barColor, borderRadius: 3, width: (pct * 100) + '%' }} />
                    </div>
                    <span style={{ color: '#5E6C84', whiteSpace: 'nowrap' }}>{hours.toFixed(0)}h</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Plan dialog modal (replaces window.prompt/confirm — blocked in Forge iframes) ─
function PlanDialogModal({ dialog, onClose, onCreate, onSaveAs, onRename, onDelete, onClear }) {
  var [nameValue, setNameValue] = React.useState(dialog.defaultName || '');
  var [busy, setBusy] = React.useState(false);
  var isNameType = dialog.type === 'new' || dialog.type === 'saveas' || dialog.type === 'rename';
  var titles = { new: 'New plan', saveas: 'Save plan as…', rename: 'Rename plan', delete: 'Delete plan', clear: 'Clear plan' };
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
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(9,30,66,0.54)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={function(e) { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 8, padding: 24, width: 320, boxShadow: '0 8px 32px rgba(0,0,0,0.22)' }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: '#172B4D', marginBottom: 14 }}>{titles[dialog.type]}</div>
        {isNameType && (
          <input autoFocus value={nameValue} onChange={function(e) { setNameValue(e.target.value); }}
            onKeyDown={function(e) { if (e.key === 'Enter') handleConfirm(); if (e.key === 'Escape') onClose(); }}
            placeholder="Plan name"
            style={{ width: '100%', padding: '8px 10px', border: '2px solid #DFE1E6', borderRadius: 4, fontSize: 13, outline: 'none', boxSizing: 'border-box', marginBottom: 16 }} />
        )}
        {!isNameType && (
          <p style={{ fontSize: 13, color: '#5E6C84', marginBottom: 16 }}>
            {dialog.type === 'delete' ? 'This plan and all its data will be permanently deleted.' : 'All assignments, placeholders, and milestones will be cleared.'}
          </p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ padding: '6px 14px', borderRadius: 4, border: '1.5px solid #DFE1E6', background: '#F4F5F7', color: '#42526E', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleConfirm} disabled={busy || (isNameType && !nameValue.trim())}
            style={{ padding: '6px 14px', borderRadius: 4, border: 'none', background: isDanger ? '#DE350B' : '#0052CC', color: '#fff', fontSize: 12, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', opacity: (isNameType && !nameValue.trim()) ? 0.5 : 1 }}>
            {busy ? '…' : labels[dialog.type]}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Small reusable UI pieces ───────────────────────────────────────────────────
function Chip({ label, color, onRemove, onClick, selected }) {
  return (
    <span onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: selected ? color + '33' : '#F4F5F7',
      border: `1.5px solid ${selected ? color : '#DFE1E6'}`,
      borderRadius: 12, padding: '2px 8px 2px 6px',
      fontSize: 11, fontWeight: 600, cursor: onClick ? 'pointer' : 'default',
      color: selected ? color : '#42526E',
    }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
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
      var cap = totalDays > 0 ? totalDays * HOURS_PER_DAY : 1;
      placeholders.forEach(function(ph) {
        var h = devUtils[ph.id] || 0;
        var pct = Math.round(h / cap * 100);
        lines.push('- **' + ph.name + '**: ' + h.toFixed(0) + 'h / ' + cap.toFixed(0) + 'h (' + pct + '%)');
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
                  var cap = totalDays > 0 ? totalDays * HOURS_PER_DAY : 1;
                  var pct = hours / cap;
                  var overloaded = pct > 1;
                  var barColor = overloaded ? '#FF5630' : pct > 0.8 ? '#FF991F' : ph.color;
                  return (
                    <div key={ph.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ width: 76, fontSize: 11, fontWeight: 600, color: ph.color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>{ph.name}</span>
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
  const [estSource, setEstSource] = useState('rough'); // 'rough' | 'children'
  const [planningMode, setPlanningMode] = useState('draft'); // 'draft' | 'final' | 'epic'
  const [bugFixPct, setBugFixPct] = useState(20);      // % of dev time spent on bug fixes after QA
  const [bufferDays, setBufferDays] = useState(0);     // Epic Timeline mode: extra working days after each dependency ends
  const [codeFreezeDays, setCodeFreezeDays] = useState(5);   // working days from last epic to code freeze
  const [stabilizationDays, setStabilizationDays] = useState(10); // working days of stabilization period
  const [planStart, setPlanStart] = useState(() => snapToWorkingDay(TODAY_STR));
  const [expandedEpics, setExpandedEpics] = useState(new Set());
  const [expandedStories, setExpandedStories] = useState(new Set()); // Epic Timeline mode: story -> subtasks
  const [focusEpicKey, setFocusEpicKey] = useState(null); // Epic Timeline mode: which epic is focused
  const [changelogCache, setChangelogCache] = useState({}); // issueKey -> { inProgressDate, readyDate } | { loading: true } | { error: true }
  const [autoScheduling, setAutoScheduling] = useState(false);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [focusDevId, setFocusDevId] = useState(null); // click a developer chip to show only their rows
  const [debugCopied, setDebugCopied] = useState(false);
  const [depsMode, setDepsMode] = useState(false);
  const [depsSource, setDepsSource] = useState(null);
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
  const [colWidths, setColWidths] = useState({ key: 140, summary: 114, est: 52, assigned: 90, qa: 44, days: 40 });
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [autoSaveStatus, setAutoSaveStatus] = useState(null);
  const [maximized, setMaximized] = useState(false); // fullscreen-overlay the timeline panel
  const [selectedPlanId, setSelectedPlanId] = useState(null);
  const [overlapAlert, setOverlapAlert] = useState(null);
  const [planDialog, setPlanDialog] = useState(null);
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const saveTimerRef = useRef(null);
  const initialLoadRef = useRef(false);
  const prevConflictKeysRef = useRef(new Set());

  const { epics, storiesByEpic, subtasksByStory, versions, loading: issuesLoading, error: issuesError } = useEpicHierarchy(projectKeys, selectedVersionId);

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
    ensurePlaceholderForAssignee,
    addMilestone, removeMilestone, clearPlan, savePlanToStorage,
    createPlan, renamePlanInIndex, deletePlanFromIndex,
  } = useVersionPlan(projectKeys[0] || null, selectedVersionId, selectedPlanId);

  useEffect(() => { resolveRoughEstField().then(setRoughEstFieldId); }, []);

  // Reset the focused epic when the version changes, since epics are version-scoped
  useEffect(() => { setFocusEpicKey(null); setExpandedStories(new Set()); }, [selectedVersionId]);

  // Auto-select first plan when version changes and plans are loaded
  useEffect(() => {
    if (!selectedVersionId) { setSelectedPlanId(null); initialLoadRef.current = false; return; }
    if (planIndex.length > 0 && !selectedPlanId) {
      setSelectedPlanId(planIndex[0].id);
    }
  }, [selectedVersionId, planIndex]);

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
    () => buildMissingEstMap(estSource, epicScopedHierarchy.epics, epicScopedHierarchy.storiesByEpic, epicScopedHierarchy.subtasksByStory, roughEstFieldId, roughMap),
    [estSource, epicScopedHierarchy, roughEstFieldId, roughMap]
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
    if (planningMode === 'draft') return { qaMap, bugFixPct };
    if (planningMode === 'epic') return { bufferDays };
    return {};
  }, [planningMode, qaMap, bugFixPct, bufferDays]);

  const computedPlan = useMemo(() => cascadePlan(plan, roughMap, draftOpts), [plan, roughMap, draftOpts]);

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

  const conflicts = useMemo(() => detectConflicts(computedPlan, roughMap, conflictOpts), [computedPlan, roughMap, conflictOpts]);

  const conflictingKeys = useMemo(function() {
    var s = new Set();
    conflicts.forEach(function(c) { s.add(c.source); s.add(c.target); });
    return s;
  }, [conflicts]);

  // Critical path keys — placed after conflictingKeys to avoid TDZ
  const criticalPathKeys = useMemo(function() {
    return new Set(computeCriticalPath(computedPlan, roughMap));
  }, [computedPlan, roughMap]);

  // Overlap detection — placed AFTER conflicts/conflictingKeys to avoid TDZ on [conflicts]
  useEffect(function() {
    var currentKeys = new Set(conflicts.map(function(c) { return c.source + '->' + c.target; }));
    var newConflicts = conflicts.filter(function(c) { return !prevConflictKeysRef.current.has(c.source + '->' + c.target); });
    if (newConflicts.length > 0) {
      setOverlapAlert({ conflicts: newConflicts });
      var t = setTimeout(function() { setOverlapAlert(null); }, 5000);
      prevConflictKeysRef.current = currentKeys;
      return function() { clearTimeout(t); };
    }
    prevConflictKeysRef.current = currentKeys;
  }, [conflicts]);

  const rows = useMemo(() => {
    if (planningMode === 'draft') {
      return epics.map(epic => ({ ...epic, _isEpic: true }));
    }
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
    const result = [];
    for (const epic of epics) {
      result.push({ ...epic, _isEpic: true });
      if (expandedEpics.has(epic.key)) {
        for (const story of (storiesByEpic[epic.key] || [])) {
          result.push({ ...story, _isEpic: false });
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
      var va = getSortValue(a, sortCol, roughMap, computedPlan);
      var vb = getSortValue(b, sortCol, roughMap, computedPlan);
      var result = (typeof va === 'string' || typeof vb === 'string')
        ? String(va).localeCompare(String(vb))
        : va - vb;
      return sortDir === 'asc' ? result : -result;
    }
    if (planningMode === 'draft') return [...filteredRows].sort(cmp);
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
  }, [filteredRows, sortCol, sortDir, roughMap, computedPlan, planningMode]);

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

  const totalLeftWidth = colWidths.key + colWidths.summary + colWidths.est + colWidths.assigned
    + (planningMode === 'draft' ? colWidths.qa : 0) + colWidths.days;

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
        const devs = (entry.assignedPlaceholders || []).length || 1;
        endIdx = startIdx + calcDays(roughMap[row.key], devs) - 1;
      }
      if (startIdx < minIdx) minIdx = startIdx;
      if (endIdx > maxIdx) maxIdx = endIdx;
    }
    return maxIdx >= minIdx ? { minIdx, maxIdx } : null;
  }, [rows, computedPlan.issues, roughMap, workingDays]);

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
      const devs = (entry.assignedPlaceholders || []).length || 1;
      const devEnd = calcEndDate(entry.startDate, roughMap[key], devs);
      if (!devEnd) continue;
      const { totalExtra } = calcQaBugFixDays(roughMap[key], devs, qaMap[key] || 0, bugFixPct);
      const effEnd = totalExtra > 0 ? addWorkingDays(devEnd, totalExtra) : devEnd;
      if (!latest || effEnd > latest) latest = effEnd;
    }
    return latest;
  }, [planningMode, computedPlan.issues, roughMap, qaMap, bugFixPct]);

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
      const devs = (entry.assignedPlaceholders || []).length || 1;
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

  function getBarProps(issueKey) {
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
    const devs = (entry.assignedPlaceholders || []).length || 1;
    const hours = roughMap[issueKey];
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
      const devs = phs.length || 1;
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
    if (planningMode === 'epic' && (subtasksByStory[issueKey] || []).length > 0) {
      placeStoryAndSubtasks(issueKey, day);
      return;
    }
    updateIssueEntry(issueKey, { startDate: day, dependencies: [], actualEndDate: undefined, historyResolved: true });
  }

  function handleTimelineClick(issueKey, dayIdx) {
    if (depsMode) { handleRowClick(issueKey); return; }
    const day = workingDays[dayIdx];
    if (!day) return;
    placeOnTimeline(issueKey, day);
  }

  function removeDependency(sourceKey, targetKey) {
    const e = computedPlan.issues?.[targetKey];
    if (!e) return;
    updateIssueEntry(targetKey, { dependencies: (e.dependencies || []).filter(d => d !== sourceKey) });
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
      const candidates = rows.filter(row => !newIssues[row.key]?.startDate);
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
            const devs = (de.assignedPlaceholders || []).length || 1;
            const depEnd = calcEndDate(de.startDate, roughMap[depKey], devs);
            if (depEnd) { const after = nextWorkDay(depEnd); if (after > start) start = after; }
          }
        }
        const devs = phs.length || 1;
        const endDate = calcEndDate(start, roughMap[row.key], devs);
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

    // eslint-disable-next-line no-console
    console.log('[autoScheduleAll] epic=' + focusEpicKey,
      'stories=' + stories.length, 'leaves=' + leaves.length,
      'alreadyDated=' + leaves.filter(r => newIssues[r.key]?.startDate).length,
      'notStartedToSchedule=' + notStartedLeaves.length,
      'notStartedKeys=', notStartedLeaves.map(r => r.key));

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
      const devs = (e.assignedPlaceholders || []).length || 1;
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
          const devs = (de.assignedPlaceholders || []).length || 1;
          // A locked dependency's real end date is a fact — never replace it with an estimate.
          const depEnd = de.actualEndDate || calcEndDate(de.startDate, roughMap[depKey], devs);
          if (depEnd) { const after = addWorkingDays(depEnd, 1 + bufferDays); if (after > start) start = after; }
        }
      }
      const devs = phs.length || 1;
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

    // eslint-disable-next-line no-console
    console.log('[autoScheduleAll] result — leaves with a startDate now:',
      leaves.map(r => ({
        key: r.key,
        startDate: newIssues[r.key]?.startDate || null,
        inVisibleWindow: newIssues[r.key]?.startDate ? workingDays.includes(newIssues[r.key].startDate) : null,
        devs: (newIssues[r.key]?.assignedPlaceholders || []).length,
      })));

    updatePlan(prev => ({ ...prev, issues: newIssues }));
  }

  // Unschedules everything in the current view — clears startDate/dependencies/actualEndDate
  // but keeps the developer roster and milestones intact. In Epic Timeline mode this is
  // scoped to the focused epic's stories+subtasks (and their changelog cache, so the
  // status-driven auto-timeline can re-derive fresh dates); Draft/Final clear all visible rows.
  function clearAllScheduling() {
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
  }

  async function handleSave() {
    setSaveStatus('saving');
    try {
      const planToSave = computedPlan;
      await savePlanToStorage(planToSave);
      if (updateDueDates) {
        for (const [key, entry] of Object.entries(planToSave.issues || {})) {
          if (!entry.startDate) continue;
          const devs = (entry.assignedPlaceholders || []).length || 1;
          const endDate = calcEndDate(entry.startDate, roughMap[key], devs);
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
          {versions.filter(v => !v.released && !v.archived).map(v => <option key={v.id} value={v.id}>{v.projectKey} · {v.name}</option>)}
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

      {/* ── Top toolbar ── */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #DFE1E6', background: '#FAFBFC', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Version selector */}
          <select value={selectedVersionId || ''} onChange={e => { setSelectedVersionId(e.target.value || null); setSelectedPlanId(null); }}
            style={{ padding: '5px 10px', fontSize: 12, border: '1.5px solid #DFE1E6', borderRadius: 4, fontWeight: 600 }}>
            <option value="">— Choose version —</option>
            {versions.filter(v => !v.released && !v.archived).map(v => <option key={v.id} value={v.id}>{v.projectKey} · {v.name}</option>)}
          </select>

          {/* Plan selector */}
          {selectedVersionId && (
            <>
              <span style={{ fontSize: 11, color: '#5E6C84', fontWeight: 600 }}>Plan:</span>
              <select value={selectedPlanId || ''} onChange={e => { if (e.target.value) setSelectedPlanId(e.target.value); }}
                style={{ padding: '4px 10px', fontSize: 12, border: '1.5px solid #DFE1E6', borderRadius: 4, minWidth: 120 }}>
                {planIndex.length === 0 && <option value="">No plans yet</option>}
                {planIndex.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button onClick={() => setPlanDialog({ type: 'new', defaultName: 'Plan ' + (planIndex.length + 1) })}
                style={btnStyle('#F4F5F7', '#42526E', '#DFE1E6')}>+ New</button>
              {selectedPlanId && (<>
                <button onClick={() => setPlanDialog({ type: 'saveas', defaultName: (planIndex.find(p => p.id === selectedPlanId)?.name || '') + ' (copy)' })}
                  style={btnStyle('#E9F2FF', '#0052CC', '#B3D4FF')}>Save as…</button>
                <button onClick={() => setPlanDialog({ type: 'rename', planId: selectedPlanId, defaultName: planIndex.find(p => p.id === selectedPlanId)?.name || '' })}
                  style={btnStyle('#F4F5F7', '#42526E', '#DFE1E6')}>Rename</button>
                <button onClick={() => setPlanDialog({ type: 'delete', planId: selectedPlanId })}
                  style={btnStyle('#FFEBE6', '#DE350B', '#FF8F73')}>Delete</button>
              </>)}
            </>
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

          {/* Est source toggle — Final and Epic Timeline modes */}
          {(planningMode === 'final' || planningMode === 'epic') && (
            <div style={{ display: 'flex', border: '1.5px solid #DFE1E6', borderRadius: 4, overflow: 'hidden' }}>
              <button onClick={() => setEstSource('rough')} style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                background: estSource === 'rough' ? '#0052CC' : '#fff',
                color: estSource === 'rough' ? '#fff' : '#42526E', border: 'none',
              }} title="Use the Rough Estimation custom field">
                Rough Est
              </button>
              <button onClick={() => setEstSource('children')} style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                background: estSource === 'children' ? '#0052CC' : '#fff',
                color: estSource === 'children' ? '#fff' : '#42526E',
                border: 'none', borderLeft: '1px solid #DFE1E6',
              }} title="Sum children's (tasks/subtasks) original estimates">
                Children Sum
              </button>
            </div>
          )}

          {/* Draft mode: QA/bugfix/freeze/stabilization settings */}
          {planningMode === 'draft' && (
            <>
              <span style={{ fontSize: 11, color: '#97A0AF' }}>|</span>
              <label style={{ fontSize: 11, color: '#5E6C84', fontWeight: 600 }}>Bug fix:</label>
              <input type="number" value={bugFixPct} min={0} max={100}
                onChange={e => setBugFixPct(Math.max(0, Math.min(100, Number(e.target.value))))}
                title="% of dev time developers spend fixing bugs after QA"
                style={{ width: 42, padding: '3px 6px', fontSize: 11, border: '1.5px solid #DFE1E6', borderRadius: 4, textAlign: 'center' }} />
              <span style={{ fontSize: 11, color: '#5E6C84' }}>%</span>
              <label style={{ fontSize: 11, color: '#5E6C84', fontWeight: 600, marginLeft: 4 }}>Freeze:</label>
              <input type="number" value={codeFreezeDays} min={0}
                onChange={e => setCodeFreezeDays(Math.max(0, Number(e.target.value)))}
                title="Working days between last epic and code freeze"
                style={{ width: 34, padding: '3px 6px', fontSize: 11, border: '1.5px solid #DFE1E6', borderRadius: 4, textAlign: 'center' }} />
              <span style={{ fontSize: 11, color: '#5E6C84' }}>d</span>
              <label style={{ fontSize: 11, color: '#5E6C84', fontWeight: 600, marginLeft: 4 }}>Stab:</label>
              <input type="number" value={stabilizationDays} min={0}
                onChange={e => setStabilizationDays(Math.max(0, Number(e.target.value)))}
                title="Working days of stabilization after code freeze"
                style={{ width: 34, padding: '3px 6px', fontSize: 11, border: '1.5px solid #DFE1E6', borderRadius: 4, textAlign: 'center' }} />
              <span style={{ fontSize: 11, color: '#5E6C84' }}>d</span>
            </>
          )}

          {/* Epic Timeline mode: buffer between a dependency ending and its dependent starting */}
          {planningMode === 'epic' && (
            <>
              <span style={{ fontSize: 11, color: '#97A0AF' }}>|</span>
              <label style={{ fontSize: 11, color: '#5E6C84', fontWeight: 600 }}>Buffer:</label>
              <input type="number" value={bufferDays} min={0}
                onChange={e => setBufferDays(Math.max(0, Number(e.target.value)))}
                title="Extra working days after a dependency ends before its dependent can start"
                style={{ width: 34, padding: '3px 6px', fontSize: 11, border: '1.5px solid #DFE1E6', borderRadius: 4, textAlign: 'center' }} />
              <span style={{ fontSize: 11, color: '#5E6C84' }}>d</span>
            </>
          )}

          {/* Plan start date */}
          <label style={{ fontSize: 11, color: '#5E6C84', fontWeight: 600 }}>From:</label>
          <input type="date" value={planStart} onChange={e => setPlanStart(snapToWorkingDay(e.target.value))}
            style={{ padding: '4px 8px', fontSize: 12, border: '1.5px solid #DFE1E6', borderRadius: 4 }} />

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={() => setMaximized(m => !m)}
              title={maximized ? 'Restore' : 'Maximize — see all stories and subtasks'}
              style={btnStyle(maximized ? '#0052CC' : '#F4F5F7', maximized ? '#fff' : '#42526E', maximized ? 'transparent' : '#DFE1E6')}>
              {maximized ? '⤡ Restore' : '⤢ Maximize'}
            </button>
            <button onClick={autoScheduleAll} disabled={autoScheduling} style={btnStyle('#E9F2FF', '#0052CC', '#B3D4FF')}>
              {autoScheduling ? 'Scheduling…' : 'Auto-schedule'}
            </button>
            <button onClick={clearAllScheduling} title="Unschedule everything in view — keeps developers and milestones"
              style={btnStyle('#FFF0B3', '#974F0C', '#FFD700')}>
              Clear all
            </button>
            {planningMode === 'epic' && (
              <button onClick={() => setShowDebugPanel(v => !v)} title="Show a raw data table of every story/subtask's computed schedule"
                style={btnStyle(showDebugPanel ? '#172B4D' : '#F4F5F7', showDebugPanel ? '#fff' : '#42526E', '#DFE1E6')}>
                🐛 Debug
              </button>
            )}
            {planningMode === 'epic' && (
              <button onClick={exportTimelineHtml} title="Download a self-contained HTML report: summary, timeline, milestones, critical path, team utilization, and the full debug table"
                style={btnStyle('#E9F2FF', '#0052CC', '#B3D4FF')}>
                ⬇ Export HTML
              </button>
            )}
            <button onClick={() => { setDepsMode(m => !m); setDepsSource(null); }}
              style={btnStyle(depsMode ? '#FFF0B3' : '#F4F5F7', depsMode ? '#974F0C' : '#42526E', depsMode ? '#FFD700' : '#DFE1E6')}>
              {depsMode ? (depsSource ? `→ Click target` : '→ Click source') : '+ Dependency'}
            </button>
            <button onClick={() => setEditingMilestone({ id: null, label: '', date: workingDays[10] || TODAY_STR, color: MILESTONE_COLORS[0] })}
              style={btnStyle('#F4F5F7', '#42526E', '#DFE1E6')}>
              + Milestone
            </button>
            <label style={{ fontSize: 11, color: '#5E6C84', display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={updateDueDates} onChange={e => setUpdateDueDates(e.target.checked)} />
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
            <button onClick={() => setPlanDialog({ type: 'clear' })}
              style={btnStyle('#FFEBE6', '#DE350B', '#FF8F73')}>
              Clear
            </button>
          </div>
        </div>

        {/* Developer placeholders row — hidden while maximized to save vertical space */}
        {!maximized && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: '#5E6C84', fontWeight: 700, flexShrink: 0 }}>Developers:</span>
            {(plan.placeholders || []).map(ph => (
              <span key={ph.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                {editingPhId === ph.id ? (
                  <input autoFocus value={editingPhValue}
                    onChange={e => setEditingPhValue(e.target.value)}
                    onBlur={() => { renamePlaceholder(ph.id, editingPhValue); setEditingPhId(null); }}
                    onKeyDown={e => { if (e.key === 'Enter') { renamePlaceholder(ph.id, editingPhValue); setEditingPhId(null); } }}
                    style={{ width: 80, fontSize: 11, border: `1.5px solid ${ph.color}`, borderRadius: 4, padding: '2px 6px' }}
                  />
                ) : (
                  <>
                    <Chip label={ph.name} color={ph.color} selected={focusDevId === ph.id}
                      onClick={() => setFocusDevId(prev => prev === ph.id ? null : ph.id)}
                      onRemove={() => removePlaceholder(ph.id)} />
                    <span onClick={() => { setEditingPhId(ph.id); setEditingPhValue(ph.name); }}
                      title="Rename" style={{ cursor: 'pointer', fontSize: 10, color: '#97A0AF', padding: '0 2px' }}>✎</span>
                  </>
                )}
              </span>
            ))}
            {focusDevId && (
              <button onClick={() => setFocusDevId(null)}
                style={{ ...btnStyle('#FFEBE6', '#DE350B', '#FF8F73'), padding: '3px 8px', fontSize: 11 }}>
                ✕ Show all
              </button>
            )}
            <button onClick={recolorPlaceholders} title="Reassign every developer's color from the current palette — fixes similar/duplicate colors"
              style={{ ...btnStyle('#F4F5F7', '#42526E', '#DFE1E6'), padding: '3px 8px', fontSize: 11 }}>
              🎨 Fix colors
            </button>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input value={newPhName} onChange={e => setNewPhName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && newPhName.trim()) { addPlaceholder(newPhName); setNewPhName(''); } }}
                placeholder="+ Add developer"
                style={{ fontSize: 11, border: '1.5px dashed #B3D4FF', borderRadius: 4, padding: '3px 8px', width: 120, outline: 'none' }}
              />
              {newPhName.trim() && (
                <button onClick={() => { addPlaceholder(newPhName); setNewPhName(''); }}
                  style={{ ...btnStyle('#E9F2FF', '#0052CC', '#B3D4FF'), padding: '3px 8px', fontSize: 11 }}>Add</button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Overlap alert toast — hidden while maximized ── */}
      {!maximized && overlapAlert && (
        <div style={{ background: '#FFEBE6', borderBottom: '1px solid #FF5630', padding: '7px 14px', fontSize: 12, color: '#DE350B', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          🔴 <strong>Developer overlap detected:</strong>
          {overlapAlert.conflicts.map(function(c, i) {
            return <span key={i} style={{ fontWeight: 600 }}>{c.placeholder.name}: {c.source} ↔ {c.target}</span>;
          })}
          <button onClick={() => setOverlapAlert(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#DE350B', fontSize: 16, lineHeight: 1 }}>×</button>
        </div>
      )}

      {/* ── Debug panel (Epic Timeline mode) — raw schedule data, copy/paste-able ── */}
      {showDebugPanel && planningMode === 'epic' && (
        <div style={{ background: '#172B4D', color: '#fff', flexShrink: 0, maxHeight: 260, overflow: 'auto', fontSize: 11 }}>
          <div style={{ position: 'sticky', top: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', background: '#0E1B31', borderBottom: '1px solid #344563' }}>
            <strong>Debug: {focusEpicKey || '(no epic selected)'} — {debugRows.length} rows</strong>
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
              style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', borderRadius: 4, border: '1px solid #5E6C84', background: debugCopied ? '#00875A' : '#344563', color: '#fff' }}>
              {debugCopied ? '✓ Copied' : '⎘ Copy table'}
            </button>
            <button onClick={() => setShowDebugPanel(false)} style={{ padding: '3px 8px', fontSize: 11, cursor: 'pointer', borderRadius: 4, border: '1px solid #5E6C84', background: '#344563', color: '#fff' }}>✕</button>
          </div>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr style={{ background: '#0E1B31' }}>
                {['Key', 'Type', 'Parent', 'Status', 'Jira Assignee', 'Assigned Dev(s)', 'Borrowed?', 'Start', 'End', 'Actual?', 'Resolved?', 'Rough Hrs', 'Dependencies'].map(h => (
                  <th key={h} style={{ padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #344563', whiteSpace: 'nowrap', position: 'sticky', top: 26 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {debugRows.map(r => (
                <tr key={r.key} style={{ borderBottom: '1px solid #253858' }}>
                  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap', fontWeight: r.type !== 'Subtask' ? 700 : 400 }}>{r.key}</td>
                  <td style={{ padding: '3px 8px' }}>{r.type}</td>
                  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap' }}>{r.parentKey}</td>
                  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap' }}>{r.status}</td>
                  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap' }}>{r.jiraAssignee}</td>
                  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap' }}>{r.assignedDevs}</td>
                  <td style={{ padding: '3px 8px' }}>{r.borrowedFromParent ? 'yes' : ''}</td>
                  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap', color: '#79E2F2' }}>{r.startDate}</td>
                  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap', color: '#79E2F2' }}>{r.endDate}</td>
                  <td style={{ padding: '3px 8px' }}>{r.isActual ? '🔒' : ''}</td>
                  <td style={{ padding: '3px 8px' }}>{r.historyResolved ? '✓' : ''}</td>
                  <td style={{ padding: '3px 8px' }}>{r.roughHours}</td>
                  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap' }}>{r.dependencies}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Missing estimate warnings — hidden while maximized ── */}
      {!maximized && Object.keys(missingEstMap).length > 0 && (
        <div style={{ background: '#FFFAE6', borderBottom: '1px solid #FFE380', padding: '5px 16px', fontSize: 11, color: '#974F0C', flexShrink: 0 }}>
          ⚠ {Object.keys(missingEstMap).length} issue(s) have missing or incomplete estimates
          {estSource === 'children' ? ' (some tasks/subtasks have no Original Estimate)' : ' (Rough Estimation field not set)'}.
          Duration calculations for those rows may be inaccurate.
        </div>
      )}

      {/* ── Conflict warnings — hidden while maximized ── */}
      {!maximized && conflicts.length > 0 && (
        <div style={{ background: '#FFFAE6', borderBottom: '1px solid #FFE380', padding: '6px 16px', fontSize: 11, flexShrink: 0 }}>
          {conflicts.map((c, i) => (
            <span key={i} style={{ marginRight: 12, color: '#974F0C' }}>
              ⚠ {c.placeholder.name}: {c.source} ↔ {c.target} overlap —
              <button onClick={() => {
                updateIssueEntry(c.target, {
                  dependencies: [...new Set([...(computedPlan.issues?.[c.target]?.dependencies || []), c.source])],
                });
              }} style={{ marginLeft: 4, fontSize: 10, border: '1px solid #FFD700', background: '#FFF0B3', borderRadius: 3, padding: '1px 6px', cursor: 'pointer', color: '#974F0C' }}>
                Auto-chain
              </button>
            </span>
          ))}
        </div>
      )}

      {/* ── Draft mode info banner ── */}
      {planningMode === 'draft' && selectedPlanId && (
        <div style={{ background: '#EAE6FF', borderBottom: '1px solid #C0B6F2', padding: '5px 16px', fontSize: 11, color: '#403294', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 700 }}>Draft mode:</span>
          Epics only · Duration = rough est ÷ devs · Assigning the same developer to multiple epics auto-creates dependencies
        </div>
      )}

      {/* ── Summary panel ── */}
      {selectedPlanId && (
        <SummaryPanel
          computedPlan={computedPlan}
          roughMapArg={roughMap}
          rows={rows}
          conflicts={conflicts}
          planIndex={planIndex}
          selectedPlanId={selectedPlanId}
        />
      )}

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
              <div onClick={() => handleSort('est')} style={{ ...cellStyle, width: colWidths.est, fontWeight: 700, textAlign: 'right', position: 'relative', cursor: 'pointer', userSelect: 'none' }}>
                Est{sortIndicator('est')}
                <ColResizer colKey="est" setColWidths={setColWidths} min={36} />
              </div>
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
              const entry = computedPlan.issues?.[row.key] || {};
              const devs = (entry.assignedPlaceholders || []).length || 0;
              const days = roughH && devs ? calcDays(roughH, devs) : null;
              const isEpic = row._isEpic;
              const isDepsTarget = depsMode && depsSource && depsSource !== row.key;
              const isDepsSrc = depsMode && !depsSource;
              const isLocked = !!entry.actualEndDate; // real dates from Jira status history — still movable, but moving it overrides the real date
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
                    background: depsSource === row.key ? '#FFF0B3' : isDepsTarget ? '#E9F2FF' : entry.startDate ? '#E3FCEF' : isEpic ? '#EAE6FF22' : '#fff',
                    cursor: depsMode ? 'crosshair' : 'grab',
                  }}>
                  {/* Key */}
                  <div style={{ ...cellStyle, width: colWidths.key, paddingLeft: isEpic ? 8 : row._isSubtask ? 32 : 20 }}>
                    {isLocked && <span title="Dates are from Jira status history — drag to override with a manual date" style={{ fontSize: 9, marginRight: 3, flexShrink: 0 }}>🔒</span>}
                    {isEpic && planningMode === 'final' && (
                      <span onClick={e => { e.stopPropagation(); setExpandedEpics(prev => { const n = new Set(prev); n.has(row.key) ? n.delete(row.key) : n.add(row.key); return n; }); }}
                        style={{ cursor: 'pointer', fontSize: 9, marginRight: 4, color: '#6554C0' }}>
                        {expandedEpics.has(row.key) ? '▼' : '▶'}
                      </span>
                    )}
                    {row._isStory && planningMode === 'epic' && (
                      <span onClick={e => { e.stopPropagation(); setExpandedStories(prev => { const n = new Set(prev); n.has(row.key) ? n.delete(row.key) : n.add(row.key); return n; }); }}
                        style={{ cursor: 'pointer', fontSize: 9, marginRight: 4, color: '#0052CC' }}>
                        {expandedStories.has(row.key) ? '▼' : '▶'}
                      </span>
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
                  {/* Summary */}
                  <div style={{ ...cellStyle, width: colWidths.summary, fontSize: 11, color: '#172B4D', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.summary}>
                    {f.summary}
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
                  {/* Assigned placeholders */}
                  <div style={{ ...cellStyle, width: colWidths.assigned, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                    {(plan.placeholders || []).map(ph => {
                      const assigned = (entry.assignedPlaceholders || []).includes(ph.id);
                      const borrowed = assigned && entry.borrowedFromParent;
                      return (
                        <span key={ph.id} onClick={e => { e.stopPropagation(); togglePlaceholder(row.key, ph.id); }}
                          title={borrowed ? `${ph.name} (inherited from parent story)` : ph.name}
                          style={{
                            width: 16, height: 16, borderRadius: '50%', cursor: 'pointer',
                            background: assigned ? ph.color : '#F4F5F7',
                            border: `1.5px solid ${assigned ? ph.color : '#DFE1E6'}`,
                            opacity: borrowed ? 0.4 : 1,
                            flexShrink: 0,
                          }} />
                      );
                    })}
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
                {workingDays.map((day, idx) => {
                  const d = parseISO(day);
                  const isToday = day === TODAY_STR;
                  const isMonday = getDay(d) === 1;
                  const hasMilestone = (computedPlan.milestones || []).some(m => m.date === day);
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
                      {hasMilestone && <span style={{ width: 6, height: 6, background: '#FF991F', borderRadius: '50%', position: 'absolute', bottom: 3 }} />}
                    </div>
                  );
                })}
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
                      const _devs = phs.length || 1;
                      const { qaDays: _qaDays, bugFixDays: _bfDays } = calcQaBugFixDays(roughMap[row.key], _devs, qaMap[row.key] || 0, bugFixPct);
                      return (<>
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
                          background: phs.length === 1 ? phs[0].color : phs.length > 1 ? `linear-gradient(90deg, ${phs.map(p => p.color).join(', ')})` : '#6554C0',
                          borderRadius: 4, cursor: 'grab', opacity: 0.88,
                          display: 'flex', alignItems: 'center', paddingLeft: 6, paddingRight: 18, gap: 4,
                          overflow: 'hidden', userSelect: 'none',
                          border: conflictingKeys.has(row.key) ? '2px solid #FF5630' : '2px solid rgba(255,255,255,0.25)',
                          outline: criticalPathKeys.has(row.key) && !conflictingKeys.has(row.key) ? '2px solid #FF991F' : 'none',
                          outlineOffset: 1,
                          boxShadow: conflictingKeys.has(row.key)
                            ? '0 0 0 2px rgba(255,86,48,0.25), 0 1px 4px rgba(0,0,0,0.18)'
                            : criticalPathKeys.has(row.key)
                            ? '0 0 0 2px rgba(255,153,31,0.3), 0 1px 4px rgba(0,0,0,0.18)'
                            : '0 1px 4px rgba(0,0,0,0.18)',
                        }} title={`${row.key}: ${bar.startDate} → ${bar.endDate} (${bar.durationDays}d) — drag to move`}>
                        <span style={{ fontSize: 10, color: '#fff', fontWeight: 700, flexShrink: 0 }}>{bar.durationDays}d</span>
                        {phs.slice(0, 3).map(ph => (
                          <span key={ph.id} title={ph.name} style={{
                            width: 12, height: 12, borderRadius: '50%', background: 'rgba(255,255,255,0.35)',
                            border: '1.5px solid rgba(255,255,255,0.7)', flexShrink: 0, fontSize: 8,
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
                        ? Math.max(1, Math.round(_fStories.reduce((s, st) => s + ((computedPlan.issues?.[st.key]?.assignedPlaceholders || []).length || 1), 0) / _fStories.length))
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
                          background: phs.length === 1 ? phs[0].color : phs.length > 1 ? `linear-gradient(90deg, ${phs.map(p => p.color).join(', ')})` : '#97A0AF',
                          borderRadius: 4, cursor: 'grab', opacity: entry.borrowedFromParent ? 0.45 : 0.88,
                          display: 'flex', alignItems: 'center', paddingLeft: 6, paddingRight: 18, gap: 4,
                          overflow: 'hidden', userSelect: 'none',
                          border: conflictingKeys.has(row.key) ? '2px solid #FF5630' : bar.isActual ? '4px solid #00875A' : 'none',
                          outline: criticalPathKeys.has(row.key) && !conflictingKeys.has(row.key) ? '2px solid #FF991F' : 'none',
                          outlineOffset: 1,
                          boxShadow: conflictingKeys.has(row.key)
                            ? '0 0 0 2px rgba(255,86,48,0.25), 0 1px 4px rgba(0,0,0,0.18)'
                            : criticalPathKeys.has(row.key)
                            ? '0 0 0 2px rgba(255,153,31,0.3), 0 1px 4px rgba(0,0,0,0.18)'
                            : '0 1px 4px rgba(0,0,0,0.18)',
                        }} title={`${row.key}: ${bar.startDate} → ${bar.endDate} (${bar.durationDays}d)${bar.isActual ? ' — actual dates from Jira status history' : ''}${entry.borrowedFromParent ? ' — dev inherited from parent story' : ''} — drag to move`}>
                        {bar.isActual && <span style={{ fontSize: 9, color: '#fff', flexShrink: 0 }} title="Actual dates from Jira status history — drag to override">🔒</span>}
                        <span style={{ fontSize: 10, color: '#fff', fontWeight: 700, flexShrink: 0 }}>{bar.durationDays}d</span>
                        {phs.slice(0, 3).map(ph => (
                          <span key={ph.id} title={ph.name} style={{
                            width: 12, height: 12, borderRadius: '50%', background: 'rgba(255,255,255,0.35)',
                            border: '1.5px solid rgba(255,255,255,0.7)', flexShrink: 0, fontSize: 8,
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

                {/* Milestone vertical lines — CLICKABLE to edit */}
                {(computedPlan.milestones || []).map(m => {
                  const idx = workingDays.indexOf(m.date);
                  if (idx < 0) return null;
                  const x = idx * DAY_WIDTH + DAY_WIDTH / 2;
                  return (
                    <g key={m.id} onClick={() => setEditingMilestone({ ...m })}
                      style={{ cursor: 'pointer', pointerEvents: 'auto' }}>
                      {/* Wide invisible hit area — ONLY around the label pill near the header, not
                          the full column height. A full-height hit rect used to sit on top of every
                          bar in this date column (SVG overlay paints after the row bars), silently
                          swallowing clicks/drags meant for any bar under a milestone's date. */}
                      <rect x={x - 8} y={HEADER_H - 20} width={16} height={24}
                        fill="transparent" />
                      <line x1={x} y1={HEADER_H} x2={x} y2={HEADER_H + sortedRows.length * ROW_HEIGHT}
                        stroke={m.color} strokeWidth={2} strokeDasharray="5 3" style={{ pointerEvents: 'stroke' }} />
                      <rect x={x - 1} y={HEADER_H - 16} width={Math.max(m.label.length * 6.5, 20)} height={14}
                        fill={m.color + 'dd'} rx={2} />
                      <text x={x + 2} y={HEADER_H - 5} fontSize={9} fill="#fff" fontWeight="bold">{m.label}</text>
                    </g>
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
                      const _sDevs = (computedPlan.issues?.[depKey]?.assignedPlaceholders || []).length || 1;
                      const { qaDays: _sqd, bugFixDays: _sbfd } = calcQaBugFixDays(roughMap[depKey], _sDevs, qaMap[depKey] || 0, bugFixPct);
                      arrowSrcX = sourceBar.left + (sourceBar.durationDays + _sqd + _sbfd) * DAY_WIDTH - 2;
                    }
                    const sx = arrowSrcX;
                    const sy = HEADER_H + depRowIdx * ROW_HEIGHT + ROW_HEIGHT / 2;
                    const tx = targetBar.left;
                    const ty = HEADER_H + rowIdx * ROW_HEIGHT + ROW_HEIGHT / 2;
                    const cx = sx + Math.abs(tx - sx) / 2;
                    return (
                      <path key={`${depKey}->${row.key}`}
                        d={`M ${sx} ${sy} C ${cx} ${sy} ${cx} ${ty} ${tx} ${ty}`}
                        stroke="#0052CC" strokeWidth={1.5} fill="none" markerEnd="url(#arrow)"
                        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                        onClick={() => removeDependency(depKey, row.key)}
                      />
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
          roughMap={roughMap}
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
