import type { ProjectIconColor } from "@t3tools/contracts";
import { createElement, use } from "react";
import type Svg from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { projectIconColorClassNames } from "../lib/projectIcon";

let lucideIcons: Promise<typeof import("../lib/lucideIconByName")> | undefined;

function loadLucideIcons() {
  lucideIcons ??= import("../lib/lucideIconByName");
  return lucideIcons;
}

/** Suspends until the Lucide set has loaded, so render it inside Suspense. */
export function LucideProjectIcon({
  name,
  color,
  size,
  onSvg,
}: {
  readonly name: string;
  readonly color: ProjectIconColor;
  readonly size: number;
  readonly onSvg?: (svg: Svg | null) => void;
}) {
  const resolved = useResolveClassNames(projectIconColorClassNames(color).text);
  const { lucideIconByName } = use(loadLucideIcons());
  return createElement(lucideIconByName(name), { ref: onSvg, size, color: resolved.color });
}
