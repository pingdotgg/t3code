import type { RootContent, Root } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const parser = unified().use(remarkParse).use(remarkGfm);

export function readAloudText(markdown: string, skipCodeBlocks: boolean) {
  const root = parser.parse(markdown);
  const visit = (node: Root | RootContent): string => {
    if (node.type === "break") return "\n";
    if (node.type === "code") return skipCodeBlocks ? "" : node.value;
    if (
      node.type === "html" ||
      node.type === "definition" ||
      node.type === "image" ||
      node.type === "imageReference"
    )
      return "";
    if ("children" in node) {
      const separator = ["root", "list", "listItem", "blockquote", "table", "tableRow"].includes(
        node.type,
      )
        ? "\n"
        : "";
      return node.children.map(visit).join(separator);
    }
    return "value" in node ? node.value : "";
  };
  return visit(root)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitReadAloudText(text: string, limit = 3500) {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const part = rest.slice(0, limit);
    const sentence = [...part.matchAll(/[.!?。！？](?:\s|$)/gu)].at(-1);
    let at = sentence ? sentence.index + sentence[0].length : part.lastIndexOf(" ");
    if (at <= 0) at = limit;
    if (/[\uD800-\uDBFF]/.test(rest[at - 1] ?? "")) at--;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function speechAudioMimeType(bytes: Uint8Array) {
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0) return "audio/aac";
  return bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70
    ? "audio/wav"
    : "audio/mpeg";
}
