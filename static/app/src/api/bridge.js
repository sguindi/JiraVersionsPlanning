import { requestJira } from '@forge/bridge';

// ── Low-level helpers ─────────────────────────────────────────────────────────

async function jiraGet(path) {
  const res = await requestJira(path, { method: 'GET' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Jira API ${res.status} on ${path}: ${text}`);
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

async function searchAll(jql, fields) {
  const all = [];
  let nextPageToken;
  while (true) {
    const body = { jql, fields, maxResults: 100 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await requestJira('/rest/api/3/search/jql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Search API ${res.status}: ${text}`);
    }
    const page = await res.json();
    if (!page.issues || page.issues.length === 0) break;
    all.push(...page.issues);
    if (!page.nextPageToken) break;
    nextPageToken = page.nextPageToken;
  }
  return all;
}

// Cache the start-date custom field ID (usually customfield_10015 on Jira Cloud)
let startDateField = 'customfield_10015';
let startDateFieldResolved = false;

async function resolveStartDateField() {
  if (startDateFieldResolved) return startDateField;
  try {
    const fields = await jiraGet('/rest/api/3/field');
    const found = fields.find(f => f.name === 'Start date' || f.name === 'Start Date');
    if (found) startDateField = found.id;
  } catch (e) {
    // fall back to customfield_10015
  }
  startDateFieldResolved = true;
  return startDateField;
}

export { resolveStartDateField };

// Cache the "Rough Estimation" custom field ID
let roughEstFieldId = null;
let roughEstFieldResolved = false;

export async function resolveRoughEstField() {
  if (roughEstFieldResolved) return roughEstFieldId;
  try {
    const fields = await jiraGet('/rest/api/3/field');
    const found = fields.find(f =>
      f.name?.toLowerCase() === 'rough estimation' ||
      f.name?.toLowerCase() === 'rough estimate' ||
      f.name?.toLowerCase().includes('rough est')
    );
    if (found) roughEstFieldId = found.id;
  } catch (e) {
    roughEstFieldId = null;
  }
  roughEstFieldResolved = true;
  return roughEstFieldId;
}

// Standard fields included in every issue search
const BASE_FIELDS = ['summary', 'status', 'assignee', 'duedate', 'issuetype', 'priority',
                     'parent', 'timeoriginalestimate', 'timespent', 'created', 'fixVersions'];

// ── Projects ──────────────────────────────────────────────────────────────────

export async function getProjects() {
  const projects = [];
  let startAt = 0;
  while (true) {
    const page = await jiraGet(
      `/rest/api/3/project/search?maxResults=50&startAt=${startAt}&orderBy=name`
    );
    projects.push(...page.values);
    if (page.isLast) break;
    startAt += page.values.length;
  }
  return projects.map(p => ({ key: p.key, id: p.id, name: p.name }));
}

// ── Calendar issues ───────────────────────────────────────────────────────────

export async function getIssuesForDateRange(projectKeys, startDate, endDate) {
  const sdf = await resolveStartDateField();
  const keys = projectKeys.join(', ');
  const jql = `project in (${keys}) AND duedate >= "${startDate}" AND duedate <= "${endDate}" AND issuetype not in (Epic)`;
  return searchAll(jql, [...BASE_FIELDS, 'issuelinks', sdf]);
}

// ── Sprint issues ─────────────────────────────────────────────────────────────

export async function getIssuesInSprint(projectKeys, sprintId) {
  const sdf = await resolveStartDateField();
  const keys = projectKeys.join(', ');
  const jql = `project in (${keys}) AND sprint = ${sprintId} AND issuetype not in (Epic) ORDER BY rank ASC`;
  return searchAll(jql, [...BASE_FIELDS, 'fixVersions', 'issuelinks', sdf]);
}

// ── Timeline issues ───────────────────────────────────────────────────────────

export async function getEpicsForProjects(projectKeys) {
  const sdf = await resolveStartDateField();
  const ref = await resolveRoughEstField();
  const keys = projectKeys.join(', ');
  const jql = `project in (${keys}) AND issuetype = Epic ORDER BY created ASC`;
  const fields = [...BASE_FIELDS, 'fixVersions', 'subtasks', sdf];
  if (ref) fields.push(ref);
  return searchAll(jql, fields);
}

export async function getStoriesForEpics(epicKeys) {
  if (!epicKeys.length) return [];
  const sdf = await resolveStartDateField();
  const ref = await resolveRoughEstField();
  const keys = epicKeys.join(', ');
  const jql = `parent in (${keys}) AND issuetype in (Story, Task, Bug) ORDER BY created ASC`;
  const fields = [...BASE_FIELDS, 'fixVersions', 'subtasks', sdf];
  if (ref) fields.push(ref);
  return searchAll(jql, fields);
}

export async function getSubtasksForStories(storyKeys) {
  if (!storyKeys.length) return [];
  const ref = await resolveRoughEstField();
  const keys = storyKeys.join(', ');
  const jql = `parent in (${keys}) AND issuetype in subTaskIssueTypes() ORDER BY created ASC`;
  const fields = [...BASE_FIELDS];
  if (ref) fields.push(ref);
  return searchAll(jql, fields);
}

