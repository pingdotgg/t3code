/* oxlint-disable eslint/no-restricted-imports -- Resolves saved project icons by name, so it needs the whole set. */
// Import lazily: one chunk avoids lucide-react/dynamic emitting about 1,900 icon chunks.
import * as Lucide from "lucide-react";
import type { LucideIcon } from "lucide-react";

const iconComponents = new Set<unknown>(Object.values(Lucide.icons));
const lucideExports: Record<string, unknown> = Lucide;

// Match Lucide export naming to resolve deprecated aliases saved by older overrides.
function toPascalName(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

// Lucide digit names can differ from this inverse; both forms resolve through toPascalName.
function toKebabName(pascalName: string): string {
  return (pascalName.match(/[A-Z][a-z]*|[0-9]+[a-z]*/g) ?? []).join("-").toLowerCase();
}

export const lucideIconNames: ReadonlyArray<string> = Object.keys(Lucide.icons).map(toKebabName);

export function lucideIconByName(name: string): LucideIcon | undefined {
  const icon = lucideExports[toPascalName(name)];
  return iconComponents.has(icon) ? (icon as LucideIcon) : undefined;
}
