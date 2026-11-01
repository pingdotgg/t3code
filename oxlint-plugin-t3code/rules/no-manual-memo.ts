import { defineRule, type ESTree } from "@oxlint/plugins";

const MANUAL_MEMO_HOOKS = new Set(["useCallback", "useMemo"]);
// "use no memo" and "use no forget" skip a component the compiler would bail on,
// which hides the bailout from the coverage checks as much as "use memo" does.
const MEMO_DIRECTIVES = new Set(["use memo", "use no memo", "use no forget"]);

const readAllowMemoHooks = (options: ReadonlyArray<unknown>): boolean => {
  const [first] = options;
  return (
    typeof first === "object" &&
    first !== null &&
    "allowMemoHooks" in first &&
    first.allowMemoHooks === true
  );
};

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
        "Disallow useCallback, useMemo and memo directives in files the React Compiler must compile; it memoizes them.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowMemoHooks: {
            type: "boolean",
            description:
              "Still permit useMemo and useCallback while a codebase ratchets toward full compiler coverage; directives stay banned.",
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allowMemoHooks: false }],
  },
  create(context) {
    const allowMemoHooks = readAllowMemoHooks(context.options);
    return {
      // A "use memo" helper only exists to force a cache scope the compiler withheld,
      // which hides the ordering or structure problem that withheld it.
      ExpressionStatement(node) {
        if (typeof node.directive !== "string" || !MEMO_DIRECTIVES.has(node.directive)) return;
        context.report({
          node,
          message:
            node.directive === "use memo"
              ? 'Drop "use memo": restructure so the compiler caches this on its own, e.g. move plain uses of a value before the hook call that splits its scope, or inline the helper.'
              : `Drop "${node.directive}": fix the code the compiler cannot prove safe instead of skipping it.`,
        });
      },
      CallExpression(node) {
        if (allowMemoHooks) return;
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
