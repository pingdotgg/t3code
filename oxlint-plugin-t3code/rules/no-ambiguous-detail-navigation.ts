import { defineRule, type ESTree } from "@oxlint/plugins";

const DETAIL_ROUTES = new Set(["Thread", "PullRequest"]);

const MESSAGE =
  "`navigate` to a Thread or PullRequest pushes or updates in place depending on what is on top. Use useSelectWorkspaceDetail to show it as the page, or StackActions.push to open it over the current one.";

function calleeName(callee: ESTree.Expression) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return null;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `navigate` to the workspace's detail routes; selections and drill-ins each have one explicit action.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (calleeName(node.callee as ESTree.Expression) !== "navigate") return;
        const [route] = node.arguments;
        if (route?.type !== "Literal" || typeof route.value !== "string") return;
        if (!DETAIL_ROUTES.has(route.value)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
