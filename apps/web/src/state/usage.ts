/**
 * Multi-environment usage state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the results. Raw transcripts never leave the machine that produced them.
 *
 * @module state/usage
 */
import { useAtomValue } from "@effect/atom-react";
import {
  USAGE_CONTRACT_VERSION,
  USAGE_LIMITS_CONTRACT_VERSION,
  type EnvironmentId,
  type ProviderUsageLimits,
  type UsageLimitsSummary,
  type UsageProviderKind,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "@t3tools/shared/usageMerge";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

/**
 * Reads every environment's summary for one window.
 *
 * Keyed by the serialised window so switching ranges does not thrash the atom
 * cache, and so each environment's query is shared with any other reader of the
 * same window.
 */
const usageByWindowAtom = Atom.family((windowKey: string) =>
  Atom.make((get): readonly EnvironmentUsageStatus[] => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    const presentations = get(environmentPresentations.presentationsAtom);

    const statuses: EnvironmentUsageStatus[] = [];
    for (const [environmentId, presentation] of presentations) {
      const result = get(serverEnvironment.usageSummary({ environmentId, input }));
      statuses.push({
        environmentId,
        label: presentation.entry.target.label,
        isPending: result.waiting,
        error: result._tag === "Failure" ? "This environment could not report usage." : null,
        summary: Option.getOrNull(AsyncResult.value(result)),
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`web-usage:window:${windowKey}`)),
);

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  /**
   * True while environments that have not failed are still answering. Failed
   * environments are reported through their own error rows: totals will not
   * improve by waiting on them, so they must not read as "still reporting".
   */
  readonly isPartial: boolean;
  readonly refresh: () => void;
}

export function useUsage(input: UsageSummaryInput): UsageView {
  const windowKey = useMemo(
    () =>
      JSON.stringify({
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        timeZone: input.timeZone,
        resolution: input.resolution,
        sinceTime: input.sinceTime,
        untilTime: input.untilTime,
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
  const atom = usageByWindowAtom(windowKey);
  const environments = useAtomValue(atom);

  // Refreshing only the derived atom would re-read the per-environment SWR
  // queries within their stale window and change nothing. Refresh each
  // environment's query so the button always rescans.
  const refresh = useCallback(() => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.usageSummary({ environmentId: environment.environmentId, input }),
      );
    }
  }, [environments, windowKey]);

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

  const answeredCount = environments.filter((environment) => environment.summary !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;

  return {
    merged,
    environments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}

export interface EnvironmentUsageLimitsStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageLimitsSummary | null;
}

const usageLimitsAtom = Atom.make((get): readonly EnvironmentUsageLimitsStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);

  const statuses: EnvironmentUsageLimitsStatus[] = [];
  for (const [environmentId, presentation] of presentations) {
    const result = get(serverEnvironment.usageLimits({ environmentId, input: {} }));
    const summary = Option.getOrNull(AsyncResult.value(result));
    // Version bumps are incompatible in either direction, and a mismatch must
    // be terminal: a null summary with a null error would read as "still
    // answering" and hold the page on its skeleton forever.
    const incompatible =
      summary !== null && summary.contractVersion !== USAGE_LIMITS_CONTRACT_VERSION;
    statuses.push({
      environmentId,
      label: presentation.entry.target.label,
      isPending: result.waiting,
      error:
        result._tag === "Failure"
          ? "This environment could not report limits."
          : incompatible
            ? "This environment runs an incompatible server version."
            : null,
      summary: summary !== null && !incompatible ? summary : null,
    });
  }
  return statuses;
}).pipe(Atom.withLabel("web-usage:limits"));

export interface ProviderLimitsStatus {
  readonly provider: UsageProviderKind;
  /** The figures this card renders. */
  readonly limits: ProviderUsageLimits;
  /** Environments whose answers this card covers. */
  readonly environmentLabels: readonly string[];
}

export interface UsageLimitsView {
  readonly providers: readonly ProviderLimitsStatus[];
  readonly environments: readonly EnvironmentUsageLimitsStatus[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  /** True while environments that have not failed are still answering. */
  readonly isPartial: boolean;
  readonly refresh: () => void;
}

/**
 * Ranks a provider's answers across environments: real figures beat every
 * failure mode, and a broken sign-in is more actionable than "API key".
 */
const AVAILABILITY_RANK: Record<ProviderUsageLimits["availability"], number> = {
  available: 0,
  unauthenticated: 1,
  unavailable: 2,
  unsupported: 3,
};

export function useUsageLimits(): UsageLimitsView {
  const environments = useAtomValue(usageLimitsAtom);

  const refresh = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.usageLimits({ environmentId: environment.environmentId, input: {} }),
      );
    }
  }, [environments]);

  // One card per provider account. Environments sharing one machine
  // (worktree servers) resolve the same credentials and must not repeat the
  // card, but two environments signed into different accounts must both stay
  // visible: hiding one could hide the account that is about to hit a limit.
  // Reset instants identify the account well enough for that grouping - the
  // windows follow the account's own clock, while utilization drifts between
  // fetches. Failure answers only surface when no environment produced
  // figures for the provider, best-ranked first.
  const providers = useMemo(() => {
    interface ProviderMerge {
      readonly accounts: Map<string, { limits: ProviderUsageLimits; labels: string[] }>;
      fallback: { limits: ProviderUsageLimits; labels: string[] } | null;
    }
    const byProvider = new Map<UsageProviderKind, ProviderMerge>();
    for (const environment of environments) {
      if (environment.summary === null) continue;
      for (const limits of environment.summary.providers) {
        let merge = byProvider.get(limits.provider);
        if (merge === undefined) {
          merge = { accounts: new Map(), fallback: null };
          byProvider.set(limits.provider, merge);
        }
        if (limits.availability === "available") {
          const accountKey = JSON.stringify([
            limits.plan,
            limits.windows.map((window) => [window.id, window.resetsAt]),
          ]);
          const account = merge.accounts.get(accountKey);
          if (account === undefined) {
            merge.accounts.set(accountKey, { limits, labels: [environment.label] });
          } else {
            account.labels.push(environment.label);
          }
        } else if (
          merge.fallback === null ||
          AVAILABILITY_RANK[limits.availability] <
            AVAILABILITY_RANK[merge.fallback.limits.availability]
        ) {
          merge.fallback = { limits, labels: [environment.label] };
        }
      }
    }
    const cards: ProviderLimitsStatus[] = [];
    for (const [provider, merge] of byProvider) {
      const entries =
        merge.accounts.size > 0
          ? [...merge.accounts.values()]
          : merge.fallback === null
            ? []
            : [merge.fallback];
      for (const entry of entries) {
        cards.push({ provider, limits: entry.limits, environmentLabels: entry.labels });
      }
    }
    return cards;
  }, [environments]);

  const answeredCount = environments.filter((environment) => environment.summary !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;

  return {
    providers,
    environments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}
