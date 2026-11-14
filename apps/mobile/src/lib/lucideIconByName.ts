// Import lazily: this evaluates every Lucide icon module, which startup should not pay for.
import * as Lucide from "lucide-react-native";
import type { LucideProps } from "lucide-react-native";
import * as LucideIcons from "lucide-react-native/icons";
import type { ForwardRefExoticComponent, RefAttributes } from "react";
import type Svg from "react-native-svg";

// Lucide forwards the ref to its root Svg; its own type omits that.
type LucideIcon = ForwardRefExoticComponent<LucideProps & RefAttributes<Svg>>;

const iconComponents = new Set<unknown>(Object.values(LucideIcons));
const lucideExports: Record<string, unknown> = Lucide;

// Match Lucide export naming to resolve deprecated aliases saved by older overrides.
function toPascalName(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function lucideIconByName(name: string): LucideIcon {
  const icon = lucideExports[toPascalName(name)];
  return iconComponents.has(icon) ? (icon as LucideIcon) : (Lucide.FolderCode as LucideIcon);
}
