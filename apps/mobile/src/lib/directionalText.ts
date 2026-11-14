import { Platform } from "react-native";
import { textDirection, type TextDirection } from "@t3tools/shared/textDirection";

export function directionalText(text: string) {
  const direction = textDirection(text);
  // Android ignores writingDirection; a render-only mark sets its first-strong paragraph direction.
  return Platform.OS === "android" && direction
    ? `${direction === "rtl" ? "\u200f" : "\u200e"}${text}`
    : text;
}

export function proseDirectionStyle(text: string, setDirection: TextDirection | undefined) {
  const direction = textDirection(text);
  return {
    ...(direction ? { direction, writingDirection: direction } : null),
    textAlign: (direction === "rtl") === (setDirection === "rtl") ? "left" : "right",
  } as const;
}
