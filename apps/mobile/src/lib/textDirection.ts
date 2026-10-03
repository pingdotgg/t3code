import {
  resolveMarkdownProseDirection,
  resolveTextDirection,
  type TextDirection,
} from "@t3tools/shared/textDirection";
import type { MarkdownNode } from "react-native-nitro-markdown";

export function resolveMarkdownNodeTextDirection(node: MarkdownNode): TextDirection {
  return resolveMarkdownProseDirection(node);
}

export { resolveTextDirection };
export type { TextDirection };
