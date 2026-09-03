import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const EFFECT_RUNTIME_METHODS = new Set([
  "runCallback",
  "runCallbackWith",
  "runFork",
  "runForkWith",
  "runPromise",
  "runPromiseExit",
  "runPromiseExitWith",
  "runPromiseWith",
  "runSync",
  "runSyncExit",
  "runSyncExitWith",
  "runSyncWith",
]);

// Existing manual runners are tracked as debt through the `maxOccurrences`
// option, set per file in the lint config. The rule permits no net-new
// occurrences in those files, while every other test file must have zero.
const readMaxOccurrences = (options: ReadonlyArray<unknown>): number => {
  const [first] = options;
  return typeof first === "object" &&
    first !== null &&
    "maxOccurrences" in first &&
    typeof first.maxOccurrences === "number"
    ? first.maxOccurrences
    : 0;
};

const manualRunnerName = (callee: unknown): Option.Option<string> => {
  const expression = unwrapExpression(callee);
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") {
    return Option.none();
  }

  const object = unwrapExpression(expression.value.object);
  const property = getPropertyName(expression.value.property);
  if (Option.isNone(property)) return Option.none();

  if (isIdentifier(object, "Effect") && EFFECT_RUNTIME_METHODS.has(property.value)) {
    return Option.some(`Effect.${property.value}`);
  }

  if (isIdentifier(object, "ManagedRuntime") && property.value === "make") {
    return Option.some("ManagedRuntime.make");
  }

  return Option.none();
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow manually creating or running Effect runtimes in tests; use @effect/vitest.",
    },
    schema: [
      {
        type: "object",
        properties: {
          maxOccurrences: {
            type: "integer",
            minimum: 0,
            description:
              "Legacy debt ceiling for this file: occurrences beyond this count are reported.",
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ maxOccurrences: 0 }],
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};

    const allowedCount = readMaxOccurrences(context.options);
    let occurrenceCount = 0;

    return {
      CallExpression(node) {
        const runner = manualRunnerName(node.callee);
        if (Option.isNone(runner)) return;

        occurrenceCount++;
        if (occurrenceCount <= allowedCount) return;

        context.report({
          node: node.callee,
          message: `Do not use ${runner.value} in tests. Use @effect/vitest with it.effect(...) and test layers instead.`,
        });
      },
    };
  },
});
