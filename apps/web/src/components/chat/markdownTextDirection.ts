import { LETTER, RTL_LETTER, textDirection } from "~/textDirection";

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

// Raw HTML such as `<li>a</li><li>b</li>` has no whitespace between its
// blocks, so they add their own to keep the words apart.
const BLOCK_TAGS = new Set([
  "blockquote",
  "br",
  "details",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "summary",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

function proseText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "code") return " ";
  const text = (node.children ?? []).map(proseText).join("");
  return node.tagName && BLOCK_TAGS.has(node.tagName) ? ` ${text} ` : text;
}

function isolateInlineCode(node: HastNode): void {
  if (node.tagName === "pre") return;
  if (node.tagName === "code") {
    node.properties = { ...node.properties, dir: "ltr" };
    return;
  }
  node.children?.forEach(isolateInlineCode);
}

/**
 * Gives each top-level block the direction of its own words, so an Arabic or
 * Hebrew reply reads right to left beside English ones. Lines inside a list or
 * quote follow it, keeping markers and rules on one side. Inline code is left
 * out of the count and isolated left to right, so its punctuation stays put.
 */
export function rehypeTextDirection() {
  return (tree: HastNode) => {
    blockTextDirections(tree);
    isolateInlineCode(tree);
  };
}

/** The top-level half of rehypeTextDirection, for trees whose inline code is already isolated. */
export function blockTextDirections(tree: HastNode) {
  for (const block of tree.children ?? []) {
    if (block.type !== "element" || block.tagName === "pre") continue;
    const dir = scriptOf(block) === "rtl" ? textDirection(proseText(block)) : scriptOf(block);
    if (dir) block.properties = { ...block.properties, dir };
  }
}


/** "rtl" when any prose letter is right-to-left; otherwise what textDirection would say. */
function scriptOf(node: HastNode): "rtl" | "ltr" | undefined {
  let found: "ltr" | undefined;
  const visit = (current: HastNode): boolean => {
    if (current.type === "text") {
      const value = current.value ?? "";
      if (RTL_LETTER.test(value)) return true;
      if (!found && LETTER.test(value)) found = "ltr";
      return false;
    }
    if (current.tagName === "code") return false;
    return (current.children ?? []).some(visit);
  };
  return visit(node) ? "rtl" : found;
}
