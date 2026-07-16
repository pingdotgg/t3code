import {
  SelectableMarkdownText as T3SelectableMarkdownText,
  type SelectableMarkdownTextProps,
} from "@t3tools/mobile-markdown-text/renderer";
import { View } from "react-native";

import { highlightCodeSnippet } from "../features/review/shikiReviewHighlighter";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode"> & {
  readonly fillWidth?: boolean;
};

export type {
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@t3tools/mobile-markdown-text/types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText({
  fillWidth = false,
  ...props
}: MobileSelectableMarkdownTextProps) {
  const content = (
    <T3SelectableMarkdownText
      {...props}
      fillWidth={fillWidth}
      highlightCode={highlightCodeSnippet}
    />
  );

  if (!fillWidth) {
    return content;
  }

  return <View style={{ alignSelf: "stretch", flexShrink: 1, minWidth: 0 }}>{content}</View>;
}
