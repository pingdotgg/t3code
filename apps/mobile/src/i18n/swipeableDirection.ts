import { I18nManager } from "react-native";

// RNGH lays out swipe actions from I18nManager.isRTL, not the inherited `direction` style,
// so a swipeable's container must match the native flag for its actions to sit at the row end.
export const SWIPEABLE_DIRECTION: "ltr" | "rtl" = I18nManager.isRTL ? "rtl" : "ltr";
