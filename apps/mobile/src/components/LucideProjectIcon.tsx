import type { ProjectIconColor } from "@t3tools/contracts";
import { use, type ComponentType } from "react";
import Svg, {
  Circle,
  Ellipse,
  Line,
  Path,
  Polygon,
  Polyline,
  Rect,
  type CommonPathProps,
} from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import type { LUCIDE_SHAPE_TAGS } from "../lib/lucideIconByName";
import { projectIconColorClassNames } from "../lib/projectIcon";

// Lucide supplies each shape's own attributes as data, so only the shared ones are typed here.
const SHAPES = {
  circle: Circle,
  ellipse: Ellipse,
  line: Line,
  path: Path,
  polygon: Polygon,
  polyline: Polyline,
  rect: Rect,
} as Record<(typeof LUCIDE_SHAPE_TAGS)[number], ComponentType<CommonPathProps>>;

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
  // Lucide's own stroke attributes; a few shapes fill with currentColor, which reads `color`.
  const stroke = {
    fill: "none",
    stroke: resolved.color,
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  return (
    <Svg
      ref={onSvg}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      color={resolved.color}
      {...stroke}
    >
      {lucideIconByName(name).map(([tag, attributes]) => {
        const Shape = Object.hasOwn(SHAPES, tag) ? SHAPES[tag as keyof typeof SHAPES] : null;
        if (!Shape) return null;
        return <Shape key={JSON.stringify([tag, attributes])} {...stroke} {...attributes} />;
      })}
    </Svg>
  );
}
