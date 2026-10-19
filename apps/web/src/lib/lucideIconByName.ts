/* oxlint-disable eslint/no-restricted-imports -- Resolves saved project icons by name, so it needs the whole set. */
// Project icon overrides save lucide icons by kebab-case name. Import this module
// lazily: it holds every lucide icon as one chunk, where `lucide-react/dynamic`
// emits a separate chunk per icon (~1,900), which dominated build output.
import * as Lucide from "lucide-react";
import type { LucideIcon } from "lucide-react";

const iconComponents = new Set<unknown>(Object.values(Lucide.icons));
const lucideExports: Record<string, unknown> = Lucide;

// Lucide derives export names this way, so it also resolves its deprecated
// aliases ("alarm-check" -> AlarmCheck) that older overrides may have saved.
function toPascalName(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

// Inverse of toPascalName for canonical exports: "ArrowDown01" -> "arrow-down-01".
// Lucide spells a handful of digit names differently ("arrow-down-0-1"); both
// forms resolve to the same icon through toPascalName.
function toKebabName(pascalName: string): string {
  return (pascalName.match(/[A-Z][a-z]*|[0-9]+[a-z]*/g) ?? []).join("-").toLowerCase();
}

export const lucideIconNames: ReadonlyArray<string> = Object.keys(Lucide.icons).map(toKebabName);

export function lucideIconByName(name: string): LucideIcon | undefined {
  const icon = lucideExports[toPascalName(name)];
  return iconComponents.has(icon) ? (icon as LucideIcon) : undefined;
}
