import { I18nManager } from "react-native";

// RNGH lays out left/right action slots from I18nManager.isRTL, not the inherited `direction` style,
// so a swipeable's container must match the native flag for leftActions to stay physical left and
// rightActions to stay physical right.
export const SWIPEABLE_DIRECTION: "ltr" | "rtl" = I18nManager.isRTL ? "rtl" : "ltr";

/** Sign of `translationX` that reveals trailing row actions: negative in LTR, positive in RTL. */
export function swipeRevealSign(direction: "ltr" | "rtl"): 1 | -1 {
  return direction === "rtl" ? 1 : -1;
}
