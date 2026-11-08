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
  AuthDiagnosticsReadScope,
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { refreshUsage, usageSummaryInput } from "@t3tools/client-runtime/state/usage";
import { resolveUsageAccess } from "@t3tools/client-runtime/state/usage-access";
import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "@t3tools/shared/usageMerge";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "./atom-registry";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { environmentSession, readEnvironmentScope } from "./session";
import {
  getEnvironmentUsageLoadingState,
  type EnvironmentUsageOption,
} from "./usageEnvironmentScope";

export type { EnvironmentUsageOption } from "./usageEnvironmentScope";

export interface EnvironmentUsageStatus extends EnvironmentUsageOption {
  readonly isPending: boolean;
  readonly isConnected: boolean;
  readonly canReadDiagnostics: boolean;
  /**
   * A connected usage query failed, or this connection may not read usage.
   * Connection coverage uses `phase`.
   */
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
      const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
      const session = AsyncResult.getOrElse(sessionResult, () => null);
      const access = resolveUsageAccess({
        connectionPhase: option.phase,
        session,
        hasSessionError: sessionResult._tag === "Failure",
      });
      if (!access.canReadDiagnostics) {
        // A session that has not arrived yet waits only through the first
        // connection attempt, like the usage query below, so a down machine
        // cannot hold the dashboard open.
        const awaitingSession = session === null && sessionResult._tag !== "Failure";
        const isPending = awaitingSession
          ? (option.phase === "available" && connectionResult.waiting) ||
            option.phase === "connecting" ||
            option.phase === "connected"
          : access.isPending;
        environments.push({
          ...option,
          isConnected: option.phase === "connected",
          ...access,
          isPending,
          error: awaitingSession && isPending ? null : access.error,
          summary: null,
        });
        continue;
      }
      // Keep reading the environment-scoped atom while disconnected so a prior
      // successful value remains visible. Wait through the first connection attempt,
      // then treat retries as terminal coverage so a down machine cannot block the UI.
      const result = get(
        serverEnvironment.usageSummary({
          environmentId,
          input: usageSummaryInput(
            input,
            get(serverEnvironment.usageModelFilterAtom(environmentId)),
          ),
        }),
      );
      const summary = AsyncResult.getOrElse(result, () => null);
      const failed = option.phase === "connected" && result._tag === "Failure";
      environments.push({
        ...option,
        isPending:
          (option.phase === "available" && connectionResult.waiting) ||
          option.phase === "connecting" ||
          (option.phase === "connected" && result.waiting),
        isConnected: option.phase === "connected",
        canReadDiagnostics: true,
        error: failed ? "This environment could not report usage." : null,
        summary,
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
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  /** True until at least one selected, connected environment has answered. */
  readonly isPending: boolean;
  /**
   * True while environments that have not failed are still answering. Failed
   * environments are reported in the environment menu and the coverage notice:
   * totals will not improve by waiting on them, so they must not read as
   * "still reporting".
   */
  readonly isPartial: boolean;
  readonly refresh: (input?: UsageSummaryInput) => Promise<void>;
}

export function useUsage(
  input: UsageSummaryInput,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
): UsageView {
  const windowKey = useMemo(
    () =>
      JSON.stringify({
        input: {
          sinceDay: input.sinceDay,
          untilDay: input.untilDay,
          timeZone: input.timeZone,
          resolution: input.resolution,
          sinceTime: input.sinceTime,
          untilTime: input.untilTime,
          clientContractVersion: input.clientContractVersion,
        },
      }),
    [
      input.sinceDay,
      input.untilDay,
      input.timeZone,
      input.resolution,
      input.sinceTime,
      input.untilTime,
      input.clientContractVersion,
    ],
  );
  const atom = usageByWindowAtom(windowKey);
  const value = useAtomValue(atom);
  const environments = value.environments;
  const selectedEnvironments = useMemo(
    () =>
      selectedEnvironmentIds === null
        ? environments
        : environments.filter(({ environmentId }) => selectedEnvironmentIds.has(environmentId)),
    [environments, selectedEnvironmentIds],
  );

  // Refreshing only the derived atom would re-read the per-environment SWR
  // queries within their stale window and change nothing. The shared helper
  // refetches model pricing, then rescans each environment's query.
  //
  // Only connected environments rescan: an unreachable environment has nothing
  // to answer, and the helper already aborts a scan whose environment drops.
  const refresh = useCallback(
    (nextInput?: UsageSummaryInput) =>
      refreshUsage({
        registry: appAtomRegistry,
        server: serverEnvironment,
        presentations: environmentPresentations,
        // Only connected environments this connection may read; the others
        // report a permission error instead of a stale or failed rescan.
        environmentIds: selectedEnvironments
          .filter(
            (environment) =>
              environment.phase === "connected" &&
              environment.canReadDiagnostics &&
              readEnvironmentScope(environment.environmentId, AuthDiagnosticsReadScope),
          )
          .map(({ environmentId }) => environmentId),
        input: nextInput ?? (JSON.parse(windowKey) as UsageAtomKey).input,
      }),
    [selectedEnvironments, windowKey],
  );

  const merged = useMemo(() => {
    const answered: EnvironmentUsage[] = selectedEnvironments.flatMap((environment) =>
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
  }, [selectedEnvironments]);

  const loadingState = getEnvironmentUsageLoadingState(selectedEnvironments);

  return {
    merged,
    options: value.options,
    environments,
    selectedEnvironments,
    isPending: !value.isCatalogReady || loadingState.isPending,
    isPartial: loadingState.isPartial,
    refresh,
  };
}
