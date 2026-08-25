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

export type MarkdownCodeHighlighter = (input: {
  readonly code: string;
  readonly language?: string | null;
  readonly theme: "light" | "dark";
}) => Promise<ReadonlyArray<ReadonlyArray<MarkdownHighlightedToken>>>;

export interface SelectableMarkdownSkill {
  readonly name: string;
  readonly displayName?: string | null;
}

export interface MarkdownImageRequest {
  readonly href: string;
  readonly alt: string | null;
  readonly title: string | null;
}

/**
 * App-supplied renderer for markdown images. The module cannot load
 * workspace-relative image paths itself — the host app resolves them (for
 * example through a signed asset URL) and returns the element to show.
 * Returning null falls back to the module's plain remote-URI rendering.
 */
export type MarkdownImageRenderer = (image: MarkdownImageRequest) => import("react").ReactNode;

export interface SelectableMarkdownTextProps {
  readonly markdown: string;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly highlightCode: MarkdownCodeHighlighter;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly preserveSoftBreaks?: boolean;
  readonly onLinkPress?: (href: string) => void;
  readonly renderImage?: MarkdownImageRenderer;
  readonly marginTop?: number;
  readonly marginBottom?: number;
}
