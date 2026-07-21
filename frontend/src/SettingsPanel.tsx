import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { createPortal } from "react-dom";
import { resetToAnonymousSession } from "./session";
import type { DriveStatus } from "./types";

const STORAGE_KEY = "phonemizer-accent-color";
const VIEWPORT_MARGIN = 12;

interface PanelPosition {
  top: number;
  left: number;
}

function hexToRgbString(hex: string): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

function applyAccent(hex: string): void {
  document.documentElement.style.setProperty("--accent", hex);
  document.documentElement.style.setProperty("--accent-rgb", hexToRgbString(hex));
}

interface SettingsPanelProps {
  silenceDurationMs: number;
  onSilenceDurationChange: (ms: number) => void;
  apiBase: string;
  sessionId: string;
}

function SettingsPanel({ silenceDurationMs, onSilenceDurationChange, apiBase, sessionId }: SettingsPanelProps) {
  const [open, setOpen] = useState(false);
  const [color, setColor] = useState("#ffc65c");
  const [pos, setPos] = useState<PanelPosition | null>(null);
  const [driveStatus, setDriveStatus] = useState<DriveStatus | null>(null); // null while loading
  const gearRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      setColor(saved);
      applyAccent(saved);
    } else {
      const defaultAccent = getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim();
      if (defaultAccent) setColor(defaultAccent);
    }
  }, []);

  useEffect(() => {
    if (!open || !apiBase) return;
    fetch(`${apiBase}/auth/me`, { headers: { "X-Session-Id": sessionId } })
      .then((r) => r.json())
      .then(setDriveStatus)
      .catch(() => setDriveStatus({ linked: false, email: null }));
  }, [open, apiBase, sessionId]);

  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        gearRef.current &&
        !gearRef.current.contains(e.target as Node) &&
        panelRef.current &&
        !panelRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  // Standalone popout: rendered through a portal (so it's never clipped or
  // pushed around by the topbar's layout/flex flow) and positioned from a
  // measurement of its own rendered size, clamped to the viewport — the
  // fixed left:0 anchor previously used ran the panel off the right edge
  // of the window whenever the gear sat close to it.
  useLayoutEffect(() => {
    if (!open || !gearRef.current || !panelRef.current) {
      setPos(null);
      return;
    }
    const gearRect = gearRef.current.getBoundingClientRect();
    const panelRect = panelRef.current.getBoundingClientRect();

    let left = gearRect.left;
    if (left + panelRect.width + VIEWPORT_MARGIN > window.innerWidth) {
      left = window.innerWidth - panelRect.width - VIEWPORT_MARGIN;
    }
    left = Math.max(VIEWPORT_MARGIN, left);

    let top = gearRect.bottom + 4;
    if (top + panelRect.height + VIEWPORT_MARGIN > window.innerHeight) {
      top = gearRect.top - panelRect.height - 4;
    }
    top = Math.max(VIEWPORT_MARGIN, top);

    setPos({ top, left });
  }, [open, driveStatus]);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const hex = e.target.value;
    setColor(hex);
    applyAccent(hex);
    localStorage.setItem(STORAGE_KEY, hex);
  };

  const handleReset = () => {
    document.documentElement.style.removeProperty("--accent");
    document.documentElement.style.removeProperty("--accent-rgb");
    localStorage.removeItem(STORAGE_KEY);
    const defaultAccent = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim();
    setColor(defaultAccent);
  };

  const handleDisconnect = () => {
    resetToAnonymousSession();
    // SESSION_ID in App.jsx is captured once at module load as a plain
    // constant (not React state) — a full reload is the simplest way to
    // make the rest of the app pick up the new anonymous identity.
    window.location.reload();
  };

  return (
    <div className="settings-control">
      <button
        ref={gearRef}
        className="settings-gear"
        type="button"
        aria-label="Settings"
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M19.14,12.94c0.04,-0.3 0.06,-0.61 0.06,-0.94c0,-0.32 -0.02,-0.64 -0.07,-0.94l2.03,-1.58c0.18,-0.14 0.23,-0.41 0.12,-0.61l-1.92,-3.32c-0.12,-0.22 -0.37,-0.29 -0.59,-0.22l-2.39,0.96c-0.5,-0.38 -1.03,-0.7 -1.62,-0.94L14.4,2.81c-0.04,-0.24 -0.24,-0.41 -0.48,-0.41h-3.84c-0.24,0 -0.43,0.17 -0.47,0.41L9.25,5.35C8.66,5.59 8.12,5.92 7.63,6.29L5.24,5.33c-0.22,-0.08 -0.47,0 -0.59,0.22L2.74,8.87C2.62,9.08 2.66,9.34 2.86,9.48l2.03,1.58C4.84,11.36 4.8,11.69 4.8,12s0.02,0.64 0.07,0.94l-2.03,1.58c-0.18,0.14 -0.23,0.41 -0.12,0.61l1.92,3.32c0.12,0.22 0.37,0.29 0.59,0.22l2.39,-0.96c0.5,0.38 1.03,0.7 1.62,0.94l0.36,2.54c0.05,0.24 0.24,0.41 0.48,0.41h3.84c0.24,0 0.44,-0.17 0.47,-0.41l0.36,-2.54c0.59,-0.24 1.13,-0.56 1.62,-0.94l2.39,0.96c0.22,0.08 0.47,0 0.59,-0.22l1.92,-3.32c0.12,-0.22 0.07,-0.47 -0.12,-0.61L19.14,12.94z M12,15.6c-1.98,0 -3.6,-1.62 -3.6,-3.6s1.62,-3.6 3.6,-3.6s3.6,1.62 3.6,3.6S13.98,15.6 12,15.6z" />
        </svg>
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="settings-panel"
            style={pos ? { top: pos.top, left: pos.left, visibility: "visible" } : { top: 0, left: 0, visibility: "hidden" }}
          >
            <label className="settings-panel-label" htmlFor="accent-color-input">
              Accent color
            </label>
            <div className="settings-panel-row">
              <input
                id="accent-color-input"
                type="color"
                value={color}
                onChange={handleChange}
              />
              <button className="settings-reset-btn" onClick={handleReset}>
                Reset
              </button>
            </div>

            <label className="settings-panel-label" htmlFor="silence-duration-input">
              Silence duration (ms)
            </label>
            <div className="settings-panel-row">
              <input
                id="silence-duration-input"
                type="number"
                className="settings-number-input"
                min={300}
                max={5000}
                step={100}
                value={silenceDurationMs}
                onChange={(e) => onSilenceDurationChange(Number(e.target.value))}
              />
            </div>
            <p className="settings-panel-hint">
              How long a pause must last before a recording auto-splits into a
              new segment.
            </p>

            <label className="settings-panel-label">Google Drive</label>
            <div className="settings-panel-row">
              {driveStatus === null ? (
                <span className="settings-panel-hint">Checking…</span>
              ) : driveStatus.linked ? (
                <>
                  <span className="settings-drive-email">{driveStatus.email}</span>
                  <button className="settings-reset-btn" onClick={handleDisconnect}>
                    Disconnect
                  </button>
                </>
              ) : (
                <a
                  className="settings-connect-btn"
                  href={`${apiBase}/auth/google/login?session_id=${sessionId}`}
                >
                  Connect Google Drive
                </a>
              )}
            </div>
            <p className="settings-panel-hint">
              {driveStatus?.linked
                ? "New recordings are saved to your Drive instead of this server."
                : "Sign in to sync recordings to your own Google Drive instead of this server."}
            </p>
          </div>,
          document.body
        )}
    </div>
  );
}

export default SettingsPanel;
