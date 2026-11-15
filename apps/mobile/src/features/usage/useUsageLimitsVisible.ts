import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { retainUsageLimitsView } from "../../connection/background-activity-scopes";

/** An environment reads provider quotas on its periodic checks only while a view of it calls this. */
export function useUsageLimitsVisible(environmentIds: ReadonlyArray<EnvironmentId>): void {
  const key = [...environmentIds].sort().join(",");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells each shown environment's activity lease that a usage limits view is on screen
  useEffect(
    () => (key === "" ? undefined : retainUsageLimitsView(key.split(",") as EnvironmentId[])),
    [key],
  );
}
