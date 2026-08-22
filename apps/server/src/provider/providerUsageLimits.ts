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
      const trimmedLabel = window.label.trim();
      const defaultLabel = kind === "session" ? "Session" : "Weekly";
      return [
        {
          kind,
          label: trimmedLabel.length > 0 ? trimmedLabel : defaultLabel,
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

/**
 * Fold a rolling usage update into the windows already on a snapshot.
 *
 * Both runtime sources emit *sparse* updates — Claude's `rate_limit_event`
 * carries one window at a time and Codex documents its notification as a
 * partial to merge into the last full read — so an update must upsert by kind
 * rather than replace the array, and must keep the previous `resetsAt` /
 * `windowDurationMins` when the update omits them. Otherwise a percent-only
 * event would drop the reset timestamp a probe had already resolved.
 */
export function mergeUsageLimitWindows(
  previous: ReadonlyArray<ServerProviderUsageWindow>,
  incoming: ReadonlyArray<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  const merged = new Map(previous.map((window) => [window.kind, window] as const));
  for (const window of incoming) {
    const existing = merged.get(window.kind);
    merged.set(window.kind, {
      ...window,
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
    });
  }
  return [...merged.values()].toSorted((left, right) => {
    if (left.kind === right.kind) return 0;
    return left.kind === "session" ? -1 : 1;
  });
}

/**
 * Apply a runtime usage update to whatever snapshot the provider currently
 * publishes. Returns `previous` untouched when the update carries no usable
 * window: a rolling event that parses to nothing must never clear bars that a
 * probe already established.
 */
export function applyRuntimeUsageLimits(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly source: ServerProviderUsageLimits["source"];
  readonly checkedAt: string;
  readonly windows: ReadonlyArray<RawUsageWindowInput>;
}): ServerProviderUsageLimits | undefined {
  const incoming = normalizeUsageWindows(input.windows);
  if (incoming.length === 0) {
    return input.previous;
  }

  const previousWindows =
    input.previous?.available === true ? input.previous.windows : ([] as const);
  return {
    source: input.source,
    available: true,
    windows: mergeUsageLimitWindows(previousWindows, incoming),
    checkedAt: input.checkedAt,
  };
}

/**
 * API-key accounts cannot report subscription windows. That unavailable
 * snapshot must replace previously available bars (a user who switched off a
 * subscription), unlike a timed-out `/usage` probe which should keep the last
 * good snapshot.
 */
function isAuthoritativeUsageUnavailable(limits: ServerProviderUsageLimits | undefined): boolean {
  return limits?.available === false && /\bAPI key\b/i.test(limits.reason ?? "");
}

/**
 * Choose usage limits after a status probe finishes.
 *
 * Live `account.rate-limits.updated` patches land on the published snapshot
 * while `checkProvider` is still running. The probe's `checkedAt` is stamped
 * when it completes, so it always looks newer than those patches. If a live
 * write happened during the wait, fold only its patched windows on top of the
 * probe. A probe that comes back unavailable must not wipe bars a previous
 * probe or live event already established, unless the account itself cannot
 * have usage (API key).
 */
export function resolveUsageLimitsAfterRefresh(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
  readonly livePatchedWindows: ReadonlyArray<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits | undefined {
  const { published, probed, livePatchedWindows } = input;
  if (isAuthoritativeUsageUnavailable(probed)) {
    return probed;
  }
  if (published?.available === true && probed?.available !== true) {
    return published;
  }
  if (
    livePatchedWindows.length > 0 &&
    published?.available === true &&
    probed?.available === true
  ) {
    return {
      source: published.source,
      available: true,
      checkedAt: published.checkedAt,
      windows: mergeUsageLimitWindows(probed.windows, livePatchedWindows),
    };
  }
  return probed;
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
