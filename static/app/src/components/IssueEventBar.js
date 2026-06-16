import React, { useState } from 'react';
import IssueTooltip from './IssueTooltip';

export function fmtHours(s) {
  if (!s) return null;
  const h = s / 3600;
  return h === Math.floor(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

const TODAY = new Date();
TODAY.setHours(0, 0, 0, 0);
const todayStr = TODAY.toISOString().slice(0, 10);

export default function IssueEventBar({ event, activeSprint }) {
  const [hover, setHover] = useState(false);
  const f = event.resource?.fields;
  if (!f) {
    // Milestone or ghost event
    return (
      <div style={{
        background: event.color || '#97A0AF',
        borderRadius: 3, padding: '1px 5px', fontSize: 11, color: '#fff',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {event.title}
      </div>
    );
  }

  const statusKey = f.status?.statusCategory?.key || 'new';
  const est = f.timeoriginalestimate || 0;
  const spent = f.timespent || 0;
  const logPct = est > 0 ? Math.min(spent / est, 1) : 0;
  const overLogged = est > 0 && spent > est;
  const overdue = f.duedate && f.duedate < todayStr && statusKey !== 'done';
  const isBlocked = (f.issuelinks || []).some(l =>
    (l.type?.name === 'Blocks' && l.inwardIssue) ||
    (l.type?.inward === 'is blocked by' && l.inwardIssue)
  );
  const addedLate = activeSprint?.startDate && f.created &&
    f.created.slice(0, 10) > activeSprint.startDate.slice(0, 10);

  // Status border
  const borderColor = overdue
    ? '#FF5630'
    : statusKey === 'done' ? '#00875A'
    : statusKey === 'indeterminate' ? '#0052CC'
    : 'rgba(0,0,0,0.15)';

  // Is this a continuation segment?
  const isContinuation = event.isContinuation;
  const segHours = event.segmentSeconds ? fmtHours(event.segmentSeconds) : null;
  const totalHours = est > 0 ? fmtHours(est) : null;

  const avatar = f.assignee?.avatarUrls?.['16x16'] || f.assignee?.avatarUrls?.['24x24'];

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: event.color || '#0052CC',
        border: `2px solid ${borderColor}`,
        borderRadius: 3,
        padding: '1px 4px 3px',
        fontSize: 11,
        color: '#fff',
        overflow: 'hidden',
        cursor: 'pointer',
        position: 'relative',
        minHeight: 20,
        opacity: isContinuation ? 0.72 : 1,
      }}
    >
      {/* Row 1: avatar + title + badges */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, overflow: 'hidden' }}>
        {avatar && (
          <img src={avatar} alt="" style={{ width: 12, height: 12, borderRadius: '50%', flexShrink: 0 }} />
        )}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {isContinuation ? '→ ' : ''}{event.resource?.key} {f.summary}
        </span>
        {overdue && <span title="Overdue" style={{ flexShrink: 0 }}>⚠</span>}
        {isBlocked && <span title="Blocked" style={{ flexShrink: 0 }}>🔒</span>}
        {addedLate && <span title="Added after sprint start" style={{ flexShrink: 0, fontSize: 9, color: '#FFE380' }}>+</span>}
        {segHours && totalHours && (
          <span style={{ flexShrink: 0, fontSize: 9, opacity: 0.9 }}>
            {segHours}{totalHours !== segHours ? `/${totalHours}` : ''}
          </span>
        )}
        {!segHours && totalHours && (
          <span style={{ flexShrink: 0, fontSize: 9, opacity: 0.9 }}>{totalHours}</span>
        )}
      </div>

      {/* Row 2: log progress bar */}
      {est > 0 && (
        <div style={{
          height: 2, background: 'rgba(255,255,255,0.25)',
          borderRadius: 1, marginTop: 2, overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', borderRadius: 1,
            width: `${logPct * 100}%`,
            background: overLogged ? '#FF5630' : statusKey === 'done' ? '#00875A' : 'rgba(255,255,255,0.9)',
          }} />
        </div>
      )}

      {hover && <IssueTooltip issue={event.resource} />}
    </div>
  );
}
