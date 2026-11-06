import { useId } from "react";
import type { ColorValue } from "react-native";
import Svg, { Circle, ClipPath, Defs, Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedCircle = withUniwind(Circle);

// OminaX "Nest" mark: an O with two side-chat bubbles, cut apart by clip paths.
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const id = useId();
  const paint = { color: props.color, colorClassName: props.colorClassName };
  return (
    <Svg
      accessibilityLabel="OminaX"
      height={props.height}
      width={(props.height * 808) / 782}
      viewBox="134 164 808 782"
    >
      <Defs>
        <ClipPath id={`${id}o`}>
          <Path
            clipRule="evenodd"
            d="M-200 -200H1224V1224H-200ZM546 740a182 182 0 1 0 364 0a182 182 0 1 0 -364 0Z"
          />
        </ClipPath>
        <ClipPath id={`${id}b`}>
          <Path
            clipRule="evenodd"
            d="M-200 -200H1224V1224H-200ZM798 888a86 86 0 1 0 172 0a86 86 0 1 0 -172 0Z"
          />
        </ClipPath>
      </Defs>
      <ThemedCircle
        cx={440}
        cy={470}
        r={250}
        clipPath={`url(#${id}o)`}
        fill="none"
        stroke="currentColor"
        strokeWidth={112}
        {...paint}
      />
      <ThemedCircle
        cx={728}
        cy={740}
        r={150}
        clipPath={`url(#${id}b)`}
        fill="currentColor"
        {...paint}
      />
      <ThemedCircle cx={884} cy={888} r={58} fill="currentColor" {...paint} />
    </Svg>
  );
}
