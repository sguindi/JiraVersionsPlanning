import { useState, useEffect, useCallback } from 'react';
import {
  getMilestonesForIssues,
  setMilestone as apiSetMilestone,
  deleteMilestone as apiDeleteMilestone,
  getProjectMilestones,
  setProjectMilestone as apiSetProjectMilestone,
  deleteProjectMilestone as apiDeleteProjectMilestone,
} from '../api/bridge';

export function useMilestones(issueKeys, projectKeys) {
  const [issueMilestones, setIssueMilestones] = useState({});
  const [projectMilestonesMap, setProjectMilestonesMap] = useState({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!issueKeys.length && !projectKeys.length) return;
    setLoading(true);
    Promise.all([
      issueKeys.length ? getMilestonesForIssues(issueKeys) : Promise.resolve({}),
      projectKeys.length ? getProjectMilestones(projectKeys) : Promise.resolve({}),
    ])
      .then(([im, pm]) => {
        setIssueMilestones(im);
        setProjectMilestonesMap(pm);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [issueKeys.join(','), projectKeys.join(',')]);

  const saveMilestone = useCallback(async (issueKey, milestone) => {
    const result = await apiSetMilestone(issueKey, milestone);
    setIssueMilestones(prev => ({ ...prev, [issueKey]: result.milestones }));
    return result;
  }, []);

  const removeMilestone = useCallback(async (issueKey, milestoneId) => {
    const result = await apiDeleteMilestone(issueKey, milestoneId);
    setIssueMilestones(prev => ({ ...prev, [issueKey]: result.milestones }));
    return result;
  }, []);

  const saveProjectMilestone = useCallback(async (projectKey, milestone) => {
    const result = await apiSetProjectMilestone(projectKey, milestone);
    setProjectMilestonesMap(prev => ({ ...prev, [projectKey]: result.milestones }));
    return result;
  }, []);

  const removeProjectMilestone = useCallback(async (projectKey, milestoneId) => {
    const result = await apiDeleteProjectMilestone(projectKey, milestoneId);
    setProjectMilestonesMap(prev => ({ ...prev, [projectKey]: result.milestones }));
    return result;
  }, []);

  return {
    issueMilestones,
    projectMilestonesMap,
    loading,
    saveMilestone,
    removeMilestone,
    saveProjectMilestone,
    removeProjectMilestone,
  };
}
