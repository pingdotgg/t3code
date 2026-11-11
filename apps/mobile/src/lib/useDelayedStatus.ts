import {
  delayedStatusDeadline,
  shownDelayedStatus,
  stepDelayedStatus,
} from "@t3tools/client-runtime/delayed-status";
import { useState } from "react";

import { useDeadlinePassed } from "./clock";

export function useDelayedStatus<A>(key: string, value: A | null, showDelayMs?: number): A | null {
  const [state, setState] = useState(() =>
    stepDelayedStatus<A>(null, { key, value, deadlinePassed: false, showDelayMs }, Date.now),
  );
  const deadlinePassed = useDeadlinePassed(delayedStatusDeadline(state));
  const next = stepDelayedStatus(state, { key, value, deadlinePassed, showDelayMs }, Date.now);
  if (next !== state) setState(next);
  return shownDelayedStatus(next, key);
}
