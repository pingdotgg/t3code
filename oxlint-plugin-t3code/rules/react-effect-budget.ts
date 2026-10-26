import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import budget from "../../scripts/effect-budget.json" with { type: "json" };
import { getPropertyName, unwrapExpression } from "../utils.ts";

const BUDGET_FILE = "scripts/effect-budget.json";
const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
const EFFECT_HOOK_TEXT = /use(?:Layout|Insertion)?Effect/;
const UNBUDGETED_FILE = /\.test\.[cm]?[jt]sx?$|[\\/](?:test|__tests__)[\\/]/;
const budgets: Readonly<Record<string, number>> = budget;
const JUSTIFIED = /oxlint-disable-next-line[^\n]*t3code\/react-effect-budget\s+--\s*\S/;

// An effect with a stated reason on the line above is a reviewed decision: it is not counted, and it
// is always reported so that the suppression comment above it is used.
const isJustified = (lines: ReadonlyArray<string>, line: number): boolean =>
  JUSTIFIED.test(lines[line - 2] ?? "");

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
    const lines = context.sourceCode.text.split("\n");
    const calls: Array<ESTree.CallExpression> = [];
    const justified: Array<ESTree.CallExpression> = [];
    return {
      CallExpression(node) {
        if (!isEffectHookCall(node)) return;
        (isJustified(lines, node.loc.start.line) ? justified : calls).push(node);
      },
      "Program:exit"() {
        for (const node of justified) {
          context.report({ node, message: "A React effect with a stated reason." });
        }
        const allowed = budgetFor(context.filename);
        if (calls.length <= allowed) return;
        const message =
          `This file has ${calls.length} React ${calls.length === 1 ? "effect" : "effects"} against a budget of ${allowed}. ` +
          "First ask whether this is synchronization that belongs in render or in the handler that causes it. " +
          "If an effect is the honest model, say why on the line above it: " +
          "`// oxlint-disable-next-line t3code/react-effect-budget -- <why>`.";
        for (const node of calls.slice(allowed)) context.report({ node, message });
      },
    };
  },
});
