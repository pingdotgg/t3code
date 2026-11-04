import {
  type ContributionStatusEntry,
  type ContributionStatusSource,
  type ContributionStatusTone,
  contributionStatusSourceKey,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
} from "@t3tools/contracts";

export interface ThreadContributionStatusChip {
  /** Source key plus item key, so a provider session taking over re-keys the chip. */
  readonly id: string;
  /** The provider that set it, or null for a plugin's status. */
  readonly driver: ProviderDriverKind | null;
  /** The first chip of each provider source carries that provider's icon. */
  readonly leadsSource: boolean;
  readonly text: string;
  readonly tone: ContributionStatusTone;
  readonly tooltip: string | null;
  readonly accessibilityLabel: string;
  /** Says where the status came from and that it can lag; never "current session". */
  readonly help: string;
  /** The details alert. The full text goes in the body: native alert titles truncate. */
  readonly details: { readonly title: string; readonly message: string };
}

function providerLabel(driver: ProviderDriverKind): string {
  return PROVIDER_DISPLAY_NAMES[driver] ?? driver;
}

function sourceLabel(source: ContributionStatusSource): string {
  return source.kind === "plugin" ? source.name : providerLabel(source.driver);
}

function statusHelp(source: ContributionStatusSource): string {
  if (source.kind === "plugin") return `Set by the ${source.name} plugin.`;
  const origin = source.driver === "pi" ? "a Pi extension" : providerLabel(source.driver);
  return `Set by ${origin}. It can lag a session change.`;
}

/** Flattens a thread's status entries into chips, in the server's order. */
export function threadContributionStatusChips(
  entries: ReadonlyArray<ContributionStatusEntry>,
): ReadonlyArray<ThreadContributionStatusChip> {
  return entries.flatMap((entry) => {
    const { source } = entry;
    const sourceKey = contributionStatusSourceKey(source);
    const label = sourceLabel(source);
    const help = statusHelp(source);
    return entry.items.map((item, index) => ({
      id: JSON.stringify([sourceKey, item.key]),
      driver: source.kind === "plugin" ? null : source.driver,
      leadsSource: index === 0,
      text: item.text,
      tone: item.tone ?? "neutral",
      tooltip: item.tooltip ?? null,
      accessibilityLabel: `${label} status: ${item.text}`,
      help,
      details: {
        title: `${label} status`,
        message: [item.text, item.tooltip, help].filter(Boolean).join("\n\n"),
      },
    }));
  });
}

export function threadHasContributionStatus(
  entries: ReadonlyArray<ContributionStatusEntry>,
): boolean {
  return entries.some((entry) => entry.items.length > 0);
}

/** Drivers whose sessions publish statuses (Pi's `setStatus`). */
const STATUS_PUBLISHING_DRIVERS: ReadonlySet<string> = new Set(["pi"]);

/**
 * Whether the feed reserves the status strip's band above its first row.
 * Threads of a publishing provider keep it from the start, so a status
 * appearing, changing or clearing never shifts the feed; other threads only
 * get it while they have a status.
 */
export function reservesContributionStatusBand(input: {
  readonly supported: boolean;
  readonly driver: ProviderDriverKind | undefined;
  readonly hasStatus: boolean;
}): boolean {
  if (!input.supported) return false;
  return (
    input.hasStatus || (input.driver !== undefined && STATUS_PUBLISHING_DRIVERS.has(input.driver))
  );
}
