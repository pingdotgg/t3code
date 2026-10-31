import { Platform } from "react-native";
import { textDirection } from "@t3tools/shared/textDirection";

export function directionalText(text: string) {
  const direction = textDirection(text);
  // Android ignores writingDirection; a render-only mark sets its first-strong paragraph direction.
  return Platform.OS === "android" && direction
    ? `${direction === "rtl" ? "\u200f" : "\u200e"}${text}`
    : text;
}
