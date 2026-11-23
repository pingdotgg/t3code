import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg accessibilityLabel="Kompas" height={props.height} width={props.height} viewBox="0 0 24 24">
      <ThemedPath
        d="M12 1.75a10.25 10.25 0 1 0 0 20.5 10.25 10.25 0 0 0 0-20.5Zm0 2a8.25 8.25 0 1 1 0 16.5 8.25 8.25 0 0 1 0-16.5ZM16.9 7.1l-6.25 2.35a2 2 0 0 0-1.15 1.15L7.1 16.9l6.25-2.35a2 2 0 0 0 1.15-1.15Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
        fillRule="evenodd"
      />
    </Svg>
  );
}
