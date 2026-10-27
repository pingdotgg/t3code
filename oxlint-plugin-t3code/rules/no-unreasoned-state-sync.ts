import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
const EFFECT_HOOK_TEXT = /use(?:Layout|Insertion)?Effect/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|[\\/](?:tests?|__tests__)[\\/]/;

const isEffectHookCall = (node: ESTree.CallExpression): boolean => {
  const callee = unwrapExpression(node.callee);
  if (Option.isNone(callee)) return false;
  const expression = callee.value;
  if (expression.type === "Identifier") return EFFECT_HOOKS.has(expression.name);
  if (expression.type === "MemberExpression" && !expression.computed) {
    return Option.exists(getPropertyName(expression.property), (name) => EFFECT_HOOKS.has(name));
  }
  return false;
};

// Every kept effect carries its reason in the suppression above it; t3code/require-suppression-reason
// rejects a suppression that does not say why.
export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Report every React effect hook, the usual way state gets synchronized; one that stays says why.",
    },
  },
  create(context) {
    if (TEST_FILE.test(context.filename) || !EFFECT_HOOK_TEXT.test(context.sourceCode.text)) {
      return {};
    }
    return {
      CallExpression(node) {
        if (!isEffectHookCall(node)) return;
        context.report({
          node,
          message:
            "First ask whether this is synchronization that belongs in render or in the handler that causes it. " +
            "If an effect is the honest model, say why on the line above it: " +
            "`// oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <why>`.",
        });
      },
    };
  },
});
