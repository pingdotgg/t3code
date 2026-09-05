import { projectIconColorClassName } from "../../../projectIconColors";
import { resolveAutomaticProjectIconColor } from "../../ProjectFavicon";

// Splits on separators and camelCase boundaries so "orange-cli", "orange_cli"
// and "orangeCli" all read as two words. Digits start their own token too, so
// "t3code" keeps its "3".
const SEPARATORS = /[\s\-_./\\:]+/;

function splitProjectNameWords(name: string): string[] {
  return name
    .split(SEPARATORS)
    .flatMap((segment) =>
      segment
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([A-Za-z])(\d)/g, "$1 $2")
        .replace(/(\d)([A-Za-z])/g, "$1 $2")
        .split(" "),
    )
    .filter((word) => word.length > 0);
}

/**
 * Two-character monogram for a project tile: the first letters of the first two
 * words, or the first two characters when the name is a single word.
 * "orange-cli" reads "OC", "Waterfruit Puzzle" reads "WP", "t3code" reads "T3".
 */
export function resolveProjectInitials(displayName: string): string {
  const words = splitProjectNameWords(displayName.trim());
  if (words.length === 0) return "?";
  // Indexed by code point, not code unit: a name starting with an emoji or any
  // other astral character would otherwise yield half a surrogate pair and
  // render as a replacement glyph.
  if (words.length === 1) return Array.from(words[0]!).slice(0, 2).join("").toUpperCase();
  return `${Array.from(words[0]!)[0]!}${Array.from(words[1]!)[0]!}`.toUpperCase();
}

/** Text color for an initials tile, matching the color the icon model would pick. */
export function resolveProjectTileColorClassName(projectName: string, cwd: string): string {
  const color = resolveAutomaticProjectIconColor(projectName, cwd);
  return color ? projectIconColorClassName(color) : "text-sidebar-muted-foreground";
}
