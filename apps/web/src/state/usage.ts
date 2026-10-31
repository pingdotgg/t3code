import { useAtomValue } from "@effect/atom-react";
import {
  AuthDiagnosticsReadScope,
  sessionGrantsScope,
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageBucket,
  type UsageSummary,
  type UsageProviderKind,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import { needsCursorKeychainAccess, refreshUsage } from "@t3tools/client-runtime/state/usage";
import { resolveUsageAccess } from "@t3tools/client-runtime/state/usage-access";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import {
  isCompatibleUsageContractVersion,
  mergeUsage,
  type EnvironmentUsage,
  type MergedUsage,
} from "@t3tools/shared/usageMerge";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import {
  loadSavedUsage,
  onSavedUsageChange,
  pickSavedUsage,
  saveUsage,
  trimSavedUsage,
} from "./savedUsage";
import { serverEnvironment } from "./server";
import { environmentSession, readEnvironmentScope } from "./session";

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly canReadDiagnostics: boolean;
  readonly isConnected: boolean;
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

onSavedUsageChange((environmentId, cleared) => {
  appAtomRegistry.refresh(savedUsageAtom(environmentId));
  if (!cleared) return;
  for (const key of lastSavedRead.keys()) {
    if (key.startsWith(`${environmentId}\u0000`)) lastSavedRead.delete(key);
  }
});

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
      const label = labels[index] ?? presentation.entry.target.label;
      const offline = UNREACHABLE.has(presentation.connection.phase);
      const isConnected = presentation.connection.phase === "connected";
      const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
      const session = AsyncResult.getOrElse(sessionResult, () => null);
      const access = resolveUsageAccess({
        connectionPhase: presentation.connection.phase,
        session,
        hasSessionError: sessionResult._tag === "Failure",
      });
      // A connected environment this connection may not read reports why.
      // Offline, saved usage still shows unless the known session denies it.
      const denied = offline
        ? session !== null && !sessionGrantsScope(session, AuthDiagnosticsReadScope)
        : !access.canReadDiagnostics;
      if (denied) {
        statuses.push({
          environmentId,
          label,
          isConnected,
          ...access,
          readByDay: false,
          offline: false,
          savedAt: null,
          window: input,
          summary: null,
          needsCursorKeychainAccess: false,
        });
        continue;
      }
      let window = input;
      let result = get(serverEnvironment.usageSummary({ environmentId, input }));
      let readByDay = false;
      if (fallbackInput !== null && isRejectedWindow(result)) {
        window = fallbackInput;
        result = get(serverEnvironment.usageSummary({ environmentId, input: fallbackInput }));
        readByDay = true;
      }
      let summary = AsyncResult.getOrElse(result, () => null);
      // Offline, the page keeps what this session read last, or else what
      // this browser saved the last time the environment answered.
      if (summary === null && offline) {
        const saved = Option.getOrElse(
          AsyncResult.value(get(savedUsageAtom(environmentId))),
          () => [],
        );
        summary = pickSavedUsage(saved, input);
        // A server that answered this span only by day saved it by day.
        if (summary === null && fallbackInput !== null) {
          summary = pickSavedUsage(saved, fallbackInput);
          if (summary !== null) {
            readByDay = true;
            window = fallbackInput;
          }
        }
      }
      statuses.push({
        environmentId,
        label,
        isPending: !offline && result.waiting,
        canReadDiagnostics: true,
        isConnected,
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
  readonly isPending: boolean;
  readonly shown: { readonly window: UsageSummaryInput; readonly merged: MergedUsage } | null;
  readonly isPartial: boolean;
  readonly refresh: (input?: UsageSummaryInput) => Promise<void>;
}

/** Claim live and offline history folders before filtering buckets, so slices match full totals. */
export function mergeAnsweredUsage(
  environments: readonly EnvironmentUsageStatus[],
  keepBucket?: (bucket: UsageBucket) => boolean,
): MergedUsage {
  const answered: EnvironmentUsage[] = [...answeredSummaries(environments)].map(
    ([environment, summary]) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      summary,
    }),
  );
  return mergeUsage(answered, USAGE_CONTRACT_VERSION, keepBucket);
}

const NO_HIDDEN_PROVIDERS: ReadonlySet<UsageProviderKind> = new Set();

function withoutProviders(
  environments: readonly EnvironmentUsageStatus[],
  hiddenProviders: ReadonlySet<UsageProviderKind>,
): readonly EnvironmentUsageStatus[] {
  if (hiddenProviders.size === 0) return environments;
  return environments.map((environment) =>
    environment.summary === null
      ? environment
      : {
          ...environment,
          summary: {
            ...environment.summary,
            buckets: environment.summary.buckets.filter(
              (bucket) => !hiddenProviders.has(bucket.provider),
            ),
            sources: environment.summary.sources.filter(
              (source) => !hiddenProviders.has(source.fingerprint.provider),
            ),
          },
        },
  );
}

function deriveSelection(
  environments: readonly EnvironmentUsageStatus[],
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
  hiddenProviders: ReadonlySet<UsageProviderKind>,
) {
  const selectedEnvironments =
    selectedEnvironmentIds === null
      ? environments
      : environments.filter((environment) => selectedEnvironmentIds.has(environment.environmentId));
  return {
    environments,
    selectedEnvironmentIds,
    hiddenProviders,
    selectedEnvironments,
    merged: mergeAnsweredUsage(withoutProviders(selectedEnvironments, hiddenProviders)),
  };
}

/**
 * Environments whose usage a comparison needs from the span before: every one
 * that answered, except an offline one whose saved usage is all counted from
 * other environments' reads.
 */
