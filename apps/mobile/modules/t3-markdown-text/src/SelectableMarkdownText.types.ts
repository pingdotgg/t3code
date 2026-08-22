import type { ReactNode } from "react";

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

export interface MarkdownImageSource {
  readonly href: string;
  readonly alt?: string | undefined;
  readonly title?: string | undefined;
}

/**
 * Overrides how block images render. `renderDefault` draws the module's own
 * image frame for a uri, so overrides that only swap the uri (e.g. a signed
 * asset URL for a workspace path) keep the native look; passing undefined
 * draws the empty frame as a placeholder.
 */
export type MarkdownImageRenderer = (
  image: MarkdownImageSource,
  renderDefault: (uri: string | undefined) => ReactNode,
) => ReactNode;

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
