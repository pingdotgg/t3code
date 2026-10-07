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
  type UsageBucket,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import { needsCursorKeychainAccess, refreshUsage } from "@t3tools/client-runtime/state/usage";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useEffect, useMemo } from "react";

import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "@t3tools/shared/usageMerge";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { loadSavedUsage, pickSavedUsage, saveUsage } from "./savedUsage";
import { serverEnvironment } from "./server";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
  readonly needsCursorKeychainAccess: boolean;
  /** Read by day because the server cannot read this span by hour. */
  readonly readByDay: boolean;
  /** Not connected now; `summary` is what it reported last, if anything. */
  readonly offline: boolean;
  /** When the shown summary was read, if it is not a live read. */
  readonly savedAt: string | null;
  /** The window `summary` answers, for saving it. */
  readonly window: UsageSummaryInput;
}

/** The read last saved per environment and window, so a read is saved once. */
const lastSavedRead = new Map<string, string>();

/** Connection phases in which an environment cannot answer a read. */
const UNREACHABLE = new Set(["available", "offline", "reconnecting", "error", "unsupported"]);

/** Saved reads per environment, loaded once and reloaded after each save. */
const savedUsageAtom = Atom.family((environmentId: string) =>
  Atom.make(Effect.promise(() => loadSavedUsage(environmentId))).pipe(
    Atom.keepAlive,
    Atom.withLabel(`web-usage:saved:${environmentId}`),
  ),
);

const HOUR_MS = 60 * 60 * 1000;
const isUsageReadError = Schema.is(UsageReadError);

/** Only the window rejection falls back; other failures stay visible as errors. */
export function isRejectedWindow(result: AsyncResult.AsyncResult<unknown, unknown>): boolean {
  if (result._tag !== "Failure") return false;
  const error = Cause.squash(result.cause);
  return isUsageReadError(error) && error.reason === "invalidWindow";
}

/**
 * Servers from before week-long hourly reads reject hourly windows over a
 * day. The same span by day still answers, so callers can chart it by day.
 */
export function dailyFallback(input: UsageSummaryInput): UsageSummaryInput | null {
  if (input.resolution !== "hour" || !input.sinceTime || !input.untilTime) return null;
  if (Date.parse(input.untilTime) - Date.parse(input.sinceTime) <= 24 * HOUR_MS) return null;
  return {
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    timeZone: input.timeZone,
    resolution: "day",
    ...(input.groupByThread === undefined ? {} : { groupByThread: input.groupByThread }),
  };
}

/** Where an environment runs, as its address's host, to tell same-named ones apart. */
function placeOf(presentation: EnvironmentPresentation): string {
  const { target } = presentation.entry;
  const profile = Option.getOrNull(presentation.entry.profile);
  const url =
    target._tag === "PrimaryConnectionTarget"
      ? target.httpBaseUrl
      : profile?._tag === "BearerConnectionProfile"
        ? profile.httpBaseUrl
        : null;
  if (url !== null && URL.canParse(url)) return new URL(url).host;
  return target.environmentId.slice(0, 8);
}

/**
 * Names for the Usage page. Servers on one machine all take its name, so a
 * name two environments share gains where each one runs.
 */
