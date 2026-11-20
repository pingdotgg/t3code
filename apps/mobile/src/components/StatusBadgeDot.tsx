import type { ReactNode } from "react";
import { View } from "react-native";

import { cn } from "../lib/cn";

export type StatusBadgeState = "working" | "waiting" | "done" | "failed" | "limited";

const STATE_CLASS: Readonly<Record<StatusBadgeState, string>> = {
  working: "bg-adaptive-sky-600-400",
  waiting: "bg-foreground-tertiary",
  done: "bg-adaptive-emerald-600-400",
  failed: "bg-danger-foreground",
  limited: "bg-warning-foreground",
};

const DOT = 6;
const RING = 2;
const OUTER = DOT + RING * 2;

/** How far the ring hangs past the icon's corner. */
const OVERHANG = 4;

const CORNER_STYLE = {
  "top-right": { top: -OVERHANG, right: -OVERHANG },
  "bottom-right": { bottom: -OVERHANG, right: -OVERHANG },
} as const;

/**
 * A 6pt status dot with a 2pt ring in the surface colour behind it. Explicit radii on two
 * concentric circles keep both round: iOS's continuous corners would make a squircle of
 * `rounded-full`, and a border would fringe the dot's edge.
 */
export function StatusBadgeDot(props: {
  readonly state: StatusBadgeState;
  /** A background class for the surface directly behind: `bg-screen` on rows, the fill on cards. */
  readonly ringClassName: string;
  /** The icon corner to sit on; omit to render the dot in the flow. */
  readonly corner?: keyof typeof CORNER_STYLE;
  readonly accessibilityLabel?: string;
}) {
  return (
    <View
      accessibilityLabel={props.accessibilityLabel}
      className={cn("items-center justify-center", props.ringClassName)}
      pointerEvents="none"
      style={{
        width: OUTER,
        height: OUTER,
        borderRadius: OUTER / 2,
        borderCurve: "circular",
        ...(props.corner ? { position: "absolute", ...CORNER_STYLE[props.corner] } : null),
      }}
    >
      <View
        className={STATE_CLASS[props.state]}
        style={{ width: DOT, height: DOT, borderRadius: DOT / 2, borderCurve: "circular" }}
      />
    </View>
  );
}

/** An icon with the status dot on its corner. The wrapper sizes to the icon. */
export function WithStatusBadgeDot(props: {
  readonly children: ReactNode;
  readonly state: StatusBadgeState;
  readonly ringClassName: string;
  readonly corner?: keyof typeof CORNER_STYLE;
  readonly accessibilityLabel?: string;
}) {
  return (
    <View>
      {props.children}
      <StatusBadgeDot
        state={props.state}
        ringClassName={props.ringClassName}
        corner={props.corner ?? "top-right"}
        accessibilityLabel={props.accessibilityLabel}
      />
    </View>
  );
}
