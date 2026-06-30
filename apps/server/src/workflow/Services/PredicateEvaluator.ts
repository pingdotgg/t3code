import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface PredicateEvaluation {
  readonly result: boolean;
  readonly matchedPaths: ReadonlyArray<string>;
}

export class PredicateEvaluationError extends Schema.TaggedErrorClass<PredicateEvaluationError>()(
  "PredicateEvaluationError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface PredicateEvaluatorShape {
  readonly evaluate: (
    rule: unknown,
    context: unknown,
  ) => Effect.Effect<PredicateEvaluation, PredicateEvaluationError>;
}

export class PredicateEvaluator extends Context.Service<
  PredicateEvaluator,
  PredicateEvaluatorShape
>()("t3/workflow/Services/PredicateEvaluator") {}
