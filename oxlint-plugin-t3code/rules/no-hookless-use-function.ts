import { defineRule, type ESTree } from "@oxlint/plugins";

const HOOK_NAME = /^use[A-Z]/;
// Bare `use` is React 19's `use(promise | context)`, which is a hook call too.
const HOOK_CALLEE = /^use([A-Z]|$)/;

type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

function isFunctionNode(node: ESTree.Node): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function isHookCallee(callee: ESTree.Node): boolean {
  if (callee.type === "Identifier") return HOOK_CALLEE.test(callee.name);
  if (callee.type === "MemberExpression" && !callee.computed) {
    return callee.property.type === "Identifier" && HOOK_CALLEE.test(callee.property.name);
  }
  return false;
}

// A hook call inside a nested callback runs when the callback runs, not during render,
// so it does not make the outer function a hook.
function callsHook(node: unknown, root: unknown): boolean {
  if (typeof node !== "object" || node === null) return false;
  if (Array.isArray(node)) return node.some((child) => callsHook(child, root));
  if (!("type" in node) || typeof node.type !== "string") return false;
  const typed = node as ESTree.Node;
  if (typed !== root && isFunctionNode(typed)) return false;
  if (typed.type === "CallExpression" && isHookCallee(typed.callee)) return true;
  for (const [key, value] of Object.entries(typed)) {
    if (key === "parent") continue;
    if (callsHook(value, root)) return true;
  }
  return false;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow use* functions that call no hooks; the React Compiler only compiles functions that do. Mirrors eslint-react's no-unnecessary-use-prefix, which oxlint does not ship.",
    },
    schema: [],
  },
  create(context) {
    const check = (name: string, fn: FunctionNode, reportNode: ESTree.Node) => {
      if (!HOOK_NAME.test(name)) return;
      if (callsHook(fn.body, fn)) return;
      context.report({
        node: reportNode,
        message: `"${name}" calls no hooks, so the React Compiler skips it and whatever it returns is rebuilt on every render. Rename it to a plain function, or read the hook it depends on inside it.`,
      });
    };
    return {
      FunctionDeclaration(node) {
        if (node.id) check(node.id.name, node, node.id);
      },
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || node.init == null) return;
        if (
          node.init.type !== "ArrowFunctionExpression" &&
          node.init.type !== "FunctionExpression"
        ) {
          return;
        }
        check(node.id.name, node.init, node.id);
      },
    };
  },
});
