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

function writtenNumber(item: MarkdownListNode, source: string): number | undefined {
  const offset = item.position?.start?.offset;
  if (offset === undefined) return undefined;
  WRITTEN_NUMBER.lastIndex = offset;
  const digits = WRITTEN_NUMBER.exec(source)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

/**
 * CommonMark numbers an ordered list from its first marker only, so answers to questions 3 and 5
 * would render as 3 and 4, and prose lines "8. sınıf" then "6. sınıf" as 8 and 9. An item whose
 * written number breaks the sequence keeps it. Unless `always`, a list written as `1.` `1.` `1.`
 * or as a sequence keeps CommonMark numbering. `source` is the text the node's offsets point into.
 */
export function keepOrderedListNumbers(
  node: MarkdownListNode,
  source: string,
  always: boolean,
): void {
  if (!node.children) return;
  if (node.type === "list" && node.ordered) {
    const written = node.children.map((item) => writtenNumber(item, source));
    const shorthand =
      written.every((value) => value === written[0]) ||
      written.every((value, index) => index === 0 || value === (written[index - 1] ?? NaN) + 1);
    if (always || !shorthand) {
      let expected = node.start ?? 1;
      node.children.forEach((item, index) => {
        const value = written[index] ?? expected;
        if (value !== expected) {
          item.data = {
            ...item.data,
            hProperties: { ...item.data?.hProperties, value: String(value) },
          };
        }
        expected = value + 1;
      });
    }
  }
  for (const child of node.children) keepOrderedListNumbers(child, source, always);
}

const enabledProcessors = new WeakSet<object>();

/**
 * Keeps every written number, shorthand included. User messages use it so the sent bubble shows
 * the numbers the composer showed and the agent received.
 */
export function remarkEnableOrderedListNumbers(this: object): undefined {
  enabledProcessors.add(this);
}

export function alwaysKeepsOrderedListNumbers(processor: object): boolean {
  return enabledProcessors.has(processor);
}

/** Sits before list recovery so offsets still point into the file. */
export function remarkKeepOrderedListNumbers(this: object): Transformer<Root> {
  return (tree, file) => {
    keepOrderedListNumbers(tree, String(file), enabledProcessors.has(this));
  };
}
