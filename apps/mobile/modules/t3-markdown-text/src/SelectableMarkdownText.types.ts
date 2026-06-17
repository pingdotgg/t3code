export interface NativeMarkdownTextStyle {
  readonly color: string;
  readonly strongColor: string;
  readonly mutedColor: string;
  readonly linkColor: string;
  readonly codeColor: string;
  readonly codeBackgroundColor: string;
  readonly codeBlockBackgroundColor: string;
  readonly fileBackgroundColor: string;
  readonly fileTextColor: string;
  readonly skillBackgroundColor: string;
  readonly skillTextColor: string;
  readonly quoteMarkerColor: string;
  readonly dividerColor: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontFamily: string;
  readonly headingFontFamily: string;
  readonly boldFontFamily: string;
}

export interface MarkdownHighlightedToken {
  readonly content: string;
  readonly color: string | null;
  readonly fontStyle: number | null;
}

export type MarkdownCodeHighlighter = (input: {
  readonly code: string;
  readonly language?: string | null;
  readonly theme: "light" | "dark";
}) => Promise<ReadonlyArray<ReadonlyArray<MarkdownHighlightedToken>>>;

export interface SelectableMarkdownSkill {
  readonly name: string;
  readonly displayName?: string | null;
}

export interface SelectableMarkdownTextProps {
  readonly markdown: string;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly highlightCode: MarkdownCodeHighlighter;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly marginTop?: number;
  readonly marginBottom?: number;
}
