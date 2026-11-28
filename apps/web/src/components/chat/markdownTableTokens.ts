type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const WRAP_ATTRIBUTE = "dataMarkdownWrapAnywhere";
const LONG_TOKEN_LENGTH = 16;
const PATH_CHARACTER = /[\\/_.]/;
const TOKENS = /\s+|\S+/g;

function wrapper(value: string): HastNode {
  return {
    type: "element",
    tagName: "span",
    properties: { [WRAP_ATTRIBUTE]: "" },
    children: [{ type: "text", value }],
  };
}

/** Splits text into tokens, wrapping only those a table cannot otherwise break. */
function wrapLongTokens(value: string, pathOnly: boolean): HastNode[] | null {
  const tokens = value.match(TOKENS);
  if (tokens === null) return null;
  let wrapped = false;
  const children = tokens.map((token) => {
    if (token.length > LONG_TOKEN_LENGTH && (!pathOnly || PATH_CHARACTER.test(token))) {
      wrapped = true;
      return wrapper(token);
    }
    return { type: "text", value: token };
  });
  return wrapped ? children : null;
}

/**
 * Long paths and identifiers in a table cell hold their min-content width, so Chromium gives
 * their column too much room and squeezes the prose beside it. Wrapping just those tokens makes
 * them breakable at any character without letting them take over a column on their own. Links
 * and formulas already handle their own wrapping, and short code such as `fix/table` stays whole.
 */
export function rehypeWrapLongTableTokens() {
  const visit = (node: HastNode, inCell: boolean): void => {
    if (node.type !== "root" && node.type !== "element") return;
    const children = node.children;
    if (children === undefined) return;
    const tag = node.tagName;
    const opaque =
      tag === "a" ||
      tag === "pre" ||
      tag === "svg" ||
      node.properties?.[WRAP_ATTRIBUTE] !== undefined ||
      node.properties?.dataMarkdownMath !== undefined;
    const childCell = (inCell || tag === "th" || tag === "td") && !opaque;
    const inlineCode = childCell && tag === "code" && node.properties?.dataInlineCode !== undefined;

    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      if (child.type === "text") {
        if (!childCell) continue;
        const parts = wrapLongTokens(child.value ?? "", !inlineCode);
        if (parts !== null) children.splice(index, 1, ...parts);
        continue;
      }
      if (child.type === "element") visit(child, childCell);
    }
  };
  return (tree: HastNode) => visit(tree, false);
}
