import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export type UsageLimitStatus = "ok" | "warning" | "limited";

export interface UsageLimitWindow {
  readonly id: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly windowDurationMins: number | null;
  readonly updatedAt: string;
}

export interface UsageLimitsSnapshot {
  readonly provider: string | null;
  readonly status: UsageLimitStatus;
  readonly windows: ReadonlyArray<UsageLimitWindow>;
  readonly planType: string | null;
  readonly credits: {
    readonly hasCredits: boolean;
    readonly unlimited: boolean;
    readonly balance: string | null;
  } | null;
  readonly overage: {
    readonly status: UsageLimitStatus;
    readonly inUse: boolean;
    readonly resetsAt: string | null;
    readonly disabledReason: string | null;
  } | null;
  readonly spendLimit: {
    readonly used: string;
    readonly limit: string;
    readonly remainingPercent: number;
    readonly resetsAt: string | null;
  } | null;
  readonly limitReason: string | null;
  readonly updatedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asStatus(value: unknown): UsageLimitStatus | null {
  return value === "ok" || value === "warning" || value === "limited" ? value : null;
}

function readWindows(value: unknown, updatedAt: string): UsageLimitWindow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const windows: UsageLimitWindow[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const id = asString(record?.id);
    const usedPercent = asFiniteNumber(record?.usedPercent);
    if (!record || !id || usedPercent === null) {
      continue;
    }
    windows.push({
      id,
      usedPercent: Math.max(0, Math.min(100, usedPercent)),
      resetsAt: asString(record.resetsAt),
      windowDurationMins: asFiniteNumber(record.windowDurationMins),
      updatedAt,
    });
  }
  return windows;
}

/**
 * Newest usage-limit state for a thread. The newest row wins for status and
 * account context; windows it does not carry are filled in from older rows of
 * the same provider, because Claude reports one window per event.
 */
export function deriveLatestUsageLimitsSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): UsageLimitsSnapshot | null {
  let snapshot: UsageLimitsSnapshot | null = null;
  const windows = new Map<string, UsageLimitWindow>();

  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "usage-limits.updated") {
      continue;
    }
    const payload = asRecord(activity.payload);
    const status = asStatus(payload?.status);
    if (!payload || !status) {
      continue;
    }
    const provider = asString(payload.provider);
    if (snapshot && snapshot.provider !== provider) {
      continue;
    }

    for (const window of readWindows(payload.windows, activity.createdAt)) {
      if (!windows.has(window.id)) {
        windows.set(window.id, window);
      }
    }

    if (snapshot) {
      continue;
    }

    const credits = asRecord(payload.credits);
    const overage = asRecord(payload.overage);
    const overageStatus = asStatus(overage?.status);
    const spendLimit = asRecord(payload.spendLimit);
    const spendLimitRemaining = asFiniteNumber(spendLimit?.remainingPercent);
    snapshot = {
      provider,
      status,
      windows: [],
      planType: asString(payload.planType),
      credits:
        credits && typeof credits.hasCredits === "boolean"
          ? {
              hasCredits: credits.hasCredits,
              unlimited: credits.unlimited === true,
              balance: asString(credits.balance),
            }
          : null,
      overage:
        overage && overageStatus
          ? {
              status: overageStatus,
              inUse: overage.inUse === true,
              resetsAt: asString(overage.resetsAt),
              disabledReason: asString(overage.disabledReason),
            }
          : null,
      spendLimit:
        spendLimit && spendLimitRemaining !== null
          ? {
              used: asString(spendLimit.used) ?? "0",
              limit: asString(spendLimit.limit) ?? "0",
              remainingPercent: Math.max(0, Math.min(100, spendLimitRemaining)),
              resetsAt: asString(spendLimit.resetsAt),
            }
          : null,
      limitReason: asString(payload.limitReason),
      updatedAt: activity.createdAt,
    };
  }

  if (!snapshot) {
    return null;
  }
  return { ...snapshot, windows: sortUsageLimitWindows([...windows.values()]) };
}

const WINDOW_ORDER: Record<string, number> = {
  five_hour: 0,
  primary: 0,
  seven_day: 1,
  secondary: 1,
  seven_day_sonnet: 2,
  seven_day_opus: 3,
};

