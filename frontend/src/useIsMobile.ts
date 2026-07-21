import { useEffect, useState } from "react";

const BREAKPOINT = 768;

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= BREAKPOINT
  );

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${BREAKPOINT}px)`);
    const handleChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handleChange);
    return () => mq.removeEventListener("change", handleChange);
  }, []);

  return isMobile;
}
