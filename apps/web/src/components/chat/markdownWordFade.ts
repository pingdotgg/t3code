type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

// Not prose (code, math, drawings) or read whole by the component that renders it (links).
const UNFADED_TAGS = new Set(["a", "code", "pre", "svg", "math", "kbd", "script", "style"]);

function isUnfaded(node: HastNode): boolean {
  if (node.tagName !== undefined && UNFADED_TAGS.has(node.tagName)) return true;
  const className = node.properties?.className;
  return Array.isArray(className) && className.some((name) => String(name).startsWith("katex"));
}

/**
 * Wraps each word of streamed prose in a span that fades in when it is first added to the page.
 * Words already on screen keep their element across re-renders, so only new words fade. Every
 * word gets a span so the element keys of earlier words never shift.
 */
export function rehypeWordFade() {
  const visit = (node: HastNode): void => {
    if (!node.children || isUnfaded(node)) return;
    const children: HastNode[] = [];
    for (const child of node.children) {
      if (child.type !== "text") {
        visit(child);
        children.push(child);
        continue;
      }
      for (const part of (child.value ?? "").split(/(\s+)/)) {
        if (part.length === 0) continue;
        children.push(
          /^\s/.test(part)
            ? { type: "text", value: part }
            : {
                type: "element",
                tagName: "span",
                properties: { dataWordFade: "" },
                children: [{ type: "text", value: part }],
              },
        );
      }
    }
    node.children = children;
  };
  return visit;
}

/** Marks the words already on screen as shown, so opening a streaming reply does not fade it in whole. */
export function settleWordFades(root: ParentNode): void {
  for (const word of root.querySelectorAll("[data-word-fade]:not([data-word-settled])")) {
    word.setAttribute("data-word-settled", "");
  }
}
