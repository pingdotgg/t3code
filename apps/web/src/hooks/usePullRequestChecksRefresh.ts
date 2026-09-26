import type { PullRequestCheck } from "@t3tools/contracts";

import { useLiveRefresh } from "./useLiveRefresh";

export function usePullRequestChecksRefresh(input: {
  refresh: (() => void) | null;
  enabled: boolean;
  key: string;
  checks: ReadonlyArray<PullRequestCheck>;
}) {
  useLiveRefresh(input.refresh, {
    key: input.key,
    enabled: input.enabled,
    intervalMs:
      input.checks.length === 0 ||
      input.checks.some((check) => check.status === "pending" || check.status === "action-required")
        ? 45_000
        : 60_000,
  });
}
