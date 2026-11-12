import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
// node:test has no `.each`, so files written against it keep their loops.
const NODE_TEST_IMPORT_PATTERN = /["']node:test["']/u;
const TEST_FUNCTIONS = new Set(["describe", "it", "suite", "test"]);
const EACH_CAPABLE_MODIFIERS = new Set(["effect", "live"]);
const LOOPS = new Set(["ForStatement", "ForInStatement", "ForOfStatement"]);
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"]);

const testCallName = (callee: unknown): Option.Option<string> => {
  const expression = unwrapExpression(callee);
  if (Option.isNone(expression)) return Option.none();

  if (expression.value.type === "Identifier") {
    return TEST_FUNCTIONS.has(expression.value.name)
      ? Option.some(expression.value.name)
      : Option.none();
  }

  if (expression.value.type !== "MemberExpression") return Option.none();
  const object = unwrapExpression(expression.value.object);
  const property = getPropertyName(expression.value.property);
  if (Option.isNone(object) || Option.isNone(property)) return Option.none();
  if (!EACH_CAPABLE_MODIFIERS.has(property.value)) return Option.none();
  if (object.value.type !== "Identifier" || !TEST_FUNCTIONS.has(object.value.name)) {
    return Option.none();
  }
  return Option.some(`${object.value.name}.${property.value}`);
};

const isInsideLoop = (node: ESTree.Node): boolean => {
  let current = node.parent;
  while (current) {
    if (LOOPS.has(current.type)) return true;
    if (FUNCTIONS.has(current.type)) return false;
    current = current.parent;
  }
  return false;
};

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow declaring tests inside a for loop; use it.each / it.effect.each / describe.each instead.",
    },
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};
    if (NODE_TEST_IMPORT_PATTERN.test(context.sourceCode.text)) return {};

    return {
      CallExpression(node) {
        const name = testCallName(node.callee);
        if (Option.isNone(name)) return;
        if (!isInsideLoop(node)) return;

        context.report({
          node: node.callee,
          message: `Do not call ${name.value}(…) inside a for loop. Use ${name.value}.each(cases)(name, …) instead.`,
        });
      },
    };
  },
});
