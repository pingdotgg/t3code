import { useState } from "react";

/** Keeps a retry control busy from click through query pending, including instant failures. */
export function useRetryButtonBusy(refreshing: boolean) {
  const [phase, setPhase] = useState<"idle" | "clicked" | "pending">("idle");

  if (phase === "clicked" && refreshing) setPhase("pending");
  if (phase === "pending" && !refreshing) setPhase("idle");

  const busy = phase !== "idle" || refreshing;

  return {
    busy,
    start() {
      if (busy) return false;
      setPhase("clicked");
      // Instant failures may never raise `refreshing`; clear after this turn paints.
      window.setTimeout(() => {
        setPhase((current) => (current === "clicked" ? "idle" : current));
      }, 0);
      return true;
    },
  };
}
