import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const BROWSER_TEST_FILE = /\.browser\.test\.[cm]?[jt]sx?$/u;
const LIFECYCLE_HOOKS = new Set(["afterAll", "afterEach", "beforeAll", "beforeEach"]);
const REACT_ACT_EXPORTS = new Set(["act", "unstable_act"]);
const ACT_ENVIRONMENT = "IS_REACT_ACT_ENVIRONMENT";
const HELPER = "Render with `await using screen = await render(...)` from apps/web/test/render.tsx";

const MESSAGES = {
  reactDomClient: `${HELPER}; it owns the React root and unmounts it on dispose.`,
  reactAct: `${HELPER} and import \`act\` from there; it enables React's act environment only while act runs.`,
  actEnvironment: `${HELPER}; its act() sets ${ACT_ENVIRONMENT} for exactly as long as it runs.`,
  lifecycleHook:
    "Browser tests acquire what they need with `using`/`await using` instead of lifecycle hooks, so nothing outlives the test that created it.",
};

const stringValue = (node: ESTree.Node | null | undefined) =>
  node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;

const namesActEnvironment = (node: unknown) => {
  const target = unwrapExpression(node);
  if (Option.isNone(target)) return false;
  if (target.value.type === "Identifier") return target.value.name === ACT_ENVIRONMENT;
  if (target.value.type !== "MemberExpression") return false;
  const property = target.value.computed
    ? Option.fromNullishOr(stringValue(target.value.property))
    : getPropertyName(target.value.property);
  return Option.getOrUndefined(property) === ACT_ENVIRONMENT;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require web component tests to render through the disposable test helper instead of managing React roots, act, or lifecycle hooks by hand.",
    },
  },
  create(context) {
    const isBrowserTest = BROWSER_TEST_FILE.test(context.filename);

    return {
      ImportDeclaration(node) {
        if (node.source.value === "react-dom/client") {
          context.report({ node: node.source, message: MESSAGES.reactDomClient });
          return;
        }
        if (node.source.value !== "react") return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          const imported =
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value;
          if (REACT_ACT_EXPORTS.has(imported)) {
            context.report({ node: specifier, message: MESSAGES.reactAct });
          }
        }
      },
      AssignmentExpression(node) {
        if (namesActEnvironment(node.left)) {
          context.report({ node: node.left, message: MESSAGES.actEnvironment });
        }
      },
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee)) return;
        if (callee.value.type === "MemberExpression") {
          // vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true) leaves the flag on for the whole test.
          const method = getPropertyName(callee.value.property);
          if (
            Option.getOrUndefined(method) === "stubGlobal" &&
            stringValue(node.arguments[0] as ESTree.Node | undefined) === ACT_ENVIRONMENT
          ) {
            context.report({ node, message: MESSAGES.actEnvironment });
          }
          return;
        }
        if (
          isBrowserTest &&
          callee.value.type === "Identifier" &&
          LIFECYCLE_HOOKS.has(callee.value.name)
        ) {
          context.report({ node: node.callee, message: MESSAGES.lifecycleHook });
        }
      },
    };
  },
});
