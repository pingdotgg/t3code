/**
 * Multi-environment usage state.
 *
 * Connected environments answer the typed usage query. Connection state
 * determines whether a waiting query contributes to loading coverage, so one
 * unreachable machine can never hold the dashboard open.
 *
 * Mirror of web usage state over mobile's atom registry.
 *
 * @module state/usage
 */
import { useAtomValue } from "@effect/atom-react";
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "@t3tools/shared/usageMerge";
import { appAtomRegistry } from "./atom-registry";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import {
  getEnvironmentUsageLoadingState,
  resolveEnvironmentUsageScope,
  type EnvironmentUsageOption,
} from "./usageEnvironmentScope";

export type { EnvironmentUsageOption } from "./usageEnvironmentScope";

export interface EnvironmentUsageStatus extends EnvironmentUsageOption {
  readonly isPending: boolean;
  /** A connected usage query failed. Connection coverage uses `phase`. */
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

interface UsageAtomValue {
  readonly isCatalogReady: boolean;
  readonly options: readonly EnvironmentUsageOption[];
  readonly environments: readonly EnvironmentUsageStatus[];
}

interface UsageAtomKey {
  readonly input: UsageSummaryInput;
}

const usageByWindowAtom = Atom.family((key: string) =>
  Atom.make((get): UsageAtomValue => {
    const { input } = JSON.parse(key) as UsageAtomKey;
    const catalog = get(environmentCatalog.catalogValueAtom);
    const presentations = get(environmentPresentations.presentationsAtom);
    const options = Array.from(presentations, ([environmentId, presentation]) => ({
      environmentId,
      label: presentation.entry.target.label,
      phase: presentation.connection.phase,
    }));

    // Keep every environment subscribed while this time window is mounted. Filtering
    // only the view avoids evicting sibling usage caches when switching scopes.
    const environments: EnvironmentUsageStatus[] = [];
    for (const option of options) {
      const { environmentId } = option;
      const connectionResult = get(environmentCatalog.stateAtom(environmentId));
      // Keep reading the environment-scoped atom while disconnected so a prior
      // successful value remains visible. Wait through the first connection attempt,
      // then treat retries as terminal coverage so a down machine cannot block the UI.
      const result = get(serverEnvironment.usageSummary({ environmentId, input }));
      const failed = option.phase === "connected" && result._tag === "Failure";
      environments.push({
        ...option,
        isPending:
          (option.phase === "available" && connectionResult.waiting) ||
          option.phase === "connecting" ||
          (option.phase === "connected" && result.waiting),
        error: failed ? "This environment could not report usage." : null,
        summary: Option.getOrNull(AsyncResult.value(result)),
      });
    }

    return {
      isCatalogReady: catalog.isReady,
      options,
      environments,
    };
  }).pipe(Atom.withLabel(`mobile-usage:${key}`)),
);

export interface UsageView {
  readonly merged: MergedUsage;
  /** All catalog entries, including entries outside the active filter. */
  readonly options: readonly EnvironmentUsageOption[];
  /** Coverage entries in the active filter. */
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironmentId: EnvironmentId | null;
  /** True until at least one connected environment has answered. */
  readonly isPending: boolean;
  readonly isPartial: boolean;
  readonly refresh: () => void;
}

export function useUsage(
  input: UsageSummaryInput,
  selectedEnvironmentId: EnvironmentId | null,
): UsageView {
  const key = useMemo(
    () =>
      JSON.stringify({
        input: {
          sinceDay: input.sinceDay,
          untilDay: input.untilDay,
          timeZone: input.timeZone,
          resolution: input.resolution,
          sinceTime: input.sinceTime,
          untilTime: input.untilTime,
        },
      }),
    [
      input.sinceDay,
      input.untilDay,
      input.timeZone,
      input.resolution,
      input.sinceTime,
      input.untilTime,
    ],
  );
  const atom = usageByWindowAtom(key);
  const value = useAtomValue(atom);
  const scope = resolveEnvironmentUsageScope(value.options, selectedEnvironmentId);
  const environments = useMemo(() => {
    if (scope.selectedEnvironmentId === null) return value.environments;
    return value.environments.filter(
      (environment) => environment.environmentId === scope.selectedEnvironmentId,
    );
  }, [scope.selectedEnvironmentId, value.environments]);

  const refresh = useCallback(() => {
    const { input } = JSON.parse(key) as UsageAtomKey;
    for (const environment of environments) {
      if (environment.phase !== "connected") continue;
      appAtomRegistry.refresh(
        serverEnvironment.usageSummary({ environmentId: environment.environmentId, input }),
      );
    }
  }, [environments, key]);

  const merged = useMemo(() => {
    const answered: EnvironmentUsage[] = environments.flatMap((environment) =>
      environment.summary === null
        ? []
        : [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              summary: environment.summary,
            },
          ],
    );
    return mergeUsage(answered, USAGE_CONTRACT_VERSION);
  }, [environments]);

  const loadingState = getEnvironmentUsageLoadingState(environments);

  return {
    merged,
    options: value.options,
    environments,
    selectedEnvironmentId: scope.selectedEnvironmentId,
    isPending: !value.isCatalogReady || loadingState.isPending,
    isPartial: loadingState.isPartial,
    refresh,
  };
}
