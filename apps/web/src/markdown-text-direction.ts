/**
 * Mixed Arabic/English markdown reads wrong under a single LTR direction: an Arabic paragraph
 * keeps its trailing punctuation on the left, and a line that opens in Arabic is laid out from
 * the wrong edge. `dir="auto"` hands each text block to the browser's own bidi algorithm, which
 * picks direction from the block's first strong character — per block, so an Arabic paragraph
 * and the English one under it each get their own.
 *
 * Text blocks only. Code and layout containers stay as they are: reversing a `<pre>` or a
 * table's column order changes meaning rather than presentation.
 */

interface HastNode {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const AUTO_DIRECTION_TAGS = new Set([
  "p",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "td",
  "th",
  "dd",
  "dt",
  "summary",
  "figcaption",
]);

/**
 * The auto algorithm skips text inside descendants that carry their own `dir`, so tagging a
 * block and its children leaves the outer one with nothing to read and it silently falls back
 * to LTR — a quote whose paragraph is Arabic would keep its rule on the left. Only the
 * outermost block of a nest gets tagged; everything under it inherits.
 *
 * `ul`/`ol` are deliberately absent so their items stay the outermost blocks and keep a
 * direction each. That leaves the list itself LTR, which is why the stylesheet pads both of
 * its inline sides: a right-to-left item's marker needs room on the side it lands on.
 */
function isAutoDirectionBlock(node: HastNode): boolean {
  if (node.type !== "element" || !node.tagName) return false;
  // A GitHub alert renders as a titled callout whose title is always English, so reading a
  // direction off the quote as a whole would pin every alert to LTR. Its paragraphs are left
  // to speak for themselves.
  if (node.properties?.dataAlert != null) return false;
  return AUTO_DIRECTION_TAGS.has(node.tagName);
}

export function rehypeAutoTextDirection() {
  return (tree: HastNode) => {
    const visit = (node: HastNode, insideTaggedBlock: boolean) => {
      const tag = !insideTaggedBlock && isAutoDirectionBlock(node);
      if (tag) {
        node.properties = { ...node.properties, dir: "auto" };
      }
      node.children?.forEach((child) => visit(child, insideTaggedBlock || tag));
    };
    visit(tree, false);
  };
}
