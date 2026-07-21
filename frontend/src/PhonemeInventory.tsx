import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PhonemeInventoryEntry } from "./types";

const POPOVER_WIDTH = 260;
const POPOVER_MARGIN = 12;
const PREVIEW_COUNT = 10;

interface ChartCell {
  row: string;
  col: string;
  symbols: string[];
}

type ExampleClickHandler = (transcriptId: number, time: number) => void;

const CONSONANT_COLS = [
  "Bilabial",
  "Labiodental",
  "Dental",
  "Alveolar",
  "Post-alveolar",
  "Palatal",
  "Velar",
  "Glottal",
];
const CONSONANT_ROWS = [
  "Plosive",
  "Nasal",
  "Affricate",
  "Fricative",
  "Approximant",
  "Lateral approx.",
];
const CONSONANT_CELLS: ChartCell[] = [
  { row: "Plosive", col: "Bilabial", symbols: ["p", "b"] },
  { row: "Plosive", col: "Alveolar", symbols: ["t", "d"] },
  { row: "Plosive", col: "Velar", symbols: ["k", "ɡ"] },
  { row: "Nasal", col: "Bilabial", symbols: ["m"] },
  { row: "Nasal", col: "Alveolar", symbols: ["n"] },
  { row: "Nasal", col: "Velar", symbols: ["ŋ"] },
  { row: "Affricate", col: "Post-alveolar", symbols: ["tʃ", "dʒ"] },
  { row: "Fricative", col: "Labiodental", symbols: ["f", "v"] },
  { row: "Fricative", col: "Dental", symbols: ["θ", "ð"] },
  { row: "Fricative", col: "Alveolar", symbols: ["s", "z"] },
  { row: "Fricative", col: "Post-alveolar", symbols: ["ʃ", "ʒ"] },
  { row: "Fricative", col: "Glottal", symbols: ["h"] },
  { row: "Approximant", col: "Alveolar", symbols: ["ɹ"] },
  { row: "Approximant", col: "Palatal", symbols: ["j"] },
  { row: "Approximant", col: "Velar", symbols: ["w"] },
  { row: "Lateral approx.", col: "Alveolar", symbols: ["l"] },
];

const VOWEL_COLS = ["Front", "Central", "Back"];
const VOWEL_ROWS = ["Close", "Near-close", "Close-mid", "Mid", "Open-mid", "Near-open", "Open"];
const VOWEL_CELLS: ChartCell[] = [
  { row: "Close", col: "Front", symbols: ["iː"] },
  { row: "Close", col: "Back", symbols: ["uː"] },
  { row: "Near-close", col: "Front", symbols: ["ɪ", "ɪɹ"] },
  { row: "Near-close", col: "Back", symbols: ["ʊ", "ʊɹ"] },
  { row: "Mid", col: "Central", symbols: ["ə", "ɚ", "ɜɹ"] },
  { row: "Open-mid", col: "Front", symbols: ["ɛ", "ɛɹ"] },
  { row: "Open-mid", col: "Central", symbols: ["ʌ"] },
  { row: "Open-mid", col: "Back", symbols: ["ɔː", "ɔɹ"] },
  { row: "Near-open", col: "Front", symbols: ["æ"] },
  { row: "Near-open", col: "Central", symbols: ["ɐ"] },
  { row: "Open", col: "Back", symbols: ["ɑː", "ɑɹ"] },
];

interface PhonemeChartProps {
  title: string;
  cols: string[];
  rows: string[];
  cells: ChartCell[];
  bySymbol: Record<string, PhonemeInventoryEntry>;
  expanded: string | null;
  onToggle: (symbol: string) => void;
  onExampleClick: ExampleClickHandler;
  apiBase: string;
  sessionId: string;
}

