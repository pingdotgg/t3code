import type { ColorValue } from "react-native";
import Svg, { Rect } from "react-native-svg";

/** The canonical lime rounded-diamond mark from the original 2code client. */
export function Brand2codeMark(props: { readonly size: number; readonly color?: ColorValue }) {
  return (
    <Svg accessibilityLabel="2code" height={props.size} width={props.size} viewBox="0 0 24 24">
      <Rect
        fill={props.color ?? "#b0fe93"}
        height={14.8}
        rx={5}
        transform="rotate(45 12 12)"
        width={14.8}
        x={4.6}
        y={4.6}
      />
    </Svg>
  );
}
