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
    <Svg accessibilityLabel="tix" height={props.height} width={props.height} viewBox="0 0 128 128">
      <ThemedPath
        d="M112 45c-4-14-18-23-34-22l5-9c-13 1-23 5-30 12l-1-10c-12 6-20 15-24 25C17 45 13 55 16 67c2 8 7 14 13 18-4 10-13 12-20 8 5 17 24 23 37 12 6-5 9-11 10-19 12 1 26 4 37 13l-1-10 12 3-3-12 11 1-5-12c6-7 8-15 5-24Z M59 66C47 78 32 80 20 70c4 15 20 21 34 13 8-5 10-12 5-17Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
        fillRule="evenodd"
      />
    </Svg>
  );
}
