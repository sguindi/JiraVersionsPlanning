import React from 'react';

export default function MilestoneMarker({ color = '#FF991F', label = '', size = 10, style = {} }) {
  return (
    <div
      title={label}
      style={{
        width: size,
        height: size,
        background: color,
        transform: 'rotate(45deg)',
        borderRadius: 2,
        flexShrink: 0,
        cursor: 'pointer',
        boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
        ...style,
      }}
    />
  );
}
