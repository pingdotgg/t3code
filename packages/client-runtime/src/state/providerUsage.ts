/**
 * Derivation and formatting for provider usage meters, shared by the web and
 * mobile composers.
 *
 * The two clients draw very different things — three SVG rings on web, a
 * popover list on mobile — but they answer the same questions about the same
 * numbers, so the answers live here rather than being written twice.
 *
 * @module state/providerUsage
 */
import type { ProviderUsageWindow, ServerProvider } from "@t3tools/contracts";

/** Past this the ring turns red: the user is close enough to care. */
export const USAGE_CRITICAL_PERCENT = 90;

export const isUsageWindowCritical = (window: ProviderUsageWindow): boolean =>
  window.usedPercent > USAGE_CRITICAL_PERCENT;

/** Clamp for drawing — a provider reporting 103% still draws a full ring. */
export const clampUsagePercent = (usedPercent: number): number =>
  Number.isFinite(usedPercent) ? Math.max(0, Math.min(100, usedPercent)) : 0;

// Shared empty result. Returning a fresh `[]` would hand a new reference to
// every consumer on every provider-status push — which happens mid-turn —
// breaking the composer footer's memo and re-rendering the send button and
// context meter for providers that will never show a usage meter at all.
const NO_USAGE_WINDOWS: ReadonlyArray<ProviderUsageWindow> = [];

/**
 * The usage windows to draw for one provider instance, or an empty array
 * when the instance reports none. Callers render nothing at all for an empty
 * array — no placeholder, so switching to a provider without usage costs no
 * layout shift.
 */
export const selectProviderUsageWindows = (
  providers: ReadonlyArray<ServerProvider>,
  instanceId: string | null | undefined,
): ReadonlyArray<ProviderUsageWindow> => {
  if (!instanceId) {
    return NO_USAGE_WINDOWS;
  }
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  return provider?.usageLimits?.windows ?? NO_USAGE_WINDOWS;
};

export const selectProviderUsageUpdatedAt = (
  providers: ReadonlyArray<ServerProvider>,
  instanceId: string | null | undefined,
): string | null => {
  if (!instanceId) {
    return null;
  }
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  return provider?.usageLimits?.updatedAt ?? null;
};

/**
 * The window a single collapsed circle should show: the one closest to
 * running out. Ties keep array order, so the server's ordering decides and
 * the circle does not flicker between two equal buckets.
 */
export const pickWorstUsageWindow = (
  windows: ReadonlyArray<ProviderUsageWindow>,
): ProviderUsageWindow | null => {
  let worst: ProviderUsageWindow | null = null;
  for (const window of windows) {
    if (worst === null || window.usedPercent > worst.usedPercent) {
      worst = window;
    }
  }
  return worst;
};

/**
 * The digits inside the ring. Integer only and no `%` sign — the ring leaves
 * roughly 13px of clear space, which fits two digits and nothing more.
 */
export const formatUsageRingLabel = (usedPercent: number): string =>
  `${Math.round(clampUsagePercent(usedPercent))}`;

/** The exact figure, for popovers where there is room to be precise. */
export const formatUsagePercent = (usedPercent: number): string => {
  const clamped = clampUsagePercent(usedPercent);
  return clamped < 10 ? `${clamped.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(clamped)}%`;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Reset times inside a day read better as a countdown ("resets in 2h 15m");
 * beyond that a countdown in hours stops being meaningful and an absolute
 * time ("resets Mon 9 AM") is what someone actually plans around.
 *
 * Returns `null` for a missing or unparseable reset — callers omit the line
 * rather than inventing one.
 */
export const formatUsageResetLabel = (
  resetsAt: string | null,
  nowMs: number,
  locale?: string,
): string | null => {
  if (!resetsAt) {
    return null;
  }
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) {
    return null;
  }
  const remainingMs = resetMs - nowMs;
  if (remainingMs <= 0) {
    return "resets shortly";
  }
  // Past a couple of days a weekday alone is ambiguous — a weekly window
  // resetting in 6 days reads identically to one resetting tomorrow — so the
  // date comes along once "next Saturday" stops meaning "this Saturday".
  if (remainingMs >= 2 * DAY_MS) {
    const formatted = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(resetMs);
    return `resets ${formatted}`;
  }
  if (remainingMs >= DAY_MS) {
    const formatted = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(resetMs);
    return `resets ${formatted}`;
  }
  const hours = Math.floor(remainingMs / HOUR_MS);
  const minutes = Math.floor((remainingMs % HOUR_MS) / MINUTE_MS);
  if (hours === 0) {
    return `resets in ${Math.max(1, minutes)}m`;
  }
  return minutes === 0 ? `resets in ${hours}h` : `resets in ${hours}h ${minutes}m`;
};

/**
 * How stale the reading is. Only surfaced once it is old enough to matter —
 * a reading from the last minute is just "now" and saying so is noise.
 */
export const formatUsageUpdatedAtLabel = (
  updatedAt: string | null,
  nowMs: number,
): string | null => {
  if (!updatedAt) {
    return null;
  }
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) {
    return null;
  }
  const ageMs = nowMs - updatedMs;
  if (ageMs < MINUTE_MS) {
    return null;
  }
  if (ageMs < HOUR_MS) {
    return `as of ${Math.floor(ageMs / MINUTE_MS)}m ago`;
  }
  if (ageMs < DAY_MS) {
    return `as of ${Math.floor(ageMs / HOUR_MS)}h ago`;
  }
  return `as of ${Math.floor(ageMs / DAY_MS)}d ago`;
};
