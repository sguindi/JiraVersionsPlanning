import React, { useState } from 'react';
import { format, parseISO } from 'date-fns';

function fmtHours(s) {
  if (!s) return null;
  const h = s / 3600;
  return h === Math.floor(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

export default function OverduePanel({ issues, onNavigate }) {
  const [expanded, setExpanded] = useState(true);

  if (!issues || issues.length === 0) return null;

  const totalHours = issues.reduce((s, i) => s + (i.fields?.timeoriginalestimate || 0), 0);

  return (
    <div style={{
      background: '#FFFAE6', border: '1px solid #FF8B00', borderRadius: 8,
      marginBottom: 10, overflow: 'hidden',
    }}>
      <button
        onClick={() => setExpanded(x => !x)}
        style={{
          width: '100%', textAlign: 'left', padding: '8px 14px',
          background: 'none', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8,
        }}
      >
        <span style={{ fontSize: 11, color: '#974F0C' }}>{expanded ? '▼' : '▶'}</span>
        <span style={{ fontWeight: 700, fontSize: 12, color: '#974F0C' }}>
          ⚠ Overdue — {issues.length} issue{issues.length !== 1 ? 's' : ''}
          {totalHours > 0 && ` · ${fmtHours(totalHours)}`}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#974F0C' }}>
          Click a row to navigate
        </span>
      </button>

      {expanded && (
        <div style={{ borderTop: '1px solid #FF8B00' }}>
          {issues.map(issue => {
            const f = issue.fields || {};
            const est = fmtHours(f.timeoriginalestimate);
            const statusKey = f.status?.statusCategory?.key || 'new';
            const statusColor = statusKey === 'indeterminate' ? '#0052CC' : '#97A0AF';
            return (
              <div
                key={issue.key}
                onClick={() => onNavigate && f.duedate && onNavigate(parseISO(f.duedate))}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 14px', borderBottom: '1px solid rgba(255,139,0,0.2)',
                  cursor: 'pointer', fontSize: 12,
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,139,0,0.08)'}
                onMouseLeave={e => e.currentTarget.style.background = 'none'}
              >
                <span style={{ color: '#DE350B', fontSize: 14 }}>⚠</span>
                <span style={{ fontWeight: 700, color: '#0052CC', flexShrink: 0 }}>{issue.key}</span>
                <span style={{ flex: 1, color: '#172B4D', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.summary}
                </span>
                {f.assignee && (
                  <span style={{ flexShrink: 0, color: '#42526E', fontSize: 11 }}>
                    {f.assignee.displayName}
                  </span>
                )}
                <span style={{ flexShrink: 0, color: '#5E6C84', fontSize: 11 }}>
                  Due {f.duedate ? format(parseISO(f.duedate), 'MMM d') : '?'}
                </span>
                <span style={{ flexShrink: 0, color: statusColor, fontSize: 11 }}>
                  {f.status?.name}
                </span>
                {est && (
                  <span style={{ flexShrink: 0, color: '#97A0AF', fontSize: 11 }}>({est})</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