function PhonemeChart({ title, cols, rows, cells, bySymbol, expanded, onToggle, onExampleClick, apiBase, sessionId }: PhonemeChartProps) {
  return (
    <div className="chart-section">
      <h3>{title}</h3>
      <div
        className="chart-grid"
        style={{
          gridTemplateColumns: `auto repeat(${cols.length}, 1fr)`,
          gridTemplateRows: `auto repeat(${rows.length}, auto)`,
        }}
      >
        <div className="chart-corner" style={{ gridRow: 1, gridColumn: 1 }} />
        {cols.map((col, ci) => (
          <div className="chart-col-label" key={col} style={{ gridRow: 1, gridColumn: ci + 2 }}>
            {col}
          </div>
        ))}
        {rows.map((row, ri) => (
          <div className="chart-row-label" key={row} style={{ gridRow: ri + 2, gridColumn: 1 }}>
            {row}
          </div>
        ))}

        {rows.map((row, ri) =>
          cols.map((col, ci) => (
            <div
              className="chart-cell"
              key={`${row}-${col}`}
              style={{ gridRow: ri + 2, gridColumn: ci + 2 }}
            />
          ))
        )}

        {cells.map(({ row, col, symbols }) => (
          <div
            className="chart-cell chart-cell-filled"
            key={`${row}-${col}`}
            style={{ gridRow: rows.indexOf(row) + 2, gridColumn: cols.indexOf(col) + 2 }}
          >
            {symbols.map((symbol) => {
              const entry = bySymbol[symbol] ?? { symbol, category: "", count: 0, examples: [] };
              return (
                <PhonemeCard
                  key={symbol}
                  entry={entry}
                  expanded={expanded === symbol}
                  onToggle={onToggle}
                  onExampleClick={onExampleClick}
                  apiBase={apiBase}
                  sessionId={sessionId}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

interface PopoverPosition {
  top: number;
  left: number;
}

interface PhonemeCardProps {
  entry: PhonemeInventoryEntry;
  expanded: boolean;
  onToggle: (symbol: string) => void;
  onExampleClick: ExampleClickHandler;
  apiBase: string;
  sessionId: string;
}

function PhonemeCard({ entry, expanded, onToggle, onExampleClick, apiBase, sessionId }: PhonemeCardProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [popoverPos, setPopoverPos] = useState<PopoverPosition | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    if (!expanded || !buttonRef.current) {
      setPopoverPos(null);
      return;
    }
    const rect = buttonRef.current.getBoundingClientRect();
    // Anchor to the button's left edge by default, but flip/clamp so the
    // popover never overflows past the right (or left) edge of the
    // viewport — previously it stayed anchored to the card and got
    // clipped invisible by the charts-row's overflow-x:auto ancestor.
    let left = rect.left;
    if (left + POPOVER_WIDTH + POPOVER_MARGIN > window.innerWidth) {
      left = window.innerWidth - POPOVER_WIDTH - POPOVER_MARGIN;
    }
    left = Math.max(POPOVER_MARGIN, left);
    setPopoverPos({ top: rect.bottom + 4, left });
  }, [expanded]);

  const previewExamples = entry.examples.slice(0, PREVIEW_COUNT);
  const hasMore = entry.examples.length > PREVIEW_COUNT;

  return (
    <div className={entry.count > 0 ? "phoneme-card captured" : "phoneme-card"}>
      <button
        ref={buttonRef}
        className="phoneme-card-main"
        onClick={() => onToggle(entry.symbol)}
        disabled={entry.count === 0}
      >
        <span className="phoneme-symbol">{entry.symbol}</span>
        <span className="phoneme-count">{entry.count}</span>
      </button>

      {expanded &&
        entry.examples.length > 0 &&
        popoverPos &&
        createPortal(
          <div
            className="phoneme-examples"
            style={{ top: popoverPos.top, left: popoverPos.left }}
          >
            {previewExamples.map((ex, i) => (
              <button
                key={i}
                className="phoneme-example"
                onClick={() => onExampleClick(ex.transcript_id, ex.start)}
              >
                <img
                  className="phoneme-thumb"
                  src={`${apiBase}/media/${ex.transcript_id}/segment.png?start=${ex.start}&end=${ex.end}&session_id=${sessionId}`}
                  alt=""
                />
                <span>{ex.word || `${ex.start.toFixed(2)}s`}</span>
              </button>
            ))}
            {hasMore && (
              <button
                className="phoneme-examples-more"
                onClick={() => setModalOpen(true)}
              >
                View all {entry.examples.length} →
              </button>
            )}
          </div>,
          document.body
        )}

      {modalOpen &&
        createPortal(
          <div
            className="phoneme-modal-backdrop"
            onClick={() => setModalOpen(false)}
          >
            <div className="phoneme-modal" onClick={(e) => e.stopPropagation()}>
              <div className="phoneme-modal-header">
                <span className="phoneme-modal-symbol">{entry.symbol}</span>
                <span className="phoneme-modal-count">
                  {entry.examples.length} recordings
                </span>
                <button
                  className="phoneme-modal-close"
                  aria-label="Close"
                  onClick={() => setModalOpen(false)}
                >
                  ×
                </button>
              </div>
              <div className="phoneme-modal-list">
                {entry.examples.map((ex, i) => (
                  <button
                    key={i}
                    className="phoneme-example"
                    onClick={() => {
                      onExampleClick(ex.transcript_id, ex.start);
                      setModalOpen(false);
                    }}
                  >
                    <img
                      className="phoneme-thumb"
                      src={`${apiBase}/media/${ex.transcript_id}/segment.png?start=${ex.start}&end=${ex.end}&session_id=${sessionId}`}
                      alt=""
                    />
                    <span>{ex.word || `${ex.start.toFixed(2)}s`}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

interface PhonemeInventoryProps {
  inventory: PhonemeInventoryEntry[];
  onExampleClick: ExampleClickHandler;
  apiBase: string;
  sessionId: string;
}

function PhonemeInventory({ inventory, onExampleClick, apiBase, sessionId }: PhonemeInventoryProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggle = (symbol: string) => setExpanded((prev) => (prev === symbol ? null : symbol));

  const bySymbol = Object.fromEntries(inventory.map((e) => [e.symbol, e]));

  const placedSymbols = new Set([
    ...CONSONANT_CELLS.flatMap((c) => c.symbols),
    ...VOWEL_CELLS.flatMap((c) => c.symbols),
  ]);
  const leftover = inventory.filter((e) => !placedSymbols.has(e.symbol));

  const chartProps = { bySymbol, expanded, onToggle: toggle, onExampleClick, apiBase, sessionId };

  return (
    <div className="inventory">
      <div className="charts-row">
        <PhonemeChart
          title="Consonants"
          cols={CONSONANT_COLS}
          rows={CONSONANT_ROWS}
          cells={CONSONANT_CELLS}
          {...chartProps}
        />

        <PhonemeChart
          title="Vowels"
          cols={VOWEL_COLS}
          rows={VOWEL_ROWS}
          cells={VOWEL_CELLS}
          {...chartProps}
        />
      </div>

      <div className="chart-section">
        <h3>Diphthongs</h3>
        <div className="phoneme-row">
          {leftover.map((entry) => (
            <PhonemeCard
              key={entry.symbol}
              entry={entry}
              expanded={expanded === entry.symbol}
              onToggle={toggle}
              onExampleClick={onExampleClick}
              apiBase={apiBase}
              sessionId={sessionId}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default PhonemeInventory;
