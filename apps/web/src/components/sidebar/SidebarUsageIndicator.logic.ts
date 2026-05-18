import {
  ProviderDriverKind,
  type OrchestrationThreadActivity,
  type ProviderInstanceId,
} from "@t3tools/contracts";

export type SidebarUsageDriverId = "codex" | "claudeAgent";
export type SidebarUsageWindowId = "fiveHour" | "weekly";

export interface SidebarUsageProviderInstanceInput {
  readonly instanceId: ProviderInstanceId | string;
  readonly driverKind: ProviderDriverKind | string;
}

export interface SidebarUsageThreadInput {
  readonly id: string;
  readonly title: string;
  readonly modelSelectionInstanceId: ProviderInstanceId | string;
  readonly sessionProvider?: ProviderDriverKind | string | null | undefined;
  readonly sessionProviderInstanceId?: ProviderInstanceId | string | null | undefined;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

export interface SidebarUsageWindow {
  readonly id: SidebarUsageWindowId;
  readonly label: string;
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly resetsAtMs: number | null;
  readonly status: string | null;
  readonly updatedAt: string;
}

export type SidebarUsageWindowMap = {
  readonly [Key in SidebarUsageWindowId]: SidebarUsageWindow | null;
};

export interface SidebarUsageProviderRow {
  readonly driverId: SidebarUsageDriverId;
  readonly driverKind: ProviderDriverKind;
  readonly label: string;
  readonly windows: SidebarUsageWindowMap;
  readonly updatedAt: string | null;
  readonly threadId: string | null;
  readonly threadTitle: string | null;
}

export interface SidebarUsageSummary {
  readonly row: SidebarUsageProviderRow;
  readonly window: SidebarUsageWindow;
}

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

export const SIDEBAR_USAGE_PROVIDER_ROWS: ReadonlyArray<{
  readonly driverId: SidebarUsageDriverId;
  readonly driverKind: ProviderDriverKind;
  readonly label: string;
}> = [
  {
    driverId: "codex",
    driverKind: CODEX_DRIVER_KIND,
    label: "Codex",
  },
  {
    driverId: "claudeAgent",
    driverKind: CLAUDE_DRIVER_KIND,
    label: "Claude",
  },
];

const WINDOW_LABELS = {
  fiveHour: "5h",
  weekly: "Week",
} as const satisfies Record<SidebarUsageWindowId, string>;
const SIDEBAR_USAGE_RESET_STALE_GRACE_MS = 2 * 60 * 1000;

function emptyWindows(): Record<SidebarUsageWindowId, SidebarUsageWindow | null> {
  return {
    fiveHour: null,
    weekly: null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(record: Record<string, unknown>, keys: ReadonlyArray<string>): number | null {
  for (const key of keys) {
    const parsed = asFiniteNumber(record[key]);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function readString(record: Record<string, unknown>, keys: ReadonlyArray<string>): string | null {
  for (const key of keys) {
    const parsed = asString(record[key]);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function normalizePercent(value: unknown, options?: { readonly allowUnitFraction?: boolean }) {
  const parsed = asFiniteNumber(value);
  if (parsed === null) {
    return null;
  }
  const percent =
    options?.allowUnitFraction === true && parsed >= 0 && parsed <= 1 ? parsed * 100 : parsed;
  return Math.max(0, Math.min(100, percent));
}

function toTimestampMs(value: unknown): number | null {
  const numeric = asFiniteNumber(value);
  if (numeric !== null) {
    if (numeric <= 0) {
      return null;
    }
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }

  const text = asString(value);
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function windowIdFromDurationMins(durationMins: number | null): SidebarUsageWindowId | null {
  if (durationMins === null) {
    return null;
  }
  if (durationMins > 0 && durationMins <= 5 * 60) {
    return "fiveHour";
  }
  if (durationMins >= 6 * 24 * 60) {
    return "weekly";
  }
  return null;
}

function windowIdFromClaudeType(rateLimitType: string | null): SidebarUsageWindowId | null {
  switch (rateLimitType) {
    case "five_hour":
      return "fiveHour";
    case "seven_day":
    case "seven_day_opus":
    case "seven_day_sonnet":
      return "weekly";
    default:
      return null;
  }
}

function makeWindow(input: {
  readonly id: SidebarUsageWindowId;
  readonly usedPercent: number | null;
  readonly resetsAtMs: number | null;
  readonly status: string | null;
  readonly updatedAt: string;
}): SidebarUsageWindow | null {
  if (input.usedPercent === null && input.resetsAtMs === null && input.status === null) {
    return null;
  }
  const remainingPercent =
    input.usedPercent === null ? null : Math.max(0, Math.min(100, 100 - input.usedPercent));
  return {
    id: input.id,
    label: WINDOW_LABELS[input.id],
    usedPercent: input.usedPercent,
    remainingPercent,
    resetsAtMs: input.resetsAtMs,
    status: input.status,
    updatedAt: input.updatedAt,
  };
}

function parseCodexWindow(
  windowValue: unknown,
  fallbackId: SidebarUsageWindowId,
  snapshot: Record<string, unknown>,
  updatedAt: string,
): SidebarUsageWindow | null {
  const windowRecord = asRecord(windowValue);
  if (!windowRecord) {
    return null;
  }

  const durationMins = readNumber(windowRecord, ["windowDurationMins", "window_duration_mins"]);
  const id = windowIdFromDurationMins(durationMins) ?? fallbackId;
  return makeWindow({
    id,
    usedPercent: normalizePercent(windowRecord.usedPercent ?? windowRecord.used_percent),
    resetsAtMs: toTimestampMs(windowRecord.resetsAt ?? windowRecord.resets_at),
    status: readString(snapshot, ["rateLimitReachedType", "rate_limit_reached_type"]),
    updatedAt,
  });
}

function parseClaudeWindow(
  info: Record<string, unknown>,
  updatedAt: string,
): SidebarUsageWindow | null {
  const rateLimitType = readString(info, ["rateLimitType", "rate_limit_type"]);
  const id = windowIdFromClaudeType(rateLimitType);
  if (!id) {
    return null;
  }

  return makeWindow({
    id,
    usedPercent: normalizePercent(info.utilization, { allowUnitFraction: true }),
    resetsAtMs: toTimestampMs(info.resetsAt ?? info.resets_at),
    status: readString(info, ["status"]),
    updatedAt,
  });
}

function isNewerOrMoreRelevantWindow(
  candidate: SidebarUsageWindow,
  current: SidebarUsageWindow | null,
): boolean {
  if (!current) {
    return true;
  }
  const dateComparison = candidate.updatedAt.localeCompare(current.updatedAt);
  if (dateComparison !== 0) {
    return dateComparison > 0;
  }
  if (candidate.usedPercent !== null && current.usedPercent !== null) {
    return candidate.usedPercent > current.usedPercent;
  }
  return candidate.usedPercent !== null && current.usedPercent === null;
}

function isFreshUsageWindow(window: SidebarUsageWindow, nowMs = Date.now()): boolean {
  return (
    window.resetsAtMs === null || window.resetsAtMs + SIDEBAR_USAGE_RESET_STALE_GRACE_MS >= nowMs
  );
}

function mergeWindow(
  windows: Record<SidebarUsageWindowId, SidebarUsageWindow | null>,
  candidate: SidebarUsageWindow | null,
) {
  if (!candidate || !isFreshUsageWindow(candidate)) {
    return;
  }
  if (isNewerOrMoreRelevantWindow(candidate, windows[candidate.id])) {
    windows[candidate.id] = candidate;
  }
}

function collectRateLimitWindows(
  value: unknown,
  updatedAt: string,
  visited = new WeakSet<object>(),
): ReadonlyArray<SidebarUsageWindow> {
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  if (visited.has(record)) {
    return [];
  }
  visited.add(record);

  const windows = emptyWindows();
  const rateLimitInfo = asRecord(record.rate_limit_info ?? record.rateLimitInfo);
  mergeWindow(windows, rateLimitInfo ? parseClaudeWindow(rateLimitInfo, updatedAt) : null);

  if (record.primary !== undefined || record.secondary !== undefined) {
    mergeWindow(windows, parseCodexWindow(record.primary, "fiveHour", record, updatedAt));
    mergeWindow(windows, parseCodexWindow(record.secondary, "weekly", record, updatedAt));
  }

  const nestedRateLimits = record.rateLimits ?? record.rate_limits;
  for (const window of collectRateLimitWindows(nestedRateLimits, updatedAt, visited)) {
    mergeWindow(windows, window);
  }

  const byLimitId = asRecord(record.rateLimitsByLimitId ?? record.rate_limits_by_limit_id);
  if (byLimitId) {
    for (const nested of Object.values(byLimitId)) {
      for (const window of collectRateLimitWindows(nested, updatedAt, visited)) {
        mergeWindow(windows, window);
      }
    }
  }

  return [windows.fiveHour, windows.weekly].filter(
    (window): window is SidebarUsageWindow => window !== null,
  );
}

function isSidebarUsageDriverId(value: string | null | undefined): value is SidebarUsageDriverId {
  return value === "codex" || value === "claudeAgent";
}

function resolveThreadDriverId(
  thread: SidebarUsageThreadInput,
  driverIdByInstanceId: ReadonlyMap<string, SidebarUsageDriverId>,
): SidebarUsageDriverId | null {
  const sessionInstanceDriver = thread.sessionProviderInstanceId
    ? driverIdByInstanceId.get(String(thread.sessionProviderInstanceId))
    : undefined;
  if (sessionInstanceDriver) {
    return sessionInstanceDriver;
  }

  const modelInstanceDriver = driverIdByInstanceId.get(String(thread.modelSelectionInstanceId));
  if (modelInstanceDriver) {
    return modelInstanceDriver;
  }

  const sessionProvider = thread.sessionProvider ? String(thread.sessionProvider) : null;
  if (isSidebarUsageDriverId(sessionProvider)) {
    return sessionProvider;
  }

  const modelSelectionInstanceId = String(thread.modelSelectionInstanceId);
  return isSidebarUsageDriverId(modelSelectionInstanceId) ? modelSelectionInstanceId : null;
}

function resolveActivityDriverId(
  activity: OrchestrationThreadActivity,
  thread: SidebarUsageThreadInput,
  driverIdByInstanceId: ReadonlyMap<string, SidebarUsageDriverId>,
): SidebarUsageDriverId | null {
  const payload = asRecord(activity.payload);
  const providerInstanceId = asString(payload?.providerInstanceId);
  if (providerInstanceId) {
    const providerInstanceDriverId = driverIdByInstanceId.get(providerInstanceId);
    if (providerInstanceDriverId) {
      return providerInstanceDriverId;
    }
  }

  const provider = asString(payload?.provider);
  if (isSidebarUsageDriverId(provider)) {
    return provider;
  }

  return resolveThreadDriverId(thread, driverIdByInstanceId);
}

function usageWindowScore(window: SidebarUsageWindow): number {
  if (window.usedPercent !== null) {
    return window.usedPercent;
  }
  switch (window.status) {
    case "rejected":
    case "rate_limit_reached":
    case "workspace_owner_usage_limit_reached":
    case "workspace_member_usage_limit_reached":
      return 100;
    case "allowed_warning":
      return 80;
    case "allowed":
      return 0;
    default:
      return -1;
  }
}

function getLatestWindow(windows: SidebarUsageWindowMap): SidebarUsageWindow | null {
  return [windows.fiveHour, windows.weekly].reduce<SidebarUsageWindow | null>((latest, window) => {
    if (!window) {
      return latest;
    }
    if (!latest) {
      return window;
    }
    return window.updatedAt.localeCompare(latest.updatedAt) > 0 ? window : latest;
  }, null);
}

export function getSidebarUsagePrimaryWindow(
  row: SidebarUsageProviderRow,
): SidebarUsageWindow | null {
  return [row.windows.fiveHour, row.windows.weekly].reduce<SidebarUsageWindow | null>(
    (primary, window) => {
      if (!window) {
        return primary;
      }
      if (!primary) {
        return window;
      }

      const scoreComparison = usageWindowScore(window) - usageWindowScore(primary);
      if (scoreComparison !== 0) {
        return scoreComparison > 0 ? window : primary;
      }
      return window.updatedAt.localeCompare(primary.updatedAt) > 0 ? window : primary;
    },
    null,
  );
}

export function getSidebarUsageDisplayPercent(window: SidebarUsageWindow | null): number | null {
  return window?.remainingPercent ?? null;
}

export function deriveSidebarUsageProviderRows(input: {
  readonly providerInstances: ReadonlyArray<SidebarUsageProviderInstanceInput>;
  readonly threads: ReadonlyArray<SidebarUsageThreadInput>;
}): ReadonlyArray<SidebarUsageProviderRow> {
  const driverIdByInstanceId = new Map<string, SidebarUsageDriverId>();
  for (const instance of input.providerInstances) {
    const driverId = String(instance.driverKind);
    if (isSidebarUsageDriverId(driverId)) {
      driverIdByInstanceId.set(String(instance.instanceId), driverId);
    }
  }

  const latestByDriverId = new Map<
    SidebarUsageDriverId,
    {
      readonly windows: Record<SidebarUsageWindowId, SidebarUsageWindow | null>;
      threadId: string | null;
      threadTitle: string | null;
    }
  >();

  const ensureEntry = (driverId: SidebarUsageDriverId) => {
    let entry = latestByDriverId.get(driverId);
    if (!entry) {
      entry = {
        windows: emptyWindows(),
        threadId: null,
        threadTitle: null,
      };
      latestByDriverId.set(driverId, entry);
    }
    return entry;
  };

  for (const thread of input.threads) {
    for (const activity of thread.activities) {
      if (activity.kind !== "account.rate-limits.updated") {
        continue;
      }

      const driverId = resolveActivityDriverId(activity, thread, driverIdByInstanceId);
      if (!driverId) {
        continue;
      }

      const payload = asRecord(activity.payload);
      const windows = collectRateLimitWindows(
        payload?.rateLimits ?? activity.payload,
        activity.createdAt,
      );
      if (windows.length === 0) {
        continue;
      }

      const current = ensureEntry(driverId);

      let changed = false;
      for (const window of windows) {
        if (isNewerOrMoreRelevantWindow(window, current.windows[window.id])) {
          current.windows[window.id] = window;
          changed = true;
        }
      }
      if (changed) {
        current.threadId = thread.id;
        current.threadTitle = thread.title;
      }
    }
  }

  return SIDEBAR_USAGE_PROVIDER_ROWS.map((row) => {
    const latest = latestByDriverId.get(row.driverId);
    const windows = latest?.windows ?? emptyWindows();
    const latestWindow = getLatestWindow(windows);

    return {
      driverId: row.driverId,
      driverKind: row.driverKind,
      label: row.label,
      windows,
      updatedAt: latestWindow?.updatedAt ?? null,
      threadId: latest?.threadId ?? null,
      threadTitle: latest?.threadTitle ?? null,
    } satisfies SidebarUsageProviderRow;
  });
}

export function getSidebarUsageSummary(
  rows: ReadonlyArray<SidebarUsageProviderRow>,
): SidebarUsageSummary | null {
  return rows.reduce<SidebarUsageSummary | null>((summary, row) => {
    const window = getSidebarUsagePrimaryWindow(row);
    if (!window) {
      return summary;
    }
    if (!summary) {
      return { row, window };
    }

    const scoreComparison = usageWindowScore(window) - usageWindowScore(summary.window);
    if (scoreComparison !== 0) {
      return scoreComparison > 0 ? { row, window } : summary;
    }
    return window.updatedAt.localeCompare(summary.window.updatedAt) > 0 ? { row, window } : summary;
  }, null);
}
