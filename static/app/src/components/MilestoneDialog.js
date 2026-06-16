import React, { useState } from 'react';

const PRESET_COLORS = ['#FF5630', '#FF991F', '#36B37E', '#0052CC', '#6554C0', '#00B8D9'];

export default function MilestoneDialog({ title, initialDate, onSave, onDelete, onClose, existing }) {
  const [label, setLabel] = useState(existing?.label || '');
  const [date, setDate] = useState(existing?.date || initialDate || '');
  const [color, setColor] = useState(existing?.color || PRESET_COLORS[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSave() {
    if (!label.trim() || !date) { setError('Label and date are required.'); return; }
    setSaving(true);
    setError(null);
    try {
      const milestone = {
        id: existing?.id || `ms_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        label: label.trim(),
        date,
        color,
        createdAt: existing?.createdAt || new Date().toISOString(),
      };
      await onSave(milestone);
      onClose();
    } catch (e) {
      setError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!existing) return;
    setSaving(true);
    try {
      await onDelete(existing.id);
      onClose();
    } catch (e) {
      setError(e?.message || 'Delete failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 2000,
      background: 'rgba(9,30,66,0.54)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: '#fff', borderRadius: 8, padding: 24, width: 340,
        boxShadow: '0 8px 32px rgba(0,0,0,0.24)',
      }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: '#172B4D', marginBottom: 16 }}>
          {title || (existing ? 'Edit Milestone' : 'Add Milestone')}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Label</label>
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="e.g. Design Review"
            style={inputStyle}
            autoFocus
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Date</label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>Color</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            {PRESET_COLORS.map(c => (
              <button key={c} onClick={() => setColor(c)} style={{
                width: 24, height: 24, borderRadius: '50%', background: c, cursor: 'pointer',
                border: color === c ? '3px solid #172B4D' : '3px solid transparent',
                padding: 0, flexShrink: 0,
              }} />
            ))}
          </div>
        </div>

        {error && <div style={{ color: '#DE350B', fontSize: 12, marginBottom: 10 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            {existing && (
              <button onClick={handleDelete} disabled={saving} style={{ ...btnStyle, background: '#FFEBE6', color: '#DE350B', border: '1px solid #FF8F73' }}>
                Delete
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={{ ...btnStyle, background: '#F4F5F7', color: '#42526E', border: '1px solid #DFE1E6' }}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving} style={{ ...btnStyle, background: '#0052CC', color: '#fff', border: 'none' }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const labelStyle = { fontSize: 11, fontWeight: 700, color: '#5E6C84', display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' };
const inputStyle = { width: '100%', padding: '7px 10px', border: '2px solid #DFE1E6', borderRadius: 4, fontSize: 13, outline: 'none', boxSizing: 'border-box', color: '#172B4D' };
const btnStyle = { padding: '7px 14px', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
