import type {
  EnvironmentId,
  SubscriptionAllowance,
  SubscriptionAllowanceSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import { isRpcMethodNotFoundError } from "../rpc/client.ts";

export const SUBSCRIPTION_ALLOWANCE_COMPATIBILITY_MESSAGE =
  "Subscription allowance reporting is not supported by this environment version.";

export type UsageView = "subscription" | "historical";

export const DEFAULT_USAGE_VIEW: UsageView = "subscription";

export const USAGE_VIEW_OPTIONS = [
  { value: "subscription" as const, label: "Subscription" },
  { value: "historical" as const, label: "Historical" },
] as const;

export type SubscriptionViewPhase = "loading" | "partial" | "ready";

export function createSubscriptionAllowanceRefreshTracker(
  onRefreshingChange: (isRefreshing: boolean) => void,
): (refreshes: readonly Promise<unknown>[]) => Promise<void> {
  let pendingRefreshes = 0;

  return async (refreshes) => {
    pendingRefreshes += 1;
    if (pendingRefreshes === 1) onRefreshingChange(true);

    try {
      await Promise.all(refreshes);
    } finally {
      pendingRefreshes -= 1;
      if (pendingRefreshes === 0) onRefreshingChange(false);
    }
  };
}

export function subscriptionViewPhase(input: {
  readonly isPending: boolean;
  readonly isPartial: boolean;
  readonly groupCount: number;
}): SubscriptionViewPhase {
  if (input.groupCount === 0 && (input.isPending || input.isPartial)) return "loading";
  return input.isPending || input.isPartial ? "partial" : "ready";
}

export function formatAllowanceWindowScope(scope: string): string {
  switch (scope) {
    case "primary":
      return "Primary limit";
    case "secondary":
      return "Secondary limit";
    case "five_hour":
      return "5-hour limit";
    case "seven_day":
      return "7-day limit";
    case "seven_day_oauth_apps":
      return "7-day OAuth apps limit";
    case "seven_day_opus":
      return "7-day Opus limit";
    case "seven_day_sonnet":
      return "7-day Sonnet limit";
    default:
      return scope;
  }
}

export function formatAllowanceDuration(minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined) return null;
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} minutes`;
}

export function progressWidthForAllowance(usedPercent: number): number {
  return Math.min(100, Math.max(0, usedPercent));
}

const isReported = (value: unknown): boolean => value !== undefined && value !== null;

export function shouldShowSpendingControl(
  spendingControl: NonNullable<SubscriptionAllowance["spendingControl"]>,
): boolean {
  return (
    spendingControl.reached === true ||
    isReported(spendingControl.limit) ||
    isReported(spendingControl.remainingPercent) ||
    isReported(spendingControl.resetsAt) ||
    isReported(spendingControl.used)
  );
}

export function shouldShowExtraUsage(
  extraUsage: NonNullable<SubscriptionAllowance["extraUsage"]>,
): boolean {
  return (
    extraUsage.isEnabled ||
    isReported(extraUsage.monthlyLimit) ||
    isReported(extraUsage.usedCredits) ||
    isReported(extraUsage.utilization)
  );
}

export function formatAllowanceResetAt(resetsAt: string): string | null {
  // @effect-diagnostics-next-line globalDate:off
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatAllowanceUpdatedAt(
  updatedAt: string | null | undefined,
  // UI formatting is intentionally wall-clock relative and remains a pure helper for both clients.
  // @effect-diagnostics-next-line globalDate:off
  now = Date.now(),
): string | null {
  if (updatedAt === null || updatedAt === undefined) return null;
  // @effect-diagnostics-next-line globalDate:off
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return null;

  const elapsedMinutes = Math.max(0, Math.floor((now - date.getTime()) / 60_000));
  if (elapsedMinutes < 1) return "Updated just now";
  if (elapsedMinutes < 60) return `Updated ${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `Updated ${elapsedHours}h ago`;
  return `Updated ${Math.floor(elapsedHours / 24)}d ago`;
}

export function formatAllowanceConnectionPhase(phase: EnvironmentConnectionPhase): string {
  switch (phase) {
    case "available":
      return "Available";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "connected":
      return "Connected";
    case "error":
      return "Connection failed";
  }
}

export function formatAllowanceUnavailableMessage(
  provider: SubscriptionAllowance["provider"],
  message: string | undefined,
): string {
  if (message !== undefined) return message;
  return provider === "claude"
    ? "Claude did not report subscription usage limits."
    : "Subscription usage is unavailable.";
}

/**
 * The allowance state owned by one connected environment.
 *
 * Connection state deliberately sits beside, rather than inside, the provider
 * record. A transport outage is not evidence that a provider account became
 * unavailable.
 */
export interface EnvironmentSubscriptionAllowanceStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly isPending: boolean;
  /** The connected server predates the additive allowance RPC. */
  readonly compatibility: boolean;
  readonly error: string | null;
  readonly snapshot: SubscriptionAllowanceSnapshot | null;
}

export function isSubscriptionAllowanceCompatibilityCause(cause: Cause.Cause<unknown>): boolean {
  return (
    cause.reasons.length > 0 &&
    cause.reasons.every(
      (reason) => Cause.isFailReason(reason) && isRpcMethodNotFoundError(reason.error),
    )
  );
}

export interface SubscriptionAllowanceSource {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly allowance: SubscriptionAllowance;
}

export function isSubscriptionAllowanceSourceCurrent(source: SubscriptionAllowanceSource): boolean {
  return (
    source.connectionPhase === "connected" &&
    source.allowance.status === "available" &&
    source.allowance.freshness !== "stale"
  );
}

export interface SubscriptionAllowanceGroup {
  /** Opaque local key. Verified account ids are used only to derive this key. */
  readonly key: string;
  readonly provider: SubscriptionAllowance["provider"];
  /** A masked provider descriptor, only when all verified sources agree. */
  readonly accountLabel: string | null;
  readonly status: SubscriptionAllowance["status"];
  readonly sources: readonly SubscriptionAllowanceSource[];
  /** One whole provider observation; never a field-by-field merge. */
  readonly effectiveSource: SubscriptionAllowanceSource | null;
  readonly hasMultipleReadings: boolean;
}

export interface SubscriptionAllowanceSourceModel {
  readonly key: string;
  readonly environmentLabel: string;
  readonly instanceId: string;
  readonly connectionLabel: string;
  readonly status: SubscriptionAllowance["status"];
  /** Retained provider data from before a failed refresh or passed reset. */
  readonly isStale: boolean;
  /** Derived from connection, availability, and freshness for UI presentation. */
  readonly isCurrent: boolean;
  readonly isEffective: boolean;
}

export interface SubscriptionAllowanceCardModel {
  readonly key: string;
  readonly provider: SubscriptionAllowance["provider"];
  readonly accountLabel: string | null;
  readonly status: SubscriptionAllowance["status"];
  readonly message: string;
  /** Retained provider data from before a failed refresh or passed reset. */
  readonly isStale: boolean;
  /** Derived from connection, availability, and freshness for UI presentation. */
  readonly isCurrent: boolean;
  readonly updatedAt: string | null;
  readonly windows: SubscriptionAllowance["windows"];
  readonly credits: NonNullable<SubscriptionAllowance["credits"]> | null;
  readonly spendingControl: NonNullable<SubscriptionAllowance["spendingControl"]> | null;
  readonly extraUsage: NonNullable<SubscriptionAllowance["extraUsage"]> | null;
  readonly hasMultipleReadings: boolean;
  readonly sources: readonly SubscriptionAllowanceSourceModel[];
}

export function formatAllowanceEnvironmentNotice(environment: {
  readonly label: string;
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly compatibility?: boolean;
  readonly error: string | null;
  readonly snapshot: unknown;
}): string | null {
  if (environment.compatibility === true) {
    return `${environment.label}: ${SUBSCRIPTION_ALLOWANCE_COMPATIBILITY_MESSAGE}`;
  }
  if (environment.error !== null) {
    return `${environment.label} could not report subscription usage.`;
  }
  if (environment.snapshot === null && environment.connectionPhase !== "connected") {
    return `${environment.label} is ${formatAllowanceConnectionPhase(environment.connectionPhase).toLowerCase()}; subscription usage will return when it reconnects.`;
  }
  return null;
}

export function presentSubscriptionAllowanceGroup(
  group: SubscriptionAllowanceGroup,
): SubscriptionAllowanceCardModel {
  const displayedSource = group.effectiveSource ?? group.sources[0];
  if (displayedSource === undefined) {
    throw new Error("Subscription allowance groups must contain a source");
  }

  const allowance = displayedSource.allowance;
  return {
    key: group.key,
    provider: allowance.provider,
    accountLabel: group.accountLabel,
    status: allowance.status,
    message: formatAllowanceUnavailableMessage(allowance.provider, allowance.message),
    isStale: allowance.freshness === "stale",
    isCurrent: isSubscriptionAllowanceSourceCurrent(displayedSource),
    updatedAt: allowance.updatedAt ?? null,
    windows: allowance.windows,
    credits: allowance.credits ?? null,
    spendingControl: allowance.spendingControl ?? null,
    extraUsage: allowance.extraUsage ?? null,
    hasMultipleReadings: group.hasMultipleReadings,
    sources: group.sources.map((source, index) => ({
      key: `${source.environmentId}:${source.allowance.instanceId}:${index}`,
      environmentLabel: source.environmentLabel,
      instanceId: source.allowance.instanceId,
      connectionLabel: formatAllowanceConnectionPhase(source.connectionPhase),
      status: source.allowance.status,
      isStale: source.allowance.freshness === "stale",
      isCurrent: isSubscriptionAllowanceSourceCurrent(source),
      isEffective: source === displayedSource,
    })),
  };
}

