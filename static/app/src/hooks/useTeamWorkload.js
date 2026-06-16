import { useState, useEffect } from 'react';
import { getTeamMembers, getIssuesByAssignee } from '../api/bridge';

export function useTeamWorkload(projectKeys, dateRange) {
  const [members, setMembers] = useState([]);
  const [issuesByUser, setIssuesByUser] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!projectKeys.length) { setMembers([]); setIssuesByUser({}); return; }
    setLoading(true);
    setError(null);
    Promise.all([
      getTeamMembers(projectKeys),
      getIssuesByAssignee(projectKeys, dateRange.start, dateRange.end),
    ])
      .then(([fetchedMembers, fetchedIssues]) => {
        // Add any assignees from issues that are not in the members list
        const known = new Set(fetchedMembers.map(m => m.accountId));
        const extras = [];
        for (const issue of Object.values(fetchedIssues).flat()) {
          const a = issue.fields?.assignee;
          if (a && !known.has(a.accountId)) {
            known.add(a.accountId);
            extras.push({ accountId: a.accountId, displayName: a.displayName, avatarUrl: a.avatarUrls?.['24x24'] || '' });
          }
        }
        setMembers([...fetchedMembers, ...extras]);
        setIssuesByUser(fetchedIssues);
      })
      .catch(e => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, [projectKeys.join(','), dateRange.start, dateRange.end]);

  return { members, issuesByUser, loading, error };
}
