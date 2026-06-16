import { useState, useEffect } from 'react';
import { getIssuesInSprint } from '../api/bridge';

export function useSprintIssues(projectKeys, sprintId) {
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!projectKeys.length || !sprintId) {
      setIssues([]);
      return;
    }
    setLoading(true);
    setError(null);
    getIssuesInSprint(projectKeys, sprintId)
      .then(setIssues)
      .catch(e => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, [projectKeys.join(','), sprintId]);

  const scheduled = issues.filter(i => i.fields?.duedate);
  const unscheduled = issues.filter(i => !i.fields?.duedate);

  return { issues, scheduled, unscheduled, loading, error };
}
