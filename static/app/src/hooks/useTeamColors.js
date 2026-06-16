import { useMemo } from 'react';

const PALETTE = [
  '#0052CC', '#00875A', '#FF5630', '#FF991F',
  '#6554C0', '#00B8D9', '#E91E63', '#795548',
  '#2196F3', '#4CAF50', '#FF9800', '#9C27B0',
];

const UNASSIGNED_COLOR = '#97A0AF';

export function useTeamColors(members) {
  const colorMap = useMemo(() => {
    const map = { __unassigned__: UNASSIGNED_COLOR };
    (members || []).forEach((m, idx) => {
      map[m.accountId] = PALETTE[idx % PALETTE.length];
    });
    return map;
  }, [(members || []).map(m => m.accountId).join(',')]);

  const colorOf = (accountId) => colorMap[accountId] || UNASSIGNED_COLOR;

  return { colorOf, colorMap };
}
