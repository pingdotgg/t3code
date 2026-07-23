import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * Fixture workflow used by `Workflow.test.ts`.
 *
 * Exercises:
 *  - `Cloudflare.task` durable steps (greet + finalize)
 *  - `Cloudflare.sleep` between steps
 *  - `Cloudflare.WorkerEnvironment` access from inside the body — regression
 *    guard for https://github.com/alchemy-run/alchemy-effect/pull/71
 */
export default class TestWorkflow extends Cloudflare.Workflow<TestWorkflow>()(
  "TestWorkflow",
  Effect.gen(function* () {
    return Effect.fn(function* (input: { value: string }) {
      console.log("greeted");
      const env = yield* Cloudflare.WorkerEnvironment;

      const greeted = yield* Cloudflare.task(
        "greet",
        Effect.succeed(`Hello, ${input.value}!`),
      );

      yield* Cloudflare.sleep("cooldown", "1 second");

      const finalized = yield* Cloudflare.task(
        "finalize",
        Effect.succeed({
          greeting: greeted,
          envBindingCount: Object.keys(env).length,
        }),
      );

      return finalized;
    });
  }),
) {}
