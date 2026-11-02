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

function plainText(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  return "children" in node ? node.children.map(plainText).join("") : "";
}

const lettersAndDigits = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Marker offset of the `index`th task item in document order, the order native renderers number
 * their checkboxes in. Null when `renderedText` shows the renderer counted a different item.
 * Android cuts that text at the item's first line break; iOS sends the whole paragraph.
 */
export function markdownTaskMarkerOffset(
  markdown: string,
  index: number,
  renderedText: string,
): number | null {
  let seen = 0;
  const find = (node: Nodes): ListItem | null => {
    if (node.type === "listItem" && typeof node.checked === "boolean" && seen++ === index) {
      return node;
    }
    if (!("children" in node)) return null;
    for (const child of node.children) {
      const item = find(child);
      if (item !== null) return item;
    }
    return null;
  };
  const item = find(parser.parse(markdown));
  const start = item?.position?.start.offset;
  if (item === null || start === undefined) return null;
  const first = item.children[0];
  const rendered = lettersAndDigits(renderedText);
  const source = lettersAndDigits(first?.type === "paragraph" ? plainText(first) : "");
  if (!rendered.startsWith(source) && !source.startsWith(rendered)) return null;
  return taskListMarkerOffset(markdown, start);
}
