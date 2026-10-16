import { Easing, ReduceMotion } from "react-native-reanimated";

/**
 * Panes frequently animate together — opening the sidebar can auto-close the inspector when both
 * no longer fit — so identical duration and easing on every pane keeps the center content pane
 * from wobbling while both edges move.
 */
export const WORKSPACE_PANE_TIMING = {
  duration: 260,
  easing: Easing.inOut(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;
