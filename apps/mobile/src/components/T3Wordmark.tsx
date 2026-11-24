import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 100 / 37.736;
  return (
    <Svg
      accessibilityLabel="HYR"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="12.73 46.612 100 37.736"
    >
      <ThemedPath
        d="M36.396 84.348L36.396 46.612L44.482 46.612L44.482 84.348ZM12.73 84.348L12.73 46.612L20.816 46.612L20.816 84.348ZM19.792 68.337L19.792 61.814L37.69 61.814L37.69 68.337ZM60.277 84.348L60.277 71.41L47.393 46.612L56.557 46.612L65.129 64.725L63.619 64.725L72.137 46.612L81.194 46.612L68.363 71.41L68.363 84.348ZM84.105 84.348L84.105 46.612L98.768 46.612Q103.35 46.612 106.396 48.202Q109.442 49.793 110.924 52.434Q112.407 55.076 112.407 58.31Q112.407 61.329 110.978 63.971Q109.549 66.612 106.531 68.229Q103.512 69.847 98.714 69.847L92.191 69.847L92.191 84.348ZM103.566 84.348L95.965 67.852L104.644 67.852L112.73 84.348ZM92.191 64.024L98.283 64.024Q101.301 64.024 102.73 62.569Q104.159 61.113 104.159 58.634Q104.159 56.208 102.73 54.779Q101.301 53.351 98.283 53.351L92.191 53.351Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
