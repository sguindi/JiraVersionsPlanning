import React, { useState, useEffect, useRef } from 'react';
import { format, startOfMonth, endOfMonth, addMonths } from 'date-fns';
import { getProjects, getTeamMembers } from './api/bridge';
import CalendarView from './components/CalendarView';
import TimelineView from './components/TimelineView';
import TeamView from './components/TeamView';
import EpicHierarchyPanel from './components/EpicHierarchyPanel';
import VersionPlanningView from './components/VersionPlanningView';
import GlobalSearch from './components/GlobalSearch';
import TutorialOverlay, { useTutorial } from './components/TutorialOverlay';

const PINNED_IDS = [];
const FILTERS_KEY = 'planJira_filters';

function loadFilters() {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveFilters(obj) {
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(obj)); } catch {}
}

function isPinned(project) {
  const key = project.key.toLowerCase();
  const name = project.name.toLowerCase();
  return PINNED_IDS.some(id => key.includes(id) || name.includes(id));
}

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'monospace', color: '#BF2600', background: '#FFEBE6', borderRadius: 8, margin: 24 }}>
          <strong>App Error:</strong>
          <pre style={{ whiteSpace: 'pre-wrap', marginTop: 8, fontSize: 12 }}>
            {this.state.error?.message || String(this.state.error)}
            {'\n'}{this.state.error?.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const TABS = [
  { id: 'calendar', label: 'Calendar' },
  { id: 'version', label: 'Version Planning' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'team', label: 'Team' },
];

function App() {
  const [projects, setProjects] = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectsError, setProjectsError] = useState(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState('calendar');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [viewMode, setViewMode] = useState('month');
  const [showSearch, setShowSearch] = useState(false);
  const { active: tutorialActive, start: startTutorial, close: closeTutorial } = useTutorial();
  const dropdownRef = useRef(null);

  // Saved filter state — initialized from localStorage
  const _saved = loadFilters();
  const [selectedKeys, setSelectedKeys] = useState(() => new Set(_saved?.selectedKeys || []));
  const [addedExtras, setAddedExtras] = useState(() => _saved?.addedExtras || []);
  const [selectedVersionId, setSelectedVersionId] = useState(() => _saved?.selectedVersionId || null);
  const [selectedSprintId, setSelectedSprintId] = useState(() => _saved?.selectedSprintId || null);
  const [selectedDeveloperIds, setSelectedDeveloperIds] = useState(() => _saved?.selectedDeveloperIds || []);
  const [teamMembers, setTeamMembers] = useState([]);

  useEffect(() => {
    getProjects()
      .then(setProjects)
      .catch(e => setProjectsError(e?.message || String(e)))
      .finally(() => setLoadingProjects(false));
  }, []);

  useEffect(() => {
    function handleClickOutside(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const pinnedProjects = projects.filter(p => isPinned(p));
  const otherProjects = projects.filter(p => !isPinned(p));
  const extraProjects = otherProjects.filter(p => addedExtras.includes(p.key));
  const availableToAdd = otherProjects.filter(p => !addedExtras.includes(p.key));
  const filteredAvailable = availableToAdd.filter(p =>
    search === '' ||
    p.key.toLowerCase().includes(search.toLowerCase()) ||
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  const toggleProject = (key) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const addExtra = (project) => {
    setAddedExtras(prev => [...prev, project.key]);
    setSelectedKeys(prev => new Set([...prev, project.key]));
    setDropdownOpen(false);
    setSearch('');
  };

  const removeExtra = (key) => {
    setAddedExtras(prev => prev.filter(k => k !== key));
    setSelectedKeys(prev => { const next = new Set(prev); next.delete(key); return next; });
  };

  const visibleProjects = [...pinnedProjects, ...extraProjects];
  const selectedProjects = visibleProjects.filter(p => selectedKeys.has(p.key));
  const selectedProjectKeys = selectedProjects.map(p => p.key);

  // Load team members whenever projects change
  useEffect(() => {
    if (!selectedProjectKeys.length) { setTeamMembers([]); return; }
    getTeamMembers(selectedProjectKeys)
      .then(setTeamMembers)
      .catch(() => setTeamMembers([]));
  }, [selectedProjectKeys.join(',')]);

  // Persist filter selections to localStorage
  useEffect(() => {
    saveFilters({
      selectedKeys: [...selectedKeys],
      addedExtras,
      selectedVersionId,
      selectedSprintId,
      selectedDeveloperIds,
    });
  }, [[...selectedKeys].sort().join(','), addedExtras.join(','), selectedVersionId, selectedSprintId, selectedDeveloperIds.join(',')]);

  const dateRange = {
    start: format(startOfMonth(currentDate), 'yyyy-MM-dd'),
    end: format(endOfMonth(currentDate), 'yyyy-MM-dd'),
  };

  const goNext = () => setCurrentDate(d => addMonths(d, 1));
  const goPrev = () => setCurrentDate(d => addMonths(d, -1));
  const goToday = () => setCurrentDate(new Date());

  return (
    <div style={{
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      background: '#F4F5F7',
      minHeight: '100vh',
      padding: 24,
      boxSizing: 'border-box',
    }}>
      {/* Header */}
      <div style={{ marginBottom: 20, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0052CC', letterSpacing: '-0.3px' }}>
            planJira
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#5E6C84' }}>
            Visual planning across calendar, timeline, and team
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setShowSearch(true)}
            title="Search issues (all projects)"
            style={{
              padding: '7px 14px', borderRadius: 6, border: '2px solid #DFE1E6',
              background: '#fff', color: '#42526E', fontSize: 14, cursor: 'pointer',
              fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            🔍 Search
          </button>
          <button
            data-tutorial="help"
            onClick={startTutorial}
            title="Replay tutorial"
            style={{
              padding: '7px 10px', borderRadius: 6, border: '2px solid #DFE1E6',
              background: '#fff', color: '#42526E', fontSize: 16, cursor: 'pointer',
            }}
          >
            ❓
          </button>
        </div>
      </div>

      {/* Project selector */}
      <div data-tutorial="projects" style={{
        background: '#FFFFFF', border: '1px solid #DFE1E6', borderRadius: 8,
        padding: '12px 16px', marginBottom: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#0052CC', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }}>
          Projects
        </div>
        {loadingProjects && <div style={{ fontSize: 13, color: '#97A0AF' }}>Loading projects…</div>}
        {projectsError && <div style={{ fontSize: 13, color: '#DE350B' }}>Error: {projectsError}</div>}
        {!loadingProjects && !projectsError && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {visibleProjects.map(p => {
              const isSelected = selectedKeys.has(p.key);
              const isExtra = addedExtras.includes(p.key);
              return (
                <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                  <button onClick={() => toggleProject(p.key)} style={{
                    padding: '5px 12px',
                    borderRadius: isExtra ? '20px 0 0 20px' : 20,
                    border: `2px solid ${isSelected ? '#0052CC' : '#DFE1E6'}`,
                    borderRight: isExtra ? (isSelected ? '1px solid rgba(255,255,255,0.4)' : '1px solid #DFE1E6') : undefined,
                    background: isSelected ? '#0052CC' : '#FAFBFC',
                    color: isSelected ? '#fff' : '#42526E',
                    fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  }}>
                    {isSelected ? '✓ ' : ''}{p.key}
                  </button>
                  {isExtra && (
                    <button onClick={() => removeExtra(p.key)} title="Remove" style={{
                      padding: '5px 8px', borderRadius: '0 20px 20px 0',
                      border: `2px solid ${isSelected ? '#0052CC' : '#DFE1E6'}`, borderLeft: 'none',
                      background: isSelected ? '#0052CC' : '#FAFBFC',
                      color: isSelected ? 'rgba(255,255,255,0.8)' : '#97A0AF',
                      fontSize: 13, cursor: 'pointer', lineHeight: 1,
                    }}>×</button>
                  )}
                </div>
              );
            })}

            <div ref={dropdownRef} style={{ position: 'relative' }}>
              <button onClick={() => { setDropdownOpen(o => !o); setSearch(''); }} style={{
                padding: '5px 12px', borderRadius: 20, border: '2px dashed #B3D4FF',
                background: dropdownOpen ? '#E9F2FF' : 'transparent',
                color: '#0052CC', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}>
                + Add project
              </button>
              {dropdownOpen && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 200,
                  background: '#fff', border: '1px solid #DFE1E6', borderRadius: 8,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.12)', width: 260, overflow: 'hidden',
                }}>
                  <div style={{ padding: '8px 8px 4px' }}>
                    <input autoFocus value={search} onChange={e => setSearch(e.target.value)}
                      placeholder="Search projects…"
                      style={{ width: '100%', padding: '6px 10px', border: '1.5px solid #DFE1E6', borderRadius: 6, fontSize: 12, outline: 'none', boxSizing: 'border-box' }}
                    />
                  </div>
                  <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                    {filteredAvailable.length === 0 && (
                      <div style={{ padding: '8px 12px', fontSize: 12, color: '#97A0AF' }}>No projects found</div>
                    )}
                    {filteredAvailable.map(p => (
                      <button key={p.key} onClick={() => addExtra(p)} style={{
                        display: 'block', width: '100%', textAlign: 'left',
                        padding: '7px 12px', border: 'none', borderBottom: '1px solid #F4F5F7',
                        background: 'transparent', cursor: 'pointer', fontSize: 12,
                      }}
                        onMouseEnter={e => e.currentTarget.style.background = '#F4F5F7'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <span style={{ fontWeight: 700, color: '#0052CC' }}>{p.key}</span>
                        <span style={{ color: '#5E6C84', marginLeft: 8 }}>{p.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {!loadingProjects && selectedKeys.size === 0 && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#97A0AF' }}>
            Select one or more projects to start planning.
          </div>
        )}
      </div>

      {/* Tab nav */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            data-tutorial={`tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '7px 20px', borderRadius: 6,
              border: activeTab === tab.id ? '2px solid #0052CC' : '2px solid #DFE1E6',
              background: activeTab === tab.id ? '#0052CC' : '#fff',
              color: activeTab === tab.id ? '#fff' : '#42526E',
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Date range controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <button onClick={goPrev} style={navBtnStyle}>‹</button>
        <button onClick={goToday} style={{ ...navBtnStyle, fontSize: 12, padding: '5px 12px' }}>Today</button>
        <button onClick={goNext} style={navBtnStyle}>›</button>
        <span style={{ fontSize: 15, fontWeight: 700, color: '#172B4D', marginLeft: 4 }}>
          {format(currentDate, 'MMMM yyyy')}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {['month', 'week', 'day'].map(m => (
            <button key={m} onClick={() => setViewMode(m)} style={{
              padding: '4px 12px', borderRadius: 4, fontSize: 12, cursor: 'pointer', fontWeight: 600,
              border: viewMode === m ? '2px solid #0052CC' : '2px solid #DFE1E6',
              background: viewMode === m ? '#E9F2FF' : '#fff',
              color: viewMode === m ? '#0052CC' : '#42526E',
            }}>
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Views */}
      {selectedProjects.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: '#97A0AF', fontSize: 14 }}>
          Select one or more projects above to start planning.
        </div>
      )}

      {selectedProjects.length > 0 && activeTab === 'calendar' && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <EpicHierarchyPanel
            projectKeys={selectedProjectKeys}
            selectedVersionId={selectedVersionId}
            onVersionChange={setSelectedVersionId}
            selectedSprintId={selectedSprintId}
            onSprintChange={setSelectedSprintId}
            teamMembers={teamMembers}
          />
          <CalendarView
            projectKeys={selectedProjectKeys}
            dateRange={dateRange}
            currentDate={currentDate}
            viewMode={viewMode}
            onNavigate={setCurrentDate}
            selectedSprintId={selectedSprintId}
            selectedVersionId={selectedVersionId}
            selectedDeveloperIds={selectedDeveloperIds}
            onDeveloperFilterChange={setSelectedDeveloperIds}
            teamMembers={teamMembers}
          />
        </div>
      )}
      {selectedProjects.length > 0 && activeTab === 'version' && (
        <VersionPlanningView projectKeys={selectedProjectKeys} />
      )}
      {selectedProjects.length > 0 && activeTab === 'timeline' && (
        <TimelineView projectKeys={selectedProjectKeys} dateRange={dateRange} currentDate={currentDate} />
      )}
      {selectedProjects.length > 0 && activeTab === 'team' && (
        <TeamView projectKeys={selectedProjectKeys} dateRange={dateRange} currentDate={currentDate} />
      )}

      {showSearch && (
        <GlobalSearch
          projectKeys={selectedProjectKeys}
          onClose={() => setShowSearch(false)}
        />
      )}

      {tutorialActive && <TutorialOverlay onClose={closeTutorial} />}
    </div>
  );
}

const navBtnStyle = {
  padding: '5px 10px', borderRadius: 4, border: '2px solid #DFE1E6',
  background: '#fff', color: '#42526E', fontSize: 16, cursor: 'pointer', fontWeight: 700,
  lineHeight: 1,
};

export default function AppWithBoundary() {
  return <ErrorBoundary><App /></ErrorBoundary>;
}
