import {
  SelectableMarkdownText as T3SelectableMarkdownText,
  type SelectableMarkdownTextProps,
} from "@t3tools/mobile-markdown-text/renderer";

import { highlightCodeSnippet } from "../features/review/shikiReviewHighlighter";
import {
  useAppearanceColorScheme,
  useAppearancePreferences,
} from "../features/settings/appearance/AppearancePreferencesProvider";

type MobileSelectableMarkdownTextProps = Omit<
  SelectableMarkdownTextProps,
  "highlightCode" | "colorScheme" | "themeColors"
>;

export type {
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@t3tools/mobile-markdown-text/types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText(props: MobileSelectableMarkdownTextProps) {
  const colorScheme = useAppearanceColorScheme();
  const { themeColors } = useAppearancePreferences();

  return (
    <T3SelectableMarkdownText
      {...props}
      colorScheme={colorScheme}
      highlightCode={highlightCodeSnippet}
      themeColors={themeColors}
    />
  );
}
