import React, { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { getIssueDetails } from '../api/bridge';

function fmtHours(s) {
  if (!s) return null;
  const h = s / 3600;
  return h === Math.floor(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

const STATUS_COLORS = {
  new: '#DFE1E6',
  indeterminate: '#0052CC',
  done: '#00875A',
};

const PRIORITY_ICONS = { Highest: '⬆⬆', High: '⬆', Medium: '➡', Low: '⬇', Lowest: '⬇⬇' };

const TODAY_STR = format(new Date(), 'yyyy-MM-dd');

function adfToText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.content) {
    const childText = node.content.map(adfToText).join('');
    return node.type === 'paragraph' ? childText + '\n' : childText;
  }
  return '';
}

function DescriptionText({ doc }) {
  if (!doc) return <span style={{ color: '#97A0AF', fontSize: 12 }}>No description</span>;
  try {
    const text = adfToText(doc).trim();
    if (!text) return <span style={{ color: '#97A0AF', fontSize: 12 }}>No description</span>;
    return <span style={{ fontSize: 12, color: '#172B4D', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{text}</span>;
  } catch (e) {
    return <span style={{ color: '#97A0AF', fontSize: 12 }}>No description</span>;
  }
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#5E6C84', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}

function IssueBody({ issue }) {
  const f = issue.fields || {};
  const statusKey = f.status?.statusCategory?.key || 'new';
  const statusColor = STATUS_COLORS[statusKey] || '#DFE1E6';
  const est = fmtHours(f.timeoriginalestimate);
  const spent = fmtHours(f.timespent);
  const remaining = fmtHours(f.timeestimate);
  const avatar = f.assignee?.avatarUrls?.['48x48'] || f.assignee?.avatarUrls?.['32x32'];
  const isOverdue = f.duedate && f.duedate < TODAY_STR && statusKey !== 'done';

  const sprintField = f.customfield_10014;
  const sprintName = Array.isArray(sprintField) && sprintField.length > 0
    ? sprintField[sprintField.length - 1]?.name
    : null;

  return (
    <div>
      {/* Summary */}
      <div style={{ fontSize: 15, fontWeight: 700, color: '#172B4D', marginBottom: 14, lineHeight: 1.4 }}>
        {f.summary}
      </div>

      {/* Status + type + priority */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        <span style={{ background: statusColor + '22', color: statusColor, border: `1px solid ${statusColor}44`, borderRadius: 4, padding: '3px 10px', fontSize: 12, fontWeight: 700 }}>
          {f.status?.name}
        </span>
        {f.issuetype && (
          <span style={{ background: '#F4F5F7', color: '#42526E', borderRadius: 4, padding: '3px 10px', fontSize: 12, fontWeight: 600 }}>
            {f.issuetype.name}
          </span>
        )}
        {f.priority && (
          <span style={{ background: '#FFF8F0', color: '#974F0C', borderRadius: 4, padding: '3px 10px', fontSize: 12, fontWeight: 600 }}>
            {PRIORITY_ICONS[f.priority.name] || ''} {f.priority.name}
          </span>
        )}
      </div>

      {/* Assignee */}
      <Field label="Assignee">
        {f.assignee ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {avatar && <img src={avatar} alt="" style={{ width: 28, height: 28, borderRadius: '50%' }} />}
            <span style={{ fontSize: 13, color: '#172B4D', fontWeight: 600 }}>{f.assignee.displayName}</span>
          </div>
        ) : <span style={{ fontSize: 12, color: '#97A0AF' }}>Unassigned</span>}
      </Field>

      {/* Time tracking */}
      {(est || spent) && (
        <Field label="Time">
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {est && <div style={{ fontSize: 12 }}><span style={{ color: '#5E6C84' }}>Est:</span> <strong>{est}</strong></div>}
            {spent && (
              <div style={{ fontSize: 12 }}>
                <span style={{ color: '#5E6C84' }}>Logged:</span>{' '}
                <strong style={{ color: f.timespent > f.timeoriginalestimate ? '#FF5630' : '#172B4D' }}>{spent}</strong>
              </div>
            )}
            {remaining && <div style={{ fontSize: 12 }}><span style={{ color: '#5E6C84' }}>Rem:</span> <strong>{remaining}</strong></div>}
          </div>
          {f.timeoriginalestimate > 0 && (
            <div style={{ height: 4, background: '#DFE1E6', borderRadius: 2, marginTop: 6, overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 2,
                width: `${Math.min((f.timespent || 0) / f.timeoriginalestimate, 1) * 100}%`,
                background: f.timespent > f.timeoriginalestimate ? '#FF5630' : '#0052CC',
              }} />
            </div>
          )}
        </Field>
      )}

      {/* Due date */}
      {f.duedate && (
        <Field label="Due date">
          <span style={{ fontSize: 13, color: isOverdue ? '#FF5630' : '#172B4D', fontWeight: 600 }}>
            {f.duedate}{isOverdue ? ' ⚠ Overdue' : ''}
          </span>
        </Field>
      )}

      {/* Parent */}
      {f.parent && (
        <Field label="Parent">
          <span style={{ fontSize: 12, color: '#6554C0', fontWeight: 600 }}>{f.parent.key}</span>
          {f.parent.fields?.summary && (
            <span style={{ fontSize: 12, color: '#5E6C84', marginLeft: 6 }}>{f.parent.fields.summary}</span>
          )}
        </Field>
      )}

      {/* Sprint */}
      {sprintName && (
        <Field label="Sprint">
          <span style={{ fontSize: 12, color: '#172B4D' }}>{sprintName}</span>
        </Field>
      )}

      {/* Fix versions */}
      {f.fixVersions?.length > 0 && (
        <Field label="Fix version(s)">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {f.fixVersions.map(v => (
              <span key={v.id} style={{ fontSize: 11, background: '#E9F2FF', color: '#0052CC', borderRadius: 3, padding: '2px 8px' }}>{v.name}</span>
            ))}
          </div>
        </Field>
      )}

      {/* Labels */}
      {f.labels?.length > 0 && (
        <Field label="Labels">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {f.labels.map(l => (
              <span key={l} style={{ fontSize: 11, background: '#F4F5F7', color: '#42526E', borderRadius: 3, padding: '2px 8px' }}>{l}</span>
            ))}
          </div>
        </Field>
      )}

      {/* Description */}
      <Field label="Description">
        <DescriptionText doc={f.description} />
      </Field>

      {/* Linked issues */}
      {f.issuelinks?.length > 0 && (
        <Field label={`Linked issues (${f.issuelinks.length})`}>
          {f.issuelinks.slice(0, 6).map((link, idx) => {
            const linked = link.outwardIssue || link.inwardIssue;
            const direction = link.outwardIssue ? link.type?.outward : link.type?.inward;
            if (!linked) return null;
            return (
              <div key={idx} style={{ fontSize: 12, marginBottom: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ color: '#5E6C84', flexShrink: 0 }}>{direction}</span>
                <span style={{ color: '#0052CC', fontWeight: 600, flexShrink: 0 }}>{linked.key}</span>
                <span style={{ color: '#42526E', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {linked.fields?.summary?.slice(0, 50)}
                </span>
              </div>
            );
          })}
        </Field>
      )}

      {/* Comments count */}
      {f.comment?.total > 0 && (
        <Field label="Comments">
          <span style={{ fontSize: 12, color: '#5E6C84' }}>
            {f.comment.total} comment{f.comment.total !== 1 ? 's' : ''}
          </span>
        </Field>
      )}
    </div>
  );
}

export default function IssueDetailPane({ issueKey, onClose, onAddMilestone }) {
  const [issue, setIssue] = useState(null);
  const [loading, setLoading] = useState(false);
  const [siteUrl, setSiteUrl] = useState('');

  // Get Jira site URL from Forge context
  useEffect(() => {
    try {
      // @forge/bridge view export
      const { view } = require('@forge/bridge');
      view.getContext().then(ctx => {
        if (ctx?.siteUrl) setSiteUrl(ctx.siteUrl);
      }).catch(() => {});
    } catch (e) {
      // view not available — link will be omitted
    }
  }, []);

  useEffect(() => {
    if (!issueKey) return;
    setIssue(null);
    setLoading(true);
    getIssueDetails(issueKey)
      .then(setIssue)
      .catch(() => setIssue(null))
      .finally(() => setLoading(false));
  }, [issueKey]);

  const isOpen = !!issueKey;
  const jiraUrl = siteUrl && issueKey ? `${siteUrl}/browse/${issueKey}` : null;

  return (
    <>
      {isOpen && (
        <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 499 }} />
      )}
      <div style={{
        position: 'fixed', top: 0, right: 0, width: 400, height: '100vh',
        background: '#fff', borderLeft: '1px solid #DFE1E6',
        boxShadow: '-4px 0 24px rgba(0,0,0,0.14)',
        zIndex: 500, overflowY: 'auto',
        transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.22s cubic-bezier(0.4,0,0.2,1)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{ padding: '14px 16px', borderBottom: '1px solid #DFE1E6', display: 'flex', alignItems: 'center', gap: 10, background: '#FAFBFC', flexShrink: 0 }}>
          <span style={{ fontWeight: 800, fontSize: 14, color: '#0052CC' }}>
            {issueKey || ''}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            {jiraUrl && (
              <a href={jiraUrl} target="_parent"
                style={{ fontSize: 11, color: '#0052CC', textDecoration: 'none', background: '#E9F2FF', padding: '3px 10px', borderRadius: 4, border: '1px solid #B3D4FF', fontWeight: 600 }}>
                Open ↗
              </a>
            )}
            {issue && onAddMilestone && (
              <button onClick={() => onAddMilestone(issue.key, issue.fields?.duedate)} style={{
                fontSize: 11, color: '#FF991F', background: '#FFFAE6',
                border: '1px solid #FFE380', borderRadius: 4, padding: '3px 10px',
                cursor: 'pointer', fontWeight: 600,
              }}>
                + Milestone
              </button>
            )}
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#97A0AF', lineHeight: 1, padding: '0 4px' }}>×</button>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: 16, flex: 1 }}>
          {loading && <div style={{ color: '#97A0AF', fontSize: 13 }}>Loading…</div>}
          {!loading && !issue && issueKey && <div style={{ color: '#97A0AF', fontSize: 13 }}>Could not load issue details.</div>}
          {issue && <IssueBody issue={issue} />}
        </div>
      </div>
    </>
  );
}
