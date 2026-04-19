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
  // Claude SDK sends: { type: "rate_limit_event", rate_limit_info: { ... }, ... }
  const info = asRecord(payload.rate_limit_info) ?? asRecord(payload);
  if (!info) {
    return null;
  }

  const utilization = asFiniteNumber(info.utilization);
  if (utilization === null) {
    return null;
  }

  const rateLimitType = asString(info.rate_limit_type);
  const statusRaw = asString(info.status);

  const windows: RateLimitWindow[] = [];

  windows.push({
    label: (rateLimitType && CLAUDE_WINDOW_LABELS[rateLimitType]) ?? "Session",
    usedPercent: Math.min(100, Math.max(0, utilization * 100)),
    resetsAt: asFiniteNumber(info.resets_at),
  });

  const status: ProviderUsageSnapshot["status"] =
    statusRaw === "rejected" ? "rejected" : statusRaw === "allowed_warning" ? "warning" : "ok";

  return {
    providerLabel: "Claude",
    windows,
    status,
  };
}

// ---------------------------------------------------------------------------
// Codex rate limit normalization
// ---------------------------------------------------------------------------

function normalizeCodexRateLimits(
  payload: Record<string, unknown>,
): Omit<ProviderUsageSnapshot, "updatedAt"> | null {
  // Codex sends: { primary: { usedPercent, windowDurationMins, resetsAt }, secondary: ..., ... }
  const primary = asRecord(payload.primary);
  const secondary = asRecord(payload.secondary);

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

  // Codex: has primary/secondary windows
  if (record.primary || record.secondary) {
    return normalizeCodexRateLimits(record);
  }

  // Unknown format — try Claude-style (flat utilization field)
  if (asFiniteNumber(record.utilization) !== null) {
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
