import {
  LinearTransition,
  ReduceMotion,
  type LayoutAnimationFunction,
} from "react-native-reanimated";

export const THREAD_SIDEBAR_ROW_LAYOUT = LinearTransition.duration(180).reduceMotion(
  ReduceMotion.System,
);

const animateSidebarRow = THREAD_SIDEBAR_ROW_LAYOUT.build();

export const ANDROID_THREAD_SIDEBAR_ROW_LAYOUT: LayoutAnimationFunction = (values) => {
  "worklet";
  // Animating row widths during a pane resize leaves Android text clipped at its old layout.
  return values.currentWidth === values.targetWidth
    ? animateSidebarRow(values)
    : {
        initialValues: {
          originX: values.targetOriginX,
          originY: values.targetOriginY,
          width: values.targetWidth,
          height: values.targetHeight,
        },
        animations: {},
      };
};
