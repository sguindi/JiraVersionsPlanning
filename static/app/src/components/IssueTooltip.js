import React from 'react';

const STATUS_COLORS = {
  new: '#DFE1E6',
  indeterminate: '#0052CC',
  done: '#00875A',
};

export function statusColor(statusCategoryKey) {
  return STATUS_COLORS[statusCategoryKey] || '#DFE1E6';
}

export function statusLabel(statusCategoryKey) {
  if (statusCategoryKey === 'done') return 'Done';
  if (statusCategoryKey === 'indeterminate') return 'In Progress';
  return 'To Do';
}

export default function IssueTooltip({ issue }) {
  const f = issue.fields || {};
  const statusKey = f.status?.statusCategory?.key || 'new';
  const color = statusColor(statusKey);

  return (
    <div style={{
      position: 'absolute',
      zIndex: 1000,
      bottom: '110%',
      left: '50%',
      transform: 'translateX(-50%)',
      background: '#fff',
      border: '1px solid #DFE1E6',
      borderRadius: 6,
      boxShadow: '0 4px 16px rgba(0,0,0,0.14)',
      padding: '10px 12px',
      minWidth: 200,
      maxWidth: 280,
      pointerEvents: 'none',
      fontSize: 12,
    }}>
      <div style={{ fontWeight: 700, color: '#0052CC', marginBottom: 4 }}>{issue.key}</div>
      <div style={{ color: '#172B4D', marginBottom: 6, lineHeight: 1.4 }}>{f.summary}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
          background: color, flexShrink: 0,
        }} />
        <span style={{ color: '#5E6C84' }}>{f.status?.name || statusLabel(statusKey)}</span>
      </div>
      {f.assignee && (
        <div style={{ marginTop: 4, color: '#5E6C84' }}>
          {f.assignee.displayName}
        </div>
      )}
      {f.duedate && (
        <div style={{ marginTop: 4, color: '#97A0AF' }}>Due: {f.duedate}</div>
      )}
    </div>
  );
}
