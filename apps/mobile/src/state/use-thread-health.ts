import { useAtomValue } from "@effect/atom-react";
import type { OrchestrationThreadActivity, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { projectThreadHealth, type ThreadHealth } from "../lib/threadHealth";
import { environmentThreadDetails } from "./threads";

const EMPTY_THREAD_ACTIVITIES_ATOM = Atom.make<ReadonlyArray<OrchestrationThreadActivity>>([]).pipe(
  Atom.withLabel("mobile-thread-health:empty"),
);

/**
 * Projects server liveness from the detail stream's authoritative activity
 * array. The client-runtime reducer replaces that array on snapshots and
 * incrementally appends live-tail activities, so both synchronization paths
 * feed the same newest-wins fold.
 *
 * Passing `null` subscribes to a static empty fallback instead of mounting the
 * per-thread detail stream — list rows use this escape hatch so they only pay
 * for a detail stream when the thread can actually stall.
 */
export function useThreadHealth(ref: ScopedThreadRef | null): ThreadHealth | null {
  const activities = useAtomValue(
    ref !== null ? environmentThreadDetails.activitiesAtom(ref) : EMPTY_THREAD_ACTIVITIES_ATOM,
  );
  return useMemo(() => projectThreadHealth(activities), [activities]);
}
