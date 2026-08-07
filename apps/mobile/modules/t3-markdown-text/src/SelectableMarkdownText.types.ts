import type { ThemeColors } from "@t3tools/themes";

export interface NativeMarkdownTextStyle {
  readonly color: string;
  readonly strongColor: string;
  readonly mutedColor: string;
  readonly linkColor: string;
  readonly inlineCodeColor: string;
  readonly codeColor: string;
  readonly codeBackgroundColor: string;
  readonly codeBlockBackgroundColor: string;
  readonly fileTextColor: string;
  readonly skillTextColor: string;
  readonly quoteMarkerColor: string;
  readonly dividerColor: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontFamily: string;
  readonly headingFontFamily: string;
  readonly boldFontFamily: string;
  readonly headingFontSizes?: ReadonlyArray<number>;
}

export interface MarkdownHighlightedToken {
  readonly content: string;
  readonly color: string | null;
  readonly fontStyle: number | null;
}

export type MarkdownColorScheme = "light" | "dark";

export type MarkdownCodeHighlighter = (input: {
  readonly code: string;
  readonly language?: string | null;
  readonly theme: MarkdownColorScheme;
  readonly themeColors?: ThemeColors | null;
}) => Promise<ReadonlyArray<ReadonlyArray<MarkdownHighlightedToken>>>;

export interface SelectableMarkdownSkill {
  readonly name: string;
  readonly displayName?: string | null;
}

export interface SelectableMarkdownTextProps {
  readonly markdown: string;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly highlightCode: MarkdownCodeHighlighter;
  /** Supplied by the app so this reusable renderer never reads OS-only state. */
  readonly colorScheme: MarkdownColorScheme;
  readonly themeColors?: ThemeColors | null;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly preserveSoftBreaks?: boolean;
  readonly onLinkPress?: (href: string) => void;
  readonly marginTop?: number;
  readonly marginBottom?: number;
}