export interface SubscriptionAllowanceProjection {
  readonly environments: readonly EnvironmentSubscriptionAllowanceStatus[];
  readonly sources: readonly SubscriptionAllowanceSource[];
  readonly groups: readonly SubscriptionAllowanceGroup[];
  readonly isPending: boolean;
  readonly isPartial: boolean;
  readonly refreshEnvironmentIds: readonly EnvironmentId[];
}

const PROVIDER_ORDER: Readonly<Record<SubscriptionAllowance["provider"], number>> = {
  codex: 0,
  claude: 1,
};

function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareSources(left: SubscriptionAllowanceSource, right: SubscriptionAllowanceSource) {
  const providerOrder =
    PROVIDER_ORDER[left.allowance.provider] - PROVIDER_ORDER[right.allowance.provider];
  if (providerOrder !== 0) return providerOrder;

  const environmentOrder = compareStrings(left.environmentId, right.environmentId);
  if (environmentOrder !== 0) return environmentOrder;
  const instanceOrder = compareStrings(left.allowance.instanceId, right.allowance.instanceId);
  if (instanceOrder !== 0) return instanceOrder;

  // Provider registries normally guarantee one record per instance. Keep the
  // projection deterministic even if a malformed or replayed snapshot carries
  // duplicate records with different readings.
  return compareStrings(
    stableJson({
      allowance: left.allowance,
      connectionPhase: left.connectionPhase,
      environmentLabel: left.environmentLabel,
    }),
    stableJson({
      allowance: right.allowance,
      connectionPhase: right.connectionPhase,
      environmentLabel: right.environmentLabel,
    }),
  );
}

function compareEnvironments(
  left: EnvironmentSubscriptionAllowanceStatus,
  right: EnvironmentSubscriptionAllowanceStatus,
): number {
  return compareStrings(left.environmentId, right.environmentId);
}

function isConnected(status: EnvironmentSubscriptionAllowanceStatus): boolean {
  return status.connectionPhase === "connected";
}

function hasProviderData(allowance: SubscriptionAllowance): boolean {
  return (
    allowance.windows.length > 0 ||
    (allowance.credits !== undefined && allowance.credits !== null) ||
    (allowance.spendingControl !== undefined && allowance.spendingControl !== null) ||
    (allowance.extraUsage !== undefined && allowance.extraUsage !== null)
  );
}

function isComplete(allowance: SubscriptionAllowance): boolean {
  return (
    allowance.completeness === "complete" ||
    (allowance.completeness === undefined && hasProviderData(allowance))
  );
}

function isFresh(allowance: SubscriptionAllowance): boolean {
  // Older additive servers omit freshness. Their available snapshot is still
  // usable, but it must not outrank an explicitly stale observation.
  return allowance.freshness !== "stale";
}

function isLiveDelivery(allowance: SubscriptionAllowance): boolean {
  // Missing delivery metadata is the live path used by the current server.
  return allowance.deliverySource !== "cache";
}

function sourceRank(source: SubscriptionAllowanceSource): readonly number[] {
  const allowance = source.allowance;
  return [
    isFresh(allowance) ? 1 : 0,
    isComplete(allowance) ? 1 : 0,
    isLiveDelivery(allowance) ? 1 : 0,
    source.connectionPhase === "connected" ? 1 : 0,
  ];
}

