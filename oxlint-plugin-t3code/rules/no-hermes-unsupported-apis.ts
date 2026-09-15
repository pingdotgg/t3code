import { defineRule, type ESTree } from "@oxlint/plugins";

// ES2023 change-array-by-copy methods. Hermes does not implement them, and
// tsconfig targets ESNext, so nothing but this rule stands between a call and a
// TypeError that is fatal on every mobile launch that reaches it.
const UNSUPPORTED_METHODS = new Map([
  ["toSorted", "[...array].sort(...)"],
  ["toReversed", "[...array].reverse()"],
  // splice returns the removed elements, so the copy itself is the result.
  ["toSpliced", "const copy = [...array]; copy.splice(...); use copy"],
]);

function memberName(node: ESTree.MemberExpression): string | null {
  const { property } = node;
  if (!node.computed && property.type === "Identifier") return property.name;
  if (property.type === "Literal" && typeof property.value === "string") return property.value;
  if (property.type === "TemplateLiteral" && property.expressions.length === 0)
    return property.quasis[0]?.value.cooked ?? null;
  return null;
}

function isIntl(node: ESTree.Node): boolean {
  if (node.type === "Identifier") return node.name === "Intl";
  return (
    node.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    ["globalThis", "global", "window"].includes(node.object.name) &&
    memberName(node) === "Intl"
  );
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow unsupported array-by-copy methods and Intl.Segmenter in code that runs on Hermes.",
    },
  },
  create(context) {
    function checkSegmenter(node: ESTree.CallExpression | ESTree.NewExpression) {
      const { callee } = node;
      if (
        callee.type === "MemberExpression" &&
        memberName(callee) === "Segmenter" &&
        isIntl(callee.object)
      ) {
        context.report({
          node: callee.property,
          message:
            "Hermes does not implement Intl.Segmenter. Use unicode-segmenter/grapheme for portable grapheme counting or segmentation.",
        });
      }
    }
    return {
      NewExpression: checkSegmenter,
      CallExpression(node) {
        checkSegmenter(node);
        if (node.callee.type !== "MemberExpression") return;
        const { property } = node.callee;
        const name = memberName(node.callee);
        if (name === null) return;
        const replacement = UNSUPPORTED_METHODS.get(name);
        if (replacement === undefined) return;

        context.report({
          node: property,
          message: `Hermes does not implement Array#${name}. Copy the array first: ${replacement}.`,
        });
      },
    };
  },
});