// ── Issue changelog (status transition history) ──────────────────────────────

export async function getIssueChangelog(issueKey) {
  const all = [];
  let startAt = 0;
  while (true) {
    const page = await jiraGet(`/rest/api/3/issue/${issueKey}/changelog?startAt=${startAt}&maxResults=100`);
    all.push(...(page.values || []));
    if (page.isLast || !page.values?.length) break;
    startAt += page.values.length;
  }
  return all;
}

export async function getVersionsForProjects(projectKeys) {
  const all = [];
  await Promise.all(projectKeys.map(async (key) => {
    try {
      const versions = await jiraGet(`/rest/api/3/project/${key}/versions`);
      all.push(...versions.map(v => ({ id: v.id, name: v.name, projectKey: key, released: v.released || false, archived: v.archived || false })));
    } catch (e) {
      // project may not have versions
    }
  }));
  return all;
}

export async function getBoardsForProject(projectKey) {
  try {
    const page = await jiraGet(`/rest/agile/1.0/board?projectKeyOrId=${projectKey}&maxResults=10`);
    return (page.values || []).map(b => ({ id: b.id, name: b.name }));
  } catch (e) {
    return [];
  }
}

export async function getSprintsForBoard(boardId) {
  const sprints = [];
  let startAt = 0;
  while (true) {
    const page = await jiraGet(
      `/rest/agile/1.0/board/${boardId}/sprint?state=active,future&maxResults=50&startAt=${startAt}`
    );
    sprints.push(...(page.values || []));
    if (page.isLast) break;
    if (!page.values?.length) break;
    startAt += page.values.length;
  }
  return sprints.map(s => ({
    id: String(s.id), name: s.name, state: s.state,
    startDate: s.startDate || null, endDate: s.endDate || null, boardId,
  }));
}

// ── Team workload ─────────────────────────────────────────────────────────────

export async function getTeamMembers(projectKeys) {
  const params = projectKeys.map(k => `projectKeys=${encodeURIComponent(k)}`).join('&');
  try {
    const users = await jiraGet(`/rest/api/3/user/assignable/multiProjectSearch?${params}&maxResults=50`);
    return (Array.isArray(users) ? users : []).map(u => ({
      accountId: u.accountId,
      displayName: u.displayName,
      avatarUrl: u.avatarUrls?.['24x24'] || u.avatarUrls?.['32x32'] || '',
      avatarUrls: u.avatarUrls || {},
    }));
  } catch (e) {
    return [];
  }
}

export async function getIssuesByAssignee(projectKeys, startDate, endDate) {
  const sdf = await resolveStartDateField();
  const keys = projectKeys.join(', ');
  const jql = `project in (${keys}) AND assignee is not EMPTY AND duedate >= "${startDate}" AND duedate <= "${endDate}"`;
  const issues = await searchAll(jql, [...BASE_FIELDS, sdf]);
  const byUser = {};
  for (const issue of issues) {
    const id = issue.fields?.assignee?.accountId;
    if (!id) continue;
    if (!byUser[id]) byUser[id] = [];
    byUser[id].push(issue);
  }
  return byUser;
}

// ── Issue detail (for detail pane) ───────────────────────────────────────────

export async function getIssueDetails(issueKey) {
  const fields = 'summary,description,status,assignee,priority,issuetype,parent,fixVersions,' +
    'timeoriginalestimate,timespent,timeestimate,created,updated,duedate,labels,comment,' +
    'issuelinks,customfield_10014,customfield_10015,customfield_10016';
  return jiraGet(`/rest/api/3/issue/${issueKey}?fields=${fields}`);
}

// ── Rough estimation inline edit ─────────────────────────────────────────────

export async function updateRoughEstimation(issueKey, hours) {
  const fieldId = await resolveRoughEstField();
  if (!fieldId) throw new Error('Rough Estimation field not found in this Jira instance');
  await jiraPut(`/rest/api/3/issue/${issueKey}`, {
    fields: { [fieldId]: Number(hours) },
  });
  return { success: true };
}

// ── Version plan — stored on Jira PROJECT properties (known-working API) ────────
// Keys: planJira-vp-{versionId}           (index of plans)
//       planJira-vp-{versionId}-{planId}  (individual plan data)

export async function getVersionPlanIndex(projectKey, versionId) {
  try {
    const prop = await jiraGet(`/rest/api/3/project/${projectKey}/properties/planJira-vp-${versionId}`);
    return Array.isArray(prop.value) ? prop.value : [];
  } catch (e) { return []; }
}

export async function saveVersionPlanIndex(projectKey, versionId, index) {
  await jiraPut(`/rest/api/3/project/${projectKey}/properties/planJira-vp-${versionId}`, index);
}