export function environmentsNeedingBaseline(
  environments: readonly EnvironmentUsageStatus[],
): readonly EnvironmentId[] {
  return [...answeredSummaries(environments)].flatMap(([environment, summary]) =>
    environment.savedAt !== null && summary.sources.length === 0 ? [] : [environment.environmentId],
  );
}

/** Comparisons wait for every contributing baseline source, including cached refreshes. */
export function baselineCoversCurrent(
  current: readonly EnvironmentUsageStatus[],
  baseline: readonly EnvironmentUsageStatus[],
): boolean {
  return (
    [...answeredSummaries(baseline).keys()].every(
      (entry) => !entry.isPending && entry.error === null,
    ) &&
    environmentsNeedingBaseline(current).every((environmentId) =>
      baseline.some(
        (entry) =>
          entry.environmentId === environmentId &&
          entry.summary !== null &&
          !entry.isPending &&
          entry.error === null,
      ),
    )
  );
}

/** Each answered environment's summary, with saved reads trimmed to the folders they keep. */
function answeredSummaries(
  environments: readonly EnvironmentUsageStatus[],
): Map<EnvironmentUsageStatus, UsageSummary> {
  // Only reads the merge will use claim their history folders.
  const usable = (summary: UsageSummary | null): summary is UsageSummary =>
    summary !== null &&
    isCompatibleUsageContractVersion(summary.contractVersion, USAGE_CONTRACT_VERSION);
  const saved = trimSavedUsage(
    environments.flatMap(({ summary, savedAt }) =>
      savedAt === null && usable(summary) ? [summary] : [],
    ),
    new Map(
      environments.flatMap(({ environmentId, summary, savedAt }) =>
        savedAt !== null && usable(summary) ? [[environmentId, summary] as const] : [],
      ),
    ),
  );
  const answered = new Map<EnvironmentUsageStatus, UsageSummary>();
  for (const environment of environments) {
    if (environment.summary === null) continue;
    answered.set(
      environment,
      environment.savedAt === null
        ? environment.summary
        : (saved.get(environment.environmentId) ?? environment.summary),
    );
  }
  return answered;
}

/** `input` null reads nothing and reports no environments. */
export function useUsage(
  input: UsageSummaryInput | null,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
  hiddenProviders: ReadonlySet<UsageProviderKind> = NO_HIDDEN_PROVIDERS,
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
  // Identity-based render sync needs a derivation retained by inputs across renders.
  const [derived, setDerived] = useState(() =>
    deriveSelection(environments, selectedEnvironmentIds, hiddenProviders),
  );
  let current = derived;
  if (
    derived.environments !== environments ||
    derived.selectedEnvironmentIds !== selectedEnvironmentIds ||
    derived.hiddenProviders !== hiddenProviders
  ) {
    current = deriveSelection(environments, selectedEnvironmentIds, hiddenProviders);
    setDerived(current);
  }
  const { selectedEnvironments, merged } = current;

  const refresh = async (nextInput?: UsageSummaryInput) => {
    const target = nextInput ?? (JSON.parse(windowKey) as UsageSummaryInput | null);
    if (target === null) return;
    await refreshUsage({
      registry: appAtomRegistry,
      server: serverEnvironment,
      presentations: environmentPresentations,
      environmentIds: selectedEnvironments
        .filter(
          (environment) =>
            environment.canReadDiagnostics &&
            readEnvironmentScope(environment.environmentId, AuthDiagnosticsReadScope),
        )
        .map(({ environmentId }) => environmentId),
      input: target,
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persist completed live summaries to offline usage storage
  useEffect(() => {
    for (const status of environments) {
      if (status.offline || status.isPending || status.summary === null) continue;
      const key = `${status.environmentId}\u0000${JSON.stringify(status.window)}`;
      if (lastSavedRead.get(key) === status.summary.readAt) continue;
      const readAt = status.summary.readAt;
      void saveUsage(status.environmentId, { input: status.window, summary: status.summary }).then(
        (saved) => {
          if (saved) lastSavedRead.set(key, readAt);
        },
      );
    }
  }, [environments]);

  const answeredCount = selectedEnvironments.filter(
    (environment) => environment.summary !== null,
  ).length;
  const stillReporting = selectedEnvironments.filter(
    (environment) =>
      environment.summary === null && environment.error === null && !environment.offline,
  ).length;
  const isPending = answeredCount === 0 && stillReporting > 0;

  const [lastAnswered, setLastAnswered] = useState<
    | (NonNullable<UsageView["shown"]> & {
        readonly selection: typeof selectedEnvironmentIds;
        readonly hidden: typeof hiddenProviders;
      })
    | null
  >(null);
  if (
    input !== null &&
    answeredCount > 0 &&
    (lastAnswered?.merged !== merged ||
      lastAnswered.window !== input ||
      lastAnswered.selection !== selectedEnvironmentIds ||
      lastAnswered.hidden !== hiddenProviders)
  ) {
    setLastAnswered({
      window: input,
      merged,
      selection: selectedEnvironmentIds,
      hidden: hiddenProviders,
    });
  }
  const kept =
    lastAnswered?.selection === selectedEnvironmentIds && lastAnswered.hidden === hiddenProviders
      ? lastAnswered
      : null;
  // With no answers, even failed ones keep the last answered usage on screen.
  // A null window reads nothing, so there is nothing to show.
  const shown =
    input === null
      ? null
      : answeredCount > 0
        ? { window: input, merged }
        : (kept ?? (isPending ? null : { window: input, merged }));

  return {
    merged,
    environments,
    selectedEnvironments,
    isPending,
    shown,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}
