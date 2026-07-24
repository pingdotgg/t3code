import { useEffect, useState } from "react";

/** Minute-quantized clock ("YYYY-MM-DDTHH:MM") for settled-state resolution.
    Quantizing keeps consumers on the same tick, so surfaces resolving
    effectiveSettled against it (sidebar partition, composer banner) can
    never disagree within a minute. */
export function useNowMinute(): string {
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  useEffect(() => {
    const id = window.setInterval(
      () => setNowMinute(new Date().toISOString().slice(0, 16)),
      60_000,
    );
    return () => window.clearInterval(id);
  }, []);
  return nowMinute;
}
