import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';

const TUTORIAL_KEY = 'planJira_tutorialDone';

const STEPS = [
  {
    title: 'Welcome to planJira!',
    body: 'This quick tour shows you the main features. Press Next to continue or Skip to exit.',
    target: null,
    position: 'center',
  },
  {
    title: 'Project Selector',
    body: 'Select one or more Jira projects to plan. Click a project chip to toggle it, or add more with "+ Add project".',
    target: '[data-tutorial="projects"]',
    position: 'bottom',
  },
  {
    title: 'Calendar Tab',
    body: 'Drag issues from the backlog onto any day to schedule them. Due dates are updated in Jira automatically.',
    target: '[data-tutorial="tab-calendar"]',
    position: 'bottom',
  },
  {
    title: 'Backlog Panel',
    body: 'The left panel lets you filter by version or sprint, then drag issues onto the calendar. Use the Epic filter chips above the calendar to focus on one epic.',
    target: null,
    position: 'center',
  },
  {
    title: 'Timeline Tab',
    body: 'Use Week / Month / Quarter / Year to zoom. Pan with ‹ › arrows. Toggle bar colors between issue type and status.',
    target: '[data-tutorial="tab-timeline"]',
    position: 'bottom',
  },
  {
    title: 'Version Planning Tab',
    body: 'Build multi-sprint plans with dependencies. Issues on the critical path are highlighted in orange.',
    target: '[data-tutorial="tab-version"]',
    position: 'bottom',
  },
  {
    title: 'Team Tab',
    body: 'See who is overloaded. Red cells mean over 8h of work assigned. Click any cell to see the full issue list.',
    target: '[data-tutorial="tab-team"]',
    position: 'bottom',
  },
  {
    title: "You're all set!",
    body: 'Click the ❓ button in the header any time to replay this tour.',
    target: '[data-tutorial="help"]',
    position: 'bottom',
  },
];

function useTargetRect(target) {
  const [rect, setRect] = useState(null);
  useLayoutEffect(() => {
    if (!target) { setRect(null); return; }
    const el = document.querySelector(target);
    if (!el) { setRect(null); return; }
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [target]);
  return rect;
}

const PAD = 10;
const CARD_W = 320;
const CARD_H_EST = 160;

function tooltipPos(rect, position) {
  if (!rect) return { top: '50%', left: '50%', transform: 'translate(-50%,-50%)' };
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (position === 'bottom') {
    const top = Math.min(rect.top + rect.height + PAD, vh - CARD_H_EST - 8);
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - CARD_W / 2, vw - CARD_W - 8));
    return { top, left };
  }
  if (position === 'right') {
    const top = Math.max(8, rect.top);
    const left = Math.min(rect.left + rect.width + PAD, vw - CARD_W - 8);
    return { top, left };
  }
  if (position === 'left') {
    const top = Math.max(8, rect.top);
    const left = Math.max(8, rect.left - CARD_W - PAD);
    return { top, left };
  }
  if (position === 'top') {
    const top = Math.max(8, rect.top - CARD_H_EST - PAD);
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - CARD_W / 2, vw - CARD_W - 8));
    return { top, left };
  }
  return { top: '50%', left: '50%', transform: 'translate(-50%,-50%)' };
}

export function useTutorial() {
  const [active, setActive] = useState(() => localStorage.getItem(TUTORIAL_KEY) !== '1');
  const start = () => setActive(true);
  const close = () => { localStorage.setItem(TUTORIAL_KEY, '1'); setActive(false); };
  return { active, start, close };
}

export default function TutorialOverlay({ onClose }) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const rect = useTargetRect(current.target);

  const next = () => {
    if (step < STEPS.length - 1) setStep(s => s + 1);
    else { localStorage.setItem(TUTORIAL_KEY, '1'); onClose(); }
  };
  const prev = () => { if (step > 0) setStep(s => s - 1); };
  const skip = () => { localStorage.setItem(TUTORIAL_KEY, '1'); onClose(); };

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'Escape') skip();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [step]); // re-register when step changes so next/prev/skip close over the right step

  const pos = tooltipPos(rect, current.position);
  const isCenter = current.position === 'center' || !rect;

  // Spotlight cutout: if there's a target, punch a hole with box-shadow
  const spotlightStyle = rect
    ? {
        position: 'fixed', inset: 0, zIndex: 9000, pointerEvents: 'none',
        boxShadow: `0 0 0 9999px rgba(0,0,0,0.55)`,
        borderRadius: 0,
        // The "hole" is created by placing a transparent div exactly over the target
        // using clip-path trick: we actually use a separate div below
      }
    : {
        position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', pointerEvents: 'none',
      };

  return (
    <>
      {/* Dark overlay */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', pointerEvents: 'none' }} />

      {/* Spotlight hole (transparent box over the target) */}
      {rect && (
        <div style={{
          position: 'fixed',
          top: rect.top - PAD,
          left: rect.left - PAD,
          width: rect.width + PAD * 2,
          height: rect.height + PAD * 2,
          zIndex: 9001,
          background: 'transparent',
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
          borderRadius: 6,
          pointerEvents: 'none',
        }} />
      )}

      {/* Tooltip card */}
      <div style={{
        position: 'fixed',
        top: isCenter ? '50%' : pos.top,
        left: isCenter ? '50%' : pos.left,
        transform: isCenter ? 'translate(-50%,-50%)' : undefined,
        width: CARD_W,
        background: '#fff',
        borderRadius: 10,
        boxShadow: '0 8px 32px rgba(0,0,0,0.28)',
        zIndex: 9002,
        padding: '20px 20px 16px',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#172B4D', flex: 1, paddingRight: 8 }}>
            {current.title}
          </div>
          <button onClick={skip} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#97A0AF', lineHeight: 1, flexShrink: 0 }}>×</button>
        </div>
        <div style={{ fontSize: 13, color: '#42526E', lineHeight: 1.6, marginBottom: 16 }}>
          {current.body}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={prev}
            disabled={step === 0}
            style={{
              padding: '6px 14px', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: step === 0 ? 'default' : 'pointer',
              border: '2px solid #DFE1E6', background: '#fff', color: step === 0 ? '#B3BAC5' : '#42526E',
            }}
          >
            ‹ Prev
          </button>
          <span style={{ fontSize: 11, color: '#97A0AF', flex: 1, textAlign: 'center' }}>
            {step + 1} / {STEPS.length}
          </span>
          <button
            onClick={next}
            style={{
              padding: '6px 16px', borderRadius: 5, fontSize: 12, fontWeight: 700, cursor: 'pointer',
              border: 'none', background: '#0052CC', color: '#fff',
            }}
          >
            {step === STEPS.length - 1 ? 'Done ✓' : 'Next ›'}
          </button>
        </div>
        <div style={{ marginTop: 10, textAlign: 'center' }}>
          <button onClick={skip} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: '#97A0AF', textDecoration: 'underline' }}>
            Skip tour
          </button>
        </div>
      </div>
    </>
  );
}
