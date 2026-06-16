import React, { useState, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Cell, LabelList } from 'recharts';
import { format, differenceInDays, startOfMonth, endOfMonth, startOfWeek, endOfWeek, startOfQuarter, endOfQuarter, startOfYear, endOfYear, addDays } from 'date-fns';
import { useEpicsAndStories } from '../hooks/useEpicsAndStories';
import { useSprints } from '../hooks/useSprints';
import { useMilestones } from '../hooks/useMilestones';
import MilestoneDialog from './MilestoneDialog';
import MilestoneMarker from './MilestoneMarker';
import { ISSUE_TYPE_COLORS, issueColor, issueStatusColor, buildRow } from '../utils/timeline';

function statusBg(statusKey) {
  if (statusKey === 'done') return '#E3FCEF';
  if (statusKey === 'indeterminate') return '#E9F2FF';
  return '#F4F5F7';
}

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div style={{
      background: '#fff', border: '1px solid #DFE1E6', borderRadius: 6,
      padding: '8px 12px', fontSize: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
    }}>
      <div style={{ fontWeight: 700, color: '#0052CC' }}>{row.key}</div>
      <div style={{ color: '#172B4D' }}>{row.label}</div>
      {row.startMs && <div style={{ color: '#5E6C84', marginTop: 4 }}>
        {format(new Date(row.startMs), 'MMM d')} – {format(new Date(row.endMs), 'MMM d, yyyy')}
      </div>}
    </div>
  );
}

const BTN_BASE = {
  fontSize: 11, padding: '3px 8px', borderRadius: 4, border: '1px solid #DFE1E6',
  background: '#fff', color: '#42526E', cursor: 'pointer', lineHeight: '16px',
};
const BTN_ACTIVE = {
  ...BTN_BASE, border: '1px solid #0052CC', background: '#E9F2FF', color: '#0052CC', fontWeight: 600,
};

