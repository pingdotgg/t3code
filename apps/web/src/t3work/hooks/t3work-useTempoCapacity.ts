/**
 * Per-person sprint capacity from Tempo (spec §10.2): user-schedule summed
 * over the sprint window minus non-issue plans. Returns null while loading or
 * when Tempo isn't configured — callers fall back to the configured default.
 */

import { useEffect, useMemo, useState } from "react";

import { useBackend } from "~/t3work/backend/t3work-BackendContext";

export function useTempoCapacity(input: {
  readonly enabled: boolean;
  readonly accountIds: ReadonlyArray<string>;
  /** Sprint window, YYYY-MM-DD inclusive. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  /** Jira project key being planned — off-project issue plans then subtract. */
  readonly projectKey?: string | undefined;
  /** Atlassian account for resolving plan issues to projects server-side. */
  readonly atlassianAccountId?: string | undefined;
}): ReadonlyMap<string, number> | null {
  const backend = useBackend();
  const [capacities, setCapacities] = useState<ReadonlyMap<string, number> | null>(null);
  const accountIdsKey = useMemo(() => [...input.accountIds].sort().join(","), [input.accountIds]);

  useEffect(() => {
    if (!backend || !input.enabled || !input.from || !input.to || accountIdsKey.length === 0) {
      setCapacities(null);
      return;
    }
    let cancelled = false;
    backend.atlassian
      .getTempoCapacity({
        accountIds: accountIdsKey.split(","),
        from: input.from,
        to: input.to,
        ...(input.projectKey ? { projectKey: input.projectKey } : {}),
        ...(input.atlassianAccountId ? { atlassianAccountId: input.atlassianAccountId } : {}),
      })
      .then((response) => {
        if (cancelled || !response.configured) return;
        const next = new Map<string, number>();
        for (const entry of response.capacities) {
          if (!entry.error) next.set(entry.accountId, entry.capacitySeconds);
        }
        setCapacities(next);
      })
      .catch(() => {
        // Tempo unavailable — the view keeps its configured fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [
    backend,
    input.enabled,
    input.from,
    input.to,
    input.projectKey,
    input.atlassianAccountId,
    accountIdsKey,
  ]);

  return capacities;
}