function sortUsageLimitWindows(windows: UsageLimitWindow[]): UsageLimitWindow[] {
  return windows.sort((left, right) => {
    const leftOrder = WINDOW_ORDER[left.id] ?? left.windowDurationMins ?? Number.MAX_SAFE_INTEGER;
    const rightOrder =
      WINDOW_ORDER[right.id] ?? right.windowDurationMins ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.id.localeCompare(right.id);
  });
}

/** True when the provider's reset instant has already passed, so the reported figure is stale. */
export function isUsageLimitWindowExpired(window: UsageLimitWindow, nowMs: number): boolean {
  if (!window.resetsAt) {
    return false;
  }
  const resetMs = Date.parse(window.resetsAt);
  return Number.isFinite(resetMs) && resetMs <= nowMs;
}

/** The window the composer glyph summarises: the most-used one that has not reset. */
export function selectHeadlineUsageLimitWindow(
  snapshot: UsageLimitsSnapshot,
  nowMs: number,
): UsageLimitWindow | null {
  let headline: UsageLimitWindow | null = null;
  for (const window of snapshot.windows) {
    if (isUsageLimitWindowExpired(window, nowMs)) {
      continue;
    }
    if (!headline || window.usedPercent > headline.usedPercent) {
      headline = window;
    }
  }
  return headline;
}

function formatDurationLabel(durationMins: number): string {
  if (durationMins % (24 * 60) === 0) {
    const days = durationMins / (24 * 60);
    return days === 7 ? "Weekly" : days === 1 ? "Daily" : `${days}-day`;
  }
  if (durationMins % 60 === 0) {
    return `${durationMins / 60}-hour`;
  }
  return `${durationMins}-minute`;
}

export function formatUsageLimitWindowLabel(window: UsageLimitWindow): string {
  switch (window.id) {
    case "five_hour":
      return "Session";
    case "seven_day":
      return "Weekly";
    case "seven_day_opus":
      return "Weekly (Opus)";
    case "seven_day_sonnet":
      return "Weekly (Sonnet)";
    default:
      break;
  }
  if (window.windowDurationMins !== null && window.windowDurationMins > 0) {
    if (window.windowDurationMins === 5 * 60) {
      return "Session";
    }
    return formatDurationLabel(window.windowDurationMins);
  }
  return window.id === "primary" ? "Session" : window.id === "secondary" ? "Weekly" : window.id;
}

export function formatUsageLimitPercent(value: number): string {
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

/** "Resets in 2h 10m" style label; "Resets soon" once the instant has passed. */
export function formatUsageLimitResetLabel(resetsAt: string | null, nowMs: number): string | null {
  if (!resetsAt) {
    return null;
  }
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) {
    return null;
  }
  const diffMinutes = Math.ceil((resetMs - nowMs) / 60_000);
  if (diffMinutes <= 0) {
    return "Resets soon";
  }
  if (diffMinutes < 60) {
    return `Resets in ${diffMinutes}m`;
  }
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  if (hours < 24) {
    return minutes > 0 ? `Resets in ${hours}h ${minutes}m` : `Resets in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `Resets in ${days}d ${remainingHours}h` : `Resets in ${days}d`;
}

export function formatUsageLimitReason(reason: string | null): string | null {
  switch (reason) {
    case null:
      return null;
    case "rate_limit_reached":
      return "Usage limit reached";
    case "spend_control_reached":
      return "Spend limit reached";
    case "workspace_owner_credits_depleted":
    case "workspace_member_credits_depleted":
      return "Workspace credits depleted";
    case "workspace_owner_usage_limit_reached":
    case "workspace_member_usage_limit_reached":
      return "Workspace usage limit reached";
    default:
      return reason.replace(/_/g, " ");
  }
}

export function formatUsageLimitPlanType(planType: string | null): string | null {
  switch (planType) {
    case null:
    case "unknown":
      return null;
    case "self_serve_business_usage_based":
      return "Business (usage-based)";
    case "enterprise_cbp_usage_based":
      return "Enterprise (usage-based)";
    case "prolite":
      return "Pro Lite";
    case "edu":
      return "Education";
    default:
      return planType.charAt(0).toUpperCase() + planType.slice(1);
  }
}
