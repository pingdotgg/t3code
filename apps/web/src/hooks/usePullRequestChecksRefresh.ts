import type { PullRequestCheck } from "@t3tools/contracts";
import { useState } from "react";

import { useLiveRefresh } from "./useLiveRefresh";

export function usePullRequestChecksRefresh(input: {
  refresh: (() => void) | null;
  enabled: boolean;
  key: string;
  checks: ReadonlyArray<PullRequestCheck>;
  headSha: string | undefined;
  updatedAt: number;
}) {
  const [observed, setObserved] = useState(() => ({
    key: input.key,
    headSha: input.headSha,
    waitingSince: input.checks.length === 0 ? input.updatedAt : null,
  }));
  if (observed.key !== input.key || observed.headSha !== input.headSha) {
    setObserved({
      key: input.key,
      headSha: input.headSha,
      waitingSince:
        input.checks.length === 0 || (observed.key === input.key && observed.headSha !== undefined)
          ? input.updatedAt
          : null,
    });
  }
  const waiting =
    observed.waitingSince !== null && input.updatedAt - observed.waitingSince < 2 * 60_000;
  useLiveRefresh(input.refresh, {
    key: input.key,
    enabled: input.enabled,
    intervalMs:
      waiting || input.checks.some((check) => check.status === "pending") ? 45_000 : 60_000,
  });
}
