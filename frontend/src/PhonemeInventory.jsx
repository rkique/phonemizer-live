import { useState } from "react";

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
const CONSONANT_CELLS = [
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
const VOWEL_CELLS = [
  { row: "Close", col: "Front", symbols: ["iː"] },
  { row: "Close", col: "Back", symbols: ["uː"] },
  { row: "Near-close", col: "Front", symbols: ["ɪ"] },
  { row: "Near-close", col: "Back", symbols: ["ʊ"] },
  { row: "Mid", col: "Central", symbols: ["ə", "ɚ", "ɜɹ"] },
  { row: "Open-mid", col: "Front", symbols: ["ɛ"] },
  { row: "Open-mid", col: "Central", symbols: ["ʌ"] },
  { row: "Open-mid", col: "Back", symbols: ["ɔː"] },
  { row: "Near-open", col: "Front", symbols: ["æ"] },
  { row: "Near-open", col: "Central", symbols: ["ɐ"] },
  { row: "Open", col: "Back", symbols: ["ɑː"] },
];

function PhonemeChart({ title, cols, rows, cells, bySymbol, expanded, onToggle, onExampleClick, apiBase }) {
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
              const entry = bySymbol[symbol] ?? { symbol, count: 0, examples: [] };
              return (
                <PhonemeCard
                  key={symbol}
                  entry={entry}
                  expanded={expanded === symbol}
                  onToggle={onToggle}
                  onExampleClick={onExampleClick}
                  apiBase={apiBase}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function PhonemeCard({ entry, expanded, onToggle, onExampleClick, apiBase }) {
  return (
    <div className={entry.count > 0 ? "phoneme-card captured" : "phoneme-card"}>
      <button
        className="phoneme-card-main"
        onClick={() => onToggle(entry.symbol)}
        disabled={entry.count === 0}
      >
        <span className="phoneme-symbol">{entry.symbol}</span>
        <span className="phoneme-count">{entry.count}</span>
      </button>

      {expanded && entry.examples.length > 0 && (
        <div className="phoneme-examples">
          {entry.examples.map((ex, i) => (
            <button
              key={i}
              className="phoneme-example"
              onClick={() => onExampleClick(ex.transcript_id, ex.start)}
            >
              <img
                className="phoneme-thumb"
                src={`${apiBase}/media/${ex.transcript_id}/segment.png?start=${ex.start}&end=${ex.end}`}
                alt=""
              />
              <span>{ex.word || `${ex.start.toFixed(2)}s`}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PhonemeInventory({ inventory, onExampleClick, apiBase }) {
  const [expanded, setExpanded] = useState(null);
  const toggle = (symbol) => setExpanded((prev) => (prev === symbol ? null : symbol));

  const bySymbol = Object.fromEntries(inventory.map((e) => [e.symbol, e]));
  const capturedCount = inventory.filter((e) => e.count > 0).length;

  const placedSymbols = new Set([
    ...CONSONANT_CELLS.flatMap((c) => c.symbols),
    ...VOWEL_CELLS.flatMap((c) => c.symbols),
  ]);
  const leftover = inventory.filter((e) => !placedSymbols.has(e.symbol));

  const chartProps = { bySymbol, expanded, onToggle: toggle, onExampleClick, apiBase };

  return (
    <div className="inventory">
      <div className="inventory-summary">
        {capturedCount} / {inventory.length} sounds captured
      </div>

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
        <h3>Diphthongs &amp; r-colored vowels</h3>
        <div className="phoneme-row">
          {leftover.map((entry) => (
            <PhonemeCard
              key={entry.symbol}
              entry={entry}
              expanded={expanded === entry.symbol}
              onToggle={toggle}
              onExampleClick={onExampleClick}
              apiBase={apiBase}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default PhonemeInventory;
