import { useState, useEffect, useCallback } from 'react';
import {
  getVersionPlanIndex, saveVersionPlanIndex,
  getVersionPlanData, saveVersionPlanData, deleteVersionPlanData,
} from '../api/bridge';

// Maximally distinct hues — deliberately only ONE orange (#EA580C) so two devs never
// render as visually-indistinguishable shades of the same color.
const PLACEHOLDER_COLORS = [
  '#2563EB', // blue
  '#16A34A', // green
  '#DC2626', // red
  '#9333EA', // purple
  '#0891B2', // cyan
  '#EA580C', // orange
  '#DB2777', // pink
  '#78350F', // brown
  '#4338CA', // indigo
  '#65A30D', // olive
  '#0D9488', // teal
  '#64748B', // slate
];

function emptyPlan() {
  return { placeholders: [], issues: {}, milestones: [], dismissedAccountIds: [] };
}

function mkId() {
  return 'plan_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

// projectKey: the Jira project key (e.g. 'PROJ') used for project properties storage
export function useVersionPlan(projectKey, versionId, planId) {
  const [planIndex, setPlanIndex] = useState([]);
  const [indexLoading, setIndexLoading] = useState(false);
  const [plan, setPlan] = useState(emptyPlan());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Load plan index when projectKey+versionId changes
  useEffect(() => {
    if (!projectKey || !versionId) { setPlanIndex([]); return; }
    setIndexLoading(true);
    getVersionPlanIndex(projectKey, versionId)
      .then(setPlanIndex)
      .catch(() => setPlanIndex([]))
      .finally(() => setIndexLoading(false));
  }, [projectKey, versionId]);

  // Load plan data when planId changes
  useEffect(() => {
    if (!projectKey || !versionId || !planId) { setPlan(emptyPlan()); return; }
    setLoading(true);
    getVersionPlanData(projectKey, versionId, planId)
      .then(data => {
        const loaded = { ...emptyPlan(), ...data };
        if (!Array.isArray(loaded.placeholders)) loaded.placeholders = [];
        if (!loaded.issues || typeof loaded.issues !== 'object') loaded.issues = {};
        if (!Array.isArray(loaded.milestones)) loaded.milestones = [];
        if (!Array.isArray(loaded.dismissedAccountIds)) loaded.dismissedAccountIds = [];
        setPlan(loaded);
      })
      .catch(() => setPlan(emptyPlan()))
      .finally(() => setLoading(false));
  }, [projectKey, versionId, planId]);

  const updatePlan = useCallback((updater) => {
    setPlan(prev => typeof updater === 'function' ? updater(prev) : { ...prev, ...updater });
  }, []);

  const updateIssueEntry = useCallback((issueKey, patch) => {
    updatePlan(prev => ({
      ...prev,
      issues: {
        ...prev.issues,
        [issueKey]: {
          startDate: null, assignedPlaceholders: [], dependencies: [],
          ...(prev.issues[issueKey] || {}),
          ...patch,
        },
      },
    }));
  }, [updatePlan]);

  const addPlaceholder = useCallback((name) => {
    updatePlan(prev => {
      const color = PLACEHOLDER_COLORS[prev.placeholders.length % PLACEHOLDER_COLORS.length];
      return {
        ...prev,
        placeholders: [...prev.placeholders, { id: mkId(), name: name.trim() || ('Dev ' + (prev.placeholders.length + 1)), color, capacityPct: 100 }],
      };
    });
  }, [updatePlan]);

  // Deterministic id from the Jira accountId means the caller can use the returned
  // id immediately (e.g. to assign it to an issue) without waiting for this state
  // update to land — no placeholder is created if one for this assignee already exists.
  // Returns null when this assignee was deliberately removed (see dismissedAccountIds) so
  // the auto-assign effects stop resurrecting a dev the user just deleted.
  const ensurePlaceholderForAssignee = useCallback((accountId, displayName) => {
    if (!accountId) return null;
    if ((plan.dismissedAccountIds || []).includes(accountId)) return null;

    // Already tracked under this accountId — reuse it.
    const byAccount = plan.placeholders.find(p => p.accountId === accountId);
    if (byAccount) return byAccount.id;

    // A manually-added placeholder for the same person (typed by name, so it has a
    // plan_* id and no accountId) must be ADOPTED rather than shadowed — otherwise the
    // same human ends up on screen twice, once per id scheme.
    const name = (displayName || '').trim();
    if (name) {
      const byName = plan.placeholders.find(p => !p.accountId && p.name.trim().toLowerCase() === name.toLowerCase());
      if (byName) {
        updatePlan(prev => ({
          ...prev,
          placeholders: prev.placeholders.map(p => p.id === byName.id ? { ...p, accountId } : p),
        }));
        return byName.id;
      }
    }

    const id = 'acc_' + accountId;
    updatePlan(prev => {
      if (prev.placeholders.some(p => p.id === id)) return prev;
      const color = PLACEHOLDER_COLORS[prev.placeholders.length % PLACEHOLDER_COLORS.length];
      return {
        ...prev,
        placeholders: [...prev.placeholders, { id, name: displayName || 'Unassigned', color, accountId, capacityPct: 100 }],
      };
    });
    return id;
  }, [updatePlan, plan.placeholders, plan.dismissedAccountIds]);

  // Capacity < 100% means this dev works fewer than the full HOURS_PER_DAY on this
  // plan — e.g. 80% of a 6h day = 4.8h/day of effective throughput toward any issue
  // they're assigned to. Clamped to (0, 100]; 0% would divide-by-zero downstream.
  const setPlaceholderCapacity = useCallback((phId, pct) => {
    const clamped = Math.max(1, Math.min(100, Math.round(pct)));
    updatePlan(prev => ({
      ...prev,
      placeholders: prev.placeholders.map(p => p.id === phId ? { ...p, capacityPct: clamped } : p),
    }));
  }, [updatePlan]);

  // Removing a dev also records their Jira accountId in `dismissedAccountIds`, because the
  // auto-assign effects re-derive placeholders from issue assignees on every plan change and
  // would otherwise resurrect the dev the moment they're deleted. Use resetDismissedAssignees
  // to opt back into auto-detection.
  const removePlaceholder = useCallback((phId) => {
    updatePlan(prev => {
      const target = prev.placeholders.find(p => p.id === phId);
      const dismissed = prev.dismissedAccountIds || [];
      return {
        ...prev,
        placeholders: prev.placeholders.filter(p => p.id !== phId),
        dismissedAccountIds: target?.accountId && !dismissed.includes(target.accountId)
          ? [...dismissed, target.accountId]
          : dismissed,
        issues: Object.fromEntries(
          Object.entries(prev.issues).map(([k, e]) => [
            k,
            { ...e, assignedPlaceholders: (e.assignedPlaceholders || []).filter(id => id !== phId) },
          ])
        ),
      };
    });
  }, [updatePlan]);

  // Drops every placeholder that isn't assigned to at least one issue — for trimming a
  // roster that accumulated devs from Jira assignees who turned out not to be planned here.
  const pruneUnusedPlaceholders = useCallback(() => {
    updatePlan(prev => {
      const used = new Set();
      for (const e of Object.values(prev.issues || {})) {
        for (const id of (e.assignedPlaceholders || [])) used.add(id);
      }
      const removed = prev.placeholders.filter(p => !used.has(p.id));
      if (!removed.length) return prev;
      const dismissed = prev.dismissedAccountIds || [];
      const newlyDismissed = removed.map(p => p.accountId).filter(a => a && !dismissed.includes(a));
      return {
        ...prev,
        placeholders: prev.placeholders.filter(p => used.has(p.id)),
        dismissedAccountIds: newlyDismissed.length ? [...dismissed, ...newlyDismissed] : dismissed,
      };
    });
  }, [updatePlan]);

  // Clears the dismissal list so auto-detection from Jira assignees can repopulate the team.
  const resetDismissedAssignees = useCallback(() => {
    updatePlan(prev => ({ ...prev, dismissedAccountIds: [] }));
  }, [updatePlan]);

  const renamePlaceholder = useCallback((phId, newName) => {
    updatePlan(prev => ({
      ...prev,
      placeholders: prev.placeholders.map(p => p.id === phId ? { ...p, name: newName } : p),
    }));
  }, [updatePlan]);

  // Reassigns every existing placeholder's color from the current PLACEHOLDER_COLORS
  // palette, in order — for plans created before a palette update, so devs that ended up
  // with two similar-looking colors (e.g. two oranges) can be fixed without recreating them.
  const recolorPlaceholders = useCallback(() => {
    updatePlan(prev => ({
      ...prev,
      placeholders: prev.placeholders.map((p, i) => ({ ...p, color: PLACEHOLDER_COLORS[i % PLACEHOLDER_COLORS.length] })),
    }));
  }, [updatePlan]);

  const addMilestone = useCallback((milestone) => {
    const ms = { id: mkId(), label: '', date: '', color: '#0052CC', ...milestone };
    updatePlan(prev => ({
      ...prev,
      milestones: [...(prev.milestones || []).filter(m => m.id !== ms.id), ms],
    }));
  }, [updatePlan]);

  const removeMilestone = useCallback((milestoneId) => {
    updatePlan(prev => ({
      ...prev,
      milestones: (prev.milestones || []).filter(m => m.id !== milestoneId),
    }));
  }, [updatePlan]);

  const clearPlan = useCallback(() => updatePlan(emptyPlan()), [updatePlan]);

  const savePlanToStorage = useCallback(async (planData) => {
    if (!projectKey || !versionId || !planId) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveVersionPlanData(projectKey, versionId, planId, planData || plan);
    } catch (e) {
      setSaveError(e?.message || 'Save failed');
      throw e;
    } finally {
      setSaving(false);
    }
  }, [projectKey, versionId, planId, plan]);

  // ── Plan index management ─────────────────────────────────────────────────────

  const createPlan = useCallback(async (name, initialData) => {
    if (!projectKey || !versionId) return null;
    const id = mkId();
    const entry = { id, name: name || ('Plan ' + (planIndex.length + 1)), createdAt: new Date().toISOString() };
    const newIndex = [...planIndex, entry];
    await saveVersionPlanIndex(projectKey, versionId, newIndex);
    await saveVersionPlanData(projectKey, versionId, id, initialData || emptyPlan());
    setPlanIndex(newIndex);
    return id;
  }, [projectKey, versionId, planIndex]);

  const renamePlanInIndex = useCallback(async (targetPlanId, newName) => {
    if (!projectKey || !versionId) return;
    const newIndex = planIndex.map(p => p.id === targetPlanId ? { ...p, name: newName } : p);
    await saveVersionPlanIndex(projectKey, versionId, newIndex);
    setPlanIndex(newIndex);
  }, [projectKey, versionId, planIndex]);

  const deletePlanFromIndex = useCallback(async (targetPlanId) => {
    if (!projectKey || !versionId) return;
    const newIndex = planIndex.filter(p => p.id !== targetPlanId);
    await saveVersionPlanIndex(projectKey, versionId, newIndex);
    await deleteVersionPlanData(projectKey, versionId, targetPlanId);
    setPlanIndex(newIndex);
  }, [projectKey, versionId, planIndex]);

  return {
    plan, loading, saving, saveError,
    planIndex, indexLoading,
    updatePlan, updateIssueEntry,
    addPlaceholder, removePlaceholder, renamePlaceholder, recolorPlaceholders, ensurePlaceholderForAssignee,
    setPlaceholderCapacity, pruneUnusedPlaceholders, resetDismissedAssignees,
    addMilestone, removeMilestone,
    clearPlan, savePlanToStorage,
    createPlan, renamePlanInIndex, deletePlanFromIndex,
  };
}
