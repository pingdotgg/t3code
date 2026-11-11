import type { ColorValue } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedSvg = withUniwind(Svg);

export function BrowserAppIcon(props: {
  readonly size: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <ThemedSvg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      color={props.color}
      colorClassName={props.colorClassName}
      accessible={false}
    >
      <Path d="M8.5 19H7.2C4.4 19 3 17.5 3 14.6V7.4C3 4.5 4.5 3 7.4 3h8.2C18.5 3 20 4.5 20 7.4v2.4" />
      <Circle cx={7.4} cy={7.2} r={0.75} fill="currentColor" stroke="none" />
      <Path d="M11.2 7.2h4.3" />
      <Path d="m12.4 11.4 7.5 2.6-3.4 1.6-1.5 3.6z" fill="currentColor" stroke="none" />
    </ThemedSvg>
  );
}
