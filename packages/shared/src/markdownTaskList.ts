import type { ListItem, Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified().use(remarkParse).use(remarkGfm);

/** Offset of the `[ ]` marker on the first line of the list item starting at `listItemStart`. */
export function taskListMarkerOffset(markdown: string, listItemStart: number): number | null {
  const firstLineEnd = markdown.indexOf("\n", listItemStart);
  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  );
  const match = firstLine.match(/^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/);
  if (!match?.[1]) return null;
  return listItemStart + firstLine.indexOf(match[1]);
}

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}

/** Hard breaks as U+2028, as iOS draws them; soft breaks stay "\n". */
function plainText(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "break" || (node.type === "html" && /^<br\b/i.test(node.value))) {
    return "\u2028";
  }
  return "children" in node ? node.children.map(plainText).join("") : "";
}

const lettersAndDigits = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, "");

/** iOS sends the first paragraph whole. Android cuts it at a hard break, or any break with hard breaks on. */
function renderedTexts(item: ListItem): string[] {
  const first = item.children[0];
  const text = first?.type === "paragraph" ? plainText(first) : "";
  return [text, text.replace(/\u2028[^]*$/, ""), text.replace(/[\u2028\n][^]*$/, "")].map(
    lettersAndDigits,
  );
}

// Native renderers give other top-level blocks (code, tables, quotes, media) their own views, and
// each view numbers its tasks from 0. Lists, headings and rules share the text view around them.
const sharedViewBlocks = new Set(["list", "heading", "thematicBreak"]);

/**
 * Marker offset of the task a native checkbox tap names. Null unless exactly one task has that
 * text and state and could have that index under some split of the document into native views.
 */
export function markdownTaskMarkerOffset(
  markdown: string,
  index: number,
  renderedText: string,
  checked: boolean,
): number | null {
  // Native attachments replace their labels, so the remaining text could name another task.
  if (renderedText.includes("\uFFFC")) return null;
  const tasks: ListItem[] = [];
  const collect = (node: Nodes) => {
    if (node.type === "listItem" && typeof node.checked === "boolean") tasks.push(node);
    if ("children" in node) node.children.forEach(collect);
  };
  const viewStarts = new Set([0]);
  for (const block of parser.parse(markdown).children) {
    const before = tasks.length;
    collect(block);
    if (sharedViewBlocks.has(block.type)) continue;
    for (let count = before; count <= tasks.length; count++) viewStarts.add(count);
  }
  const rendered = lettersAndDigits(renderedText);
  const matches = tasks.filter(
    (task, position) =>
      task.checked === !checked &&
      viewStarts.has(position - index) &&
      renderedTexts(task).includes(rendered),
  );
  const start = matches.length === 1 ? matches[0]?.position?.start.offset : undefined;
  return start === undefined ? null : taskListMarkerOffset(markdown, start);
}
