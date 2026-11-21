import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";

export const UNAVAILABLE_DASH = "–";

export interface UsageSegment {
  readonly key: string;
  readonly text: string;
  /** What a hover shows: the window's full name, or why the limits are unavailable. */
  readonly title: string;
}

export interface ProviderUsage {
  readonly instanceId: string;
  readonly driver: string;
  readonly name: string;
  readonly segments: ReadonlyArray<UsageSegment>;
}

const KIND_ORDER = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
} as const satisfies Record<ServerProviderUsageWindow["kind"], number>;

/** The engine labels a model window `Weekly · Fable`. */
function modelName(window: ServerProviderUsageWindow): string | undefined {
  const separator = window.label.lastIndexOf("·");
  return separator >= 0 ? window.label.slice(separator + 1).trim() : undefined;
}

/** Time to reset: `5d 22h`, `3h 12m`, or minutes under an hour. */
export function formatReset(resetsAt: string, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((Date.parse(resetsAt) - nowMs) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** Session before weekly before the rest, then model windows last. */
export function orderWindows(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  const rank = (window: ServerProviderUsageWindow) =>
    (modelName(window) === undefined ? 0 : 10) + KIND_ORDER[window.kind];
  return windows.toSorted((left, right) => rank(left) - rank(right));
}

export function formatWindow(window: ServerProviderUsageWindow, nowMs: number): UsageSegment {
  const percent = `${Math.round(window.usedPercent)}%`;
  const model = modelName(window);
  const trailing =
    model ?? (window.resetsAt === undefined ? undefined : formatReset(window.resetsAt, nowMs));
  return {
    key: window.id,
    text: trailing === undefined ? percent : `${percent} ${trailing}`,
    title: window.label,
  };
}

const unavailable = (key: string, reason: string): ReadonlyArray<UsageSegment> => [
  { key, text: UNAVAILABLE_DASH, title: reason },
];

function segmentsFor(provider: ServerProvider, nowMs: number): ReadonlyArray<UsageSegment> {
  const limits = provider.usageLimits;
  if (limits === undefined) {
    return unavailable(
      "signed-out",
      provider.message ?? "Signed out, so there are no usage limits.",
    );
  }
  if (limits.unavailable !== undefined) {
    return unavailable(
      "unavailable",
      limits.unavailable.message ??
        (limits.unavailable.reason === "unsupported"
          ? "This account has no usage limits to read."
          : "The last attempt to read usage limits failed."),
    );
  }
  if (limits.windows.length === 0) {
    return unavailable("no-windows", "This account reports no usage windows.");
  }
  return orderWindows(limits.windows).map((window) => formatWindow(window, nowMs));
}

/**
 * One section per installed Claude Code instance that reports limits, or is signed out and so shows a dash.
 * A signed-in instance with no limits at all, such as one that cannot report them, has no section.
 */
export function describeUsage(
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
): ReadonlyArray<ProviderUsage> {
  return providers
    .filter(
      (provider) =>
        provider.driver === "claudeAgent" &&
        provider.enabled &&
        provider.installed &&
        (provider.usageLimits !== undefined || provider.auth.status === "unauthenticated"),
    )
    .map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      name: provider.displayName ?? provider.driver,
      segments: segmentsFor(provider, nowMs),
    }));
}