export function distinctLabels(
  entries: readonly { readonly label: string; readonly place: () => string }[],
): readonly string[] {
  const counts = new Map<string, number>();
  for (const { label } of entries) counts.set(label, (counts.get(label) ?? 0) + 1);
  return entries.map(({ label, place }) =>
    (counts.get(label) ?? 0) > 1 ? `${label} · ${place()}` : label,
  );
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
    const input = JSON.parse(windowKey) as UsageSummaryInput | null;
    // No window asks nothing, so an optional read can keep its hook in place.
    if (input === null) return [];
    const presentations = get(environmentPresentations.presentationsAtom);

    const statuses: EnvironmentUsageStatus[] = [];
    const fallbackInput = dailyFallback(input);
    const labels = distinctLabels(
      [...presentations.values()].map((presentation) => ({
        label: presentation.entry.target.label,
        place: () => placeOf(presentation),
      })),
    );
    for (const [index, [environmentId, presentation]] of [...presentations].entries()) {
      let window = input;
      let result = get(serverEnvironment.usageSummary({ environmentId, input }));
      let readByDay = false;
      if (fallbackInput !== null && isRejectedWindow(result)) {
        window = fallbackInput;
        result = get(serverEnvironment.usageSummary({ environmentId, input: fallbackInput }));
        readByDay = true;
      }
      const offline = UNREACHABLE.has(presentation.connection.phase);
      let summary = Option.getOrNull(AsyncResult.value(result));
      // Offline, the page keeps what this session read last, or else what
      // this browser saved the last time the environment answered.
      if (summary === null && offline) {
        const saved = pickSavedUsage(
          Option.getOrElse(AsyncResult.value(get(savedUsageAtom(environmentId))), () => []),
          input,
        );
        summary = saved?.summary ?? null;
        readByDay = saved?.readByDay ?? false;
        window = readByDay && fallbackInput !== null ? fallbackInput : input;
      }
      statuses.push({
        environmentId,
        label: labels[index] ?? presentation.entry.target.label,
        isPending: !offline && result.waiting,
        error:
          !offline && result._tag === "Failure" ? "This environment could not report usage." : null,
        readByDay,
        offline,
        savedAt: offline ? (summary?.readAt ?? null) : null,
        window,
        summary,
        needsCursorKeychainAccess: needsCursorKeychainAccess(
          summary,
          get(serverEnvironment.providersValueAtom(environmentId)),
        ),
      });
    }
    return statuses;
  }).pipe(Atom.withLabel(`web-usage:window:${windowKey}`)),
);

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  /** True until at least one selected environment has answered. */
  readonly isPending: boolean;
  /**
   * True while environments that have not failed are still answering. Failed
   * environments are reported through their own error rows: totals will not
   * improve by waiting on them, so they must not read as "still reporting".
   */
  readonly isPartial: boolean;
  readonly refresh: (input?: UsageSummaryInput) => Promise<void>;
}

/**
 * Merges every environment that has answered. `keepBucket` narrows the merge,
 * for example to one model; source ownership still applies, so the result
 * matches that slice of the full merge. Session counts are per directory and
 * are not narrowed.
 */
export function mergeAnsweredUsage(
  environments: readonly EnvironmentUsageStatus[],
  keepBucket?: (bucket: UsageBucket) => boolean,
): MergedUsage {
  const answered: EnvironmentUsage[] = environments.flatMap(({ environmentId, label, summary }) =>
    summary === null ? [] : [{ environmentId, label, summary }],
  );
  return mergeUsage(answered, USAGE_CONTRACT_VERSION, keepBucket);
}

/** `input` null reads nothing and reports no environments. */
export function useUsage(
  input: UsageSummaryInput | null,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
): UsageView {
  // A string key, so a fresh but equal window object reuses the same query.
  const windowKey =
    input === null
      ? "null"
      : JSON.stringify({
          sinceDay: input.sinceDay,
          untilDay: input.untilDay,
          timeZone: input.timeZone,
          resolution: input.resolution,
          sinceTime: input.sinceTime,
          untilTime: input.untilTime,
          groupByThread: input.groupByThread,
        });
  const atom = usageByWindowAtom(windowKey);
  const environments = useAtomValue(atom);
  const selectedEnvironments = useMemo(
    () =>
      selectedEnvironmentIds === null
        ? environments
        : environments.filter((environment) =>
            selectedEnvironmentIds.has(environment.environmentId),
          ),
    [environments, selectedEnvironmentIds],
  );

  const refresh = useCallback(
    async (nextInput?: UsageSummaryInput) => {
      const target = nextInput ?? (JSON.parse(windowKey) as UsageSummaryInput | null);
      if (target === null) return;
      await refreshUsage({
        registry: appAtomRegistry,
        server: serverEnvironment,
        presentations: environmentPresentations,
        environmentIds: selectedEnvironments.map(({ environmentId }) => environmentId),
        input: target,
      });
    },
    [selectedEnvironments, windowKey],
  );

  // Keep each live read, so an environment's usage still shows while it is offline.
  useEffect(() => {
    for (const status of environments) {
      if (status.offline || status.isPending || status.summary === null) continue;
      const key = `${status.environmentId}\u0000${JSON.stringify(status.window)}`;
      if (lastSavedRead.get(key) === status.summary.readAt) continue;
      lastSavedRead.set(key, status.summary.readAt);
      void saveUsage(status.environmentId, { input: status.window, summary: status.summary }).then(
        () => appAtomRegistry.refresh(savedUsageAtom(status.environmentId)),
      );
    }
  }, [environments]);

  const merged = useMemo(() => mergeAnsweredUsage(selectedEnvironments), [selectedEnvironments]);

  const answeredCount = selectedEnvironments.filter(
    (environment) => environment.summary !== null,
  ).length;
  const stillReporting = selectedEnvironments.filter(
    (environment) =>
      environment.summary === null && environment.error === null && !environment.offline,
  ).length;

  return {
    merged,
    environments,
    selectedEnvironments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}
