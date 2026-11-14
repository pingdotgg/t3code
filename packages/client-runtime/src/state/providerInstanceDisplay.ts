import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";

function humanizeSlug(slug: string): string {
  return slug
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function resolveProviderInstanceDisplayName(
  snapshot: Pick<ServerProvider, "instanceId" | "driver" | "displayName">,
): string {
  const trimmedSnapshotName = snapshot.displayName?.trim();
  const kindLabel = PROVIDER_DISPLAY_NAMES[snapshot.driver] ?? humanizeSlug(snapshot.driver);
  if (trimmedSnapshotName && trimmedSnapshotName !== kindLabel) return trimmedSnapshotName;
  if (snapshot.instanceId !== defaultInstanceIdForDriver(snapshot.driver)) {
    const humanized = humanizeSlug(snapshot.instanceId);
    if (humanized.length > 0) return humanized;
  }
  return trimmedSnapshotName || kindLabel;
}

export function providerInstanceInitials(label: string): string {
  // Punctuation separates words so "Codex (hub)" reads CH, not C(. An apostrophe
  // inside a word stays ("Theo's Codex" is TC); a quoting one does not
  // ("Codex 'hub'" is CH).
  const words = label
    .replace(/[^\P{P}'’]+/gu, " ")
    .split(/\s+/u)
    .map((word) => word.replace(/^['’]+|['’]+$/gu, ""))
    .filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return Array.from(words[0]!).slice(0, 2).join("").toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
    .join("");
}

export function normalizeProviderAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed : undefined;
}

export function providerAccentForegroundColor(accentColor: string) {
  const linearChannel = (offset: number) => {
    const value = Number.parseInt(accentColor.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * linearChannel(1) + 0.7152 * linearChannel(3) + 0.0722 * linearChannel(5);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? "#000000" : "#ffffff";
}

/**
 * Size of the initials tab beside a provider logo, in px. Web and mobile both read it so the
 * tab looks the same. The letters stay at 9px or more; smaller text is not readable.
 */
export function providerInstanceTabMetrics(iconSize: number) {
  const large = iconSize >= 18;
  return {
    height: large ? 13 : 12,
    fontSize: large ? 10 : 9,
    paddingHorizontal: 3,
    /** Fixed width in a "corner" slot, so the space kept beside the slot fits any initials. */
    cornerWidth: 22,
    borderRadius: 4,
    /** How far the tab sits over the logo's right edge. */
    overlap: 4,
    /** How far the tab hangs below the logo. */
    drop: 3,
    /** Width of the surface-colored ring that separates the tab from the logo. */
    ring: 1.5,
  } as const;
}

export function shouldShowInstanceBadge(
  entry: {
    readonly driverKind: ProviderDriverKind;
    readonly accentColor?: string | undefined;
    readonly acpRegistryAgentId?: string | undefined;
    readonly enabled: boolean;
  },
  entries: Iterable<{
    readonly driverKind: ProviderDriverKind;
    readonly acpRegistryAgentId?: string | undefined;
    readonly enabled: boolean;
  }>,
): boolean {
  if (normalizeProviderAccentColor(entry.accentColor)) return true;
  let sharedProviderCount = 0;
  for (const candidate of entries) {
    if (candidate.driverKind !== entry.driverKind) continue;
    // Historical threads still need to distinguish accounts that are all disabled.
    if (entry.enabled && !candidate.enabled) continue;
    if (
      entry.driverKind === "acpRegistry" &&
      candidate.acpRegistryAgentId !== entry.acpRegistryAgentId
    ) {
      continue;
    }
    if (++sharedProviderCount > 1) return true;
  }
  return false;
}
