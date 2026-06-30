import * as NodeModule from "node:module";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  PredicateEvaluationError,
  PredicateEvaluator,
  type PredicateEvaluatorShape,
} from "../Services/PredicateEvaluator.ts";
import { inspectJsonLogicRule } from "../jsonLogicRule.ts";

interface JsonLogicModule {
  readonly apply: (rule: unknown, data?: unknown) => unknown;
  readonly truthy: (value: unknown) => boolean;
}

const require = NodeModule.createRequire(import.meta.url);
const jsonLogic = require("json-logic-js") as JsonLogicModule;
const isPredicateEvaluationError = Schema.is(PredicateEvaluationError);

const makePredicateError = (message: string, cause?: unknown) =>
  new PredicateEvaluationError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const evaluateRule = (rule: unknown, context: unknown) =>
  Effect.try({
    try: () => {
      const inspection = inspectJsonLogicRule(rule);
      const issue = inspection.issues[0];
      if (issue !== undefined) {
        throw makePredicateError(issue.message);
      }
      const raw = jsonLogic.apply(rule, context);
      return {
        result: jsonLogic.truthy(raw),
        matchedPaths: inspection.variablePaths,
      };
    },
    catch: (cause) =>
      isPredicateEvaluationError(cause)
        ? cause
        : makePredicateError("JSONLogic evaluation failed", cause),
  });

const make = Effect.succeed({
  evaluate: evaluateRule,
} satisfies PredicateEvaluatorShape);

export const PredicateEvaluatorLive = Layer.effect(PredicateEvaluator, make);
