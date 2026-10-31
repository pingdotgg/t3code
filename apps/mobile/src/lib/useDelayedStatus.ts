import {
  delayedStatusDeadline,
  shownDelayedStatus,
  stepDelayedStatus,
} from "@t3tools/client-runtime/delayed-status";
import { useState } from "react";

import { useDeadlinePassed } from "./clock";

export function useDelayedStatus<A>(key: string, value: A | null): A | null {
  const [state, setState] = useState(() =>
    stepDelayedStatus<A>(null, { key, value, deadlinePassed: false }, Date.now),
  );
  const deadlinePassed = useDeadlinePassed(delayedStatusDeadline(state));
  const next = stepDelayedStatus(state, { key, value, deadlinePassed }, Date.now);
  if (next !== state) setState(next);
  return shownDelayedStatus(next, key);
}
