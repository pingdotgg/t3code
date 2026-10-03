/**
 * How a configured provider instance presents itself in a client: its label,
 * its accent color, its glyph and badge text, and whether its icon carries
 * the account badge. Shared by
 * web and mobile so both clients name and badge the same instance identically.
 *
 * @module providerInstanceDisplay
 */
import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_INSTANCE_INITIALS_ICON,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";

/**
 * Title-case a slug: splits on `_` / `-` and camelCase boundaries, so
 * `codex_personal` becomes "Codex Personal" and `myCustomInstance` becomes
 * "My Custom Instance".
 */
function humanizeSlug(slug: string): string {
  return slug
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Resolve an instance's label with a tiered priority:
 *
 *   1. A snapshot `displayName` that differs from the driver's brand label —
 *      the server has explicitly named this instance, trust it.
 *   2. For non-default instances, a humanized `instanceId` — the server fell
 *      back to the driver-level label (the same for every instance of that
 *      kind), so the slug is what keeps "Codex" and "Codex Personal" apart.
 *   3. The snapshot's `displayName`, or the brand label from contracts.
 */
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

/**
 * Turn a display name into up to two initials for the badge: the first two
 * characters of a single word, or the first character of each of the first
 * two words. Iterates by code point so an emoji never splits into surrogates.
 */
export function providerInstanceInitials(label: string): string {
  const words = label.replace(/[_-]+/g, " ").split(/\s+/u).filter(Boolean);
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
 * width: short labels fill it, three characters still fit.
 */
export function providerInstanceInitialsGlyphScale(label: string): number {
  const length = Array.from(label).length;
  return length <= 1 ? 0.72 : length === 2 ? 0.54 : 0.4;
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

interface InstanceGlyphIdentity {
  readonly driverKind: ProviderDriverKind;
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
    if (isProviderInstanceInitialsIcon(candidate.icon)) continue;
    if (instanceGlyphKey(candidate) !== glyphKey) continue;
    if (++sharedGlyphCount > 1) return true;
  }
  return false;
}
