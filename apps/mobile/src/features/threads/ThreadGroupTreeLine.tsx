import type { ColorValue } from "react-native";
import Svg, { Line, Path } from "react-native-svg";

/** How far a worker's content sits right of its lead's content. */
export const THREAD_GROUP_INDENT = 22;
/** The line's x from the lead's content edge: the centre of the lead chip's chevron. */
const LINE_OFFSET = 5.5;
const BRANCH_RADIUS = 8;
/** The branch stops this far short of the worker's content. */
const BRANCH_GAP = 4;

type ThreadGroupTreeLineProps =
  | {
      readonly kind: "lead";
      readonly color: ColorValue;
      /** The lead's content inset from the row's left edge. */
      readonly leadLeft: number;
      /** From the bottom of the title block to the row's bottom edge, separator included. */
      readonly stubHeight: number;
    }
  | {
      readonly kind: "worker" | "last";
      readonly color: ColorValue;
      readonly leadLeft: number;
      /** The title line's vertical centre, measured from the row's top edge. */
      readonly branchY: number;
      /** The worker's own content offset past its indent, such as a project icon. */
      readonly contentInset: number;
    };

/**
 * One row's segment of the vertical line in a group's indent gutter. Render it inside the row's
 * outer container, which has no vertical margin, so segments of adjacent rows meet edge to edge.
 */
export function ThreadGroupTreeLine(props: ThreadGroupTreeLineProps) {
  const { color } = props;
  const x = props.leadLeft + LINE_OFFSET;

  if (props.kind === "lead") {
    return (
      <Svg
        pointerEvents="none"
        accessible={false}
        width={x + 1}
        height={props.stubHeight}
        style={{ position: "absolute", left: 0, bottom: 0 }}
      >
        <Line x1={x} y1={0} x2={x} y2={props.stubHeight} stroke={color} strokeWidth={1} />
      </Svg>
    );
  }

  const branchEnd = props.leadLeft + THREAD_GROUP_INDENT + props.contentInset - BRANCH_GAP;
  const curveStart = props.branchY - BRANCH_RADIUS;
  return (
    <Svg
      pointerEvents="none"
      accessible={false}
      width={branchEnd}
      height="100%"
      style={{ position: "absolute", left: 0, top: 0, bottom: 0 }}
    >
      <Line
        x1={x}
        y1={0}
        x2={x}
        y2={props.kind === "last" ? curveStart : "100%"}
        stroke={color}
        strokeWidth={1}
      />
      <Path
        d={`M ${x} ${curveStart} A ${BRANCH_RADIUS} ${BRANCH_RADIUS} 0 0 0 ${x + BRANCH_RADIUS} ${props.branchY} H ${branchEnd}`}
        fill="none"
        stroke={color}
        strokeWidth={1}
      />
    </Svg>
  );
}
