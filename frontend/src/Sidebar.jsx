import { useState } from "react";

function formatTime(createdAt) {
  if (!createdAt) return "";
  const d = new Date(createdAt.replace(" ", "T") + "Z");
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Sidebar({
  transcripts,
  selectedId,
  view,
  onSelect,
  onViewChange,
  onDelete,
  onDeleteMany,
  onExportMany,
}) {
  const [checked, setChecked] = useState(() => new Set());
  const ordered = transcripts.slice().reverse();

  const allChecked = ordered.length > 0 && ordered.every((t) => checked.has(t.id));

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
      <div className="sidebar-tabs">
        <button
          className={view === "inventory" ? "sidebar-tab active" : "sidebar-tab"}
          onClick={() => onViewChange("inventory")}
        >
          Phoneme Inventory
        </button>
      </div>

      <div className="sidebar-header-row">
        <label className="select-all">
          <input
            type="checkbox"
            checked={allChecked}
            onChange={toggleAll}
            disabled={ordered.length === 0}
          />
          Recordings
        </label>
        {checked.size > 0 && (
          <div className="bulk-actions">
            <button className="bulk-export-btn" onClick={exportChecked}>
              Export ({checked.size})
            </button>
            <button className="bulk-delete-btn" onClick={deleteChecked}>
              Delete ({checked.size})
            </button>
          </div>
        )}
      </div>

      <div className="sidebar-list">
        {ordered.length === 0 && <p className="sidebar-empty">No recordings yet</p>}
        {ordered.map((t) => (
          <div
            key={t.id}
            className={
              view === "recordings" && t.id === selectedId
                ? "sidebar-item selected"
                : "sidebar-item"
            }
          >
            <input
              type="checkbox"
              className="item-checkbox"
              checked={checked.has(t.id)}
              onChange={() => toggleOne(t.id)}
            />

            <div
              className="sidebar-item-body"
              role="button"
              tabIndex={0}
              onClick={() => onSelect(t.id)}
              onKeyDown={(e) => e.key === "Enter" && onSelect(t.id)}
            >
              <div className="sidebar-item-ipa">{t.ipa}</div>
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
    </aside>
  );
}

export default Sidebar;
