import { defineRule } from "@oxlint/plugins";

// ES2023 change-array-by-copy methods. Hermes does not implement them, and
// tsconfig targets ESNext, so nothing but this rule stands between a call and a
// TypeError that is fatal on every mobile launch that reaches it.
const UNSUPPORTED_METHODS = new Map([
  ["toSorted", "[...array].sort(...)"],
  ["toReversed", "[...array].reverse()"],
  ["toSpliced", "[...array].splice(...)"],
]);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow ES2023 array-by-copy methods (toSorted, toReversed, toSpliced) in code that runs on Hermes.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        const { property } = node.callee;
        const name =
          property.type === "Identifier"
            ? property.name
            : property.type === "Literal" && typeof property.value === "string"
              ? property.value
              : null;
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
