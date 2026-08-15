import { DynamicColorIOS, Platform, type ColorValue, type ViewStyle } from "react-native";

/**
 * One opaque surface for content rendered inside a native form sheet.
 *
 * UIKit owns the outer sheet material and rounded corners. The presented route
 * owns this surface so nested navigators never expose a differently colored
 * native container while their screens move.
 */
export const NATIVE_SHEET_SURFACE_COLOR: ColorValue | undefined =
  Platform.OS === "ios" ? DynamicColorIOS({ light: "#f2f2f7", dark: "#0e0e0e" }) : undefined;

export const NATIVE_SHEET_SURFACE_CONTENT_STYLE: ViewStyle | undefined =
  NATIVE_SHEET_SURFACE_COLOR === undefined
    ? undefined
    : { backgroundColor: NATIVE_SHEET_SURFACE_COLOR };

export const FORM_SHEET_PRESENTATION_OPTIONS = {
  presentation: "formSheet" as const,
};
