import { useState, useEffect } from 'react';
import { getEpicsForProjects, getStoriesForEpics, getSubtasksForStories, getVersionsForProjects } from '../api/bridge';

export function useEpicHierarchy(projectKeys, selectedVersionId) {
  const [epics, setEpics] = useState([]);
  const [storiesByEpic, setStoriesByEpic] = useState({});
  const [subtasksByStory, setSubtasksByStory] = useState({});
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Fetch versions separately (only when projects change)
  useEffect(() => {
    if (!projectKeys.length) { setVersions([]); return; }
    getVersionsForProjects(projectKeys)
      .then(setVersions)
      .catch(() => setVersions([]));
  }, [projectKeys.join(',')]);

  // Fetch hierarchy when projects change
  useEffect(() => {
    if (!projectKeys.length) {
      setEpics([]); setStoriesByEpic({}); setSubtasksByStory({});
      return;
    }
    setLoading(true);
    setError(null);

    getEpicsForProjects(projectKeys)
      .then(async (fetchedEpics) => {
        setEpics(fetchedEpics);
        const epicKeys = fetchedEpics.map(e => e.key);
        const stories = await getStoriesForEpics(epicKeys);

        // Group stories by epic key
        const byEpic = {};
        for (const s of stories) {
          const pk = s.fields?.parent?.key;
          if (!pk) continue;
          if (!byEpic[pk]) byEpic[pk] = [];
          byEpic[pk].push(s);
        }
        setStoriesByEpic(byEpic);

        // Fetch subtasks for all stories
        const storyKeys = stories.map(s => s.key);
        const subtasks = await getSubtasksForStories(storyKeys);
        const byStory = {};
        for (const st of subtasks) {
          const pk = st.fields?.parent?.key;
          if (!pk) continue;
          if (!byStory[pk]) byStory[pk] = [];
          byStory[pk].push(st);
        }
        setSubtasksByStory(byStory);
      })
      .catch(e => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, [projectKeys.join(',')]);

  // Apply version filter client-side
  // No filter: return everything
  if (!selectedVersionId) {
    return { epics, storiesByEpic, subtasksByStory, versions, loading, error };
  }

  // Filter stories to those in the selected version (versions are usually set on stories, not epics)
  const filteredStoriesByEpic = {};
  for (const epicKey of Object.keys(storiesByEpic)) {
    const versionStories = storiesByEpic[epicKey].filter(s =>
      (s.fields?.fixVersions || []).some(v => v.id === selectedVersionId)
    );
    if (versionStories.length > 0) filteredStoriesByEpic[epicKey] = versionStories;
  }

  // Include epic if it directly has the version OR has at least one story in the version
  const filteredEpics = epics.filter(e =>
    (e.fields?.fixVersions || []).some(v => v.id === selectedVersionId) ||
    !!filteredStoriesByEpic[e.key]
  );

  return { epics: filteredEpics, storiesByEpic: filteredStoriesByEpic, subtasksByStory, versions, loading, error };
}
