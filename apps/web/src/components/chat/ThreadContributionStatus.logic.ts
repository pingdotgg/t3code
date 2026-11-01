import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  type ContributionStatusEntry,
  type ContributionStatusSource,
  type ContributionStatusTone,
  contributionStatusSourceKey,
  ProviderDriverKind,
} from "@t3tools/contracts";

const PI_DRIVER = ProviderDriverKind.make("pi");

export interface ContributionStatusChip {
  /** Source key plus item key, so a provider-session takeover re-keys the chip. */
  readonly id: string;
  readonly text: string;
  readonly tone: ContributionStatusTone;
  readonly tooltip: string | null;
  /** Static help naming where the status came from. Never claims it is current. */
  readonly origin: string;
}

function contributionStatusOrigin(source: ContributionStatusSource): string {
  const name = resolveProviderInstanceDisplayName({
    instanceId: source.providerInstanceId,
    driver: source.driver,
  });
  return source.driver === PI_DRIVER
    ? `From a ${name} extension. It can lag a session change.`
    : `From ${name}. It can lag a session change.`;
}

/** One chip per status item, in the server's order. */
export function contributionStatusChips(
  entries: ReadonlyArray<ContributionStatusEntry>,
): ReadonlyArray<ContributionStatusChip> {
  return entries.flatMap((entry) => {
    const sourceKey = contributionStatusSourceKey(entry.source);
    const origin = contributionStatusOrigin(entry.source);
    return entry.items.map((item) => ({
      id: JSON.stringify([sourceKey, item.key]),
      text: item.text,
      tone: item.tone ?? "neutral",
      tooltip: item.tooltip || null,
      origin,
    }));
  });
}
