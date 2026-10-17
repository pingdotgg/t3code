import { defineRule, type ESTree } from "@oxlint/plugins";

const MANUAL_MEMO_HOOKS = new Set(["useCallback", "useMemo"]);

function manualMemoHookName(callee: ESTree.Node): string | null {
  if (callee.type === "Identifier") {
    return MANUAL_MEMO_HOOKS.has(callee.name) ? callee.name : null;
  }
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "React" &&
    callee.property.type === "Identifier" &&
    MANUAL_MEMO_HOOKS.has(callee.property.name)
  ) {
    return callee.property.name;
  }
  return null;
}

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow useCallback and useMemo in files the React Compiler must compile; it memoizes them.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = manualMemoHookName(node.callee);
        if (name === null) return;
        context.report({
          node: node.callee,
          message: `Drop ${name}: the React Compiler memoizes this file. Write the plain value or function, and use useStableCallback only where a handler must keep one identity across renders.`,
        });
      },
    };
  },
});
