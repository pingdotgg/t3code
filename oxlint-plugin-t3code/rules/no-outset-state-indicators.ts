import { defineRule, type ESTree } from "@oxlint/plugins";

const CLASS_COMPOSERS = new Set(["cn", "clsx", "classNames", "cva", "twMerge"]);
const STATE_VARIANT =
  /(?:^|[^\w])(?:focus(?:-visible|-within)?|selected|checked|pressed)(?=$|[^\w])/u;
const RING_WIDTH = /^ring(?:-(?:[1-9]\d*|\[[^\]]+\]|\(length:[^)]+\)))?$/u;
// Pixel widths only; arbitrary values like `outline-[#243c5a]` are colors.
const OUTLINE_WIDTH = /^outline-(?:(\d+)|\[(?:length:)?(\d+(?:\.\d+)?)px\])$/u;
const INWARD_OFFSET = /^-outline-offset-(\d+)$/u;

/** Splits `dark:[&_a]:ring-2!` into its variants and utility, ignoring colons inside brackets. */
function parseClass(token: string) {
  const variants: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index++) {
    const character = token[index];
    if (character === "[" || character === "(") depth++;
    else if (character === "]" || character === ")") depth--;
    else if (character === ":" && depth === 0) {
      variants.push(token.slice(start, index));
      start = index + 1;
    }
  }
  return { variants, utility: token.slice(start).replace(/^!|!$/gu, "") };
}

type ParsedClass = ReturnType<typeof parseClass>;

/** A companion applies when its variants are a subset of the indicator's variants. */
const covers = (companion: ParsedClass, indicator: ParsedClass) =>
  companion.variants.every((variant) => indicator.variants.includes(variant));

const isClassComposer = (node: ESTree.Node) =>
  node.type === "CallExpression" &&
  node.callee.type === "Identifier" &&
  CLASS_COMPOSERS.has(node.callee.name);

/** Strings a composition always includes; branches, class maps, and other calls are not guaranteed. */
function collectStrings(node: unknown, out: string[]) {
  if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, out);
    return;
  }
  if (typeof node !== "object" || node === null || !("type" in node)) return;
  const current = node as ESTree.Node;
  if (/^(?:Conditional|Logical|Object)Expression$/u.test(current.type)) return;
  if (current.type === "CallExpression" && !isClassComposer(current)) return;
  if (current.type === "Literal" && typeof current.value === "string") out.push(current.value);
  if (current.type === "TemplateElement") out.push(current.value.cooked ?? current.value.raw);
  for (const [key, value] of Object.entries(current)) {
    if (key !== "parent") collectStrings(value, out);
  }
}

/** Classes guaranteed alongside a node by each enclosing `cn(...)`, so sibling companions count. */
function scopeClasses(node: ESTree.Node, own: ParsedClass[]) {
  const strings: string[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if (/Statement$|Declaration$|^JSX(?:Attribute|Element)$/u.test(current.type)) break;
    if (isClassComposer(current)) collectStrings(current, strings);
  }
  return [...own, ...strings.join(" ").split(/\s+/u).map(parseClass)];
}

function offenders(text: string, node: ESTree.Node) {
  const own = text.split(/\s+/u).filter(Boolean).map(parseClass);
  const found: string[] = [];
  let scope: ParsedClass[] | undefined;
  for (const token of own) {
    const { utility, variants } = token;
    const label = [...variants, utility].join(":");
    // Positive offsets push the outline out of the element; the app default is inward.
    if (/^outline-offset-|^\[outline-offset:/u.test(utility)) {
      found.push(label);
      continue;
    }
    if (!STATE_VARIANT.test(variants.join(":"))) continue;
    if (RING_WIDTH.test(utility)) {
      scope ??= scopeClasses(node, own);
      const inset = scope.some((other) => other.utility === "ring-inset" && covers(other, token));
      if (!inset) found.push(label);
      continue;
    }
    const outline = OUTLINE_WIDTH.exec(utility);
    if (outline) {
      const width = Number(outline[1] ?? outline[2]);
      if (width <= 2) continue;
      scope ??= scopeClasses(node, own);
      const inward = scope.some((other) => {
        const offset = INWARD_OFFSET.exec(other.utility);
        return offset !== null && Number(offset[1]) >= width && covers(other, token);
      });
      if (!inward) found.push(label);
    }
  }
  return found;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep focus and selection indicators inside their element, where an ancestor cannot clip them.",
    },
  },
  create(context) {
    const check = (node: ESTree.Node, text: string) => {
      for (const utility of offenders(text, node)) {
        context.report({
          node,
          message: `${utility} paints a focus or selection indicator outside its element, where an ancestor can clip it. Add ring-inset under the same variant, drop the positive outline offset, or use a negative offset at least as wide as the outline.`,
        });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateLiteral(node) {
        check(node, node.quasis.map((part) => part.value.cooked ?? part.value.raw).join(" "));
      },
    };
  },
});
