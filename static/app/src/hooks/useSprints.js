import { useState, useEffect } from 'react';
import { getBoardsForProject, getSprintsForBoard } from '../api/bridge';

export function useSprints(projectKeys) {
  const [sprints, setSprints] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!projectKeys.length) { setSprints([]); return; }
    setLoading(true);
    setError(null);
    Promise.all(projectKeys.map(key => getBoardsForProject(key)))
      .then(async (boardGroups) => {
        const allBoards = boardGroups.flat();
        // Deduplicate boards by id
        const seen = new Set();
        const uniqueBoards = allBoards.filter(b => { if (seen.has(b.id)) return false; seen.add(b.id); return true; });
        const sprintGroups = await Promise.all(uniqueBoards.map(b => getSprintsForBoard(b.id)));
        setSprints(sprintGroups.flat());
      })
      .catch(e => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, [projectKeys.join(',')]);

  return { sprints, loading, error };
}
