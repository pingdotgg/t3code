import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";

export interface RawUsageWindowInput {
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt?: string;
  readonly windowDurationMins?: number;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

export function windowKindFromDuration(input: {
  readonly windowDurationMins?: number;
  readonly shortestWindowDurationMins?: number;
  readonly longestWindowDurationMins?: number;
}): ServerProviderUsageWindow["kind"] | undefined {
  const duration = input.windowDurationMins;
  if (typeof duration !== "number" || !Number.isFinite(duration)) {
    return undefined;
  }
  if (
    duration >= 10080 ||
    (duration === input.longestWindowDurationMins &&
      input.longestWindowDurationMins !== input.shortestWindowDurationMins)
  ) {
    return "weekly";
  }
  if (duration === input.shortestWindowDurationMins) {
    return "session";
  }
  return "session";
}

export function normalizeUsageWindows(
  windows: ReadonlyArray<RawUsageWindowInput>,
): ReadonlyArray<ServerProviderUsageWindow> {
  const normalizedDurations = windows
    .map((window) => window.windowDurationMins)
    .filter(
      (duration): duration is number => typeof duration === "number" && Number.isFinite(duration),
    )
    .toSorted((left, right) => left - right);
  const shortestWindowDurationMins = normalizedDurations[0];
  const longestWindowDurationMins = normalizedDurations.at(-1);

  return windows
    .flatMap((window) => {
      const kind = windowKindFromDuration({
        ...(typeof window.windowDurationMins === "number"
          ? { windowDurationMins: window.windowDurationMins }
          : {}),
        ...(typeof shortestWindowDurationMins === "number" ? { shortestWindowDurationMins } : {}),
        ...(typeof longestWindowDurationMins === "number" ? { longestWindowDurationMins } : {}),
      });
      if (!kind) {
        return [];
      }
      return [
        {
          kind,
          label: kind === "session" ? "Session" : "Weekly",
          usedPercent: clampPercent(window.usedPercent),
          ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
          ...(typeof window.windowDurationMins === "number" &&
          Number.isFinite(window.windowDurationMins)
            ? { windowDurationMins: Math.max(0, Math.round(window.windowDurationMins)) }
            : {}),
        } satisfies ServerProviderUsageWindow,
      ];
    })
    .toSorted((left, right) => {
      if (left.kind === right.kind) return 0;
      return left.kind === "session" ? -1 : 1;
    });
}

/** Account or auth shape cannot report subscription quota; refresh must clear stale bars. */
const AUTHORITATIVE_UNAVAILABLE_USAGE_REASON_PREFIX = "Usage limits unavailable for";

function isAuthoritativeUnavailableUsage(
  usageLimits: ServerProviderUsageLimits | undefined,
): boolean {
  if (!usageLimits || usageLimits.available) {
    return false;
  }
  const reason = usageLimits.reason ?? "";
  return reason.startsWith(AUTHORITATIVE_UNAVAILABLE_USAGE_REASON_PREFIX);
}

/**
 * Keep the last known available usage limits when a scheduled refresh would
 * replace them with an unavailable stub (for example when
 * `account/rateLimits/read` fails but live patches already populated quota).
 * Authoritative unavailable results, such as an API key account after auth
 * changes, replace the prior snapshot so the UI does not show stale quota bars.
 */
export function preserveAvailableUsageLimitsOnRefresh(
  previous: ServerProviderUsageLimits | undefined,
  next: ServerProviderUsageLimits | undefined,
): ServerProviderUsageLimits | undefined {
  if (next?.available) {
    return next;
  }
  if (previous?.available && !isAuthoritativeUnavailableUsage(next)) {
    return previous;
  }
  return next;
}

export function makeUnavailableUsageLimits(input: {
  readonly source: ServerProviderUsageLimits["source"];
  readonly checkedAt: string;
  readonly reason?: string;
}): ServerProviderUsageLimits {
  return {
    source: input.source,
    available: false,
    reason: input.reason ?? "Unable to fetch usage",
    windows: [],
    checkedAt: input.checkedAt,
  };
}

function sortUsageWindows(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return windows.toSorted((left, right) => {
    if (left.kind === right.kind) return 0;
    return left.kind === "session" ? -1 : 1;
  });
}

/**
 * Merge a sparse runtime usage update into an existing snapshot. Windows
 * present in `incoming` replace matching kinds from `previous`; other kinds
 * are preserved so partial Codex `account.rate-limits.updated` events do not
 * drop quota windows that were not included in the notification.
 */
export function mergeProviderUsageLimits(
  previous: ServerProviderUsageLimits | undefined,
  incoming: ServerProviderUsageLimits,
): ServerProviderUsageLimits {
  if (!incoming.available || incoming.windows.length === 0) {
    return previous ?? incoming;
  }

  if (!previous?.available || previous.windows.length === 0) {
    return incoming;
  }

  const windowsByKind = new Map(previous.windows.map((window) => [window.kind, window] as const));
  for (const window of incoming.windows) {
    windowsByKind.set(window.kind, window);
  }

  return {
    source: incoming.source,
    available: true,
    checkedAt: incoming.checkedAt,
    windows: sortUsageWindows([...windowsByKind.values()]),
  };
}

export function makeUsageLimitsSnapshot(input: {
  readonly source: ServerProviderUsageLimits["source"];
  readonly checkedAt: string;
  readonly windows: ReadonlyArray<RawUsageWindowInput>;
  readonly unavailableReason: string;
}): ServerProviderUsageLimits {
  const normalizedWindows = normalizeUsageWindows(input.windows);
  if (normalizedWindows.length === 0) {
    return makeUnavailableUsageLimits({
      source: input.source,
      checkedAt: input.checkedAt,
      reason: input.unavailableReason,
    });
  }

  return {
    source: input.source,
    available: true,
    windows: normalizedWindows,
    checkedAt: input.checkedAt,
  };
}
