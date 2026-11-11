type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const LEADING_PUNCTUATION = /^[.,:;!?…)\]}"'’”]+/;

// Browsers allow a wrap after inline-flex chips even before punctuation.
export function rehypeChipPunctuation() {
  const visit = (node: HastNode): void => {
    if (node.tagName === "pre" || !node.children) return;
    const children: HastNode[] = [];
    for (const child of node.children) {
      visit(child);
      const previous = children.at(-1);
      const punctuation =
        child.type === "text" && (previous?.tagName === "a" || previous?.tagName === "code")
          ? LEADING_PUNCTUATION.exec(child.value ?? "")?.[0]
          : undefined;
      if (!previous || !punctuation) {
        children.push(child);
        continue;
      }
      children[children.length - 1] = {
        type: "element",
        tagName: "span",
        properties: {
          className: ["has-[[data-slot=context-chip-label]]:whitespace-nowrap"],
        },
        children: [previous, { type: "text", value: punctuation }],
      };
      const rest = (child.value ?? "").slice(punctuation.length);
      if (rest) children.push({ ...child, value: rest });
    }
    node.children = children;
  };
  return visit;
}
