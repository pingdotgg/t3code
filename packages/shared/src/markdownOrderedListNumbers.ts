import type { Root } from "mdast";
import type { Transformer } from "unified";

interface MarkdownListNode {
  readonly type: string;
  readonly ordered?: boolean | null | undefined;
  readonly start?: number | null | undefined;
  readonly position?:
    | { readonly start?: { readonly offset?: number | undefined } | undefined }
    | undefined;
  data?: { hProperties?: Record<string, unknown> | undefined } | undefined;
  children?: MarkdownListNode[] | undefined;
}

const WRITTEN_NUMBER = /[ \t]*(\d{1,9})[.)]/y;

/**
 * CommonMark numbers an ordered list from its first marker only, so answers to questions 3 and 5
 * would render as 3 and 4. An item whose written number breaks the sequence keeps it. `source` is
 * the text the node's offsets point into.
 */
export function keepOrderedListNumbers(node: MarkdownListNode, source: string): void {
  if (!node.children) return;
  if (node.type === "list" && node.ordered) {
    let expected = node.start ?? 1;
    for (const item of node.children) {
      const offset = item.position?.start?.offset;
      WRITTEN_NUMBER.lastIndex = offset ?? 0;
      const digits = offset === undefined ? undefined : WRITTEN_NUMBER.exec(source)?.[1];
      const value = digits === undefined ? expected : Number(digits);
      if (value !== expected) {
        item.data = {
          ...item.data,
          hProperties: { ...item.data?.hProperties, value: String(value) },
        };
      }
      expected = value + 1;
    }
  }
  for (const child of node.children) keepOrderedListNumbers(child, source);
}

export function remarkKeepOrderedListNumbers(): Transformer<Root> {
  return (tree, file) => keepOrderedListNumbers(tree, String(file));
}
