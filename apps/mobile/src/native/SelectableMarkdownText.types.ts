export interface NativeMarkdownTextStyle {
  readonly selectionColor?: string;
  readonly selectionHandleColor?: string;
  readonly color: string;
  readonly strongColor: string;
  readonly mutedColor: string;
  readonly linkColor: string;
  readonly inlineCodeColor: string;
  readonly codeColor: string;
  readonly codeBackgroundColor: string;
  readonly codeBlockBackgroundColor: string;
  readonly fileTextColor: string;
  readonly quoteMarkerColor: string;
  readonly dividerColor: string;
  readonly contextChipBorderColor?: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontFamily: string;
  readonly headingFontFamily: string;
  readonly boldFontFamily: string;
  readonly headingFontSizes?: ReadonlyArray<number>;
}

export interface SelectableMarkdownSkill {
  readonly name: string;
  readonly displayName?: string | null;
  readonly path?: string;
}

export interface MarkdownImageRequest {
  readonly href: string;
  readonly alt: string | null;
  readonly title: string | null;
}

/** Host apps resolve workspace-relative images. Return null to retain Enriched's native media rendering. */
export type MarkdownImageRenderer = (image: MarkdownImageRequest) => import("react").ReactNode;

export type MarkdownImageSourceResolver = (
  image: MarkdownImageRequest,
) =>
  | { uri: string; headers?: Record<string, string> }
  | null
  | Promise<{ uri: string; headers?: Record<string, string> } | null>;

export interface MarkdownFileContextMenuAction {
  readonly id: string;
  readonly title: string;
  readonly disabled?: boolean;
}

export interface MarkdownFileContextMenu {
  readonly title?: string;
  readonly actions: ReadonlyArray<MarkdownFileContextMenuAction>;
}

export interface MarkdownLinkCustomization {
  readonly iconTintColor?: string;
  readonly color?: string;
  readonly label?: string;
  readonly icon?: import("react-native").ImageSourcePropType;
  readonly chip?: { readonly accent?: string; readonly tintsIcon: boolean };
}

export interface SelectableMarkdownTextProps {
  readonly markdown: string;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly preserveSoftBreaks?: boolean;
  readonly onLinkPress?: (href: string) => void;
  readonly fileContextMenu?: (href: string) => MarkdownFileContextMenu | undefined;
  readonly onFileContextMenuAction?: (href: string, actionId: string) => void;
  readonly linkCustomization?: (href: string) => MarkdownLinkCustomization | undefined;
  readonly contextClipboardFragment?: string;
  readonly renderImage?: MarkdownImageRenderer;
  readonly fileEmbedLabel?: (href: string, standalone: boolean) => string | null;
  readonly resolveImageSource?: MarkdownImageSourceResolver;
  readonly onImagePress?: (href: string) => void;
  readonly marginTop?: number;
  readonly marginBottom?: number;
}
