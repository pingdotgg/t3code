import { defineRule, type ESTree } from "@oxlint/plugins";

const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self"]);

function isResizeObserverConstructor(node: ESTree.Node): boolean {
  if (node.type === "Identifier") return node.name === "ResizeObserver";
  if (node.type !== "MemberExpression" || node.object.type !== "Identifier") return false;
  if (!GLOBAL_OBJECTS.has(node.object.name)) return false;
  const { property } = node;
  if (!node.computed && property.type === "Identifier") return property.name === "ResizeObserver";
  return property.type === "Literal" && property.value === "ResizeObserver";
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow constructing ResizeObserver directly in web code; use observeResize.",
    },
  },
  create(context) {
    return {
      NewExpression(node) {
        if (!isResizeObserverConstructor(node.callee)) return;
        context.report({
          node: node.callee,
          message:
            "Use observeResize from ~/lib/observeResize. React commits state set in a raw ResizeObserver callback after the paint, so layout derived from the observed size lands one frame late.",
        });
      },
    };
  },
});
