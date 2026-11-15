import { useEffect } from "react";

import { retainUsageLimitsView } from "../lib/backgroundActivityReporter";

/** The server reads provider quotas on its periodic checks only while a view calls this. */
export function useUsageLimitsVisible(visible = true): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the server's activity lease that a usage limits view is on screen
  useEffect(() => (visible ? retainUsageLimitsView() : undefined), [visible]);
}
