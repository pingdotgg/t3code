import type {
  ProviderDriverKind,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

export type ProviderUsageTone = "default" | "warning" | "critical";

export interface ProviderUsageWindowView {
  readonly key: string;
  readonly label: string;
  readonly percentLabel: string;
  /** Clamped 0..100 fill for the progress ring. */
  readonly usedPercent: number;
  readonly tone: ProviderUsageTone;
  readonly resetsAtLabel: string | undefined;
}

export interface ProviderUsageRowView {
  readonly key: string;
  readonly name: string;
  readonly driver: ProviderDriverKind;
  readonly accentColor: string | undefined;
  readonly windows: ReadonlyArray<ProviderUsageWindowView>;
  readonly updatedAgoLabel: string;
  readonly tone: ProviderUsageTone;
}

const WARNING_PERCENT = 70;
const CRITICAL_PERCENT = 90;

export function providerUsageWindowTone(window: ServerProviderUsageWindow): ProviderUsageTone {
  if (window.status === "exhausted" || window.usedPercent >= CRITICAL_PERCENT) {
    return "critical";
  }
  if (window.status === "warning" || window.usedPercent >= WARNING_PERCENT) {
    return "warning";
  }
  return "default";
}

const TONE_RANK: Record<ProviderUsageTone, number> = { default: 0, warning: 1, critical: 2 };

function worstTone(tones: ReadonlyArray<ProviderUsageTone>): ProviderUsageTone {
  return tones.reduce<ProviderUsageTone>(
    (worst, tone) => (TONE_RANK[tone] > TONE_RANK[worst] ? tone : worst),
    "default",
  );
}

function parseIsoMs(iso: string): number | undefined {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function formatDurationShort(deltaMs: number): string {
  const totalMinutes = Math.max(1, Math.round(deltaMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

export function formatResetsAt(resetsAtIso: string | undefined, nowMs: number): string | undefined {
  if (resetsAtIso === undefined) {
    return undefined;
  }
  const resetMs = parseIsoMs(resetsAtIso);
  if (resetMs === undefined) {
    return undefined;
  }
  if (resetMs <= nowMs) {
    return "resets soon";
  }
  return `resets in ${formatDurationShort(resetMs - nowMs)}`;
}

export function formatUpdatedAgo(updatedAtIso: string, nowMs: number): string {
  const updatedMs = parseIsoMs(updatedAtIso);
  if (updatedMs === undefined) {
    return "updated recently";
  }
  const deltaMs = nowMs - updatedMs;
  if (deltaMs < 60_000) {
    return "updated just now";
  }
  return `updated ${formatDurationShort(deltaMs)} ago`;
}

function providerDisplayName(provider: ServerProvider): string {
  if (provider.displayName !== undefined) {
    return provider.displayName;
  }
  const driver = provider.driver;
  return driver.charAt(0).toUpperCase() + driver.slice(1);
}

/**
 * Rows for the sidebar usage panel: one per provider that has reported
 * usage. Providers without usage data are omitted entirely; provider
 * order is preserved from the registry snapshot.
 */
export function getProviderUsageRows(
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
): ReadonlyArray<ProviderUsageRowView> {
  const rows: ProviderUsageRowView[] = [];
  for (const provider of providers) {
    const usage = provider.usage;
    if (!usage || usage.windows.length === 0 || !provider.enabled) {
      continue;
    }
    const windows = usage.windows.map((window): ProviderUsageWindowView => {
      const usedPercent = Math.min(Math.max(window.usedPercent, 0), 100);
      return {
        key: window.key,
        label: window.label,
        percentLabel: `${Math.round(usedPercent)}%`,
        usedPercent,
        tone: providerUsageWindowTone(window),
        resetsAtLabel: formatResetsAt(window.resetsAt, nowMs),
      };
    });
    rows.push({
      key: provider.instanceId,
      name: providerDisplayName(provider),
      driver: provider.driver,
      accentColor: provider.accentColor,
      windows,
      updatedAgoLabel: formatUpdatedAgo(usage.updatedAt, nowMs),
      tone: worstTone(windows.map((window) => window.tone)),
    });
  }
  return rows;
}
