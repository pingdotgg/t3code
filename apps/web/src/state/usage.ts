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
  type EnvironmentId,
  type UsageSummary,
  type UsageSummaryInput,
  type UsageThreadBreakdownInput,
  type UsageThreadRow,
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

export function useUsage(
  input: UsageSummaryInput,
  /** A namespaced project key, `null` for outside-projects buckets, `undefined` for no filter. */
  projectFilter?: string | null,
): UsageView {
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
    return mergeUsage(
      answered,
      USAGE_CONTRACT_VERSION,
      projectFilter === undefined ? undefined : { projectFilter },
    );
  }, [environments, projectFilter]);

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

export interface UsageThreadsView {
  readonly rows: readonly UsageThreadRow[];
  readonly truncatedRows: number;
  /** True until every listed environment answered or failed. */
  readonly isPending: boolean;
  readonly failedEnvironments: number;
}

const usageThreadsAtom = Atom.family((requestKey: string) =>
  Atom.make((get): UsageThreadsView => {
    const { input, environmentIds } = JSON.parse(requestKey) as {
      input: UsageThreadBreakdownInput;
      environmentIds: readonly EnvironmentId[];
    };

    const rows: UsageThreadRow[] = [];
    // Environments sharing a transcript directory report the same sessions;
    // row keys are derived from provider session ids, so first-in wins.
    const seen = new Set<string>();
    let truncatedRows = 0;
    let pending = 0;
    let failed = 0;
    for (const environmentId of environmentIds) {
      const result = get(serverEnvironment.usageThreadBreakdown({ environmentId, input }));
      if (result.waiting) pending += 1;
      if (result._tag === "Failure") failed += 1;
      const breakdown = Option.getOrNull(AsyncResult.value(result));
      if (breakdown === null) continue;
      truncatedRows += breakdown.truncatedRows;
      for (const row of breakdown.rows) {
        const dedupeKey = `${row.provider}\u0000${row.key}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        rows.push(row);
      }
    }
    rows.sort((a, b) => b.costUsd - a.costUsd);

    return { rows, truncatedRows, isPending: pending > 0, failedEnvironments: failed };
  }).pipe(Atom.withLabel(`web-usage:threads:${requestKey}`)),
);

/**
 * Thread drill-down across the environments that contributed to the summary.
 * Mount the consuming component only while the thread view is open; fetching
 * starts on first read.
 */
export function useUsageThreads(
  input: UsageThreadBreakdownInput,
  environmentIds: readonly EnvironmentId[],
): UsageThreadsView {
  const requestKey = useMemo(
    () => JSON.stringify({ input, environmentIds }),
    [input, environmentIds],
  );
  return useAtomValue(usageThreadsAtom(requestKey));
}
