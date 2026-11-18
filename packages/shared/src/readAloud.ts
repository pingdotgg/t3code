import type { RootContent, Root } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const parser = unified().use(remarkParse).use(remarkGfm);

// Already ends a sentence, allowing closing quotes or brackets after the punctuation.
const SENTENCE_END = /[.!?…:;。！？：；]["'”’)\]]*$/u;

/**
 * Plain text with one sentence per line. Speech engines read newlines as spaces, so every
 * heading, paragraph, list item, and table row ends in punctuation to keep its pause.
 */
export function readAloudText(markdown: string, skipCodeBlocks: boolean) {
  const sentences: string[] = [];
  const speak = (text: string) => {
    for (const line of text.split("\n")) {
      const sentence = line.replace(/\s+/g, " ").trim();
      if (sentence) sentences.push(SENTENCE_END.test(sentence) ? sentence : `${sentence}.`);
    }
  };
  const inline = (node: RootContent): string => {
    if (node.type === "break") return "\n";
    if (node.type === "html" || node.type === "image" || node.type === "imageReference") return "";
    if ("children" in node) return node.children.map(inline).join("");
    return "value" in node ? node.value : "";
  };
  const block = (node: Root | RootContent) => {
    if (node.type === "paragraph" || node.type === "heading") speak(inline(node));
    else if (node.type === "tableRow")
      speak(
        node.children
          .map((cell) => inline(cell).trim())
          .filter(Boolean)
          .join(", "),
      );
    else if (node.type === "code") {
      if (!skipCodeBlocks) speak(node.value);
    } else if (node.type !== "html" && node.type !== "definition" && "children" in node)
      for (const child of node.children) block(child);
  };
  block(parser.parse(markdown));
  return sentences.join("\n");
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
