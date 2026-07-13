import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { projectThreadHealth, type ThreadHealth } from "../lib/threadHealth";
import { environmentThreadDetails } from "./threads";

/**
 * Projects server liveness from the detail stream's authoritative activity
 * array. The client-runtime reducer replaces that array on snapshots and
 * incrementally appends live-tail activities, so both synchronization paths
 * feed the same newest-wins fold.
 */
export function useThreadHealth(ref: ScopedThreadRef): ThreadHealth | null {
  const activities = useAtomValue(environmentThreadDetails.activitiesAtom(ref));
  return useMemo(() => projectThreadHealth(activities), [activities]);
}
