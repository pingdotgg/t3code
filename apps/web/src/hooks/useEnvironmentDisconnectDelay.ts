import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

/** Wait through brief outages before offering to switch off the active environment. */
export function useEnvironmentDisconnectDelay(unavailableEnvironmentId: EnvironmentId | null) {
  const [delay, setDelay] = useState({ environmentId: unavailableEnvironmentId, elapsed: false });
  if (delay.environmentId !== unavailableEnvironmentId) {
    setDelay({ environmentId: unavailableEnvironmentId, elapsed: false });
  }

  useEffect(() => {
    if (unavailableEnvironmentId === null) return;
    const timeout = setTimeout(
      () => setDelay({ environmentId: unavailableEnvironmentId, elapsed: true }),
      20_000,
    );
    return () => clearTimeout(timeout);
  }, [unavailableEnvironmentId]);

  return (
    unavailableEnvironmentId !== null &&
    delay.environmentId === unavailableEnvironmentId &&
    delay.elapsed
  );
}
