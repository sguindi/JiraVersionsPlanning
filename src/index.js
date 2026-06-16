import Resolver from '@forge/resolver';
import { requestJira } from '@forge/api';

const resolver = new Resolver();

async function jiraGet(path) {
  const res = await requestJira(path, { method: 'GET' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GET ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function jiraPut(path, body) {
  const res = await requestJira(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PUT ${path} → ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

// ── Issue due date update (drag-and-drop) ─────────────────────────────────────

resolver.define('updateIssueDueDate', async ({ payload }) => {
  const { issueKey, duedate } = payload;
  await jiraPut(`/rest/api/3/issue/${issueKey}`, {
    fields: { duedate: duedate || null },
  });
  return { success: true };
});

// ── Issue-level milestones ────────────────────────────────────────────────────

resolver.define('getMilestonesForIssues', async ({ payload }) => {
  const { issueKeys } = payload;
  const result = {};
  const BATCH = 20;
  for (let i = 0; i < issueKeys.length; i += BATCH) {
    const batch = issueKeys.slice(i, i + BATCH);
    await Promise.all(batch.map(async (key) => {
      try {
        const prop = await jiraGet(`/rest/api/3/issue/${key}/properties/planJira-milestones`);
        result[key] = prop.value || [];
      } catch (e) {
        result[key] = [];
      }
    }));
  }
  return result;
});

resolver.define('setMilestone', async ({ payload }) => {
  const { issueKey, milestone } = payload;
  let existing = [];
  try {
    const prop = await jiraGet(`/rest/api/3/issue/${issueKey}/properties/planJira-milestones`);
    existing = prop.value || [];
  } catch (e) {
    // 404 = property doesn't exist yet
  }
  const updated = [...existing.filter(m => m.id !== milestone.id), milestone];
  await jiraPut(`/rest/api/3/issue/${issueKey}/properties/planJira-milestones`, updated);
  return { success: true, milestones: updated };
});

resolver.define('deleteMilestone', async ({ payload }) => {
  const { issueKey, milestoneId } = payload;
  let existing = [];
  try {
    const prop = await jiraGet(`/rest/api/3/issue/${issueKey}/properties/planJira-milestones`);
    existing = prop.value || [];
  } catch (e) {
    return { success: true, milestones: [] };
  }
  const updated = existing.filter(m => m.id !== milestoneId);
  if (updated.length === 0) {
    await requestJira(`/rest/api/3/issue/${issueKey}/properties/planJira-milestones`, { method: 'DELETE' });
  } else {
    await jiraPut(`/rest/api/3/issue/${issueKey}/properties/planJira-milestones`, updated);
  }
  return { success: true, milestones: updated };
});

// ── Project-level milestones ──────────────────────────────────────────────────

resolver.define('getProjectMilestones', async ({ payload }) => {
  const { projectKeys } = payload;
  const result = {};
  await Promise.all(projectKeys.map(async (key) => {
    try {
      const prop = await jiraGet(`/rest/api/3/project/${key}/properties/planJira-milestones`);
      result[key] = prop.value || [];
    } catch (e) {
      result[key] = [];
    }
  }));
  return result;
});

resolver.define('setProjectMilestone', async ({ payload }) => {
  const { projectKey, milestone } = payload;
  let existing = [];
  try {
    const prop = await jiraGet(`/rest/api/3/project/${projectKey}/properties/planJira-milestones`);
    existing = prop.value || [];
  } catch (e) {
    // 404 = property doesn't exist yet
  }
  const updated = [...existing.filter(m => m.id !== milestone.id), milestone];
  await jiraPut(`/rest/api/3/project/${projectKey}/properties/planJira-milestones`, updated);
  return { success: true, milestones: updated };
});

resolver.define('deleteProjectMilestone', async ({ payload }) => {
  const { projectKey, milestoneId } = payload;
  let existing = [];
  try {
    const prop = await jiraGet(`/rest/api/3/project/${projectKey}/properties/planJira-milestones`);
    existing = prop.value || [];
  } catch (e) {
    return { success: true, milestones: [] };
  }
  const updated = existing.filter(m => m.id !== milestoneId);
  if (updated.length === 0) {
    await requestJira(`/rest/api/3/project/${projectKey}/properties/planJira-milestones`, { method: 'DELETE' });
  } else {
    await jiraPut(`/rest/api/3/project/${projectKey}/properties/planJira-milestones`, updated);
  }
  return { success: true, milestones: updated };
});

export const handler = resolver.getDefinitions();
