import type { ColorValue, StyleProp, ViewStyle } from "react-native";
import Svg, { Path } from "react-native-svg";

/** One Superheroicons 24px solid glyph: paths in a 24-unit box. */
export type ConnGlyphData = ReadonlyArray<{ readonly d: string; readonly evenOdd: boolean }>;

/**
 * Draws a Conn glyph filled with `color`. `stroke` adds an outline of that colour, for halos
 * behind another glyph.
 */
export function ConnGlyph(props: {
  readonly glyph: ConnGlyphData;
  readonly size?: number | undefined;
  readonly color?: ColorValue | undefined;
  readonly stroke?: ColorValue | undefined;
  readonly strokeWidth?: number | undefined;
  readonly style?: StyleProp<ViewStyle>;
  readonly accessibilityLabel?: string | undefined;
  readonly testID?: string | undefined;
}) {
  const size = props.size ?? 24;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={props.style}
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
    >
      {props.glyph.map((path, index) => (
        <Path
          // oxlint-disable-next-line react/no-array-index-key -- a glyph's paths never reorder
          key={index}
          d={path.d}
          fill={props.color ?? "currentColor"}
          fillRule={path.evenOdd ? "evenodd" : "nonzero"}
          {...(props.stroke === undefined
            ? {}
            : {
                stroke: props.stroke,
                strokeWidth: props.strokeWidth ?? 2,
                strokeLinejoin: "round",
              })}
        />
      ))}
    </Svg>
  );
}
