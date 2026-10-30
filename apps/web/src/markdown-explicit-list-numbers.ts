import type { Nodes, Root } from "mdast";

const LIST_ITEM_NUMBER = /[ \t]*(\d{1,9})[.)]/y;

/**
 * CommonMark keeps only an ordered list's first number, so `1.` `5.` `8.` renders
 * as 1, 2, 3. Users type the numbers they mean, so their messages keep each one
 * as the item's `value`. A list that repeats one number (`1.` `1.` `1.`) is the
 * Markdown shorthand for auto-numbering and stays numbered as CommonMark does.
 */
export function remarkExplicitListNumbers() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (node: Nodes) => {
      if (node.type === "list" && node.ordered) {
        const typedNumbers = node.children.map((item) => {
          const offset = item.position?.start.offset;
          if (offset === undefined) return undefined;
          LIST_ITEM_NUMBER.lastIndex = offset;
          const typed = LIST_ITEM_NUMBER.exec(source)?.[1];
          return typed === undefined ? undefined : Number(typed);
        });
        if (typedNumbers.some((typed) => typed !== typedNumbers[0])) {
          let displayed = (node.start ?? 1) - 1;
          node.children.forEach((item, index) => {
            const number = typedNumbers[index] ?? displayed + 1;
            if (number !== displayed + 1) {
              item.data = {
                ...item.data,
                hProperties: { ...item.data?.hProperties, value: String(number) },
              };
            }
            displayed = number;
          });
        }
      }
      if ("children" in node) for (const child of node.children) visit(child);
    };
    visit(tree);
  };
}
