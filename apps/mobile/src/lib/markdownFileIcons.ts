import { Image, type ImageSourcePropType } from "react-native";

import type { MarkdownFileIcon } from "./markdownLinks";
import { MARKDOWN_FILE_ICON_SOURCES } from "./markdownFileIcons.generated";

export function markdownFileIconSource(icon: MarkdownFileIcon): ImageSourcePropType {
  return MARKDOWN_FILE_ICON_SOURCES[icon];
}

export function markdownIconAssetUri(source: ImageSourcePropType): string | undefined {
  return Image.resolveAssetSource(source)?.uri;
}
