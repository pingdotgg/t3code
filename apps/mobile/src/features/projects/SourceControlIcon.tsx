import type { SourceControlIcon as SourceControlIconArtwork } from "@t3tools/client-runtime/source-control-clients";
import { useId } from "react";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedSvg = withUniwind(Svg);

/** Draws a host's mark from its definition's artwork; `currentColor` follows `color`. */
export function SourceControlIcon(props: {
  readonly icon: SourceControlIconArtwork | null;
  readonly size?: number;
  readonly color?: string;
  readonly colorClassName?: string;
}) {
  // Gradient ids must not collide when one screen shows the same mark more than once.
  const idPrefix = useId().replace(/[^\w-]/gu, "");
  const size = props.size ?? 18;
  const { icon } = props;
  if (icon === null) return null;
  const paint = (value: SourceControlIconArtwork["paths"][number]["fill"]) =>
    value === undefined
      ? "none"
      : typeof value === "string"
        ? value
        : `url(#${idPrefix}-${value.gradient})`;

  return (
    <ThemedSvg
      width={size}
      height={size}
      viewBox={icon.viewBox}
      color={props.color}
      colorClassName={props.colorClassName}
      fill="none"
    >
      {icon.gradients ? (
        <Defs>
          {icon.gradients.map((gradient) => (
            <LinearGradient
              key={gradient.id}
              id={`${idPrefix}-${gradient.id}`}
              x1={gradient.x1}
              y1={gradient.y1}
              x2={gradient.x2}
              y2={gradient.y2}
              gradientTransform={gradient.transform}
              gradientUnits="userSpaceOnUse"
            >
              {gradient.stops.map((stop) => (
                <Stop
                  key={stop.offset}
                  offset={stop.offset}
                  stopColor={stop.color}
                  stopOpacity={stop.opacity}
                />
              ))}
            </LinearGradient>
          ))}
        </Defs>
      ) : null}
      {icon.paths.map((path, index) => (
        <Path
          // Paths repeat with different paints, so their data is not a key.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          d={path.d}
          fill={paint(path.fill)}
          fillRule={path.fillRule}
          fillOpacity={path.fillOpacity}
          stroke={path.stroke}
          strokeWidth={path.strokeWidth}
        />
      ))}
    </ThemedSvg>
  );
}
