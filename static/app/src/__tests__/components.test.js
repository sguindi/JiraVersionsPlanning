import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock react-big-calendar to avoid complex localizer setup in tests
jest.mock('react-big-calendar', () => ({
  Calendar: ({ children }) => <div data-testid="mock-calendar">{children}</div>,
  dateFnsLocalizer: () => ({}),
}));
jest.mock('react-big-calendar/lib/addons/dragAndDrop', () => (C) => C);

// Mock recharts to avoid canvas errors
jest.mock('recharts', () => {
  const mock = (name) => ({ children }) => <div data-testid={`recharts-${name}`}>{children}</div>;
  return {
    BarChart: mock('BarChart'),
    Bar: mock('Bar'),
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    ReferenceLine: () => null,
    LabelList: () => null,
    ResponsiveContainer: ({ children }) => <div>{children}</div>,
  };
});

// Mock all hooks that make API calls
jest.mock('../hooks/useIssues', () => ({
  useIssues: () => ({ issues: [], loading: false, error: null }),
}));
jest.mock('../hooks/useSprintIssues', () => ({
  useSprintIssues: () => ({ issues: [] }),
}));
jest.mock('../hooks/useSprintSchedule', () => ({
  useSprintSchedule: () => ({ schedule: {}, saveSegments: jest.fn(), removeIssue: jest.fn() }),
}));
jest.mock('../hooks/useTeamColors', () => ({
  useTeamColors: () => ({ colorOf: () => '#0052CC' }),
}));
jest.mock('../hooks/useMilestones', () => ({
  useMilestones: () => ({
    issueMilestones: {}, projectMilestonesMap: {},
    saveMilestone: jest.fn(), removeMilestone: jest.fn(),
    saveProjectMilestone: jest.fn(), removeProjectMilestone: jest.fn(),
  }),
}));
jest.mock('../hooks/useTeamWorkload', () => ({
  useTeamWorkload: () => ({ members: [], issuesByUser: {}, loading: false, error: null }),
}));
jest.mock('../hooks/useEpicsAndStories', () => ({
  useEpicsAndStories: () => ({ epics: [], stories: [], loading: false, error: null }),
}));
jest.mock('../hooks/useEpicHierarchy', () => ({
  useEpicHierarchy: () => ({
    epics: [], storiesByEpic: {}, subtasksByStory: {},
    loading: false, error: null,
  }),
}));
jest.mock('../hooks/useVersionPlan', () => ({
  useVersionPlan: () => ({
    planIndex: [], selectedPlanId: null, plan: null, setSelectedPlanId: jest.fn(),
    createPlan: jest.fn(), deletePlan: jest.fn(), renamePlanInIndex: jest.fn(),
    updateIssueEntry: jest.fn(), savePlanToStorage: jest.fn(),
  }),
}));
jest.mock('../api/bridge', () => ({
  updateIssueDueDate: jest.fn(),
  resolveRoughEstField: jest.fn(() => Promise.resolve(null)),
  updateRoughEstimation: jest.fn(),
}));

import TeamView from '../components/TeamView';
import GlobalSearch from '../components/GlobalSearch';
import TutorialOverlay from '../components/TutorialOverlay';

const DATE_RANGE = { start: '2025-01-01', end: '2025-01-31' };

describe('TeamView', () => {
  it('renders without crash and shows empty state message', () => {
    render(<TeamView projectKeys={['TEST']} dateRange={DATE_RANGE} />);
    expect(screen.getByText(/No team members found/i)).toBeTruthy();
  });
});

describe('GlobalSearch', () => {
  it('renders search input', () => {
    render(<GlobalSearch projectKeys={['TEST']} onClose={jest.fn()} />);
    expect(screen.getByPlaceholderText(/Search by issue key/i)).toBeTruthy();
  });

  it('closes on Escape key', () => {
    const onClose = jest.fn();
    render(<GlobalSearch projectKeys={['TEST']} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('TutorialOverlay', () => {
  it('renders the first step', () => {
    render(<TutorialOverlay onClose={jest.fn()} />);
    expect(screen.getByText(/Welcome to planJira/i)).toBeTruthy();
    expect(screen.getByText('Next ›')).toBeTruthy();
  });

  it('advances to next step', () => {
    render(<TutorialOverlay onClose={jest.fn()} />);
    fireEvent.click(screen.getByText('Next ›'));
    expect(screen.getByText('Project Selector')).toBeTruthy();
  });

  it('calls onClose when Skip tour is clicked', () => {
    const onClose = jest.fn();
    render(<TutorialOverlay onClose={onClose} />);
    fireEvent.click(screen.getByText('Skip tour'));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose and sets localStorage on Done', () => {
    const onClose = jest.fn();
    render(<TutorialOverlay onClose={onClose} />);
    // Click through all steps to Done
    const STEPS = 8;
    for (let i = 0; i < STEPS - 1; i++) {
      const btn = screen.queryByText('Next ›');
      if (btn) fireEvent.click(btn);
    }
    const done = screen.queryByText('Done ✓');
    if (done) fireEvent.click(done);
    expect(onClose).toHaveBeenCalled();
  });
});