export async function getVersionPlanData(projectKey, versionId, planId) {
  try {
    const prop = await jiraGet(`/rest/api/3/project/${projectKey}/properties/planJira-vp-${versionId}-${planId}`);
    const v = prop.value || {};
    if (!Array.isArray(v.placeholders)) v.placeholders = [];
    if (!v.issues || typeof v.issues !== 'object') v.issues = {};
    if (!Array.isArray(v.milestones)) v.milestones = [];
    return v;
  } catch (e) { return {}; }
}

export async function saveVersionPlanData(projectKey, versionId, planId, plan) {
  await jiraPut(`/rest/api/3/project/${projectKey}/properties/planJira-vp-${versionId}-${planId}`, plan);
}

export async function deleteVersionPlanData(projectKey, versionId, planId) {
  try {
    await requestJira(
      `/rest/api/3/project/${projectKey}/properties/planJira-vp-${versionId}-${planId}`,
      { method: 'DELETE' }
    );
  } catch (e) { /* 404 = already gone */ }
}

// ── Issue due date update (drag-and-drop) ─────────────────────────────────────

export async function updateIssueDueDate(issueKey, duedate) {
  await jiraPut(`/rest/api/3/issue/${issueKey}`, {
    fields: { duedate: duedate || null },
  });
  return { success: true };
}

// ── Sprint split schedule (stored per project, per sprint) ────────────────────

async function getSprintScheduleRaw(projectKey, sprintId) {
  try {
    const prop = await jiraGet(`/rest/api/3/project/${projectKey}/properties/planJira-sprint-${sprintId}`);
    return prop.value || {};
  } catch (e) {
    return {};
  }
}

export async function getSprintSchedule(projectKeys, sprintId) {
  if (!projectKeys.length || !sprintId) return {};
  // Merge schedules from all selected projects (issues belong to one project each)
  const results = await Promise.all(projectKeys.map(k => getSprintScheduleRaw(k, sprintId)));
  return Object.assign({}, ...results);
}

export async function saveSprintSchedule(projectKey, sprintId, issueKey, segments) {
  const existing = await getSprintScheduleRaw(projectKey, sprintId);
  const updated = { ...existing, [issueKey]: segments };
  await jiraPut(`/rest/api/3/project/${projectKey}/properties/planJira-sprint-${sprintId}`, updated);
  return updated;
}

export async function removeFromSprintSchedule(projectKey, sprintId, issueKey) {
  const existing = await getSprintScheduleRaw(projectKey, sprintId);
  const updated = { ...existing };
  delete updated[issueKey];
  await jiraPut(`/rest/api/3/project/${projectKey}/properties/planJira-sprint-${sprintId}`, updated);
  return updated;
}

// ── Issue-level milestones ────────────────────────────────────────────────────

async function getIssueMilestoneList(issueKey) {
  try {
    const prop = await jiraGet(`/rest/api/3/issue/${issueKey}/properties/planJira-milestones`);
    return prop.value || [];
  } catch (e) {
    return [];
  }
}

export async function getMilestonesForIssues(issueKeys) {
  if (!issueKeys.length) return {};
  const result = {};
  const BATCH = 20;
  for (let i = 0; i < issueKeys.length; i += BATCH) {
    const batch = issueKeys.slice(i, i + BATCH);
    await Promise.all(batch.map(async (key) => {
      result[key] = await getIssueMilestoneList(key);
    }));
  }
  return result;
}

export async function setMilestone(issueKey, milestone) {
  const existing = await getIssueMilestoneList(issueKey);
  const updated = [...existing.filter(m => m.id !== milestone.id), milestone];
  await jiraPut(`/rest/api/3/issue/${issueKey}/properties/planJira-milestones`, updated);
  return { success: true, milestones: updated };
}

export async function deleteMilestone(issueKey, milestoneId) {
  const existing = await getIssueMilestoneList(issueKey);
  const updated = existing.filter(m => m.id !== milestoneId);
  await jiraPut(`/rest/api/3/issue/${issueKey}/properties/planJira-milestones`, updated);
  return { success: true, milestones: updated };
}

// ── Project-level milestones ──────────────────────────────────────────────────

async function getProjectMilestoneList(projectKey) {
  try {
    const prop = await jiraGet(`/rest/api/3/project/${projectKey}/properties/planJira-milestones`);
    return prop.value || [];
  } catch (e) {
    return [];
  }
}

export async function getProjectMilestones(projectKeys) {
  if (!projectKeys.length) return {};
  const result = {};
  await Promise.all(projectKeys.map(async (key) => {
    result[key] = await getProjectMilestoneList(key);
  }));
  return result;
}

export async function setProjectMilestone(projectKey, milestone) {
  const existing = await getProjectMilestoneList(projectKey);
  const updated = [...existing.filter(m => m.id !== milestone.id), milestone];
  await jiraPut(`/rest/api/3/project/${projectKey}/properties/planJira-milestones`, updated);
  return { success: true, milestones: updated };
}

export async function deleteProjectMilestone(projectKey, milestoneId) {
  const existing = await getProjectMilestoneList(projectKey);
  const updated = existing.filter(m => m.id !== milestoneId);
  await jiraPut(`/rest/api/3/project/${projectKey}/properties/planJira-milestones`, updated);
  return { success: true, milestones: updated };
}
