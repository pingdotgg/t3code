import { defineRule } from "@oxlint/plugins";

const MEMO_DIRECTIVES = new Set(["use memo", "use no memo", "use no forget"]);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow "use memo" and "use no memo" directives; they hide the code a React Compiler bailout points at.',
    },
  },
  create(context) {
    return {
      ExpressionStatement(node) {
        if (typeof node.directive !== "string" || !MEMO_DIRECTIVES.has(node.directive)) return;
        context.report({
          node,
          message: `Drop "${node.directive}": fix the code the compiler cannot prove safe instead of forcing or skipping memoization.`,
        });
      },
    };
  },
});
