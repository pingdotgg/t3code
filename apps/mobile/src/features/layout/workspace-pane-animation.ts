import { Easing, ReduceMotion } from "react-native-reanimated";

/** Panes can open and close together; matching duration and easing prevents the center pane from wobbling. */
export const WORKSPACE_PANE_TIMING = {
  duration: 260,
  easing: Easing.inOut(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;
