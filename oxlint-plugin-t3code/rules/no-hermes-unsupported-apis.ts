import { defineRule, type ESTree } from "@oxlint/plugins";

// Add global APIs by dotted path, or instance methods by name. Values explain the replacement.
const UNSUPPORTED_GLOBAL_APIS = new Map([
  [
    "Intl.Segmenter",
    "Use a portable implementation or a simpler character-counting approximation.",
  ],
]);

const UNSUPPORTED_METHODS = new Map([
  [
    "toSorted",
    "Hermes does not implement Array#toSorted. Copy the array first: [...array].sort(...).",
  ],
  [
    "toReversed",
    "Hermes does not implement Array#toReversed. Copy the array first: [...array].reverse().",
  ],
  // splice returns the removed elements, so the copy itself is the result.
  [
    "toSpliced",
    "Hermes does not implement Array#toSpliced. Copy the array first: const copy = [...array]; copy.splice(...); use copy.",
  ],
]);

function memberName(node: ESTree.MemberExpression): string | null {
  const { property } = node;
  if (!node.computed && property.type === "Identifier") return property.name;
  if (property.type === "Literal" && typeof property.value === "string") return property.value;
  if (property.type === "TemplateLiteral" && property.expressions.length === 0)
    return property.quasis[0]?.value.cooked ?? null;
  return null;
}

function globalApiPath(node: ESTree.Node): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type !== "MemberExpression") return null;
  const object = globalApiPath(node.object);
  const property = memberName(node);
  if (object === null || property === null) return null;
  return ["globalThis", "global", "window"].includes(object) ? property : `${object}.${property}`;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow APIs that Hermes does not implement in mobile and shared client code.",
    },
  },
  create(context) {
    function checkApi(node: ESTree.CallExpression | ESTree.NewExpression) {
      const path = globalApiPath(node.callee);
      const replacement = path === null ? undefined : UNSUPPORTED_GLOBAL_APIS.get(path);
      if (replacement !== undefined) {
        context.report({
          node: node.callee,
          message: `Hermes does not implement ${path}. ${replacement}`,
        });
        return;
      }
      if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
      const name = memberName(node.callee);
      const message = name === null ? undefined : UNSUPPORTED_METHODS.get(name);
      if (message !== undefined) context.report({ node: node.callee.property, message });
    }
    return { NewExpression: checkApi, CallExpression: checkApi };
  },
});
