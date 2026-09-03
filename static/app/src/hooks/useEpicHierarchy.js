import { useState, useEffect, useCallback, useRef } from 'react';
import { getEpicsForProjects, getStoriesForEpics, getSubtasksForStories, getVersionsForProjects } from '../api/bridge';

export function useEpicHierarchy(projectKeys, selectedVersionId) {
  const [epics, setEpics] = useState([]);
  const [storiesByEpic, setStoriesByEpic] = useState({});
  const [subtasksByStory, setSubtasksByStory] = useState({});
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const epicsRef = useRef(epics);
  epicsRef.current = epics;

  // Fetch versions separately (only when projects change)
  useEffect(() => {
    if (!projectKeys.length) { setVersions([]); return; }
    getVersionsForProjects(projectKeys)
      .then(setVersions)
      .catch(() => setVersions([]));
  }, [projectKeys.join(',')]);

  // Pulls the full hierarchy fresh from Jira. Exposed as `refetch` so the UI can offer a
  // manual "Refresh from Jira" action — epics/stories added to (or removed from) the version
  // since the page loaded otherwise only show up on a full reload. Returns the key sets so a
  // caller can diff old vs new and report what changed.
  const load = useCallback(() => {
    if (!projectKeys.length) {
      setEpics([]); setStoriesByEpic({}); setSubtasksByStory({});
      return Promise.resolve({ addedEpicKeys: [], removedEpicKeys: [] });
    }
    setLoading(true);
    setError(null);
    const prevEpicKeys = new Set(epicsRef.current.map(e => e.key));

    return getEpicsForProjects(projectKeys)
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

        const newEpicKeys = new Set(epicKeys);
        return {
          addedEpicKeys: epicKeys.filter(k => !prevEpicKeys.has(k)),
          removedEpicKeys: [...prevEpicKeys].filter(k => !newEpicKeys.has(k)),
        };
      })
      .catch(e => { setError(e?.message || String(e)); return { addedEpicKeys: [], removedEpicKeys: [] }; })
      .finally(() => setLoading(false));
  }, [projectKeys.join(',')]);

  // Fetch hierarchy when projects change
  useEffect(() => { load(); }, [load]);

  // Apply version filter client-side
  // No filter: return everything
  if (!selectedVersionId) {
    return { epics, storiesByEpic, subtasksByStory, versions, loading, error, refetch: load };
  }

  const epicHasVersion = (e) => (e.fields?.fixVersions || []).some(v => v.id === selectedVersionId);

  // Which of an epic's stories belong to this version. Versions are usually set on stories,
  // but plenty of teams tag only the EPIC and leave its stories untagged — those stories used
  // to be filtered out entirely, so the epic still appeared (it carries the version itself)
  // with an expand caret but zero children, and its rolled-up hours were missing too.
  // An UNTAGGED story now inherits its epic's version. A story explicitly tagged to some
  // OTHER version is still excluded, so work already shipped in an earlier version can't leak
  // into this plan's totals.
  const storiesForEpic = (epic) => (storiesByEpic[epic.key] || []).filter(s => {
    const fvs = s.fields?.fixVersions || [];
    if (fvs.some(v => v.id === selectedVersionId)) return true;
    return fvs.length === 0 && epicHasVersion(epic);
  });

  const filteredStoriesByEpic = {};
  for (const epic of epics) {
    const versionStories = storiesForEpic(epic);
    if (versionStories.length > 0) filteredStoriesByEpic[epic.key] = versionStories;
  }

  // Include epic if it directly has the version OR has at least one story in the version
  const filteredEpics = epics.filter(e => epicHasVersion(e) || !!filteredStoriesByEpic[e.key]);

  // subtasksByStory is fetched once for EVERY story across the whole project, so it must be
  // scoped to just the stories left in filteredStoriesByEpic — otherwise every count that
  // flattens it (missing-estimate badge, estimate coverage, rough-estimate rollups) silently
  // includes subtasks from stories that belong to other versions entirely.
  const includedStoryKeys = new Set(Object.values(filteredStoriesByEpic).flat().map(s => s.key));
  const filteredSubtasksByStory = {};
  for (const key of Object.keys(subtasksByStory)) {
    if (includedStoryKeys.has(key)) filteredSubtasksByStory[key] = subtasksByStory[key];
  }

  return { epics: filteredEpics, storiesByEpic: filteredStoriesByEpic, subtasksByStory: filteredSubtasksByStory, versions, loading, error, refetch: load };
}
