import type { OrchestrationThreadActivity } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export interface RateLimitWindow {
  /** Label for this window, e.g. "Session (5 hrs)" or "Weekly" */
  readonly label: string;
  /** Percentage used, 0-100 */
  readonly usedPercent: number;
  /** Unix timestamp (seconds) when this window resets, or null if unknown */
  readonly resetsAt: number | null;
}

export interface ProviderUsageSnapshot {
  /** The provider name to show in the tooltip header */
  readonly providerLabel: string;
  /** Rate limit windows (e.g. session + weekly) */
  readonly windows: ReadonlyArray<RateLimitWindow>;
  /** Overall status */
  readonly status: "ok" | "warning" | "rejected";
  /** When this snapshot was last updated */
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Claude rate_limit_event normalization
//
// Real payload shape (from native event logs):
// {
//   type: "rate_limit_event",
//   rate_limit_info: {
//     status: "allowed" | "allowed_warning" | "rejected",
//     resetsAt: 1776582000,           // camelCase, unix seconds
//     rateLimitType: "five_hour",     // camelCase
//     overageStatus: "rejected",
//     overageDisabledReason: "...",
//     isUsingOverage: false,
//     utilization?: number,           // 0-1, may be absent
//   },
//   uuid: "...",
//   session_id: "...",
// }
// ---------------------------------------------------------------------------

const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  five_hour: "Session (5 hrs)",
  seven_day: "Weekly",
  seven_day_opus: "Weekly (Opus)",
  seven_day_sonnet: "Weekly (Sonnet)",
  overage: "Overage",
};

function normalizeClaudeRateLimitEvent(
  payload: Record<string, unknown>,
): Omit<ProviderUsageSnapshot, "updatedAt"> | null {
  const info = asRecord(payload.rate_limit_info) ?? asRecord(payload);
  if (!info) {
    return null;
  }

  // The SDK may use camelCase or snake_case depending on version.
  const rateLimitType =
    asString(info.rateLimitType) ?? asString(info.rate_limit_type);
  const statusRaw = asString(info.status);
  const resetsAt =
    asFiniteNumber(info.resetsAt) ?? asFiniteNumber(info.resets_at);

  // utilization (0-1) may or may not be present.
  const utilization = asFiniteNumber(info.utilization);

  const label = (rateLimitType && CLAUDE_WINDOW_LABELS[rateLimitType]) ?? "Session";

  const windows: RateLimitWindow[] = [];

  if (utilization !== null) {
    // We have a utilization value — use it directly.
    windows.push({
      label,
      usedPercent: Math.min(100, Math.max(0, utilization * 100)),
      resetsAt,
    });
  } else if (rateLimitType || resetsAt !== null) {
    // No utilization, but we still know which window and its reset time.
    // Show a placeholder — the status field tells us whether we're OK or not.
    const estimatedPercent =
      statusRaw === "rejected"
        ? 100
        : statusRaw === "allowed_warning"
          ? 80
          : 0;
    windows.push({
      label,
      usedPercent: estimatedPercent,
      resetsAt,
    });
  }

  if (windows.length === 0) {
    return null;
  }

  const status: ProviderUsageSnapshot["status"] =
    statusRaw === "rejected"
      ? "rejected"
      : statusRaw === "allowed_warning"
        ? "warning"
        : "ok";

  return {
    providerLabel: "Claude",
    windows,
    status,
  };
}

// ---------------------------------------------------------------------------
// Codex rate limit normalization
//
// Real payload shape (from native event logs):
// The activity payload is the full rateLimits object. Due to adapter nesting,
// it may arrive as:
//   { rateLimits: { limitId, primary: {...}, secondary: {...}, ... } }
// or directly as:
//   { limitId, primary: {...}, secondary: {...}, ... }
// We handle both.
//
// primary/secondary shape:
//   { usedPercent: 1, windowDurationMins: 300, resetsAt: 1776587601 }
// ---------------------------------------------------------------------------

