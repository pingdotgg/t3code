import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PredicateEvaluationError, PredicateEvaluator } from "../Services/PredicateEvaluator.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";

const layer = it.layer(PredicateEvaluatorLive);

layer("PredicateEvaluator", (it) => {
  it.effect("evaluates allowlisted JSONLogic and reports referenced paths", () =>
    Effect.gen(function* () {
      const evaluator = yield* PredicateEvaluator;
      const evaluation = yield* evaluator.evaluate(
        {
          and: [
            { "==": [{ var: "steps.tests.exitCode" }, 0] },
            { in: ["pass", { var: "steps.review.output.verdict" }] },
            { "!=": [{ var: "pipeline.result" }, "failure"] },
            { "!": { var: "steps.review.output.blocked" } },
          ],
        },
        {
          pipeline: { result: "success" },
          status: "running",
          steps: {
            tests: { exitCode: 0, status: "completed" },
            review: { status: "completed", output: { verdict: "pass", blocked: false } },
          },
        },
      );

      assert.equal(evaluation.result, true);
      assert.deepEqual(evaluation.matchedPaths, [
        "steps.tests.exitCode",
        "steps.review.output.verdict",
        "pipeline.result",
        "steps.review.output.blocked",
      ]);
    }),
  );

  it.effect("rejects unsupported operators before evaluation", () =>
    Effect.gen(function* () {
      const evaluator = yield* PredicateEvaluator;
      const result = yield* Effect.exit(evaluator.evaluate({ cat: ["x", "y"] }, {}));

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.isTrue(
          result.cause.toString().includes(PredicateEvaluationError.name) ||
            result.cause.toString().includes("unsupported JSONLogic operator"),
        );
      }
    }),
  );

  it.effect("rejects var defaults and non-string var paths", () =>
    Effect.gen(function* () {
      const evaluator = yield* PredicateEvaluator;
      const withDefault = yield* Effect.exit(
        evaluator.evaluate({ "==": [{ var: ["status", "idle"] }, "idle"] }, {}),
      );
      const nonString = yield* Effect.exit(evaluator.evaluate({ var: 123 }, {}));

      assert.equal(withDefault._tag, "Failure");
      assert.equal(nonString._tag, "Failure");
    }),
  );
});
