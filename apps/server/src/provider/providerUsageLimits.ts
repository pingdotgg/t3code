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

export function toIsoDateTimeFromUnixSeconds(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
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
  return undefined;
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
