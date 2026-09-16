import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

/**
 * Fold a sparse runtime update into the limits a provider currently
 * publishes. Windows upsert by `id`; a window the update omits keeps its
 * previous values, and a window that arrives without `resetsAt` or
 * `windowDurationMins` keeps whatever the last probe resolved for it. An
 * update with no windows leaves `previous` untouched.
 *
 * An update carrying windows clears an `unsupported` snapshot. A probe only
 * ever guesses at whether an account has subscription windows, and for Claude
 * Team and Enterprise accounts it guesses wrong: `get_usage` reports no limits
 * for them, yet every turn streams their real utilization. A window arriving
 * from the runtime is first-hand proof the probe was wrong, so it wins.
 */
export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (update.windows.length === 0) {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  // Codex sends this notification beside every token-usage tick, almost
  // always with unchanged numbers. Decide "nothing changed" per window on
  // the way through so the no-op case never allocates a new snapshot.
  let changed = false;
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
    };
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  if (!changed && previous !== undefined && previous.unavailable === undefined) {
    return previous;
  }
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: merged.values() }),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
  };
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins
  );
}

/**
 * The moment a window's percentage stops describing anything: its rolling
 * period rolls over and the quota it measured is gone. `resetsAt` names that
 * moment outright, and a window without one is bounded instead by how long
 * its period runs from the read that produced it. A window carrying neither
 * could be any age, so it gets no expiry.
 */
export const usageWindowExpiresAt = (
  window: ServerProviderUsageWindow,
  checkedAt: string,
): number | undefined => {
  if (window.resetsAt !== undefined) {
    const resetsAt = Date.parse(window.resetsAt);
    return Number.isNaN(resetsAt) ? undefined : resetsAt;
  }
  if (window.windowDurationMins === undefined) {
    return undefined;
  }
  const readAt = Date.parse(checkedAt);
  return Number.isNaN(readAt) ? undefined : readAt + window.windowDurationMins * 60_000;
};

/**
 * Drop windows from a preserved snapshot whose period has rolled over by
 * `asOf`. A probe carries no information for windows it did not read, so once
 * a window has expired there is nothing to hold onto: the value on screen is
 * definitely wrong, not just possibly stale. Expiry is the same calculation
 * the cache hydrates against, so a window bounded only by
 * `windowDurationMins` ages out from the `checkedAt` that recorded it rather
 * than living forever. Returns the input unchanged (same reference) when
 * nothing expired, so the "keep publishing the same object" identity checks
 * below still hold.
 */
function dropExpiredWindows(
  limits: ServerProviderUsageLimits,
  asOf: string,
): ServerProviderUsageLimits {
  const asOfMillis = Date.parse(asOf);
  if (Number.isNaN(asOfMillis)) {
    return limits;
  }
  const isLive = (window: ServerProviderUsageWindow) => {
    const expiresAt = usageWindowExpiresAt(window, limits.checkedAt);
    return expiresAt === undefined || expiresAt > asOfMillis;
  };
  if (limits.windows.every(isLive)) {
    return limits;
  }
  return { ...limits, windows: limits.windows.filter(isLive) };
}

/**
 * Choose what to publish after a status probe finishes. A probe that failed
 * this time must not wipe bars a previous probe or a turn already
 * established, so the last good snapshot stays.
 *
 * Every driver omits `usageLimits` entirely on early-return failure paths
 * (executable missing, spawn failure, timeout), and several drivers never
 * populate it at all. That omission carries no information about the
 * account's actual windows, so it is treated the same as a failed probe: the
 * last published snapshot stands.
 *
 * `unsupported` gets the same treatment once windows are on screen, but only
 * for providers that pass `keepPublishedWindowsWhenProbeUnsupported`. A probe
 * that reads windows never answers `unsupported`, so windows plus an
 * `unsupported` probe can only mean a turn reported limits the probe cannot
 * see, which is the normal state of a Claude Team or Enterprise account.
 * Letting the probe win there would blank the bars on every status refresh
 * and redraw them on the next turn. Other providers have no such quirk: a
 * Codex probe reporting `unsupported` (for example, right after switching to
 * an API-key account) is authoritative and must replace stale windows from a
 * previous account.
 *
 * Every "reuse published windows" path above still needs to age those windows
 * out: an interval probe runs whether or not a turn ever streams a fresh
 * reading, so a Claude Team/Enterprise session bar that reset an hour ago
 * must not keep showing last hour's percentage forever. A probe that read
 * limits carries its own `checkedAt`, and that timestamp is the
 * reconciliation point in preference to `asOf` (the moment the refresh
 * landed): it is the probe's own view of the account, and it keeps the
 * result deterministic. A probe that reported nothing has no such timestamp,
 * so `asOf` ages its preserved windows instead — otherwise a provider whose
 * executable went missing would show the same percentages until the process
 * restarts. Either way consecutive failures keep converging, since each
 * refresh re-checks the survivors against a later point. If every window
 * expires, there is nothing left to preserve and the probe's own result wins.
 *
 * A successful probe replaces the published windows outright, including any
 * runtime update that landed while it was running. That is a deliberate
 * trade-off: the Codex and Claude reads take a few seconds at most, the
 * probe is the fresher full read in every case except that window, and the
 * per-window epoch bookkeeping needed to reconcile the two was more code
 * than the sub-second regression it prevented. The next runtime event
 * corrects it.
 */
export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
  readonly asOf: string;
  readonly keepPublishedWindowsWhenProbeUnsupported?: boolean;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  const freshPublished =
    published && !published.unavailable
      ? dropExpiredWindows(published, probed?.checkedAt ?? input.asOf)
      : published;
  if (
    probed === undefined &&
    freshPublished &&
    !freshPublished.unavailable &&
    freshPublished.windows.length > 0
  ) {
    return freshPublished;
  }
  if (
    input.keepPublishedWindowsWhenProbeUnsupported &&
    probed?.unavailable &&
    freshPublished &&
    !freshPublished.unavailable &&
    freshPublished.windows.length > 0
  ) {
    return freshPublished;
  }
  if (
    probed?.unavailable?.reason === "probeFailed" &&
    freshPublished &&
    !freshPublished.unavailable &&
    freshPublished.windows.length > 0
  ) {
    return freshPublished;
  }
  return probed;
}
