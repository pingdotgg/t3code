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
  value?: string;
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
 * direction each. That leaves the list itself LTR, which is what `data-rtl-item` below is for.
 */
function isAutoDirectionBlock(node: HastNode): boolean {
  if (node.type !== "element" || !node.tagName) return false;
  // A GitHub alert renders as a titled callout whose title is always English, so reading a
  // direction off the quote as a whole would pin every alert to LTR. Its paragraphs are left
  // to speak for themselves.
  if (node.properties?.dataAlert != null) return false;
  return AUTO_DIRECTION_TAGS.has(node.tagName);
}

const FIRST_LETTER = /\p{L}/u;

/**
 * The living right-to-left scripts. Not the full Unicode R/AL bidi classes — those are not
 * expressible as a property escape in JS — but every script a message is realistically in.
 * Kept in step with the mobile client's `markdownTextDirection`, which reads the same rule.
 */
const RIGHT_TO_LEFT_LETTER =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Hanifi_Rohingya}\p{Script=Yezidi}]/u;

function firstLetter(node: HastNode): string | undefined {
  if (node.type === "text") return FIRST_LETTER.exec(node.value ?? "")?.[0];
  for (const child of node.children ?? []) {
    const letter = firstLetter(child);
    if (letter) return letter;
  }
  return undefined;
}

/**
 * A right-to-left item hangs its marker on the list's end side, where an LTR list has no gutter,
 * so the list has to be told it holds one. `:dir(rtl)` would say it in CSS alone, but the build
 * lowers that selector to a `:lang()` list which never matches a `dir="auto"` element.
 *
 * The first strong letter is the same rule `dir="auto"` itself follows, so the two agree; where
 * they don't, the cost is 1.25rem of unused padding rather than text on the wrong side.
 */
function holdsRightToLeftItem(list: HastNode): boolean {
  return (list.children ?? []).some((child) => {
    if (child.tagName !== "li") return false;
    const letter = firstLetter(child);
    return letter != null && RIGHT_TO_LEFT_LETTER.test(letter);
  });
}

export function rehypeAutoTextDirection() {
  return (tree: HastNode) => {
    const visit = (node: HastNode, taggedAncestor: string | undefined) => {
      const tag = taggedAncestor === undefined && isAutoDirectionBlock(node);
      if (tag) {
        node.properties = { ...node.properties, dir: "auto" };
      }
      const isList = node.tagName === "ul" || node.tagName === "ol";
      if (isList && holdsRightToLeftItem(node)) {
        node.properties = { ...node.properties, dataRtlItem: "" };
      }
      // A list under an item starts the outermost-only rule over, so an English item nested under
      // an Arabic one still reads its own way round: the item above it keeps its own line for
      // `auto` to read. A list under a quote does not get that — a quote's whole content can be
      // the list, and tagging the items would leave the rail nothing to read and pin it left.
      const childAncestor =
        isList && taggedAncestor === "li" ? undefined : tag ? node.tagName : taggedAncestor;
      node.children?.forEach((child) => visit(child, childAncestor));
    };
    visit(tree, undefined);
  };
}
