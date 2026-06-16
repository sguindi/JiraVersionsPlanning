import React, { useState, useMemo } from 'react';
import { format, parseISO, eachDayOfInterval, eachWeekOfInterval, endOfWeek, isWithinInterval } from 'date-fns';
import { useTeamWorkload } from '../hooks/useTeamWorkload';

const DAY_CAPACITY_H = 8;

function cellIntensity(count) {
  return Math.min(count / 5, 1);
}

function fmtH(s) {
  if (!s) return '0h';
  const h = s / 3600;
  return h === Math.floor(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

function WorkloadCell({ issues, onClick }) {
  const intensity = cellIntensity(issues.length);
  const totalH = issues.reduce((s, i) => s + (i.fields?.timeoriginalestimate || 0), 0) / 3600;
  const overCap = totalH > DAY_CAPACITY_H;
  const bg = issues.length === 0
    ? '#F4F5F7'
    : overCap
      ? `rgba(255,86,48,${0.15 + intensity * 0.5})`
      : `rgba(0, 82, 204, ${0.1 + intensity * 0.7})`;
  const textColor = intensity > 0.5 ? '#fff' : overCap ? '#FF5630' : '#172B4D';

  return (
    <td
      onClick={issues.length ? onClick : undefined}
      style={{
        background: bg,
        border: `1px solid ${overCap && issues.length ? '#FF5630' : '#DFE1E6'}`,
        textAlign: 'center',
        fontSize: 11,
        fontWeight: 600,
        color: textColor,
        width: 60,
        minWidth: 40,
        height: 32,
        cursor: issues.length ? 'pointer' : 'default',
        userSelect: 'none',
        verticalAlign: 'middle',
      }}
      title={issues.length ? `${issues.length} issue(s) · ${fmtH(totalH * 3600)} · click to expand` : ''}
    >
      {issues.length > 0 ? issues.length : ''}
    </td>
  );
}

function CellModal({ member, col, issues, onClose }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(9,30,66,0.54)', zIndex: 1999 }} />
      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
        background: '#fff', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        zIndex: 2000, width: 440, maxHeight: '70vh', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #F4F5F7', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: '#172B4D' }}>{member.displayName}</div>
            <div style={{ fontSize: 11, color: '#97A0AF', marginTop: 2 }}>
              {col.label} · {issues.length} issue{issues.length !== 1 ? 's' : ''} ·{' '}
              {fmtH(issues.reduce((s, i) => s + (i.fields?.timeoriginalestimate || 0), 0))} of {DAY_CAPACITY_H}h
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#97A0AF', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ overflowY: 'auto', padding: '8px 0' }}>
          {issues.map(i => {
            const f = i.fields || {};
            const est = f.timeoriginalestimate;
            const statusKey = f.status?.statusCategory?.key || 'new';
            const statusColor = statusKey === 'done' ? '#36B37E' : statusKey === 'indeterminate' ? '#0052CC' : '#97A0AF';
            return (
              <div key={i.key} style={{ padding: '8px 18px', borderBottom: '1px solid #F8F9FA', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{ fontWeight: 700, color: '#0052CC', fontSize: 12 }}>{i.key}</span>
                    <span style={{ fontSize: 10, color: statusColor, background: statusColor + '18', padding: '1px 6px', borderRadius: 10 }}>
                      {f.status?.name || statusKey}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: '#172B4D' }}>{f.summary}</div>
                  {f.duedate && <div style={{ fontSize: 11, color: '#97A0AF', marginTop: 2 }}>Due: {f.duedate}</div>}
                </div>
                {est > 0 && <span style={{ fontSize: 11, color: '#42526E', whiteSpace: 'nowrap' }}>{fmtH(est)}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

export default function TeamView({ projectKeys, dateRange }) {
  const { members, issuesByUser, loading, error } = useTeamWorkload(projectKeys, dateRange);
  const [groupBy, setGroupBy] = useState('day');
  const [selectedCell, setSelectedCell] = useState(null); // { member, col, issues }

  const columns = useMemo(() => {
    const start = parseISO(dateRange.start);
    const end = parseISO(dateRange.end);
    if (groupBy === 'week') {
      return eachWeekOfInterval({ start, end }, { weekStartsOn: 1 }).map(w => ({
        key: format(w, 'yyyy-MM-dd'),
        label: format(w, 'MMM d'),
        start: w,
        end: endOfWeek(w, { weekStartsOn: 1 }),
      }));
    }
    return eachDayOfInterval({ start, end }).map(d => ({
      key: format(d, 'yyyy-MM-dd'),
      label: format(d, 'EEE d'),
      start: d,
      end: d,
    }));
  }, [dateRange.start, dateRange.end, groupBy]);

  function getIssuesForCell(accountId, col) {
    return (issuesByUser[accountId] || []).filter(i => {
      const due = i.fields?.duedate;
      if (!due) return false;
      return isWithinInterval(parseISO(due), { start: col.start, end: col.end });
    });
  }

  if (loading) return <div style={{ padding: 24, color: '#97A0AF', fontSize: 13 }}>Loading team workload…</div>;
  if (error) return <div style={{ padding: 24, color: '#DE350B', fontSize: 13 }}>Error: {error}</div>;
  if (!members.length) return <div style={{ padding: 24, color: '#97A0AF', fontSize: 13 }}>No team members found for the selected projects.</div>;

  return (
    <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #DFE1E6', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
      {/* Controls */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #F4F5F7', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: '#5E6C84', fontWeight: 600 }}>Group by:</span>
        {['day', 'week'].map(g => (
          <button key={g} onClick={() => setGroupBy(g)} style={{
            padding: '4px 12px', borderRadius: 4, fontSize: 12, cursor: 'pointer', fontWeight: 600,
            border: groupBy === g ? '2px solid #0052CC' : '2px solid #DFE1E6',
            background: groupBy === g ? '#E9F2FF' : '#fff',
            color: groupBy === g ? '#0052CC' : '#42526E',
          }}>
            {g.charAt(0).toUpperCase() + g.slice(1)}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#97A0AF' }}>
          Click any cell to see issues · Red = over {DAY_CAPACITY_H}h capacity
        </span>
      </div>

      {/* Heatmap table */}
      <div style={{ overflowX: 'auto', padding: 16 }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
          <thead>
            <tr>
              <th style={{
                textAlign: 'left', padding: '6px 12px', background: '#F4F5F7',
                border: '1px solid #DFE1E6', fontSize: 11, color: '#42526E',
                fontWeight: 700, minWidth: 140, position: 'sticky', left: 0, zIndex: 1,
              }}>
                Team Member
              </th>
              {columns.map(col => (
                <th key={col.key} style={{
                  padding: '6px 4px', background: '#F4F5F7', border: '1px solid #DFE1E6',
                  fontSize: 10, color: '#42526E', fontWeight: 600, textAlign: 'center',
                  width: 60, minWidth: 40,
                }}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members.map(member => {
              const total = (issuesByUser[member.accountId] || []).length;
              return (
                <tr key={member.accountId}>
                  <td style={{
                    padding: '6px 12px', border: '1px solid #DFE1E6', background: '#FAFBFC',
                    fontWeight: 600, color: '#172B4D', whiteSpace: 'nowrap',
                    position: 'sticky', left: 0, zIndex: 1,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {member.avatarUrl && (
                        <img src={member.avatarUrl} alt="" style={{ width: 20, height: 20, borderRadius: '50%' }} />
                      )}
                      <span>{member.displayName}</span>
                      {total > 0 && (
                        <span style={{ fontSize: 10, color: '#97A0AF', fontWeight: 400 }}>({total})</span>
                      )}
                    </div>
                  </td>
                  {columns.map(col => {
                    const cellIssues = getIssuesForCell(member.accountId, col);
                    return (
                      <WorkloadCell
                        key={col.key}
                        issues={cellIssues}
                        onClick={() => setSelectedCell({ member, col, issues: cellIssues })}
                      />
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div style={{ padding: '8px 16px', borderTop: '1px solid #F4F5F7', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: '#97A0AF' }}>Load:</span>
        {[1, 2, 3, 5].map(n => (
          <span key={n} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
            <span style={{
              width: 16, height: 16, borderRadius: 3, display: 'inline-block',
              background: `rgba(0,82,204,${0.1 + cellIntensity(n) * 0.7})`,
              border: '1px solid #DFE1E6',
            }} />
            {n}{n === 5 ? '+' : ''}
          </span>
        ))}
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, marginLeft: 8 }}>
          <span style={{ width: 16, height: 16, borderRadius: 3, display: 'inline-block', background: 'rgba(255,86,48,0.4)', border: '1px solid #FF5630' }} />
          Over {DAY_CAPACITY_H}h
        </span>
      </div>

      {selectedCell && (
        <CellModal
          member={selectedCell.member}
          col={selectedCell.col}
          issues={selectedCell.issues}
          onClose={() => setSelectedCell(null)}
        />
      )}
    </div>
  );
}
