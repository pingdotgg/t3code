// Import lazily: this evaluates every Lucide icon's path data, which startup should not pay for.
import { icons } from "lucide";
import type { IconNode } from "lucide";

export const LUCIDE_SHAPE_TAGS = [
  "circle",
  "ellipse",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
] as const;

// Keyed by Lucide export name, including the deprecated aliases older overrides saved.
const iconNodes: Record<string, IconNode> = icons;

function toPascalName(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function lucideIconByName(name: string): IconNode {
  const pascalName = toPascalName(name);
  return Object.hasOwn(iconNodes, pascalName) ? iconNodes[pascalName]! : icons.FolderCode;
}
