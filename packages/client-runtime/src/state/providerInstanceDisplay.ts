import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_INSTANCE_INITIALS_ICON,
  ProviderDriverKind,
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

/** Badge labels render at most this many characters; longer ones are clipped. */
export const PROVIDER_INSTANCE_BADGE_LABEL_MAX_CHARS = 3;

/**
 * The badge text for an instance: its configured label, clipped by code point
 * so an emoji never splits, or the display name's initials.
 */
export function resolveProviderInstanceBadgeLabel(input: {
  readonly displayName: string;
  readonly badgeLabel?: string | undefined;
}): string {
  const label = input.badgeLabel?.trim();
  if (!label) return providerInstanceInitials(input.displayName);
  return Array.from(label).slice(0, PROVIDER_INSTANCE_BADGE_LABEL_MAX_CHARS).join("");
}

/** Driver slugs whose logo every client can draw, in the order settings offers them. */
export const PROVIDER_INSTANCE_LOGO_ICONS: ReadonlyArray<ProviderDriverKind> = [
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "pi",
].map((slug) => ProviderDriverKind.make(slug));

/**
 * The driver slug whose glyph an instance draws: its chosen logo when this
 * client knows it, otherwise its own driver's.
 */
export function resolveProviderInstanceGlyphDriver(input: {
  readonly driverKind: ProviderDriverKind;
  readonly icon?: string | undefined;
}): ProviderDriverKind {
  const chosen = PROVIDER_INSTANCE_LOGO_ICONS.find((logo) => logo === input.icon);
  return chosen ?? input.driverKind;
}

/**
 * Font size for a badge label drawn as the glyph, as a fraction of the glyph's
 * width. Sized so the widest bold letters and emoji still fit on one line.
 */
export function providerInstanceInitialsGlyphScale(label: string): number {
  const length = Array.from(label).length;
  return length <= 1 ? 0.7 : length === 2 ? 0.46 : 0.32;
}

/** Whether an instance draws its badge label in place of a logo. */
export function isProviderInstanceInitialsIcon(icon: string | undefined): boolean {
  return icon === PROVIDER_INSTANCE_INITIALS_ICON;
}

/** Only `#rrggbb` accent colors render; anything else is treated as unset. */
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

interface InstanceGlyphIdentity {
  readonly driverKind: ProviderDriverKind;
  readonly enabled: boolean;
  readonly icon?: string | undefined;
  readonly acpRegistryAgentId?: string | undefined;
}

// Two instances look alike when they draw the same glyph: a chosen logo this
// client knows wins over the driver's, and ACP agents each have their own.
function instanceGlyphKey(entry: InstanceGlyphIdentity): string {
  const glyphDriver = resolveProviderInstanceGlyphDriver(entry);
  if (glyphDriver === "acpRegistry") return `acp:${entry.acpRegistryAgentId ?? ""}`;
  return `logo:${glyphDriver}`;
}

/**
 * Whether an instance's icon carries the account badge: accent color or badge
 * label set, or several instances drawing the same glyph so it alone is
 * ambiguous. An initials glyph already is the badge text, so it never gets one.
 * Shared by the composer trigger, the picker rail, and sidebar/thread rows.
 */
export function shouldShowInstanceBadge(
  entry: InstanceGlyphIdentity & {
    readonly accentColor?: string | undefined;
    readonly badgeLabel?: string | undefined;
  },
  entries: Iterable<InstanceGlyphIdentity>,
): boolean {
  if (isProviderInstanceInitialsIcon(entry.icon)) return false;
  if (entry.accentColor || entry.badgeLabel) return true;
  const glyphKey = instanceGlyphKey(entry);
  let sharedGlyphCount = 0;
  for (const candidate of entries) {
    if (entry.enabled && !candidate.enabled) continue;
    if (isProviderInstanceInitialsIcon(candidate.icon)) continue;
    if (instanceGlyphKey(candidate) !== glyphKey) continue;
    if (++sharedGlyphCount > 1) return true;
  }
  return false;
}
