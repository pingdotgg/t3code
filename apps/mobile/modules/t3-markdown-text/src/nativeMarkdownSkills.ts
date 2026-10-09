import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import { collectComposerSkillTokens } from "@t3tools/shared/composerInlineTokens";

const OPAQUE_NODES = new Set([
  "code_inline",
  "code_block",
  "link",
  "image",
  "html_inline",
  "html_block",
  "math_inline",
  "math_block",
]);
const utf8 = new TextEncoder();

/** Keep quoted skill source opaque to MD4C, while retaining code/link boundaries and source offsets. */
export function parseNativeMarkdownWithSkillTokens(
  markdown: string,
  parse: (source: string) => MarkdownNode,
): MarkdownNode {
  const document = parse(markdown);
  if (!markdown.includes('"')) return document;
  const quoted = collectComposerSkillTokens(markdown).filter(
    (token) => token.source.includes('"') && /[\\&<>`*_[\]~]/u.test(token.source),
  );
  if (quoted.length === 0) return document;
  const opaque: { start: number; end: number }[] = [];
  const visit = (node: MarkdownNode) => {
    if (OPAQUE_NODES.has(node.type)) {
      if (node.beg !== undefined && node.end !== undefined)
        opaque.push({ start: node.beg, end: node.end });
      return;
    }
    node.children?.forEach(visit);
  };
  visit(document);

  let cursor = 0;
  let byteOffset = 0;
  opaque.sort((left, right) => left.start - right.start);
  let opaqueIndex = 0;
  const tokens = quoted
    .map((token) => {
      byteOffset += utf8.encode(markdown.slice(cursor, token.start)).length;
      const start = byteOffset;
      byteOffset += utf8.encode(token.source).length;
      cursor = token.end;
      return { ...token, byteStart: start, byteEnd: byteOffset };
    })
    .filter((token) => {
      while (opaque[opaqueIndex] && opaque[opaqueIndex]!.end <= token.byteStart) opaqueIndex++;
      for (
        let index = opaqueIndex;
        index < opaque.length && opaque[index]!.start < token.byteEnd;
        index++
      ) {
        const range = opaque[index]!;
        if (!(range.start >= token.byteStart && range.end <= token.byteEnd)) return false;
      }
      return true;
    });
  if (tokens.length === 0) return document;

  const usedPrefixes = new Set(
    Array.from(markdown.matchAll(/T3QuotedSkill(\d+)Z/g), (match) => match[1]),
  );
  let suffix = 0;
  while (usedPrefixes.has(String(suffix))) suffix++;
  const prefix = `T3QuotedSkill${suffix}Z`;
  const parts: string[] = [];
  let protectedByteOffset = 0;
  cursor = 0;
  const replacements = tokens.map((token, index) => {
    const before = markdown.slice(cursor, token.start);
    const marker = `${prefix}${index}Z`;
    parts.push(before, marker);
    protectedByteOffset += utf8.encode(before).length;
    const protectedStart = protectedByteOffset;
    protectedByteOffset += marker.length;
    cursor = token.end;
    return { ...token, marker, protectedStart, protectedEnd: protectedByteOffset };
  });
  parts.push(markdown.slice(cursor));
  const markerPattern = new RegExp(`${prefix}(\\d+)Z`, "g");

  const originalOffset = (offset: number, side: "start" | "end") => {
    let low = 0;
    let high = replacements.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (replacements[middle]!.protectedStart <= offset) low = middle + 1;
      else high = middle;
    }
    const replacement = replacements[low - 1];
    if (!replacement) return offset;
    if (offset < replacement.protectedEnd)
      return side === "start" ? replacement.byteStart : replacement.byteEnd;
    return offset + replacement.byteEnd - replacement.protectedEnd;
  };

  const restore = (node: MarkdownNode): MarkdownNode[] => {
    const restored = {
      ...node,
      ...(node.beg === undefined ? {} : { beg: originalOffset(node.beg, "start") }),
      ...(node.end === undefined ? {} : { end: originalOffset(node.end, "end") }),
      ...(node.children ? { children: node.children.flatMap(restore) } : {}),
    };
    if (node.type !== "text" || node.content === undefined) return [restored];
    const children: MarkdownNode[] = [];
    let position = 0;
    for (const match of node.content.matchAll(markerPattern)) {
      const replacement = replacements[Number(match[1])];
      if (!replacement) continue;
      const start = match.index;
      if (start > position)
        children.push({ type: "text", content: node.content.slice(position, start) });
      const skillNode = {
        type: "text" as const,
        content: replacement.source,
        skillSource: replacement.source,
        beg: replacement.byteStart,
        end: replacement.byteEnd,
      };
      children.push(skillNode);
      position = start + match[0].length;
    }
    if (position === 0) return [restored];
    if (position < node.content.length)
      children.push({ type: "text", content: node.content.slice(position) });
    return children;
  };

  return restore(parse(parts.join("")))[0]!;
}
