import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import withDragAndDrop from 'react-big-calendar/lib/addons/dragAndDrop';
import { format, parse, startOfWeek, getDay, addDays, parseISO } from 'date-fns';
import { enUS } from 'date-fns/locale';
import { useIssues } from '../hooks/useIssues';
import { useMilestones } from '../hooks/useMilestones';
import { useSprintIssues } from '../hooks/useSprintIssues';
import { useSprintSchedule } from '../hooks/useSprintSchedule';
import { useTeamColors } from '../hooks/useTeamColors';
import { updateIssueDueDate } from '../api/bridge';
import IssueEventBar from './IssueEventBar';
import IssueTooltip, { statusColor } from './IssueTooltip';
import MilestoneDialog from './MilestoneDialog';
import SprintHealthBar from './SprintHealthBar';
import OverduePanel from './OverduePanel';
import IssueDetailPane from './IssueDetailPane';

const locales = { 'en-US': enUS };
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales });
const DnDCalendar = withDragAndDrop(Calendar);

import { DAY_CAPACITY_SECONDS, computeDayCapacity, dayLoadPct, computeSplit } from '../utils/scheduling';

const TODAY_STR = format(new Date(), 'yyyy-MM-dd');

function exportICS(issues) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//planJira//EN',
    'CALSCALE:GREGORIAN',
  ];
  for (const i of issues) {
    const f = i.fields || {};
    if (!f.duedate) continue;
    const dt = f.duedate.replace(/-/g, '');
    const summary = `${i.key}: ${(f.summary || '').replace(/[\\;,\n\r]/g, ' ')}`;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${i.key}@planjira`);
    lines.push(`DTSTART;VALUE=DATE:${dt}`);
    lines.push(`DTEND;VALUE=DATE:${dt}`);
    lines.push(`SUMMARY:${summary}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'planjira-calendar.ics';
  a.click();
  URL.revokeObjectURL(url);
}

function fmtHours(s) {
  if (!s) return '0h';
  const h = s / 3600;
  return h === Math.floor(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

function issueToEvents(issue, colorOf, schedule) {
  if (!issue || !issue.fields) return [];
  const f = issue.fields;
  const assigneeId = f.assignee?.accountId || '__unassigned__';
  const color = colorOf(assigneeId);
  const totalEst = f.timeoriginalestimate || 0;

  // Check if this issue has a multi-day schedule
  const segs = schedule?.[issue.key];
  if (segs && segs.length > 1) {
    return segs.map((seg, idx) => ({
      id: idx === 0 ? issue.key : `${issue.key}_seg${idx}`,
      title: idx === 0 ? `${issue.key}: ${f.summary}` : `${issue.key} →`,
      start: new Date(seg.date + 'T12:00:00'),
      end: new Date(seg.date + 'T12:00:00'),
      allDay: true,
      resource: issue,
      color,
      resourceId: assigneeId,
      isContinuation: idx > 0,
      segmentSeconds: seg.seconds,
    }));
  }

  if (!f.duedate) return [];
  return [{
    id: issue.key,
    title: `${issue.key}: ${f.summary}`,
    start: new Date(f.duedate + 'T12:00:00'),
    end: new Date(f.duedate + 'T12:00:00'),
    allDay: true,
    resource: issue,
    color,
    resourceId: assigneeId,
    isContinuation: false,
    segmentSeconds: null,
  }];
}

function CapacityDateHeader({ date, label, issues }) {
  const dateStr = format(date, 'yyyy-MM-dd');
  const cap = computeDayCapacity(issues, dateStr);
  const entries = Object.values(cap);
  const isToday = dateStr === TODAY_STR;

  if (!entries.length) {
    return <span style={{ fontSize: 12, fontWeight: isToday ? 800 : 400, color: isToday ? '#0052CC' : 'inherit' }}>{label}</span>;
  }
  const maxUsed = Math.max(...entries.map(e => e.used));
  const pct = Math.min(maxUsed / DAY_CAPACITY_SECONDS, 1.4);
  const barColor = pct > 1 ? '#FF5630' : pct > 0.66 ? '#FF991F' : '#36B37E';
  const totalUsed = entries.reduce((s, e) => s + e.used, 0);

  return (
    <div style={{ fontSize: 12, lineHeight: 1.4 }}>
      <span style={{ fontWeight: isToday ? 800 : 400, color: isToday ? '#0052CC' : 'inherit' }}>{label}</span>
      <div style={{ height: 3, background: '#DFE1E6', borderRadius: 2, overflow: 'hidden', width: '80%', margin: '2px auto 0' }}>
        <div style={{ height: '100%', background: barColor, width: `${Math.min(pct / 1.4, 1) * 100}%`, transition: 'width 0.2s' }} />
      </div>
      <div style={{ fontSize: 9, color: pct > 1 ? '#FF5630' : '#97A0AF', textAlign: 'center' }}>
        {fmtHours(totalUsed)}{pct > 1 ? ' ⚠' : ''}
      </div>
    </div>
  );
}

function DevChip({ member, color, selected, onClick, label }) {
  const avatar = member?.avatarUrl;
  const name = label || member?.displayName || 'Unknown';
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 5,
      padding: '3px 10px 3px 6px', borderRadius: 20, cursor: 'pointer',
      border: selected ? `2px solid ${color}` : '2px solid #DFE1E6',
      background: selected ? color + '22' : '#fff',
      fontSize: 11, fontWeight: 600, color: selected ? color : '#42526E',
    }}>
      {avatar
        ? <img src={avatar} alt="" style={{ width: 16, height: 16, borderRadius: '50%', border: `1.5px solid ${color}` }} />
        : <span style={{ width: 16, height: 16, borderRadius: '50%', background: color, display: 'inline-block' }} />
      }
      {name}
    </button>
  );
}

