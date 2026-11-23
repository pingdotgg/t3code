import Svg, { Circle } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedCircle = withUniwind(Circle);

/**
 * How full the thread's context window is, drawn as a ring inside a round composer button.
 * `percent` is 0-100. The ring takes the colour of `colorClassName`; past 90 the arc turns danger.
 */
export function ComposerContextRing(props: {
  readonly size: number;
  readonly percent: number;
  readonly colorClassName: string;
}) {
  const used = Math.max(0, Math.min(100, props.percent));
  const strokeWidth = Math.max(2, props.size * 0.075);
  const radius = props.size / 2 - strokeWidth * 1.1;
  const circumference = 2 * Math.PI * radius;
  const center = props.size / 2;
  return (
    <Svg
      width={props.size}
      height={props.size}
      style={{ position: "absolute", transform: [{ rotate: "-90deg" }] }}
      pointerEvents="none"
    >
      <ThemedCircle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        colorClassName={props.colorClassName}
        stroke="currentColor"
        strokeOpacity={0.28}
        strokeWidth={strokeWidth}
      />
      <ThemedCircle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        colorClassName={used > 90 ? "accent-danger-foreground" : props.colorClassName}
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={circumference * (1 - used / 100)}
      />
    </Svg>
  );
}
