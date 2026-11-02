import type { Nodes } from "mdast";
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

/**
 * Task list items in document order, the order renderers number their checkboxes in. `text` is
 * the item's first paragraph as plain text, to check a renderer's item against the source.
 */
export function markdownTaskListItems(
  markdown: string,
): ReadonlyArray<{ readonly markerOffset: number | null; readonly text: string }> {
  const items: Array<{ markerOffset: number | null; text: string }> = [];
  const visit = (node: Nodes) => {
    if (node.type === "listItem" && typeof node.checked === "boolean") {
      const start = node.position?.start.offset;
      const first = node.children[0];
      items.push({
        markerOffset: start === undefined ? null : taskListMarkerOffset(markdown, start),
        text: first?.type === "paragraph" ? plainText(first) : "",
      });
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(parser.parse(markdown));
  return items;
}
