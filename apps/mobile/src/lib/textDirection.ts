import { resolveTextDirection, type TextDirection } from "@t3tools/shared/textDirection";
import type { MarkdownNode } from "react-native-nitro-markdown";

const GITHUB_ALERT_MARKER = /\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/giu;
const MAX_MARKDOWN_PROSE_CODE_UNITS = 17_408;

function collectMarkdownProse(
  node: MarkdownNode,
  chunks: string[],
  remainingCodeUnits: number,
): number {
  if (remainingCodeUnits === 0) return 0;
  if (node.type === "code_inline" || node.type === "code_block" || node.type === "image") {
    return remainingCodeUnits;
  }

  if (node.type === "text") {
    const text = (node.content ?? "").slice(0, remainingCodeUnits).replace(GITHUB_ALERT_MARKER, "");
    chunks.push(text);
    return remainingCodeUnits - text.length;
  }

  for (const child of node.children ?? []) {
    remainingCodeUnits = collectMarkdownProse(child, chunks, remainingCodeUnits);
    if (remainingCodeUnits === 0) break;
  }
  return remainingCodeUnits;
}

function markdownProse(node: MarkdownNode): string {
  const chunks: string[] = [];
  collectMarkdownProse(node, chunks, MAX_MARKDOWN_PROSE_CODE_UNITS);
  return chunks.join("");
}

export function resolveMarkdownNodeTextDirection(node: MarkdownNode): TextDirection {
  return resolveTextDirection(markdownProse(node));
}

export { resolveTextDirection };
export type { TextDirection };
