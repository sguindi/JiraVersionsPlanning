import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { format, parseISO, addDays, getDay, isAfter } from 'date-fns';
import { useEpicHierarchy } from '../hooks/useEpicHierarchy';
import { useVersionPlan } from '../hooks/useVersionPlan';
import { resolveRoughEstField, updateIssueDueDate, updateRoughEstimation } from '../api/bridge';
import IssueDetailPane from './IssueDetailPane';
import { cascadePlan, detectConflicts, calcEndDate, calcDays, nextWorkDay, addWorkingDays, buildWorkingDays, findCriticalPath, calcQaBugFixDays, HOURS_PER_DAY, isWeekend } from '../utils/planning';

// ── Constants ─────────────────────────────────────────────────────────────────
const DAY_WIDTH = 50;       // px per working day
const ROW_HEIGHT = 38;
const HEADER_H = 50;
const LEFT_W = 440;
const MILESTONE_COLORS = ['#0052CC', '#FF991F', '#6554C0', '#00875A', '#FF5630', '#00B8D9'];
const TODAY_STR = format(new Date(), 'yyyy-MM-dd');

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
  } else {
    // children mode — stories: sum subtasks' timeoriginalestimate
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

function buildMissingEstMap(mode, epics, storiesByEpic, subtasksByStory, fieldId) {
  var missing = {};
  if (mode === 'rough') {
    var checkIssue = function(issue) {
      if (!issue || !issue.key) return;
      var val = fieldId ? (issue.fields && issue.fields[fieldId]) : null;
      if (val == null || isNaN(Number(val)) || Number(val) <= 0) missing[issue.key] = true;
    };
    epics.forEach(checkIssue);
    Object.values(storiesByEpic).flat().forEach(checkIssue);
  } else {
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
      if (childStories.some(function(s) { return missing[s.key]; })) {
        missing[epic.key] = true;
      }
    });
  }
  return missing;
}

// ── Epic summary bar (spans all placed stories) ───────────────────────────────
function getEpicSummaryBarProps(epicKey, storiesByEpic, computedPlan, roughMap, workingDays) {
  var stories = storiesByEpic[epicKey] || [];
  var leftMin = Infinity;
  var rightMax = -Infinity;
  var placed = 0;
  stories.forEach(function(story) {
    var entry = computedPlan.issues && computedPlan.issues[story.key];
    if (!entry || !entry.startDate) return;
    var devs = (entry.assignedPlaceholders || []).length || 1;
    var hours = roughMap[story.key];
    var dur = calcDays(hours, devs);
    var startIdx = workingDays.indexOf(entry.startDate);
    if (startIdx < 0) return;
    placed++;
    var left = startIdx * DAY_WIDTH;
    var right = left + dur * DAY_WIDTH;
    if (left < leftMin) leftMin = left;
    if (right > rightMax) rightMax = right;
  });
  if (placed === 0) return null;
  return {
    left: leftMin,
    width: Math.max(DAY_WIDTH, rightMax - leftMin) - 2,
    placedStories: placed,
    totalStories: stories.length,
  };
}

