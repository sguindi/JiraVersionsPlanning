import { useState, useEffect, useCallback } from 'react';
import { getSprintSchedule, saveSprintSchedule, removeFromSprintSchedule } from '../api/bridge';

export function useSprintSchedule(projectKeys, sprintId) {
  const [schedule, setSchedule] = useState({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectKeys.length || !sprintId) { setSchedule({}); return; }
    setLoading(true);
    getSprintSchedule(projectKeys, sprintId)
      .then(setSchedule)
      .catch(() => setSchedule({}))
      .finally(() => setLoading(false));
  }, [projectKeys.join(','), sprintId]);

  // issueProjectKey: the project key the issue belongs to (e.g. 'PROJ')
  const saveSegments = useCallback(async (issueProjectKey, issueKey, segments) => {
    if (!sprintId) return;
    const updated = await saveSprintSchedule(issueProjectKey, sprintId, issueKey, segments);
    setSchedule(prev => ({ ...prev, [issueKey]: segments }));
    return updated;
  }, [sprintId]);

  const removeIssue = useCallback(async (issueProjectKey, issueKey) => {
    if (!sprintId) return;
    await removeFromSprintSchedule(issueProjectKey, sprintId, issueKey);
    setSchedule(prev => { const n = { ...prev }; delete n[issueKey]; return n; });
  }, [sprintId]);

  return { schedule, loading, saveSegments, removeIssue };
}