function normalizeCodexRateLimits(
  payload: Record<string, unknown>,
): Omit<ProviderUsageSnapshot, "updatedAt"> | null {
  // Handle double-nesting: payload might be { rateLimits: { primary, ... } }
  let data = payload;
  if (!data.primary && !data.secondary) {
    const nested = asRecord(data.rateLimits);
    if (nested) {
      data = nested;
    }
  }

  const primary = asRecord(data.primary);
  const secondary = asRecord(data.secondary);

  if (!primary && !secondary) {
    return null;
  }

  const windows: RateLimitWindow[] = [];

  if (primary) {
    const usedPercent = asFiniteNumber(primary.usedPercent);
    if (usedPercent !== null) {
      const durationMins = asFiniteNumber(primary.windowDurationMins);
      let label = "Session";
      if (durationMins !== null) {
        const hours = Math.round(durationMins / 60);
        label = hours > 0 ? `Session (${hours} hrs)` : `Session (${durationMins} min)`;
      }
      windows.push({
        label,
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        resetsAt: asFiniteNumber(primary.resetsAt),
      });
    }
  }

  if (secondary) {
    const usedPercent = asFiniteNumber(secondary.usedPercent);
    if (usedPercent !== null) {
      const durationMins = asFiniteNumber(secondary.windowDurationMins);
      let label = "Weekly";
      if (durationMins !== null) {
        const days = Math.round(durationMins / (60 * 24));
        if (days >= 2) {
          label = `Weekly`;
        }
      }
      windows.push({
        label,
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        resetsAt: asFiniteNumber(secondary.resetsAt),
      });
    }
  }

  if (windows.length === 0) {
    return null;
  }

  const maxPercent = Math.max(...windows.map((w) => w.usedPercent));
  const status: ProviderUsageSnapshot["status"] =
    maxPercent >= 100 ? "rejected" : maxPercent >= 80 ? "warning" : "ok";

  return {
    providerLabel: "Codex",
    windows,
    status,
  };
}

// ---------------------------------------------------------------------------
// Detect provider and normalize
// ---------------------------------------------------------------------------

function normalizeRateLimitPayload(
  payload: unknown,
): Omit<ProviderUsageSnapshot, "updatedAt"> | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  // Claude: has rate_limit_info or type === "rate_limit_event"
  if (record.rate_limit_info || record.type === "rate_limit_event") {
    return normalizeClaudeRateLimitEvent(record);
  }

  // Codex: has primary/secondary windows (possibly nested under rateLimits)
  if (record.primary || record.secondary) {
    return normalizeCodexRateLimits(record);
  }

  // Codex double-nested: { rateLimits: { primary, secondary, ... } }
  const nested = asRecord(record.rateLimits);
  if (nested && (nested.primary || nested.secondary || nested.limitId !== undefined)) {
    return normalizeCodexRateLimits(record);
  }

  // Unknown format — try Claude-style (flat fields with rateLimitType or utilization)
  if (
    asFiniteNumber(record.utilization) !== null ||
    asString(record.rateLimitType) !== null ||
    asString(record.rate_limit_type) !== null
  ) {
    return normalizeClaudeRateLimitEvent(record);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derives a merged provider usage snapshot from the activity stream.
 *
 * Claude emits one `rate_limit_event` per rate-limit window (e.g. a `five_hour`
 * event and a separate `seven_day` event), so we merge the most recent event
 * for each distinct window label into a single snapshot.  Codex emits both
 * primary and secondary in a single event, so merging is a no-op for it.
 */
export function deriveLatestProviderUsageSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ProviderUsageSnapshot | null {
  const windowsByLabel = new Map<string, RateLimitWindow>();
  let providerLabel: string | null = null;
  let latestStatus: ProviderUsageSnapshot["status"] = "ok";
  let latestUpdatedAt: string | null = null;

  // Walk backwards so the first match for each label wins (most recent).
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "account.rate-limits.updated") {
      continue;
    }

    const result = normalizeRateLimitPayload(activity.payload);
    if (!result) {
      continue;
    }

    if (providerLabel === null) {
      providerLabel = result.providerLabel;
      latestStatus = result.status;
      latestUpdatedAt = activity.createdAt;
    }

    // Only merge events from the same provider.
    if (result.providerLabel !== providerLabel) {
      continue;
    }

    for (const window of result.windows) {
      if (!windowsByLabel.has(window.label)) {
        windowsByLabel.set(window.label, window);
      }
    }

    // Escalate status if a worse status was seen in an older event.
    if (result.status === "rejected") {
      latestStatus = "rejected";
    } else if (result.status === "warning" && latestStatus === "ok") {
      latestStatus = "warning";
    }
  }

  if (providerLabel === null || windowsByLabel.size === 0 || latestUpdatedAt === null) {
    return null;
  }

  return {
    providerLabel,
    windows: Array.from(windowsByLabel.values()),
    status: latestStatus,
    updatedAt: latestUpdatedAt,
  };
}
