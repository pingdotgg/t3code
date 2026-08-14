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

/**
 * Paint the adaptive background on the presented screen itself. Nested stacks
 * can stay transparent over this single surface, so a push never exposes an
 * unpainted form-sheet host behind the moving child view controllers.
 */
export const FORM_SHEET_PRESENTATION_OPTIONS = {
  presentation: "formSheet" as const,
  ...(NATIVE_SHEET_SURFACE_CONTENT_STYLE === undefined
    ? null
    : { contentStyle: NATIVE_SHEET_SURFACE_CONTENT_STYLE }),
};
