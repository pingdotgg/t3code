import { LinearTransition, ReduceMotion } from "react-native-reanimated";

export const THREAD_SIDEBAR_ROW_LAYOUT = LinearTransition.duration(180).reduceMotion(
  ReduceMotion.System,
);