function compareEffectiveSources(
  left: SubscriptionAllowanceSource,
  right: SubscriptionAllowanceSource,
): number {
  const leftRank = sourceRank(left);
  const rightRank = sourceRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    const rankDelta = (rightRank[index] ?? 0) - (leftRank[index] ?? 0);
    if (rankDelta !== 0) return rankDelta;
  }
  return compareSources(left, right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function readingFingerprint(allowance: SubscriptionAllowance): string {
  const {
    instanceId: _instanceId,
    freshness: _freshness,
    updatedAt: _updatedAt,
    observationSource: _observationSource,
    deliverySource: _deliverySource,
    verifiedAccountId: _verifiedAccountId,
    maskedAccountLabel: _maskedAccountLabel,
    ...reading
  } = allowance;
  return stableJson(reading);
}

function identityKey(source: SubscriptionAllowanceSource): string {
  const verifiedAccountId = source.allowance.verifiedAccountId?.trim();
  return verifiedAccountId === undefined || verifiedAccountId.length === 0
    ? `source:${source.allowance.provider}:${source.environmentId}:${source.allowance.instanceId}`
    : `verified:${source.allowance.provider}:${verifiedAccountId}`;
}

function accountLabel(sources: readonly SubscriptionAllowanceSource[]): string | null {
  if (sources[0]?.allowance.verifiedAccountId === undefined) return null;
  const labels = sources.map((source) => source.allowance.maskedAccountLabel?.trim() ?? null);
  if (labels.some((label) => label === null || label.length === 0)) return null;
  const uniqueLabels = new Set(labels);
  const label = labels[0] ?? null;
  return uniqueLabels.size === 1 && label !== null ? label : null;
}

function hasMultipleReadings(sources: readonly SubscriptionAllowanceSource[]): boolean {
  const readings = sources
    .filter((source) => source.allowance.status === "available")
    .map((source) => readingFingerprint(source.allowance));
  return new Set(readings).size > 1;
}

function makeGroups(
  sources: readonly SubscriptionAllowanceSource[],
): readonly SubscriptionAllowanceGroup[] {
  const grouped = new Map<string, SubscriptionAllowanceSource[]>();
  for (const source of sources) {
    const key = identityKey(source);
    const existing = grouped.get(key);
    if (existing === undefined) grouped.set(key, [source]);
    else existing.push(source);
  }

  const groups = [...grouped.entries()].map(([key, groupedSources]) => {
    const sortedSources = [...groupedSources].sort(compareSources);
    const effectiveSource =
      sortedSources
        .filter((source) => source.allowance.status === "available")
        .sort(compareEffectiveSources)[0] ?? null;
    return {
      key,
      provider: sortedSources[0]!.allowance.provider,
      accountLabel: accountLabel(sortedSources),
      status: effectiveSource?.allowance.status ?? "unavailable",
      sources: sortedSources,
      effectiveSource,
      hasMultipleReadings: hasMultipleReadings(sortedSources),
    } satisfies SubscriptionAllowanceGroup;
  });
  const accountLabelCounts = new Map<string, number>();
  for (const group of groups) {
    if (group.accountLabel !== null) {
      const labelKey = `${group.provider}:${group.accountLabel}`;
      accountLabelCounts.set(labelKey, (accountLabelCounts.get(labelKey) ?? 0) + 1);
    }
  }

  return groups
    .map((group) => {
      if (
        group.accountLabel === null ||
        accountLabelCounts.get(`${group.provider}:${group.accountLabel}`) === 1
      ) {
        return group;
      }
      const source = group.effectiveSource ?? group.sources[0]!;
      return {
        ...group,
        accountLabel: `${group.accountLabel} · ${source.environmentLabel} · ${source.allowance.instanceId}`,
      };
    })
    .sort((left, right) => {
      const providerOrder = PROVIDER_ORDER[left.provider] - PROVIDER_ORDER[right.provider];
      return providerOrder === 0 ? compareStrings(left.key, right.key) : providerOrder;
    })
    .map((group, index) => ({
      ...group,
      // React and consumers receive a local ordinal, never the provider's
      // equality-only identity.
      key: `allowance-group:${index}`,
    }));
}

function projectSources(
  environments: readonly EnvironmentSubscriptionAllowanceStatus[],
): readonly SubscriptionAllowanceSource[] {
  return environments
    .flatMap(
      (environment) =>
        environment.snapshot?.allowances.map((allowance) => ({
          environmentId: environment.environmentId,
          environmentLabel: environment.label,
          connectionPhase: environment.connectionPhase,
          allowance,
        })) ?? [],
    )
    .sort(compareSources);
}

export function reconcileSubscriptionAllowances(
  input: readonly EnvironmentSubscriptionAllowanceStatus[],
): SubscriptionAllowanceProjection {
  const environments = [...input].sort(compareEnvironments);
  const connected = environments.filter(isConnected);
  const answeredCount = connected.filter((environment) => environment.snapshot !== null).length;
  const stillReporting = connected.filter(
    (environment) =>
      environment.snapshot === null &&
      !environment.compatibility &&
      environment.error === null &&
      environment.isPending,
  ).length;
  const sources = projectSources(environments);

  return {
    environments,
    sources,
    groups: makeGroups(sources),
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refreshEnvironmentIds: connected
      .filter((environment) => !environment.compatibility)
      .map((environment) => environment.environmentId),
  };
}
