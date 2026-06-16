# planJira — Visual Planning for Jira

A Planyway-style planning tool built on **Atlassian Forge** (Custom UI). Gives you a calendar, Gantt timeline, team workload heatmap, and version planning board — all backed by your live Jira data.

---

## Features

| Tab | What it does |
|---|---|
| **Calendar** | Drag issues onto days to set due dates. Epic filter chips. Developer filter. iCal export. Overdue panel with auto-reschedule. |
| **Timeline** | Gantt chart with zoom (Week / Month / Quarter / Year), pan, sprint strips, today line, and color-by-type or color-by-status toggle. |
| **Team** | Heatmap of issues per developer per day/week. Click any cell to see the full issue list. Red = over 8 h capacity. |
| **Version Planning** | Build multi-sprint dependency plans. Auto-cascade start dates. Conflict detection (red). Critical path highlight (orange). |
| **Global Search** | Search all loaded issues by key or summary from the header. |
| **Saved Filters** | Project selection, sprint, version, and developer filters persist across page reloads. |
| **Tutorial** | 8-step guided tour on first load. Replay with the ❓ button. |

---

## Tech Stack

- **Platform:** Atlassian Forge `jira:globalPage` (Custom UI)
- **Frontend:** React 18, react-big-calendar, Recharts, date-fns v3
- **API:** `@forge/bridge` `requestJira` — no backend resolver
- **Tests:** Jest via react-scripts (CRA), @testing-library/react

---

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- [Forge CLI](https://developer.atlassian.com/platform/forge/getting-started/) — `npm install -g @forge/cli`
- An Atlassian account with a Jira site (free tier works)

---

## Setup & Development

```bash
# 1. Clone
git clone https://github.com/sguindi/JiraVersionsPlanning.git
cd JiraVersionsPlanning

# 2. Install Forge dependencies (root)
npm install

# 3. Install React app dependencies
cd static/app
npm install
cd ../..

# 4. Log in to Forge
forge login

# 5. Register the app (first time only — creates a new app ID for you)
forge register

# 6. Start the React dev server
cd static/app && npm start &

# 7. In a separate terminal, start the Forge tunnel
forge tunnel
```

Open your Jira site → Apps → planJira.

---

## Deploy to Production

```bash
# Build the React app first (required before every deploy)
cd static/app
npm run build
cd ../..

# Deploy
forge deploy

# Install on your Jira site (first time only)
forge install
```

---

## Run Tests

```bash
cd static/app
npm test
```

33 tests across `src/__tests__/utils.test.js` (pure functions) and `src/__tests__/components.test.js` (smoke tests).

---

## Project Structure

```
planJira/
├── manifest.yml              # Forge app manifest
├── package.json              # Forge CLI dependencies
├── src/
│   └── index.js              # Forge resolver entry (minimal — no backend)
└── static/app/               # React Custom UI
    ├── src/
    │   ├── App.js            # Root component, tab navigation, saved filters
    │   ├── components/
    │   │   ├── CalendarView.js        # Calendar + drag-drop
    │   │   ├── TimelineView.js        # Gantt chart
    │   │   ├── TeamView.js            # Workload heatmap
    │   │   ├── VersionPlanningView.js # Dependency planner
    │   │   ├── EpicHierarchyPanel.js  # Backlog side panel
    │   │   ├── GlobalSearch.js        # Search overlay
    │   │   └── TutorialOverlay.js     # Guided tour
    │   ├── hooks/            # Data-fetching hooks (useIssues, useEpicsAndStories, …)
    │   ├── api/
    │   │   └── bridge.js     # All Jira API calls via @forge/bridge
    │   └── utils/
    │       ├── timeline.js   # buildRow, issueColor, issueStatusColor
    │       ├── scheduling.js # computeSplit, dayLoadPct
    │       └── planning.js   # cascadePlan, findCriticalPath, detectConflicts
    └── package.json
```

---

## Jira Permissions Required

```yaml
permissions:
  scopes:
    - read:jira-user
    - read:jira-work
    - write:jira-work
    - manage:jira-project
```

---

## License

MIT
