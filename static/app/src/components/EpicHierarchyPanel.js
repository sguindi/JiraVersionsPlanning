import React, { useState, useEffect, useMemo } from 'react';
import { useEpicHierarchy } from '../hooks/useEpicHierarchy';
import { useSprintIssues } from '../hooks/useSprintIssues';
import { useTeamColors } from '../hooks/useTeamColors';
import { getBoardsForProject, getSprintsForBoard } from '../api/bridge';

const TYPE_COLORS = {
  Epic: '#6554C0', Story: '#0052CC', Task: '#00B8D9',
  Bug: '#FF5630', Subtask: '#36B37E',
};

const DAY_CAP = 6 * 3600;

function fmtHours(s) {
  if (!s) return null;
  const h = s / 3600;
  return h === Math.floor(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

function IssueRow({ issue, indent, colorOf }) {
  if (!issue || !issue.fields) return null;
  const f = issue.fields;
  const typeName = f.issuetype?.name || 'Task';
  const dotColor = TYPE_COLORS[typeName] || '#B3BAC5';
  const est = fmtHours(f.timeoriginalestimate);
  const isScheduled = !!f.duedate;
  const statusKey = f.status?.statusCategory?.key || 'new';
  const assigneeId = f.assignee?.accountId || '__unassigned__';
  const devColor = colorOf(assigneeId);
  const avatar = f.assignee?.avatarUrls?.['16x16'];

  return (
    <div
      draggable={!isScheduled}
      onDragStart={(e) => {
        if (isScheduled) return;
        window.__planJiraDrag = issue;
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', issue.key);
      }}
      onDragEnd={() => { window.__planJiraDrag = null; }}
      title={isScheduled ? `Scheduled: ${f.duedate}` : `${typeName} · Drag to schedule`}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        paddingLeft: 8 + indent * 14, paddingRight: 8,
        paddingTop: 5, paddingBottom: 5,
        borderBottom: '1px solid #F4F5F7',
        background: statusKey === 'done' ? '#F0FFF4' : '#fff',
        cursor: isScheduled ? 'default' : 'grab',
        opacity: isScheduled ? 0.55 : 1,
        fontSize: 11, userSelect: 'none',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#172B4D' }}>
        <span style={{ fontWeight: 700, color: dotColor, marginRight: 3 }}>{issue.key}</span>
        {f.summary}
      </span>
      {avatar
        ? <img src={avatar} alt="" style={{ width: 14, height: 14, borderRadius: '50%', flexShrink: 0, border: `1.5px solid ${devColor}` }} />
        : f.assignee
          ? <span style={{ width: 14, height: 14, borderRadius: '50%', background: devColor, flexShrink: 0, display: 'inline-block' }} title={f.assignee.displayName} />
          : <span style={{ width: 14, height: 14, borderRadius: '50%', background: '#DFE1E6', flexShrink: 0, display: 'inline-block' }} title="Unassigned" />
      }
      {est && <span style={{ fontSize: 10, color: '#5E6C84', background: '#DFE1E6', borderRadius: 3, padding: '1px 4px', flexShrink: 0 }}>{est}</span>}
      {isScheduled && <span style={{ fontSize: 10, color: '#36B37E', flexShrink: 0 }}>{f.duedate}</span>}
      {!isScheduled && <span style={{ color: '#B3BAC5', fontSize: 12, flexShrink: 0 }}>⠿</span>}
    </div>
  );
}

function EpicSection({ epic, stories, subtasksByStory, colorOf }) {
  const [expanded, setExpanded] = useState(true);
  if (!epic || !epic.fields) return null;
  const f = epic.fields;
  const est = fmtHours(f.timeoriginalestimate);
  const isScheduled = !!f.duedate;

  return (
    <div>
      <div
        draggable={!isScheduled}
        onDragStart={e => { if (!isScheduled) { window.__planJiraDrag = epic; e.dataTransfer.effectAllowed = 'copy'; } }}
        onDragEnd={() => { window.__planJiraDrag = null; }}
        onClick={() => setExpanded(x => !x)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
          background: '#EAE6FF', borderBottom: '1px solid #C0B6F2',
          cursor: 'pointer', fontSize: 11, fontWeight: 700, userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 9, color: '#6554C0', flexShrink: 0 }}>{expanded ? '▼' : '▶'}</span>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#6554C0', flexShrink: 0 }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#403294' }}>
          <span style={{ color: '#6554C0', marginRight: 3 }}>{epic.key}</span>{f.summary}
        </span>
        {est && <span style={{ fontSize: 10, color: '#6554C0', background: '#C0B6F2', borderRadius: 3, padding: '1px 4px', flexShrink: 0 }}>{est}</span>}
        <span style={{ fontSize: 10, color: '#8777D9', flexShrink: 0 }}>{stories.length}</span>
      </div>
      {expanded && stories.map(story => {
        const subtasks = subtasksByStory?.[story.key] || [];
        return (
          <div key={story.key}>
            <IssueRow issue={story} indent={1} colorOf={colorOf} />
            {subtasks.map(st => <IssueRow key={st.key} issue={st} indent={2} colorOf={colorOf} />)}
          </div>
        );
      })}
    </div>
  );
}

// Sprint capacity summary at the bottom of the panel
function SprintCapacitySummary({ issues, teamMembers, colorOf }) {
  if (!issues.length || !teamMembers.length) return null;
  const DAY_SECONDS = 6 * 3600;

  const byMember = {};
  for (const issue of issues) {
    if (!issue?.fields?.duedate) continue;
    const id = issue.fields.assignee?.accountId || '__unassigned__';
    if (!byMember[id]) byMember[id] = { planned: 0, name: issue.fields.assignee?.displayName || 'Unassigned' };
    byMember[id].planned += issue.fields.timeoriginalestimate || 0;
  }

  const entries = teamMembers.map(m => ({
    ...m,
    planned: byMember[m.accountId]?.planned || 0,
  })).filter(m => m.planned > 0);

  if (!entries.length) return null;

  const totalPlanned = entries.reduce((s, m) => s + m.planned, 0);

  return (
    <div style={{ padding: '8px 12px', borderTop: '1px solid #DFE1E6', background: '#FAFBFC' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#5E6C84', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Scheduled · {fmtHours(totalPlanned)}
      </div>
      {entries.map(m => {
        const pct = Math.min(m.planned / (5 * DAY_SECONDS), 1); // relative to 5-day sprint
        const color = colorOf(m.accountId);
        return (
          <div key={m.accountId} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 10, color: '#42526E', width: 70, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>
              {m.displayName}
            </span>
            <div style={{ flex: 1, height: 5, background: '#DFE1E6', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${pct * 100}%`, height: '100%', background: color, borderRadius: 3 }} />
            </div>
            <span style={{ fontSize: 10, color: '#5E6C84', flexShrink: 0 }}>{fmtHours(m.planned)}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function EpicHierarchyPanel({
  projectKeys, selectedVersionId, onVersionChange,
  selectedSprintId, onSprintChange, teamMembers,
}) {
  const { colorOf } = useTeamColors(teamMembers);

  // Load sprints for the sprint filter
  const [sprints, setSprints] = useState([]);
  useEffect(() => {
    if (!projectKeys.length) { setSprints([]); return; }
    Promise.all(projectKeys.map(k => getBoardsForProject(k)))
      .then(async (boardGroups) => {
        const seen = new Set();
        const boards = boardGroups.flat().filter(b => { if (seen.has(b.id)) return false; seen.add(b.id); return true; });
        const sprintGroups = await Promise.all(boards.map(b => getSprintsForBoard(b.id)));
        setSprints(sprintGroups.flat());
      })
      .catch(() => setSprints([]));
  }, [projectKeys.join(',')]);

  // Data source: sprint issues OR epic hierarchy
  const epicData = useEpicHierarchy(projectKeys, selectedVersionId);
  const sprintData = useSprintIssues(projectKeys, selectedSprintId);

  const usingSprint = !!selectedSprintId;
  const loading = usingSprint ? sprintData.loading : epicData.loading;
  const error = usingSprint ? sprintData.error : epicData.error;

  // When sprint selected: group issues by parent epic
  const { sprintEpics, sprintStoriesByEpic, sprintOrphans } = useMemo(() => {
    if (!usingSprint) return { sprintEpics: [], sprintStoriesByEpic: {}, sprintOrphans: [] };
    const issues = sprintData.issues || [];
    const epicMap = {};
    const byEpic = {};
    const orphans = [];
    for (const issue of issues) {
      if (!issue?.fields) continue;
      const parentKey = issue.fields.parent?.key;
      if (parentKey) {
        if (!byEpic[parentKey]) byEpic[parentKey] = [];
        byEpic[parentKey].push(issue);
      } else {
        orphans.push(issue);
      }
    }
    // Create synthetic epic stubs for grouping
    const parentKeys = Object.keys(byEpic);
    for (const pk of parentKeys) {
      const parentInfo = issues.find(i => i.key === pk)?.fields?.parent;
      epicMap[pk] = {
        key: pk,
        fields: { summary: parentInfo?.fields?.summary || pk, issuetype: { name: 'Epic' }, status: { statusCategory: { key: 'new' } } }
      };
    }
    return { sprintEpics: Object.values(epicMap), sprintStoriesByEpic: byEpic, sprintOrphans: orphans };
  }, [usingSprint, sprintData.issues]);

  const allSprintIssues = sprintData.issues || [];

  // Drop target: drag calendar event back here to unschedule
  const handleDragOver = (e) => {
    if (window.__planJiraUnschedule) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
  };
  const handleDrop = (e) => {
    const key = window.__planJiraUnschedule;
    if (key && window.__planJiraUnscheduleCallback) {
      e.preventDefault();
      window.__planJiraUnscheduleCallback(key);
      window.__planJiraUnschedule = null;
      window.__planJiraUnscheduleCallback = null;
    }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{
        width: 280, flexShrink: 0, background: '#fff', border: '1px solid #DFE1E6',
        borderRadius: 8, display: 'flex', flexDirection: 'column',
        overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', maxHeight: 720,
      }}
    >
      {/* Header */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #DFE1E6', background: '#FAFBFC' }}>
        <div style={{ fontWeight: 700, fontSize: 12, color: '#172B4D', marginBottom: 8 }}>Backlog</div>

        {/* Sprint filter — hidden for now (put aside) */}

        {/* Version filter (shown only when no sprint selected) */}
        {!selectedSprintId && (
          <select value={selectedVersionId || ''} onChange={e => onVersionChange(e.target.value || null)}
            style={{ width: '100%', padding: '5px 8px', fontSize: 11, border: '1.5px solid #DFE1E6', borderRadius: 4, background: '#fff', color: '#172B4D' }}>
            <option value="">All versions</option>
            {(epicData.versions || []).filter(v => !v.released && !v.archived).map(v => (
              <option key={v.id} value={v.id}>{v.projectKey} — {v.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Legend */}
      <div style={{ padding: '4px 8px', borderBottom: '1px solid #F4F5F7', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {Object.entries(TYPE_COLORS).map(([type, color]) => (
          <span key={type} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: '#5E6C84' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />{type}
          </span>
        ))}
      </div>

      {/* Scrollable list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && <div style={{ padding: 16, fontSize: 12, color: '#97A0AF', textAlign: 'center' }}>Loading…</div>}
        {error && <div style={{ padding: 16, fontSize: 12, color: '#DE350B' }}>Error: {error}</div>}

        {!loading && !error && usingSprint && (
          <>
            {sprintEpics.length === 0 && sprintOrphans.length === 0 && (
              <div style={{ padding: 16, fontSize: 12, color: '#97A0AF', textAlign: 'center' }}>No issues in this sprint.</div>
            )}
            {sprintEpics.map(epic => (
              <EpicSection key={epic.key} epic={epic} stories={sprintStoriesByEpic[epic.key] || []} subtasksByStory={{}} colorOf={colorOf} />
            ))}
            {sprintOrphans.length > 0 && (
              <div>
                <div style={{ padding: '4px 8px', fontSize: 10, fontWeight: 700, color: '#5E6C84', background: '#F4F5F7', textTransform: 'uppercase' }}>
                  No epic
                </div>
                {sprintOrphans.map(i => <IssueRow key={i.key} issue={i} indent={0} colorOf={colorOf} />)}
              </div>
            )}
          </>
        )}

        {!loading && !error && !usingSprint && (
          <>
            {epicData.epics.length === 0 && (
              <div style={{ padding: 16, fontSize: 12, color: '#97A0AF', textAlign: 'center' }}>
                No epics found.{selectedVersionId ? ' Try "All versions".' : ''}
              </div>
            )}
            {epicData.epics.map(epic => (
              <EpicSection key={epic.key} epic={epic}
                stories={epicData.storiesByEpic?.[epic.key] || []}
                subtasksByStory={epicData.subtasksByStory}
                colorOf={colorOf}
              />
            ))}
          </>
        )}
      </div>

      {/* Sprint capacity summary */}
      {usingSprint && <SprintCapacitySummary issues={allSprintIssues} teamMembers={teamMembers} colorOf={colorOf} />}

      <div style={{ padding: '5px 10px', borderTop: '1px solid #F4F5F7', fontSize: 10, color: '#97A0AF', textAlign: 'center' }}>
        Drag to calendar to schedule · Drag back here to unschedule
      </div>
    </div>
  );
}