export default function TimelineView({ projectKeys, dateRange, currentDate }) {
  const { epics, stories, loading, error } = useEpicsAndStories(projectKeys);
  const { sprints } = useSprints(projectKeys);
  const allIssues = useMemo(() => [...epics, ...stories], [epics, stories]);
  const issueKeys = useMemo(() => allIssues.map(i => i.key), [allIssues]);
  const { issueMilestones, projectMilestonesMap, saveMilestone, removeMilestone, saveProjectMilestone, removeProjectMilestone } = useMilestones(issueKeys, projectKeys);

  const [expandedEpics, setExpandedEpics] = useState(new Set());
  const [milestoneDialog, setMilestoneDialog] = useState(null);
  const [viewRange, setViewRange] = useState({ start: dateRange.start, end: dateRange.end });
  const [activePreset, setActivePreset] = useState('Month');
  const [colorMode, setColorMode] = useState('type'); // 'type' | 'status'

  const startDateField = 'customfield_10015';
  const windowStart = new Date(viewRange.start + 'T00:00:00');
  const windowEnd = new Date(viewRange.end + 'T23:59:59');
  const windowStartMs = windowStart.getTime();
  const windowEndMs = windowEnd.getTime();
  const windowDays = differenceInDays(windowEnd, windowStart) + 1;

  const applyPreset = (preset) => {
    const today = new Date();
    let s, e;
    if (preset === 'Week') { s = startOfWeek(today, { weekStartsOn: 1 }); e = endOfWeek(today, { weekStartsOn: 1 }); }
    else if (preset === 'Month') { s = startOfMonth(today); e = endOfMonth(today); }
    else if (preset === 'Quarter') { s = startOfQuarter(today); e = endOfQuarter(today); }
    else { s = startOfYear(today); e = endOfYear(today); }
    setActivePreset(preset);
    setViewRange({ start: format(s, 'yyyy-MM-dd'), end: format(e, 'yyyy-MM-dd') });
  };

  const zoomIn = () => {
    const sMs = new Date(viewRange.start + 'T12:00:00').getTime();
    const eMs = new Date(viewRange.end + 'T12:00:00').getTime();
    const center = (sMs + eMs) / 2;
    const half = (eMs - sMs) / 4;
    setActivePreset(null);
    setViewRange({ start: format(new Date(center - half), 'yyyy-MM-dd'), end: format(new Date(center + half), 'yyyy-MM-dd') });
  };

  const zoomOut = () => {
    const sMs = new Date(viewRange.start + 'T12:00:00').getTime();
    const eMs = new Date(viewRange.end + 'T12:00:00').getTime();
    const center = (sMs + eMs) / 2;
    const half = eMs - sMs;
    setActivePreset(null);
    setViewRange({ start: format(new Date(center - half), 'yyyy-MM-dd'), end: format(new Date(center + half), 'yyyy-MM-dd') });
  };

  const pan = (dir) => {
    const sMs = new Date(viewRange.start + 'T12:00:00').getTime();
    const eMs = new Date(viewRange.end + 'T12:00:00').getTime();
    const delta = ((eMs - sMs) / 2) * dir;
    setActivePreset(null);
    setViewRange({ start: format(new Date(sMs + delta), 'yyyy-MM-dd'), end: format(new Date(eMs + delta), 'yyyy-MM-dd') });
  };

  const rangeLabel = useMemo(() => {
    if (windowStart.getFullYear() === windowEnd.getFullYear()) {
      if (windowDays <= 60) return `${format(windowStart, 'MMM d')} – ${format(windowEnd, 'MMM d, yyyy')}`;
      return `${format(windowStart, 'MMM')} – ${format(windowEnd, 'MMM yyyy')}`;
    }
    return `${format(windowStart, 'MMM yyyy')} – ${format(windowEnd, 'MMM yyyy')}`;
  }, [windowStart, windowEnd, windowDays]);

  const rows = useMemo(() => {
    const result = [];
    const epicRows = epics
      .map(e => buildRow(e, windowStartMs, windowEndMs, startDateField))
      .filter(Boolean);

    for (const er of epicRows) {
      result.push({ ...er, barLabel: expandedEpics.has(er.key) ? '' : er.summary });
      if (expandedEpics.has(er.key)) {
        const children = stories
          .filter(s => s?.fields?.parent?.key === er.key)
          .map(s => buildRow(s, windowStartMs, windowEndMs, startDateField))
          .filter(Boolean);
        result.push(...children);
      }
    }

    // Stories without an epic parent
    const epicKeySet = new Set(epics.map(e => e.key));
    const orphanStories = stories
      .filter(s => {
        const pk = s?.fields?.parent?.key;
        return !pk || !epicKeySet.has(pk);
      })
      .map(s => { const r = buildRow(s, windowStartMs, windowEndMs, startDateField); return r ? { ...r, barLabel: '' } : null; })
      .filter(Boolean);
    result.push(...orphanStories);

    return result;
  }, [epics, stories, expandedEpics, windowStartMs, windowEndMs]);

  const toggleEpic = (key) => {
    setExpandedEpics(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Sprint reference lines in the date domain
  const sprintLines = useMemo(() => {
    return sprints
      .filter(s => s.startDate && s.endDate)
      .map(s => {
        const ms = new Date(s.startDate).getTime();
        return { ms, name: s.name, offset: ms - windowStartMs };
      })
      .filter(s => s.offset >= 0 && s.offset <= windowEndMs - windowStartMs);
  }, [sprints, windowStartMs, windowEndMs]);

  // Sprint bands for the header strip
  const sprintBands = useMemo(() => {
    const span = windowEndMs - windowStartMs;
    if (span <= 0) return [];
    return sprints
      .filter(s => s.startDate && s.endDate)
      .map(s => {
        const sMs = new Date(s.startDate).getTime();
        const eMs = new Date(s.endDate).getTime();
        const clampedS = Math.max(sMs, windowStartMs);
        const clampedE = Math.min(eMs, windowEndMs);
        if (clampedE <= clampedS) return null;
        return {
          id: s.id,
          name: s.name,
          state: s.state,
          leftPct: (clampedS - windowStartMs) / span * 100,
          widthPct: (clampedE - clampedS) / span * 100,
        };
      })
      .filter(Boolean);
  }, [sprints, windowStartMs, windowEndMs]);

  // Project milestones as vertical lines
  const allProjectMilestones = useMemo(() => {
    const all = [];
    for (const [pk, milestones] of Object.entries(projectMilestonesMap)) {
      for (const m of milestones) {
        const ms = new Date(m.date + 'T12:00:00').getTime();
        const offset = ms - windowStartMs;
        if (offset >= 0 && offset <= windowEndMs - windowStartMs) {
          all.push({ ...m, projectKey: pk, offset });
        }
      }
    }
    return all;
  }, [projectMilestonesMap, windowStartMs, windowEndMs]);

  const xTicks = useMemo(() => {
    let step;
    if (windowDays > 180) step = 30;
    else if (windowDays > 60) step = 14;
    else if (windowDays > 20) step = 7;
    else if (windowDays > 7) step = 3;
    else step = 1;
    const ticks = [];
    for (let d = 0; d < windowDays; d += step) ticks.push(d * 86400000);
    return ticks;
  }, [windowDays]);

  const xTickFormatter = (ms) => {
    const d = addDays(windowStart, ms / 86400000);
    return format(d, windowDays > 180 ? 'MMM yyyy' : 'MMM d');
  };

  if (loading) return <div style={{ padding: 24, color: '#97A0AF', fontSize: 13 }}>Loading epics and stories…</div>;
  if (error) return <div style={{ padding: 24, color: '#DE350B', fontSize: 13 }}>Error: {error}</div>;
  if (!rows.length) return <div style={{ padding: 24, color: '#97A0AF', fontSize: 13 }}>No epics found in the selected projects.</div>;

  const barHeight = 28;
  const chartHeight = Math.max(300, rows.length * barHeight + 60);
  const domainMax = windowEndMs - windowStartMs;

  return (
    <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #DFE1E6', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
      {/* Legend + zoom controls */}
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #F4F5F7', fontSize: 12, color: '#5E6C84', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {Object.entries(ISSUE_TYPE_COLORS).map(([type, color]) => (
          <span key={type} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
            {type}
          </span>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
          {['Week', 'Month', 'Quarter', 'Year'].map(p => (
            <button key={p} onClick={() => applyPreset(p)} style={activePreset === p ? BTN_ACTIVE : BTN_BASE}>{p}</button>
          ))}
          <span style={{ color: '#DFE1E6', margin: '0 2px' }}>|</span>
          <button onClick={zoomOut} style={BTN_BASE} title="Zoom out">−</button>
          <button onClick={zoomIn} style={BTN_BASE} title="Zoom in">+</button>
          <span style={{ color: '#DFE1E6', margin: '0 2px' }}>|</span>
          <button onClick={() => pan(-1)} style={BTN_BASE} title="Pan left">‹</button>
          <span style={{ fontSize: 11, color: '#42526E', minWidth: 110, textAlign: 'center' }}>{rangeLabel}</span>
          <button onClick={() => pan(1)} style={BTN_BASE} title="Pan right">›</button>
          <span style={{ color: '#DFE1E6', margin: '0 2px' }}>|</span>
          <button onClick={() => setColorMode(m => m === 'type' ? 'status' : 'type')} style={colorMode === 'status' ? BTN_ACTIVE : BTN_BASE} title="Toggle color mode">
            {colorMode === 'type' ? 'Color: Type' : 'Color: Status'}
          </button>
        </div>
      </div>

      {/* Sprint header strip */}
      {sprintBands.length > 0 && (
        <div style={{ display: 'flex', borderBottom: '1px solid #F4F5F7' }}>
          <div style={{ width: 200, flexShrink: 0, borderRight: '1px solid #F4F5F7', fontSize: 10, color: '#97A0AF', display: 'flex', alignItems: 'center', paddingLeft: 8 }}>
            Sprints
          </div>
          <div style={{ flex: 1, position: 'relative', height: 26, paddingRight: 20, overflow: 'hidden' }}>
            {sprintBands.map(s => (
              <div key={s.id} style={{
                position: 'absolute',
                left: `${s.leftPct}%`,
                width: `${s.widthPct}%`,
                top: 3, bottom: 3,
                background: s.state === 'active' ? '#E3FCEF' : '#EAE6FF',
                border: `1px solid ${s.state === 'active' ? '#57D9A3' : '#C0B6F2'}`,
                borderRadius: 3,
                display: 'flex',
                alignItems: 'center',
                paddingLeft: 5,
                overflow: 'hidden',
                boxSizing: 'border-box',
              }}>
                <span style={{ fontSize: 10, color: s.state === 'active' ? '#006644' : '#6554C0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 500 }}>
                  {s.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex' }}>
        {/* Row labels */}
        <div style={{ width: 200, flexShrink: 0, borderRight: '1px solid #F4F5F7' }}>
          <div style={{ height: 40 }} /> {/* spacer for x-axis */}
          {rows.map((row) => (
            <div
              key={row.key}
              onClick={row.isEpic ? () => toggleEpic(row.key) : undefined}
              style={{
                height: barHeight,
                display: 'flex',
                alignItems: 'center',
                paddingLeft: row.isEpic ? 8 : 20,
                fontSize: 11,
                fontWeight: row.isEpic ? 700 : 400,
                color: row.isEpic ? '#0052CC' : '#42526E',
                cursor: row.isEpic ? 'pointer' : 'default',
                borderBottom: '1px solid #F4F5F7',
                background: statusBg(row.statusKey),
                overflow: 'hidden',
                gap: 4,
              }}
              title={row.label}
            >
              {row.isEpic && (
                <span style={{ fontSize: 9, marginRight: 2 }}>
                  {expandedEpics.has(row.key) ? '▼' : '▶'}
                </span>
              )}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {row.key}
              </span>
              <button
                onClick={e => {
                  e.stopPropagation();
                  setMilestoneDialog({
                    type: 'issue', issueKey: row.key,
                    initialDate: format(new Date(row.startMs), 'yyyy-MM-dd'),
                    existing: issueMilestones[row.key]?.[0] || null,
                  });
                }}
                title="Add milestone"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#97A0AF', fontSize: 11, padding: '0 4px', lineHeight: 1 }}
              >+</button>
            </div>
          ))}
        </div>

        {/* Chart area */}
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <BarChart
              layout="vertical"
              data={rows}
              margin={{ top: 10, right: 20, left: 0, bottom: 10 }}
              barSize={barHeight - 8}
            >
              <XAxis
                type="number"
                domain={[0, domainMax]}
                ticks={xTicks}
                tickFormatter={xTickFormatter}
                fontSize={10}
                tickLine={false}
              />
              <YAxis type="category" dataKey="key" hide />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(0,82,204,0.04)' }} />

              {/* Sprint start reference lines */}
              {sprintLines.map(s => (
                <ReferenceLine key={s.ms} x={s.offset} stroke="#B3BAC5" strokeDasharray="3 3" label={{ value: s.name, fontSize: 9, fill: '#97A0AF' }} />
              ))}

              {/* Project milestone reference lines */}
              {allProjectMilestones.map(m => (
                <ReferenceLine key={`pm_${m.id}`} x={m.offset} stroke={m.color} strokeWidth={2} strokeDasharray="4 2" />
              ))}

              {/* Today line */}
              {Date.now() >= windowStartMs && Date.now() <= windowEndMs && (
                <ReferenceLine x={Date.now() - windowStartMs} stroke="#0052CC" strokeWidth={2}
                  label={{ value: 'Today', fontSize: 9, fill: '#0052CC', position: 'top' }} />
              )}

              {/* Transparent offset bar */}
              <Bar dataKey="offset" stackId="g" fill="transparent" isAnimationActive={false} />

              {/* Duration bar */}
              <Bar dataKey="duration" stackId="g" isAnimationActive={false} radius={[2, 2, 2, 2]}>
                {rows.map((row) => (
                  <Cell key={row.key}
                    fill={colorMode === 'status' ? issueStatusColor(row.statusKey) : row.color}
                    opacity={row.statusKey === 'done' ? 0.6 : 0.9} />
                ))}
                <LabelList dataKey="barLabel" position="insideLeft" style={{ fill: '#fff', fontSize: 10, fontWeight: 600 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>

          {/* Issue milestone diamonds overlaid */}
          {rows.map((row, idx) => {
            const milestones = issueMilestones[row.key] || [];
            return milestones.map(m => {
              const mMs = new Date(m.date + 'T12:00:00').getTime();
              const xPct = ((mMs - windowStartMs) / domainMax) * 100;
              if (xPct < 0 || xPct > 100) return null;
              const top = 40 + idx * barHeight + barHeight / 2 - 6;
              return (
                <div
                  key={m.id}
                  style={{
                    position: 'absolute',
                    left: `calc(${xPct}% - 6px)`,
                    top,
                    cursor: 'pointer',
                    zIndex: 10,
                  }}
                  title={m.label}
                  onClick={() => setMilestoneDialog({ type: 'issue', issueKey: row.key, initialDate: m.date, existing: m })}
                >
                  <MilestoneMarker color={m.color} label={m.label} size={12} />
                </div>
              );
            });
          })}
        </div>
      </div>

      {/* Add project milestone button */}
      <div style={{ padding: '8px 16px', borderTop: '1px solid #F4F5F7', display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: '#97A0AF' }}>Add team milestone:</span>
        {projectKeys.map(pk => (
          <button key={pk} onClick={() => setMilestoneDialog({ type: 'project', projectKey: pk, initialDate: viewRange.start, existing: null })}
            style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, border: '1px dashed #B3BAC5', background: 'transparent', color: '#0052CC', cursor: 'pointer' }}>
            + {pk}
          </button>
        ))}
        {allProjectMilestones.map(m => (
          <span key={m.id} onClick={() => setMilestoneDialog({ type: 'project', projectKey: m.projectKey, initialDate: m.date, existing: m })}
            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer', color: '#42526E' }}>
            <MilestoneMarker color={m.color} size={8} />
            {m.label} ({m.date})
          </span>
        ))}
      </div>

      {milestoneDialog && (
        <MilestoneDialog
          initialDate={milestoneDialog.initialDate}
          existing={milestoneDialog.existing}
          onSave={async (milestone) => {
            if (milestoneDialog.type === 'project') {
              await saveProjectMilestone(milestoneDialog.projectKey, milestone);
            } else {
              await saveMilestone(milestoneDialog.issueKey, milestone);
            }
          }}
          onDelete={async (milestoneId) => {
            if (milestoneDialog.type === 'project') {
              await removeProjectMilestone(milestoneDialog.projectKey, milestoneId);
            } else {
              await removeMilestone(milestoneDialog.issueKey, milestoneId);
            }
          }}
          onClose={() => setMilestoneDialog(null)}
        />
      )}
    </div>
  );
}
