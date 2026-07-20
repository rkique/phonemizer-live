import { useState } from "react";

function formatTime(createdAt) {
  if (!createdAt) return "";
  const d = new Date(createdAt.replace(" ", "T") + "Z");
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  // Mirror Gmail's list: today's entries show a time, anything earlier
  // shows just the date.
  if (isToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// Sidebar renders transcripts in row format.
function Sidebar({
  transcripts,
  selectedId,
  view,
  pending,
  onSelect,
  onViewChange,
  onDelete,
  onDeleteMany,
  onExportMany,
}) {
  const [checked, setChecked] = useState(() => new Set());
  const ordered = transcripts.slice().reverse();

  const allChecked = ordered.length > 0 && ordered.every((t) => checked.has(t.id));

  //state handlers for sidebar.
  
  const toggleOne = (id) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setChecked(allChecked ? new Set() : new Set(ordered.map((t) => t.id)));
  };

  const deleteChecked = () => {
    onDeleteMany([...checked]);
    setChecked(new Set());
  };

  const exportChecked = () => {
    onExportMany([...checked]);
  };

  return (
    <aside className="sidebar">
      <div
        className={view === "inventory" ? "sidebar-zone active" : "sidebar-zone"}
        role="button"
        tabIndex={0}
        onClick={() => onViewChange("inventory")}
        onKeyDown={(e) => e.key === "Enter" && onViewChange("inventory")}
      >
        <span className="sidebar-zone-label">Phoneme Inventory</span>
      </div>

      <div
        className={view === "recordings" ? "sidebar-zone-recordings active" : "sidebar-zone-recordings"}
        onClick={() => onViewChange("recordings")}
      >
        <div className="sidebar-header-row">
          <span className="sidebar-header-titles">
            <span className="sidebar-zone-label">Recordings</span>
            {checked.size > 0 && (
              <span className="selected-count">{checked.size} selected</span>
            )}
          </span>
        </div>

        <div className="sidebar-actions-row">
          <button
            className="select-all-btn"
            onClick={toggleAll}
            disabled={ordered.length === 0}
          >
            {allChecked ? "Deselect all" : "Select all"}
          </button>
          <div className="bulk-actions">
            <button
              className="bulk-export-btn"
              onClick={exportChecked}
              disabled={checked.size === 0}
            >
              Export
            </button>
            <button
              className="bulk-delete-btn"
              onClick={deleteChecked}
              disabled={checked.size === 0}
              aria-label={`Delete ${checked.size} recordings`}
            >
              <svg viewBox="0 -960 960 960" width="18" height="18" fill="currentColor">
                <path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120zm400-600H280v520h400zM360-280h80v-360h-80zm160 0h80v-360h-80zM280-720v520z" />
              </svg>
            </button>
          </div>
        </div>

        <div className="sidebar-list">
          {ordered.length === 0 && pending === 0 && (
            <p className="sidebar-empty">No recordings yet</p>
          )}
          {Array.from({ length: pending }).map((_, i) => (
            <div key={`pending-${i}`} className="sidebar-item pending">
              <span className="checkbox-hover-circle" />
              <div className="sidebar-item-body">
                <div className="shimmer-bar shimmer-bar-ipa" />
                <div className="sidebar-item-meta">
                  <span className="shimmer-bar shimmer-bar-meta" />
                  <span className="shimmer-bar shimmer-bar-meta" />
                </div>
              </div>
              <span className="delete-btn-spacer" />
            </div>
          ))}
          {ordered.map((t) => (
            <div
              key={t.id}
              className={
                view === "recordings" && t.id === selectedId
                  ? "sidebar-item selected"
                  : "sidebar-item"
              }
            >
              <label className="checkbox-hover-circle">
                <input
                  type="checkbox"
                  className="item-checkbox"
                  checked={checked.has(t.id)}
                  onChange={() => toggleOne(t.id)}
                />
              </label>

              <div
                className="sidebar-item-body"
                role="button"
                tabIndex={0}
                onClick={() => onSelect(t.id)}
                onKeyDown={(e) => e.key === "Enter" && onSelect(t.id)}
              >
                <div className={t.is_sample ? "sidebar-item-ipa sample" : "sidebar-item-ipa"}>
                  {t.ipa}
                </div>
                <div className="sidebar-item-meta">
                  <span>{t.duration ? `${t.duration.toFixed(1)}s` : ""}</span>
                  <span>{formatTime(t.created_at)}</span>
                </div>
              </div>

              <button
                className="delete-btn"
                aria-label="Delete recording"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(t.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;
