import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import budget from "../../scripts/effect-budget.json" with { type: "json" };
import { getPropertyName, unwrapExpression } from "../utils.ts";

const BUDGET_FILE = "scripts/effect-budget.json";
const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
const EFFECT_HOOK_TEXT = /use(?:Layout|Insertion)?Effect/;
const UNBUDGETED_FILE = /\.test\.[cm]?[jt]sx?$|[\\/](?:test|__tests__)[\\/]/;
const budgets: Readonly<Record<string, number>> = budget;

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

// Budget keys are repo-relative; matching on the path's end also works for files linted elsewhere.
const budgetFor = (filename: string): number => {
  const normalized = filename.replaceAll("\\", "/");
  const key = Object.keys(budgets).find((file) => normalized.endsWith(`/${file}`));
  return key === undefined ? 0 : budgets[key]!;
};

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: `Hold each file to the React effect hooks it is allowed in ${BUDGET_FILE}; a missing entry allows none.`,
    },
  },
  create(context) {
    if (UNBUDGETED_FILE.test(context.filename) || !EFFECT_HOOK_TEXT.test(context.sourceCode.text)) {
      return {};
    }
    const calls: Array<ESTree.CallExpression> = [];
    return {
      CallExpression(node) {
        if (isEffectHookCall(node)) calls.push(node);
      },
      "Program:exit"() {
        const allowed = budgetFor(context.filename);
        if (calls.length <= allowed) return;
        const message =
          `This file has ${calls.length} React ${calls.length === 1 ? "effect" : "effects"} against a budget of ${allowed}. ` +
          "Prefer deriving in render, event handlers, a `key` reset, an element-owned ref callback, or a store. " +
          `If an effect is genuinely right, raise this file's entry in ${BUDGET_FILE} in the same PR.`;
        for (const node of calls.slice(allowed)) context.report({ node, message });
      },
    };
  },
});