export default function CalendarView({
  projectKeys, dateRange, currentDate, viewMode, onNavigate,
  selectedSprintId, selectedVersionId, selectedDeveloperIds, onDeveloperFilterChange, teamMembers,
}) {
  const { issues: calendarIssues, loading, error } = useIssues(projectKeys, dateRange);
  const { issues: sprintIssues } = useSprintIssues(projectKeys, selectedSprintId);
  const { schedule, saveSegments, removeIssue: removeSchedule } = useSprintSchedule(projectKeys, selectedSprintId);
  const { colorOf } = useTeamColors(teamMembers);

  const [extraIssues, setExtraIssues] = useState([]);
  const [localDates, setLocalDates] = useState({});
  const [capacityWarning, setCapacityWarning] = useState(null);
  const [milestoneDialog, setMilestoneDialog] = useState(null);
  const [detailIssueKey, setDetailIssueKey] = useState(null);
  const [selectedEpicKey, setSelectedEpicKey] = useState(null);

  // Fix 1: drag-out-to-unschedule tracking
  const draggingKeyRef = useRef(null);
  const droppedOnCalendarRef = useRef(false);

  const issueKeys = useMemo(() => {
    const all = [...(calendarIssues || []), ...(sprintIssues || []), ...extraIssues];
    return [...new Set(all.filter(i => i?.key).map(i => i.key))];
  }, [calendarIssues, sprintIssues, extraIssues]);

  const {
    issueMilestones, projectMilestonesMap,
    saveMilestone, removeMilestone, saveProjectMilestone, removeProjectMilestone,
  } = useMilestones(issueKeys, projectKeys);

  // Merge all issue sources, apply date overrides
  const allIssues = useMemo(() => {
    const map = {};
    for (const i of [...(calendarIssues || []), ...(sprintIssues || []), ...extraIssues]) {
      if (!i?.key || !i.fields) continue;
      map[i.key] = i;
    }
    return Object.values(map);
  }, [calendarIssues, sprintIssues, extraIssues]);

  const displayedIssues = useMemo(() => allIssues.map(i => {
    const override = localDates[i.key];
    if (!override) return i;
    return { ...i, fields: { ...i.fields, duedate: override } };
  }), [allIssues, localDates]);

  const availableEpics = useMemo(() => {
    const map = {};
    for (const i of allIssues) {
      const p = i.fields?.parent;
      if (p?.key && p?.fields?.summary) map[p.key] = { key: p.key, summary: p.fields.summary };
    }
    return Object.values(map).sort((a, b) => a.key.localeCompare(b.key));
  }, [allIssues]);

  // Build calendar events
  const events = useMemo(() => {
    const issueEvents = displayedIssues.flatMap(i => issueToEvents(i, colorOf, schedule));

    // Project milestone events
    const milestoneEvents = [];
    for (const [pk, milestones] of Object.entries(projectMilestonesMap)) {
      for (const m of milestones) {
        milestoneEvents.push({
          id: `pm_${pk}_${m.id}`,
          title: `◆ ${m.label}`,
          start: new Date(m.date + 'T12:00:00'),
          end: new Date(m.date + 'T12:00:00'),
          allDay: true,
          resource: { _isProjectMilestone: true, projectKey: pk, milestone: m },
          color: m.color,
          resourceId: '__milestones__',
        });
      }
    }
    return [...issueEvents, ...milestoneEvents];
  }, [displayedIssues, projectMilestonesMap, colorOf, schedule]);

  // Filter events by epic + selected developers
  const visibleEvents = useMemo(() => {
    let filtered = events;
    if (selectedEpicKey) {
      filtered = filtered.filter(ev => {
        if (ev.resource?._isProjectMilestone) return true;
        return ev.resource?.fields?.parent?.key === selectedEpicKey;
      });
    }
    if (selectedDeveloperIds && selectedDeveloperIds.length > 0) {
      filtered = filtered.filter(ev => {
        if (ev.resource?._isProjectMilestone) return true;
        return selectedDeveloperIds.includes(ev.resourceId || '__unassigned__');
      });
    }
    return filtered;
  }, [events, selectedDeveloperIds, selectedEpicKey]);

  // Overdue issues
  const overdueIssues = useMemo(() =>
    displayedIssues.filter(i => {
      const f = i.fields;
      return f?.duedate && f.duedate < TODAY_STR && f.status?.statusCategory?.key !== 'done';
    }), [displayedIssues]);

  // Active sprint object (for health bar + IssueEventBar)
  const activeSprint = useMemo(() => {
    if (!selectedSprintId || !teamMembers) return null;
    return null; // Sprint details loaded separately in SprintHealthBar
  }, [selectedSprintId]);

  // Day background coloring
  const dayPropGetter = useCallback((date) => {
    const dateStr = format(date, 'yyyy-MM-dd');
    const isToday = dateStr === TODAY_STR;
    const pct = dayLoadPct(displayedIssues, dateStr);
    const bg = pct > 1
      ? 'rgba(255,86,48,0.10)'
      : pct > 0.66
      ? 'rgba(255,153,31,0.08)'
      : pct > 0
      ? 'rgba(54,179,126,0.05)'
      : undefined;
    return {
      style: {
        background: bg,
        borderTop: isToday ? '3px solid #0052CC' : undefined,
      },
    };
  }, [displayedIssues]);

  const visibleTeamMembers = useMemo(() => teamMembers || [], [teamMembers]);

  // Resources (developer swimlanes in week view)
  const resources = useMemo(() => {
    if (viewMode !== 'week' || !visibleTeamMembers?.length) return undefined;
    const base = visibleTeamMembers;
    const visible = selectedDeveloperIds?.length
      ? base.filter(m => selectedDeveloperIds.includes(m.accountId))
      : base;
    return [
      ...visible.map(m => ({ id: m.accountId, title: m.displayName, avatarUrl: m.avatarUrl })),
      { id: '__unassigned__', title: 'Unassigned', avatarUrl: null },
    ];
  }, [viewMode, visibleTeamMembers, selectedDeveloperIds]);

  // Unschedule — declared early so useEffect and handleEventDrop can reference it
  const handleUnschedule = useCallback((issueKey) => {
    setExtraIssues(prev => prev.filter(i => i.key !== issueKey));
    setLocalDates(prev => { const n = { ...prev }; delete n[issueKey]; return n; });
    updateIssueDueDate(issueKey, null).catch(() => {});
    if (selectedSprintId) {
      const projectKey = issueKey.split('-')[0];
      removeSchedule(projectKey, issueKey).catch(() => {});
    }
  }, [selectedSprintId, removeSchedule]);

  // Fix 1: listen for dragend — detect calendar event dropped outside calendar
  useEffect(() => {
    function onDragEnd() {
      const key = draggingKeyRef.current;
      const droppedOnCal = droppedOnCalendarRef.current;
      draggingKeyRef.current = null;
      droppedOnCalendarRef.current = false;
      if (key && !droppedOnCal) handleUnschedule(key);
    }
    document.addEventListener('dragend', onDragEnd);
    return () => document.removeEventListener('dragend', onDragEnd);
  }, [handleUnschedule]);

  // Reschedule existing event (within calendar DnD)
  const handleEventDrop = useCallback(({ event, start }) => {
    if (event.resource?._isProjectMilestone) return;
    if (event.isContinuation) return;
    droppedOnCalendarRef.current = true;
    const newDate = format(start, 'yyyy-MM-dd');
    const issueKey = event.id;
    const orig = event.resource?.fields?.duedate;
    setLocalDates(prev => ({ ...prev, [issueKey]: newDate }));
    updateIssueDueDate(issueKey, newDate).catch(() => {
      setLocalDates(prev => ({ ...prev, [issueKey]: orig }));
    });
  }, []);

  // Drop from EpicHierarchyPanel
  const handleExternalDrop = useCallback(({ start }) => {
    const issue = window.__planJiraDrag;
    if (!issue || !issue.fields) return;

    const dropDate = start instanceof Date ? start : parseISO(format(start, 'yyyy-MM-dd'));
    const issueKey = issue.key;
    const est = issue.fields.timeoriginalestimate || 0;
    const assigneeId = issue.fields.assignee?.accountId || '__unassigned__';

    // Compute split
    const segments = computeSplit(est, assigneeId, dropDate, displayedIssues);
    const lastDate = segments[segments.length - 1]?.date || format(dropDate, 'yyyy-MM-dd');

    // Check over-capacity
    if (est > 0 && segments.length > 1) {
      setCapacityWarning({ message: `Split across ${segments.length} days: ${segments.map(s => `${format(parseISO(s.date), 'EEE MMM d')} (${fmtHours(s.seconds)})`).join(', ')}` });
      setTimeout(() => setCapacityWarning(null), 5000);
    } else if (est > 0) {
      const used = computeDayCapacity(displayedIssues, lastDate)[assigneeId]?.used || 0;
      if (used + est > DAY_CAPACITY_SECONDS) {
        setCapacityWarning({ message: `⚠ Over capacity for ${issue.fields.assignee?.displayName || 'Unassigned'} on ${lastDate}` });
        setTimeout(() => setCapacityWarning(null), 4000);
      }
    }

    // Optimistic: add issue with last segment date (for calendar display)
    const scheduledIssue = { ...issue, fields: { ...issue.fields, duedate: lastDate } };
    setExtraIssues(prev => [...prev.filter(i => i.key !== issueKey), scheduledIssue]);
    setLocalDates(prev => ({ ...prev, [issueKey]: lastDate }));

    // Persist
    updateIssueDueDate(issueKey, lastDate).catch(() => {
      setExtraIssues(prev => prev.filter(i => i.key !== issueKey));
      setLocalDates(prev => { const n = { ...prev }; delete n[issueKey]; return n; });
    });

    if (selectedSprintId && segments.length > 0) {
      const projectKey = issueKey.split('-')[0];
      saveSegments(projectKey, issueKey, segments).catch(() => {});
    }
  }, [displayedIssues, selectedSprintId, saveSegments]);

  // Attach unschedule callback to window for panel to call
  window.__planJiraUnscheduleCallback = handleUnschedule;

  // Reschedule all overdue
  const rescheduleAllOverdue = useCallback(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (const issue of overdueIssues) {
      const est = issue.fields.timeoriginalestimate || 0;
      const assigneeId = issue.fields.assignee?.accountId || '__unassigned__';
      const segments = computeSplit(est, assigneeId, today, displayedIssues);
      const lastDate = segments[segments.length - 1]?.date || format(today, 'yyyy-MM-dd');
      setLocalDates(prev => ({ ...prev, [issue.key]: lastDate }));
      updateIssueDueDate(issue.key, lastDate).catch(() => {});
      if (selectedSprintId && segments.length > 0) {
        const projectKey = issue.key.split('-')[0];
        saveSegments(projectKey, issue.key, segments).catch(() => {});
      }
    }
  }, [overdueIssues, displayedIssues, selectedSprintId, saveSegments]);

  // Milestone handlers
  const handleSelectSlot = useCallback(({ start }) => {
    if (!projectKeys[0]) return;
    setMilestoneDialog({ type: 'project', projectKey: projectKeys[0], initialDate: format(start, 'yyyy-MM-dd'), existing: null });
  }, [projectKeys]);

  const handleSelectEvent = useCallback((event) => {
    if (event.isContinuation) return;
    if (event.resource?._isProjectMilestone) {
      const { projectKey, milestone } = event.resource;
      setMilestoneDialog({ type: 'project', projectKey, initialDate: milestone.date, existing: milestone });
      return;
    }
    // Fix 3: open detail pane
    setDetailIssueKey(event.id);
  }, []);

  const rbcViewMap = { month: 'month', week: 'week', day: 'day' };

  const components = useMemo(() => ({
    event: (props) => <IssueEventBar {...props} />,
    month: {
      dateHeader: ({ date, label }) => (
        <CapacityDateHeader date={date} label={label} issues={displayedIssues} />
      ),
    },
    resourceHeader: resources ? ({ resource }) => (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px' }}>
        {resource.avatarUrl
          ? <img src={resource.avatarUrl} alt="" style={{ width: 20, height: 20, borderRadius: '50%' }} />
          : <span style={{ width: 20, height: 20, borderRadius: '50%', background: colorOf(resource.id), display: 'inline-block' }} />
        }
        <span style={{ fontSize: 12, fontWeight: 600, color: '#172B4D' }}>{resource.title}</span>
      </div>
    ) : undefined,
  }), [displayedIssues, colorOf, resources]);

  const toggleDeveloper = (accountId) => {
    onDeveloperFilterChange(prev => {
      if (!prev) prev = [];
      if (prev.includes(accountId)) return prev.filter(id => id !== accountId);
      return [...prev, accountId];
    });
  };

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Sprint health bar */}
      {selectedSprintId && (
        <SprintHealthBar sprint={null} issues={[...displayedIssues, ...(sprintIssues || [])]} />
      )}

      {/* Overdue panel */}
      <OverduePanel issues={overdueIssues} onNavigate={onNavigate} />

      {/* Epic filter chips + iCal export */}
      {availableEpics.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#5E6C84', fontWeight: 600 }}>Epic:</span>
          <button
            onClick={() => setSelectedEpicKey(null)}
            style={{
              padding: '3px 10px', borderRadius: 12, fontSize: 11, cursor: 'pointer', fontWeight: 600,
              border: !selectedEpicKey ? '2px solid #6554C0' : '1.5px solid #DFE1E6',
              background: !selectedEpicKey ? '#EAE6FF' : '#F4F5F7',
              color: !selectedEpicKey ? '#6554C0' : '#42526E',
            }}
          >
            All
          </button>
          {availableEpics.map(e => (
            <button
              key={e.key}
              onClick={() => setSelectedEpicKey(selectedEpicKey === e.key ? null : e.key)}
              title={`${e.key}: ${e.summary}`}
              style={{
                padding: '3px 10px', borderRadius: 12, fontSize: 11, cursor: 'pointer', fontWeight: 600,
                border: selectedEpicKey === e.key ? '2px solid #6554C0' : '1.5px solid #DFE1E6',
                background: selectedEpicKey === e.key ? '#EAE6FF' : '#F4F5F7',
                color: selectedEpicKey === e.key ? '#6554C0' : '#42526E',
                maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {e.key}: {e.summary.length > 18 ? e.summary.slice(0, 18) + '…' : e.summary}
            </button>
          ))}
          <button
            onClick={() => exportICS(displayedIssues)}
            title="Export issues with due dates as .ics calendar file"
            style={{
              marginLeft: 'auto', padding: '3px 10px', borderRadius: 12, fontSize: 11, cursor: 'pointer',
              fontWeight: 600, border: '1.5px solid #DFE1E6', background: '#F4F5F7', color: '#42526E',
            }}
          >
            ↓ .ics
          </button>
        </div>
      )}

      {/* Developer filter chips */}
      {visibleTeamMembers && visibleTeamMembers.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#5E6C84', fontWeight: 600 }}>Show:</span>
          <DevChip
            member={null} color="#172B4D" label="All"
            selected={!selectedDeveloperIds || selectedDeveloperIds.length === 0}
            onClick={() => onDeveloperFilterChange([])}
          />
          {visibleTeamMembers.map(m => (
            <DevChip key={m.accountId} member={m} color={colorOf(m.accountId)}
              selected={selectedDeveloperIds?.includes(m.accountId)}
              onClick={() => toggleDeveloper(m.accountId)}
            />
          ))}
          <DevChip member={null} color="#97A0AF" label="Unassigned"
            selected={selectedDeveloperIds?.includes('__unassigned__')}
            onClick={() => toggleDeveloper('__unassigned__')}
          />
        </div>
      )}

      {/* Capacity warning toast */}
      {capacityWarning && (
        <div style={{ background: '#FFFAE6', border: '1px solid #FF991F', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#974F0C' }}>
          {capacityWarning.message}
        </div>
      )}

      {/* Calendar */}
      <div style={{ background: '#fff', borderRadius: 8, padding: 16, border: '1px solid #DFE1E6', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
        {loading && <div style={{ fontSize: 13, color: '#97A0AF', marginBottom: 8 }}>Loading issues…</div>}
        {error && <div style={{ fontSize: 13, color: '#DE350B', marginBottom: 8 }}>Error: {error}</div>}

        {overdueIssues.length > 0 && (
          <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={rescheduleAllOverdue} style={{
              fontSize: 11, padding: '4px 12px', borderRadius: 4, cursor: 'pointer',
              border: '1.5px solid #FF5630', background: '#FFEBE6', color: '#DE350B', fontWeight: 600,
            }}>
              ↻ Reschedule overdue ({overdueIssues.length})
            </button>
          </div>
        )}

        <DnDCalendar
          localizer={localizer}
          events={visibleEvents}
          date={currentDate}
          onNavigate={onNavigate}
          view={rbcViewMap[viewMode] || 'month'}
          onView={() => {}}
          toolbar={false}
          style={{ height: viewMode === 'week' && resources ? Math.max(400, resources.length * 100) : 580 }}
          draggableAccessor={(event) => !event.isContinuation && !event.resource?._isProjectMilestone}
          onDragStart={({ event }) => {
            draggingKeyRef.current = event.id;
            droppedOnCalendarRef.current = false;
          }}
          onEventDrop={handleEventDrop}
          onSelectSlot={handleSelectSlot}
          onSelectEvent={handleSelectEvent}
          selectable
          eventPropGetter={() => ({ style: { background: 'transparent', border: 'none', padding: 0 } })}
          dayPropGetter={dayPropGetter}
          components={components}
          resources={resources}
          resourceIdAccessor="id"
          resourceTitleAccessor="title"
          dragFromOutsideItem={() => ({
            title: window.__planJiraDrag?.key || '',
            allDay: true,
            start: new Date(),
            end: new Date(),
            resource: window.__planJiraDrag || {},
          })}
          onDropFromOutside={handleExternalDrop}
          onDragStart={(e) => {
            // Mark event for unschedule on drag
            if (e?.event?.id) window.__planJiraUnschedule = e.event.id;
          }}
        />
      </div>

      {/* Legend */}
      <div style={{ fontSize: 11, color: '#97A0AF' }}>
        Drag from backlog → schedule · Drag event → reschedule · Drag back to panel → unschedule ·
        {' '}Day: <span style={{ color: '#36B37E' }}>■</span> &lt;67%
        {' '}<span style={{ color: '#FF991F' }}>■</span> 67–100%
        {' '}<span style={{ color: '#FF5630' }}>■</span> over capacity ·
        {' '}Event border: grey=todo · blue=in progress · green=done · red=overdue
      </div>

      <IssueDetailPane
        issueKey={detailIssueKey}
        onClose={() => setDetailIssueKey(null)}
        onAddMilestone={(issueKey, initialDate) => {
          setDetailIssueKey(null);
          setMilestoneDialog({ type: 'issue', issueKey, initialDate: initialDate || format(new Date(), 'yyyy-MM-dd'), existing: null });
        }}
      />

      {milestoneDialog && (
        <MilestoneDialog
          initialDate={milestoneDialog.initialDate}
          existing={milestoneDialog.existing}
          onSave={async (milestone) => {
            if (milestoneDialog.type === 'project') await saveProjectMilestone(milestoneDialog.projectKey, milestone);
            else await saveMilestone(milestoneDialog.issueKey, milestone);
          }}
          onDelete={async (milestoneId) => {
            if (milestoneDialog.type === 'project') await removeProjectMilestone(milestoneDialog.projectKey, milestoneId);
            else await removeMilestone(milestoneDialog.issueKey, milestoneId);
          }}
          onClose={() => setMilestoneDialog(null)}
        />
      )}
    </div>
  );
}
