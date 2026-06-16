import { useState, useEffect } from 'react';
import { getIssuesForDateRange } from '../api/bridge';

export function useIssues(projectKeys, dateRange) {
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!projectKeys.length) { setIssues([]); return; }
    setLoading(true);
    setError(null);
    getIssuesForDateRange(projectKeys, dateRange.start, dateRange.end)
      .then(setIssues)
      .catch(e => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, [projectKeys.join(','), dateRange.start, dateRange.end]);

  return { issues, loading, error };
}
