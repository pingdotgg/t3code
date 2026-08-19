/**
 * Vibe-Proxy usage state for the Settings → Usages page.
 *
 * Two server calls back this page. The query returns whatever snapshot the
 * server already has on disk, so a revisit paints immediately; the refresh
 * command re-fetches upstream. The page always issues the refresh on mount and
 * keeps the older snapshot on screen until the newer one lands.
 */
import type { VibeProxyUsageResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useRef, useState } from "react";

import { usePrimaryEnvironmentId } from "./environments";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

export interface VibeProxyUsageState {
  /** Freshest result available: the completed refresh, else the server cache. */
  readonly result: VibeProxyUsageResult | null;
  /** True while a refresh is in flight, including the automatic one on mount. */
  readonly isRefreshing: boolean;
  /** Transport failure. Upstream problems arrive as `result.refreshProblem`. */
  readonly error: string | null;
  readonly refresh: () => void;
}

function transportErrorMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not reach this environment.";
}

/**
 * @param configurationKey Null while the integration is off or incompletely
 * configured. A changed key re-fetches after a saved configuration change.
 */
export function useVibeProxyUsage(configurationKey: string | null): VibeProxyUsageState {
  const canFetch = configurationKey !== null;
  const environmentId = usePrimaryEnvironmentId();
  const stateKey =
    environmentId === null || configurationKey === null
      ? null
      : `${environmentId}:${configurationKey}`;
  const cached = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.vibeProxyUsage({ environmentId, input: {} }),
  );
  const refreshCommand = useAtomCommand(serverEnvironment.refreshVibeProxyUsage, {
    reportFailure: false,
  });

  const [refreshed, setRefreshed] = useState<{
    readonly key: string;
    readonly value: VibeProxyUsageResult;
  } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<{ readonly key: string; readonly message: string } | null>(
    null,
  );
  // Only the newest refresh may write state: a stale response landing after a
  // manual retry would otherwise reinstate the older snapshot.
  const requestGeneration = useRef(0);

  const refresh = useCallback(() => {
    if (environmentId === null || stateKey === null) return;
    const requestKey = stateKey;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setIsRefreshing(true);

    void refreshCommand({ environmentId, input: {} }).then((outcome) => {
      if (requestGeneration.current !== generation) return;
      setIsRefreshing(false);
      if (outcome._tag === "Failure") {
        setError({ key: requestKey, message: transportErrorMessage(outcome.cause) });
        return;
      }
      setError(null);
      setRefreshed({ key: requestKey, value: outcome.value });
    });
  }, [environmentId, refreshCommand, stateKey]);

  // Every visit refetches, as does a saved configuration change.
  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (stateKey !== null) return;
    requestGeneration.current += 1;
    setIsRefreshing(false);
    setError(null);
  }, [stateKey]);

  return {
    result: refreshed?.key === stateKey ? refreshed.value : cached.data,
    isRefreshing: isRefreshing || (canFetch && refreshed?.key !== stateKey && cached.isPending),
    error:
      error?.key === stateKey ? error.message : refreshed?.key !== stateKey ? cached.error : null,
    refresh,
  };
}
