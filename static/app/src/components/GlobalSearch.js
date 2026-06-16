import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useEpicsAndStories } from '../hooks/useEpicsAndStories';
import IssueDetailPane from './IssueDetailPane';

const TYPE_COLORS = {
  Epic: '#6554C0',
  Story: '#0052CC',
  Task: '#00B8D9',
  Bug: '#FF5630',
};

function typeColor(typeName) {
  return TYPE_COLORS[typeName] || '#97A0AF';
}

function statusColor(statusKey) {
  if (statusKey === 'done') return '#36B37E';
  if (statusKey === 'indeterminate') return '#0052CC';
  return '#97A0AF';
}

export default function GlobalSearch({ projectKeys, onClose }) {
  const { epics, stories, loading } = useEpicsAndStories(projectKeys);
  const [query, setQuery] = useState('');
  const [detailKey, setDetailKey] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        if (detailKey) setDetailKey(null);
        else onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [detailKey, onClose]);

  const allIssues = useMemo(() => [...epics, ...stories], [epics, stories]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allIssues.filter(i => {
      const key = (i.key || '').toLowerCase();
      const summary = (i.fields?.summary || '').toLowerCase();
      return key.includes(q) || summary.includes(q);
    }).slice(0, 40);
  }, [allIssues, query]);

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(9,30,66,0.54)', zIndex: 8000,
        }}
      />

      {/* Panel */}
      <div style={{
        position: 'fixed', top: 60, left: '50%', transform: 'translateX(-50%)',
        width: 600, maxWidth: '90vw', background: '#fff',
        borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.24)',
        zIndex: 8001, display: 'flex', flexDirection: 'column', maxHeight: '70vh',
      }}>
        {/* Search input */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #F4F5F7', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18, color: '#97A0AF' }}>🔍</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by issue key or summary…"
            style={{
              flex: 1, border: 'none', outline: 'none', fontSize: 15,
              color: '#172B4D', background: 'transparent',
            }}
          />
          {query && (
            <button onClick={() => setQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: '#97A0AF', lineHeight: 1 }}>×</button>
          )}
        </div>

        {/* Results */}
        <div style={{ overflowY: 'auto' }}>
          {loading && (
            <div style={{ padding: '16px', fontSize: 13, color: '#97A0AF', textAlign: 'center' }}>Loading issues…</div>
          )}
          {!loading && query.trim() && results.length === 0 && (
            <div style={{ padding: '16px', fontSize: 13, color: '#97A0AF', textAlign: 'center' }}>No issues match "{query}"</div>
          )}
          {!loading && !query.trim() && (
            <div style={{ padding: '16px', fontSize: 13, color: '#97A0AF', textAlign: 'center' }}>
              {allIssues.length > 0 ? `${allIssues.length} issues loaded — start typing to search` : 'Select a project first'}
            </div>
          )}
          {results.map(i => {
            const f = i.fields || {};
            const typeName = f.issuetype?.name;
            const statusKey = f.status?.statusCategory?.key || 'new';
            return (
              <button
                key={i.key}
                onClick={() => setDetailKey(i.key)}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 12,
                  width: '100%', textAlign: 'left', padding: '10px 16px',
                  border: 'none', borderBottom: '1px solid #F4F5F7',
                  background: 'transparent', cursor: 'pointer',
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#F8F9FA'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <span style={{
                  display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                  background: typeColor(typeName), flexShrink: 0, marginTop: 5,
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                    <span style={{ fontWeight: 700, color: '#0052CC', fontSize: 12, flexShrink: 0 }}>{i.key}</span>
                    <span style={{
                      fontSize: 10, color: statusColor(statusKey),
                      background: statusColor(statusKey) + '18',
                      padding: '1px 6px', borderRadius: 10, flexShrink: 0,
                    }}>
                      {f.status?.name || statusKey}
                    </span>
                    {typeName && (
                      <span style={{ fontSize: 10, color: typeColor(typeName), fontWeight: 600, flexShrink: 0 }}>
                        {typeName}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 13, color: '#172B4D', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.summary}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div style={{ padding: '8px 16px', borderTop: '1px solid #F4F5F7', fontSize: 11, color: '#97A0AF', display: 'flex', justifyContent: 'space-between' }}>
          <span>Click an issue to open details · Esc to close</span>
          {results.length > 0 && <span>{results.length} result{results.length !== 1 ? 's' : ''}</span>}
        </div>
      </div>

      {detailKey && (
        <IssueDetailPane
          issueKey={detailKey}
          onClose={() => setDetailKey(null)}
        />
      )}
    </>
  );
}
