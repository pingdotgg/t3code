import type { ImageSourcePropType } from "react-native";

import type { MarkdownLinkIcon } from "./markdownLinks";

// Black-on-transparent marks; callers tint them with the link color.
const MARKDOWN_LINK_ICON_SOURCES = {
  github: require("../assets/link-icons/github.png"),
} as const satisfies Readonly<Record<MarkdownLinkIcon, ImageSourcePropType>>;

export function markdownLinkIconSource(icon: MarkdownLinkIcon): ImageSourcePropType {
  return MARKDOWN_LINK_ICON_SOURCES[icon];
}
