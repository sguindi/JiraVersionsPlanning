import { useState, useEffect } from 'react';
import { getEpicsForProjects, getStoriesForEpics } from '../api/bridge';

export function useEpicsAndStories(projectKeys) {
  const [epics, setEpics] = useState([]);
  const [stories, setStories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!projectKeys.length) { setEpics([]); setStories([]); return; }
    setLoading(true);
    setError(null);
    getEpicsForProjects(projectKeys)
      .then(async (fetchedEpics) => {
        setEpics(fetchedEpics);
        const epicKeys = fetchedEpics.map(e => e.key);
        const fetchedStories = await getStoriesForEpics(epicKeys);
        setStories(fetchedStories);
      })
      .catch(e => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, [projectKeys.join(',')]);

  return { epics, stories, loading, error };
}
