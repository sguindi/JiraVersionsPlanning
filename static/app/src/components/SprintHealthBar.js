import React from 'react';
import { differenceInDays, parseISO, isAfter, isBefore } from 'date-fns';

function fmtHours(s) {
  if (!s) return '0h';
  const h = s / 3600;
  return h === Math.floor(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

function Bar({ pct, color, bg = '#DFE1E6' }) {
  return (
    <div style={{ height: 6, background: bg, borderRadius: 3, overflow: 'hidden', flex: 1 }}>
      <div style={{
        height: '100%', borderRadius: 3,
        width: `${Math.min(pct * 100, 100)}%`,
        background: color,
        transition: 'width 0.3s',
      }} />
    </div>
  );
}

export default function SprintHealthBar({ sprint, issues }) {
  if (!sprint || !issues) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const sprintStart = sprint.startDate ? parseISO(sprint.startDate) : null;
  const sprintEnd = sprint.endDate ? parseISO(sprint.endDate) : null;

  // Elapsed %
  let elapsedPct = 0;
  let totalDays = 0;
  let elapsedDays = 0;
  if (sprintStart && sprintEnd) {
    totalDays = Math.max(1, differenceInDays(sprintEnd, sprintStart));
    elapsedDays = Math.max(0, Math.min(differenceInDays(today, sprintStart), totalDays));
    elapsedPct = elapsedDays / totalDays;
  }

  // Hours metrics
  const validIssues = issues.filter(i => i && i.fields);
  const totalEstSeconds = validIssues.reduce((s, i) => s + (i.fields.timeoriginalestimate || 0), 0);
  const doneSeconds = validIssues
    .filter(i => i.fields.status?.statusCategory?.key === 'done')
    .reduce((s, i) => s + (i.fields.timeoriginalestimate || 0), 0);
  const unscheduledSeconds = validIssues
    .filter(i => !i.fields.duedate)
    .reduce((s, i) => s + (i.fields.timeoriginalestimate || 0), 0);

  const donePct = totalEstSeconds > 0 ? doneSeconds / totalEstSeconds : 0;
  const diff = donePct - elapsedPct;
  const healthColor = diff >= 0 ? '#00875A' : diff >= -0.2 ? '#FF991F' : '#DE350B';
  const healthLabel = diff >= 0 ? 'On track' : diff >= -0.2 ? 'At risk' : 'Behind';

  return (
    <div style={{
      background: '#fff', border: '1px solid #DFE1E6', borderRadius: 8,
      padding: '10px 16px', marginBottom: 10,
      boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {/* Sprint name + health badge */}
        <div style={{ fontWeight: 700, fontSize: 13, color: '#172B4D', flexShrink: 0 }}>
          {sprint.name}
        </div>
        <span style={{
          fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
          background: healthColor + '22', color: healthColor,
        }}>
          {healthLabel}
        </span>

        {/* Elapsed bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 160 }}>
          <span style={{ fontSize: 10, color: '#5E6C84', flexShrink: 0, width: 52 }}>Elapsed</span>
          <Bar pct={elapsedPct} color="#5E6C84" />
          <span style={{ fontSize: 10, color: '#5E6C84', flexShrink: 0 }}>
            {elapsedDays}/{totalDays}d
          </span>
        </div>

        {/* Done bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 160 }}>
          <span style={{ fontSize: 10, color: '#5E6C84', flexShrink: 0, width: 52 }}>Done</span>
          <Bar pct={donePct} color={healthColor} />
          <span style={{ fontSize: 10, color: healthColor, flexShrink: 0, fontWeight: 600 }}>
            {fmtHours(doneSeconds)}/{fmtHours(totalEstSeconds)}
          </span>
        </div>

        {/* Unscheduled */}
        {unscheduledSeconds > 0 && (
          <div style={{ fontSize: 11, color: '#FF991F', flexShrink: 0 }}>
            ⚠ {fmtHours(unscheduledSeconds)} unscheduled
          </div>
        )}
      </div>
    </div>
  );
}
