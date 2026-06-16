import { type StyleProp, StyleSheet, type TextStyle } from "react-native";
import type { NativeFontWeight } from "./T3MarkdownTextRunNativeComponent";

export function flattenStyles(rootStyle: TextStyle, style: StyleProp<TextStyle>) {
  const flattenedStyle = StyleSheet.flatten([rootStyle, style]) as TextStyle;
  return {
    ...flattenedStyle,
    fontWeight: fontWeightToNativeProp(flattenedStyle.fontWeight ?? "normal"),
    backgroundColor: flattenedStyle.backgroundColor
      ? flattenedStyle.backgroundColor
      : "transparent",
    shadowOffset: flattenedStyle.shadowOffset
      ? flattenedStyle.shadowOffset
      : { width: 0, height: 0 },
  };
}

// Codegen doesn't like using integer values for enums (c++ L) so we'll conver them to the proper native prop
// value before returning flattened styles.
function fontWeightToNativeProp(fontWeight: TextStyle["fontWeight"]): NativeFontWeight {
  switch (fontWeight) {
    case "normal":
      return "normal";
    case "bold":
      return "bold";
    case 100:
    case "100":
    case "ultralight":
      return "ultraLight";
    case 200:
    case "200":
      return "ultraLight";
    case 300:
    case "300":
    case "light":
      return "light";
    case 400:
    case "400":
    case "regular":
      return "normal";
    case 500:
    case "500":
    case "medium":
      return "medium";
    case 600:
    case "600":
    case "semibold":
      return "semibold";
    case 700:
    case "700":
      return "semibold";
    case 800:
    case "800":
      return "bold";
    case 900:
    case "900":
    case "heavy":
      return "heavy";
    default:
      return "normal";
  }
}
