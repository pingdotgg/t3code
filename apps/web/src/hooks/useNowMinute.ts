import { useEffect, useState } from "react";

/** Minute-quantized clock ("YYYY-MM-DDTHH:MM") for settled-state resolution.
    Ticks are aligned to UTC minute boundaries — not offset from mount time —
    so every consumer (sidebar partition, composer banner) crosses each minute
    together and effectiveSettled can never disagree between surfaces. */
export function useNowMinute(): string {
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  useEffect(() => {
    let intervalId: number | null = null;
    const timeoutId = window.setTimeout(
      () => {
        setNowMinute(new Date().toISOString().slice(0, 16));
        intervalId = window.setInterval(
          () => setNowMinute(new Date().toISOString().slice(0, 16)),
          60_000,
        );
      },
      60_000 - (Date.now() % 60_000),
    );
    return () => {
      window.clearTimeout(timeoutId);
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, []);
  return nowMinute;
}