// ── saveEst — module-level to avoid TDZ ──────────────────────────────────────
// Called from the component's inline edit handler; setLocalRoughEst + setEditingEstKey
// are passed as arguments to keep this pure.
async function saveEstFn(issueKey, value, setLocalRoughEst, setEditingEstKey) {
  var hours = parseFloat(value);
  if (isNaN(hours) || hours < 0) return;
  setLocalRoughEst(function(prev) { return Object.assign({}, prev, { [issueKey]: hours }); });
  setEditingEstKey(null);
  try { await updateRoughEstimation(issueKey, hours); } catch (e) { /* keep local value */ }
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

  var accentColor = mode === 'final' ? '#0052CC' : '#6554C0';
  var accentLight = mode === 'final' ? '#E9F2FF' : '#EAE6FF';
  var deliveryLabel = mode === 'final' ? 'Committed Delivery' : 'Draft Delivery';

  function buildReportText() {
    var lines = [];
    lines.push('# ' + (mode === 'final' ? 'Final Delivery Report' : 'Draft Delivery Estimate') + (planName ? ': ' + planName : ''));
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
  const [planningMode, setPlanningMode] = useState('draft'); // 'draft' | 'final'
  const [bugFixPct, setBugFixPct] = useState(20);      // % of dev time spent on bug fixes after QA
  const [codeFreezeDays, setCodeFreezeDays] = useState(5);   // working days from last epic to code freeze
  const [stabilizationDays, setStabilizationDays] = useState(10); // working days of stabilization period
  const [planStart, setPlanStart] = useState(TODAY_STR);
  const [expandedEpics, setExpandedEpics] = useState(new Set());
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
  const [autoSaveStatus, setAutoSaveStatus] = useState(null);
  const [selectedPlanId, setSelectedPlanId] = useState(null);
  const [overlapAlert, setOverlapAlert] = useState(null);
  const [planDialog, setPlanDialog] = useState(null);
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const saveTimerRef = useRef(null);
  const initialLoadRef = useRef(false);
  const prevConflictKeysRef = useRef(new Set());

  const { epics, storiesByEpic, subtasksByStory, versions, loading: issuesLoading, error: issuesError } = useEpicHierarchy(projectKeys, selectedVersionId);
  const {
    plan, loading: planLoading, saving, planIndex, indexLoading,
    updateIssueEntry, updatePlan, addPlaceholder, removePlaceholder, renamePlaceholder,
    addMilestone, removeMilestone, clearPlan, savePlanToStorage,
    createPlan, renamePlanInIndex, deletePlanFromIndex,
  } = useVersionPlan(projectKeys[0] || null, selectedVersionId, selectedPlanId);

  useEffect(() => { resolveRoughEstField().then(setRoughEstFieldId); }, []);

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
    () => Object.assign({}, buildRoughMap(estSource, epics, storiesByEpic, subtasksByStory, roughEstFieldId), localRoughEst),
    [estSource, epics, storiesByEpic, subtasksByStory, roughEstFieldId, localRoughEst]
  );

  const missingEstMap = useMemo(
    () => buildMissingEstMap(estSource, epics, storiesByEpic, subtasksByStory, roughEstFieldId),
    [estSource, epics, storiesByEpic, subtasksByStory, roughEstFieldId]
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
  const draftOpts = useMemo(() => (
    planningMode === 'draft' ? { qaMap, bugFixPct } : {}
  ), [planningMode, qaMap, bugFixPct]);

  const computedPlan = useMemo(() => cascadePlan(plan, roughMap, draftOpts), [plan, roughMap, draftOpts]);
  const conflicts = useMemo(() => detectConflicts(computedPlan, roughMap, draftOpts), [computedPlan, roughMap, draftOpts]);

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
  }, [planningMode, epics, storiesByEpic, expandedEpics]);

  // Extend window to cover code freeze + stabilization period beyond the last epic
  const workingDays = useMemo(
    () => buildWorkingDays(planStart, 150 + codeFreezeDays + stabilizationDays),
    [planStart, codeFreezeDays, stabilizationDays]
  );
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

  function getBarProps(issueKey) {
    const entry = computedPlan.issues?.[issueKey];
    if (!entry?.startDate) return null;
    const devs = (entry.assignedPlaceholders || []).length || 1;
    const hours = roughMap[issueKey];
    const durationDays = calcDays(hours, devs);
    const startIdx = workingDays.indexOf(entry.startDate);
    if (startIdx < 0) return null;
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

  function handleTimelineClick(issueKey, dayIdx) {
    if (depsMode) { handleRowClick(issueKey); return; }
    const day = workingDays[dayIdx];
    if (!day) return;
    updateIssueEntry(issueKey, { startDate: day });
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

  function autoScheduleAll() {
    const newIssues = {};
    for (const [k, e] of Object.entries(computedPlan.issues || {})) newIssues[k] = { ...e };
    const nextAvail = {}; // phId → next available date
    for (const row of rows) {
      const entry = newIssues[row.key] || { startDate: null, assignedPlaceholders: [], dependencies: [] };
      if (entry.startDate) continue;
      const phs = entry.assignedPlaceholders || [];
      if (!phs.length) continue;
      let start = planStart;
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
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (e) {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus(null), 5000);
    }
  }

  const todayIdx = workingDays.indexOf(TODAY_STR);

  if (!selectedVersionId) {
    return (
      <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #DFE1E6', padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#172B4D', marginBottom: 12 }}>Version Planning</div>
        <p style={{ color: '#5E6C84', fontSize: 13, marginBottom: 16 }}>Select a version to start planning your timeline.</p>
        <select onChange={e => setSelectedVersionId(e.target.value || null)}
          style={{ padding: '8px 12px', fontSize: 13, border: '2px solid #DFE1E6', borderRadius: 6, minWidth: 240 }}>
          <option value="">— Choose a version —</option>
          {versions.map(v => <option key={v.id} value={v.id}>{v.projectKey} · {v.name}{v.released ? ' ✓' : ''}</option>)}
        </select>
        {issuesLoading && <div style={{ marginTop: 12, color: '#97A0AF', fontSize: 12 }}>Loading versions…</div>}
      </div>
    );
  }

  return (
    <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #DFE1E6', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden', display: 'flex', flexDirection: 'column', height: 'calc(100vh - 180px)' }}>

      {/* ── Top toolbar ── */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #DFE1E6', background: '#FAFBFC', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Version selector */}
          <select value={selectedVersionId || ''} onChange={e => { setSelectedVersionId(e.target.value || null); setSelectedPlanId(null); }}
            style={{ padding: '5px 10px', fontSize: 12, border: '1.5px solid #DFE1E6', borderRadius: 4, fontWeight: 600 }}>
            <option value="">— Choose version —</option>
            {versions.map(v => <option key={v.id} value={v.id}>{v.projectKey} · {v.name}</option>)}
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
          </div>

          {/* Est source toggle — Final mode only */}
          {planningMode === 'final' && (
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

          {/* Plan start date */}
          <label style={{ fontSize: 11, color: '#5E6C84', fontWeight: 600 }}>From:</label>
          <input type="date" value={planStart} onChange={e => setPlanStart(e.target.value)}
            style={{ padding: '4px 8px', fontSize: 12, border: '1.5px solid #DFE1E6', borderRadius: 4 }} />

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={autoScheduleAll} style={btnStyle('#E9F2FF', '#0052CC', '#B3D4FF')}>
              Auto-schedule
            </button>
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

        {/* Developer placeholders row */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: '#5E6C84', fontWeight: 700, flexShrink: 0 }}>Developers:</span>
          {(plan.placeholders || []).map(ph => (
            <span key={ph.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {editingPhId === ph.id ? (
                <input autoFocus value={editingPhValue}
                  onChange={e => setEditingPhValue(e.target.value)}
                  onBlur={() => { renamePlaceholder(ph.id, editingPhValue); setEditingPhId(null); }}
                  onKeyDown={e => { if (e.key === 'Enter') { renamePlaceholder(ph.id, editingPhValue); setEditingPhId(null); } }}
                  style={{ width: 80, fontSize: 11, border: `1.5px solid ${ph.color}`, borderRadius: 4, padding: '2px 6px' }}
                />
              ) : (
                <Chip label={ph.name} color={ph.color}
                  onClick={() => { setEditingPhId(ph.id); setEditingPhValue(ph.name); }}
                  onRemove={() => removePlaceholder(ph.id)} />
              )}
            </span>
          ))}
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
      </div>

      {/* ── Overlap alert toast ── */}
      {overlapAlert && (
        <div style={{ background: '#FFEBE6', borderBottom: '1px solid #FF5630', padding: '7px 14px', fontSize: 12, color: '#DE350B', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          🔴 <strong>Developer overlap detected:</strong>
          {overlapAlert.conflicts.map(function(c, i) {
            return <span key={i} style={{ fontWeight: 600 }}>{c.placeholder.name}: {c.source} ↔ {c.target}</span>;
          })}
          <button onClick={() => setOverlapAlert(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#DE350B', fontSize: 16, lineHeight: 1 }}>×</button>
        </div>
      )}

      {/* ── Missing estimate warnings ── */}
      {Object.keys(missingEstMap).length > 0 && (
        <div style={{ background: '#FFFAE6', borderBottom: '1px solid #FFE380', padding: '5px 16px', fontSize: 11, color: '#974F0C', flexShrink: 0 }}>
          ⚠ {Object.keys(missingEstMap).length} issue(s) have missing or incomplete estimates
          {estSource === 'children' ? ' (some tasks/subtasks have no Original Estimate)' : ' (Rough Estimation field not set)'}.
          Duration calculations for those rows may be inaccurate.
        </div>
      )}

      {/* ── Conflict warnings ── */}
      {conflicts.length > 0 && (
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
        <div style={{ padding: 32, textAlign: 'center', color: '#97A0AF', fontSize: 13 }}>No epics found for this version.</div>
      ) : (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* ── Left table ── */}
          <div ref={leftRef} onScroll={onLeftScroll}
            style={{ width: LEFT_W, flexShrink: 0, overflowY: 'auto', overflowX: 'hidden', borderRight: '1px solid #DFE1E6' }}>
            {/* Column headers */}
            <div style={{ position: 'sticky', top: 0, zIndex: 10, background: '#F4F5F7', borderBottom: '1px solid #DFE1E6', display: 'flex', height: HEADER_H, alignItems: 'center' }}>
              <div style={{ ...cellStyle, width: 100, fontWeight: 700 }}>Key</div>
              <div style={{ ...cellStyle, flex: 1, fontWeight: 700 }}>Summary</div>
              <div style={{ ...cellStyle, width: 52, fontWeight: 700, textAlign: 'right' }}>Est</div>
              <div style={{ ...cellStyle, width: 90, fontWeight: 700 }}>Assigned</div>
              {planningMode === 'draft' && (
                <div style={{ ...cellStyle, width: 44, fontWeight: 700, textAlign: 'center', color: '#FF991F' }} title="QA testing days for this epic">QA d</div>
              )}
              <div style={{ ...cellStyle, width: 40, fontWeight: 700, textAlign: 'right' }}>Days</div>
            </div>
            {rows.map(row => {
              const f = row.fields || {};
              const roughH = roughMap[row.key];
              const entry = computedPlan.issues?.[row.key] || {};
              const devs = (entry.assignedPlaceholders || []).length || 0;
              const days = roughH && devs ? calcDays(roughH, devs) : null;
              const isEpic = row._isEpic;
              const isDepsTarget = depsMode && depsSource && depsSource !== row.key;
              const isDepsSrc = depsMode && !depsSource;
              return (
                <div key={row.key}
                  draggable
                  onDragStart={e => { window.__versionPlanDrag = { issueKey: row.key }; e.dataTransfer.effectAllowed = 'move'; }}
                  onDragEnd={() => { window.__versionPlanDrag = null; }}
                  onClick={() => handleRowClick(row.key)}
                  style={{
                    display: 'flex', alignItems: 'center', height: ROW_HEIGHT,
                    borderBottom: '1px solid #F4F5F7',
                    background: depsSource === row.key ? '#FFF0B3' : isDepsTarget ? '#E9F2FF' : isEpic ? '#EAE6FF22' : '#fff',
                    cursor: depsMode ? 'crosshair' : 'grab',
                  }}>
                  {/* Key */}
                  <div style={{ ...cellStyle, width: 100, paddingLeft: isEpic ? 8 : 20 }}>
                    {isEpic && planningMode === 'final' && (
                      <span onClick={e => { e.stopPropagation(); setExpandedEpics(prev => { const n = new Set(prev); n.has(row.key) ? n.delete(row.key) : n.add(row.key); return n; }); }}
                        style={{ cursor: 'pointer', fontSize: 9, marginRight: 4, color: '#6554C0' }}>
                        {expandedEpics.has(row.key) ? '▼' : '▶'}
                      </span>
                    )}
                    <span
                      onClick={e => { e.stopPropagation(); setDetailIssueKey(row.key); }}
                      style={{ fontSize: 11, fontWeight: isEpic ? 700 : 400, color: isEpic ? '#6554C0' : '#0052CC', cursor: 'pointer', textDecoration: 'underline' }}
                      title="Click to open details"
                    >{row.key}</span>
                  </div>
                  {/* Summary */}
                  <div style={{ ...cellStyle, flex: 1, fontSize: 11, color: '#172B4D', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.summary}>
                    {f.summary}
                  </div>
                  {/* Est — click to edit inline */}
                  <div
                    onClick={e => { e.stopPropagation(); setEditingEstKey(row.key); setEditingEstValue(roughH != null ? String(roughH) : ''); }}
                    title="Click to edit estimate"
                    style={{ ...cellStyle, width: 52, textAlign: 'right', fontSize: 11, cursor: 'pointer' }}
                  >
                    {editingEstKey === row.key ? (
                      <input
                        autoFocus
                        type="number"
                        value={editingEstValue}
                        onChange={e => setEditingEstValue(e.target.value)}
                        onBlur={() => saveEstFn(row.key, editingEstValue, setLocalRoughEst, setEditingEstKey)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') saveEstFn(row.key, editingEstValue, setLocalRoughEst, setEditingEstKey);
                          if (e.key === 'Escape') setEditingEstKey(null);
                        }}
                        onClick={e => e.stopPropagation()}
                        style={{ width: 44, fontSize: 10, border: '1.5px solid #0052CC', borderRadius: 3, textAlign: 'right', padding: '1px 3px' }}
                      />
                    ) : roughH != null ? (
                      <span style={{ color: '#0052CC', fontWeight: 600 }}>
                        {roughH % 1 === 0 ? roughH : roughH.toFixed(1)}h
                        {missingEstMap[row.key] && <span title="Incomplete estimates" style={{ color: '#FF991F', marginLeft: 2 }}>⚠</span>}
                      </span>
                    ) : (
                      <span style={{ color: missingEstMap[row.key] ? '#FF5630' : '#97A0AF' }}>
                        {missingEstMap[row.key] ? '—⚠' : '—'}
                      </span>
                    )}
                  </div>
                  {/* Assigned placeholders */}
                  <div style={{ ...cellStyle, width: 90, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                    {(plan.placeholders || []).map(ph => {
                      const assigned = (entry.assignedPlaceholders || []).includes(ph.id);
                      return (
                        <span key={ph.id} onClick={e => { e.stopPropagation(); togglePlaceholder(row.key, ph.id); }}
                          title={ph.name}
                          style={{
                            width: 16, height: 16, borderRadius: '50%', cursor: 'pointer',
                            background: assigned ? ph.color : '#F4F5F7',
                            border: `1.5px solid ${assigned ? ph.color : '#DFE1E6'}`,
                            flexShrink: 0,
                          }} />
                      );
                    })}
                    {!(plan.placeholders || []).length && <span style={{ fontSize: 10, color: '#97A0AF' }}>add devs ↑</span>}
                  </div>
                  {/* QA days — Draft mode only */}
                  {planningMode === 'draft' && (
                    <div style={{ ...cellStyle, width: 44, justifyContent: 'center' }}>
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
                  <div style={{ ...cellStyle, width: 40, textAlign: 'right', fontSize: 11 }}>
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
              if (day) updateIssueEntry(drag.issueKey, { startDate: day });
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
              {rows.map((row, rowIdx) => {
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
                          title={depsMode ? undefined : `Set start: ${day}`}
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
                          onClick={e => { e.stopPropagation(); updateIssueEntry(row.key, { startDate: null }); }}
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
                      const sb = getEpicSummaryBarProps(row.key, storiesByEpic, computedPlan, roughMap, workingDays);
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
                    })() : bar && (
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
                          borderRadius: 4, cursor: 'grab', opacity: 0.88,
                          display: 'flex', alignItems: 'center', paddingLeft: 6, paddingRight: 18, gap: 4,
                          overflow: 'hidden', userSelect: 'none',
                          border: conflictingKeys.has(row.key) ? '2px solid #FF5630' : 'none',
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
                          onClick={e => { e.stopPropagation(); updateIssueEntry(row.key, { startDate: null }); }}
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

              {/* SVG layer: today line + dependency arrows + milestone lines */}
              <svg style={{ position: 'absolute', top: 0, left: 0, width: totalTimelineWidth, height: HEADER_H + rows.length * ROW_HEIGHT, overflow: 'visible' }}>
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
                    y2={HEADER_H + rows.length * ROW_HEIGHT}
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
                      style={{ cursor: 'pointer' }}>
                      {/* Wide invisible hit area */}
                      <rect x={x - 8} y={0} width={16} height={HEADER_H + rows.length * ROW_HEIGHT}
                        fill="transparent" />
                      <line x1={x} y1={HEADER_H} x2={x} y2={HEADER_H + rows.length * ROW_HEIGHT}
                        stroke={m.color} strokeWidth={2} strokeDasharray="5 3" />
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
                  const svgH = HEADER_H + rows.length * ROW_HEIGHT;
                  return (
                    <>
                      {cfIdx >= 0 && seIdx > cfIdx && (
                        <rect
                          x={cfIdx * DAY_WIDTH} y={HEADER_H}
                          width={(seIdx + 1 - cfIdx) * DAY_WIDTH} height={rows.length * ROW_HEIGHT}
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
                {rows.map((row, rowIdx) => {
                  const entry = computedPlan.issues?.[row.key] || {};
                  return (entry.dependencies || []).map(depKey => {
                    const depRowIdx = rows.findIndex(r => r.key === depKey);
                    const sourceBar = getBarProps(depKey);
                    const targetBar = getBarProps(row.key);
                    if (depRowIdx < 0 || !sourceBar || !targetBar) return null;
                    // In draft mode, arrow leaves from end of QA+bugfix bar, not just dev bar
                    let arrowSrcX = sourceBar.left + sourceBar.width;
                    if (planningMode === 'draft') {
                      const _sDevs = (computedPlan.issues?.[depKey]?.assignedPlaceholders || []).length || 1;
                      const { qaDays: _sqd, bugFixDays: _sbfd } = calcQaBugFixDays(roughMap[depKey], _sDevs, qaMap[depKey] || 0, bugFixPct);
                      arrowSrcX = sourceBar.left + (sourceBar.durationDays + _sqd + _sbfd) * DAY_WIDTH;
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

      {/* Existing milestones list */}
      {(computedPlan.milestones || []).length > 0 && (
        <div style={{ padding: '6px 16px', borderTop: '1px solid #F4F5F7', background: '#FAFBFC', display: 'flex', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>
          {(computedPlan.milestones || []).map(m => (
            <Chip key={m.id} label={`${m.label} (${m.date})`} color={m.color}
              onClick={() => setEditingMilestone({ ...m })}
              onRemove={() => removeMilestone(m.id)} />
          ))}
        </div>
      )}

      {/* ── Delivery report ── */}
      {selectedPlanId && (
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
