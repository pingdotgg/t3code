import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, VibeProxySettings, VibeProxyUsageResult } from "@t3tools/contracts";
import { vibeProxyConfigurationKey } from "@t3tools/shared/vibeProxyUsage";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";

import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

interface CachedVibeProxyUsage {
  readonly environmentId: EnvironmentId;
  readonly settings: VibeProxySettings;
  readonly result: VibeProxyUsageResult | null;
  readonly isPending: boolean;
  readonly error: string | null;
}

export interface VibeProxyUsageView {
  readonly environmentId: EnvironmentId | null;
  readonly settings: VibeProxySettings | null;
  readonly result: VibeProxyUsageResult | null;
  readonly isRefreshing: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

function formatTransportError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not reach this environment.";
}

const cachedVibeProxyUsageAtom = Atom.make((get): CachedVibeProxyUsage | null => {
  const presentations = get(environmentPresentations.presentationsAtom);

  for (const [environmentId] of presentations) {
    const config = get(serverEnvironment.configValueAtom(environmentId));
    if (config === null) continue;

    const query = get(serverEnvironment.vibeProxyUsage({ environmentId, input: {} }));
    return {
      environmentId,
      settings: config.settings.vibeProxy,
      result: Option.getOrNull(AsyncResult.value(query)),
      isPending: query.waiting,
      error: query._tag === "Failure" ? formatTransportError(query.cause) : null,
    };
  }

  return null;
}).pipe(Atom.withLabel("mobile-usage:vibe-proxy"));

interface RefreshState {
  readonly environmentId: EnvironmentId;
  readonly configurationKey: string;
  readonly result: VibeProxyUsageResult | null;
  readonly isRefreshing: boolean;
  readonly error: string | null;
}

export function useVibeProxyUsage(): VibeProxyUsageView {
  const cached = useAtomValue(cachedVibeProxyUsageAtom);
  const refreshCommand = useAtomCommand(serverEnvironment.refreshVibeProxyUsage, {
    reportFailure: false,
  });
  const [refreshState, setRefreshState] = useState<RefreshState | null>(null);
  const generation = useRef(0);
  const configurationKey = cached === null ? null : vibeProxyConfigurationKey(cached.settings);

  const refresh = useCallback(() => {
    if (cached === null || configurationKey === null) return;
    const currentGeneration = generation.current + 1;
    generation.current = currentGeneration;
    const environmentId = cached.environmentId;
    setRefreshState((current) => ({
      environmentId,
      configurationKey,
      result:
        current?.environmentId === environmentId && current.configurationKey === configurationKey
          ? current.result
          : null,
      isRefreshing: true,
      error: null,
    }));

    void refreshCommand({ environmentId, input: {} }).then((outcome) => {
      if (generation.current !== currentGeneration) return;
      setRefreshState((current) => {
        const previousResult =
          current?.environmentId === environmentId && current.configurationKey === configurationKey
            ? current.result
            : null;
        return outcome._tag === "Failure"
          ? {
              environmentId,
              configurationKey,
              result: previousResult,
              isRefreshing: false,
              error: formatTransportError(outcome.cause),
            }
          : {
              environmentId,
              configurationKey,
              result: outcome.value,
              isRefreshing: false,
              error: null,
            };
      });
    });
  }, [cached, configurationKey, refreshCommand]);

  const automaticRefreshKey =
    cached === null || configurationKey === null
      ? null
      : `${cached.environmentId}:${configurationKey}`;
  const previousAutomaticRefreshKey = useRef<string | null>(null);
  useEffect(() => {
    if (previousAutomaticRefreshKey.current === automaticRefreshKey) return;
    previousAutomaticRefreshKey.current = automaticRefreshKey;
    refresh();
  }, [automaticRefreshKey, refresh]);

  const currentRefresh =
    cached !== null &&
    configurationKey !== null &&
    refreshState?.environmentId === cached.environmentId &&
    refreshState.configurationKey === configurationKey
      ? refreshState
      : null;

  return {
    environmentId: cached?.environmentId ?? null,
    settings: cached?.settings ?? null,
    result: currentRefresh?.result ?? cached?.result ?? null,
    isRefreshing:
      currentRefresh?.isRefreshing ??
      (cached !== null && configurationKey !== null && cached.isPending),
    error: currentRefresh?.error ?? cached?.error ?? null,
    refresh,
  };
}
