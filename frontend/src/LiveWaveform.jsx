import { useEffect, useState } from "react";

const BAR_COUNT = 28;

function LiveWaveform({ level }) {
  const [levels, setLevels] = useState(() => Array(BAR_COUNT).fill(0));

  useEffect(() => {
    setLevels((prev) => [...prev.slice(1), level]);
  }, [level]);

  return (
    <div className="live-waveform">
      {levels.map((l, i) => (
        <span
          key={i}
          className="live-waveform-bar"
          style={{ height: `${Math.max(Math.min(l * 500, 100), 8)}%` }}
        />
      ))}
    </div>
  );
}

export default LiveWaveform;
