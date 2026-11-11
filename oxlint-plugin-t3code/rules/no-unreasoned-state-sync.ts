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

// Agents read this message and act on it, so it walks the alternatives before it shows the way out.
const MESSAGE =
  "Stop and reconsider before keeping this effect. " +
  "Is it computable from props or state? Compute it during render; the compiler memoizes it. " +
  "Does it respond to a user action? Do it in that handler. " +
  "Does it reset state when a prop changes? Key the component on that prop. " +
  "Does it tell a parent or store that a value changed? Do it where the change happens. " +
  "Does it load app data? Read it from an atom. " +
  "Does it read a value from outside React? Use an atom or useSyncExternalStore. " +
  "An effect that sets state another effect reads is one handler or one derivation. " +
  "An effect is right only when it keeps something outside React in step with this component while mounted: " +
  "a DOM node, listener, timer, native module, connection, router, imperative toast, " +
  "or a registry entry or resource held until unmount. " +
  "Moving the same logic into a ref or store to dodge this rule is not a fix. " +
  "If the effect does that, name what it keeps in step on the line above: " +
  "`// oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <what it syncs with and why>`.";

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
          message: MESSAGE,
        });
      },
    };
  },
});
