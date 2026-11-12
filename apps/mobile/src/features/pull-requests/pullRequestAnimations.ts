import {
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  withTiming,
  type LayoutAnimationFunction,
} from "react-native-reanimated";

export const PR_ROW_LAYOUT = LinearTransition.duration(180).reduceMotion(ReduceMotion.System);
export const PR_ROW_ENTER = FadeIn.duration(140).reduceMotion(ReduceMotion.System);
export const PR_ROW_EXIT = FadeOut.duration(100).reduceMotion(ReduceMotion.System);

export const PR_DISCLOSURE_ENTER = FadeIn.delay(80).duration(120).reduceMotion(ReduceMotion.System);

// Follow expanding status rows without interpolating the clipped markdown's height.
export const PR_POSITION_LAYOUT: LayoutAnimationFunction = (values) => {
  "worklet";
  return {
    initialValues: {
      originX: values.targetOriginX,
      originY: values.currentOriginY,
      width: values.targetWidth,
      height: values.targetHeight,
    },
    animations: {
      originX: values.targetOriginX,
      originY: withTiming(values.targetOriginY, {
        duration: 180,
        reduceMotion: ReduceMotion.System,
      }),
      width: values.targetWidth,
      height: values.targetHeight,
    },
  };
};
