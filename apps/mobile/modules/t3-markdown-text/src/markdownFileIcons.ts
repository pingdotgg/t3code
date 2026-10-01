import { Image, type ImageSourcePropType } from "react-native";

import type { MarkdownFileIcon } from "./markdownLinks";
import { MARKDOWN_FILE_ICON_SOURCES } from "./markdownFileIcons.generated";

export function markdownFileIconSource(icon: MarkdownFileIcon): ImageSourcePropType {
  return MARKDOWN_FILE_ICON_SOURCES[icon];
}

/**
 * Bundled icon URI handed to native views that draw the icon themselves. The
 * sources are static requires, so this only comes back undefined when the
 * bundler dropped the asset; callers treat a missing icon as "no icon".
 */
export function markdownIconAssetUri(source: ImageSourcePropType): string | undefined {
  return Image.resolveAssetSource(source)?.uri;
}
