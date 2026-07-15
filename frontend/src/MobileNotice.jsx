import { useEffect, useState } from "react";

const BREAKPOINT = 768;

function MobileNotice() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= BREAKPOINT
  );
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${BREAKPOINT}px)`);
    const handleChange = (e) => setIsMobile(e.matches);
    mq.addEventListener("change", handleChange);
    return () => mq.removeEventListener("change", handleChange);
  }, []);

  if (!isMobile || dismissed) return null;

  return (
    <div className="mobile-modal-backdrop">
      <div className="mobile-modal">
        <h2>Desktop recommended</h2>
        <p>
          phonemizer.live is optimized for larger screens — the spectrogram,
          phoneme charts, and recording controls need room to work well.
          You can keep going, but expect a cramped layout on mobile.
        </p>
        <button className="mobile-modal-dismiss" onClick={() => setDismissed(true)}>
          Continue anyway
        </button>
      </div>
    </div>
  );
}

export default MobileNotice;
