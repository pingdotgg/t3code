import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * Fixture workflow used by `Workflow.test.ts`.
 *
 * Exercises:
 *  - `Cloudflare.Workflows.task` durable steps with retry config and step context
 *  - `Cloudflare.Workflows.sleep` between steps
 *  - `Cloudflare.Workflows.waitForEvent` external event delivery
 *  - `Cloudflare.Workers.WorkerEnvironment` access from inside the body — regression
 *    guard for https://github.com/alchemy-run/alchemy/pull/71
 */
export default class TestWorkflow extends Cloudflare.Workflow<TestWorkflow>()(
  "TestWorkflow",
  Effect.gen(function* () {
    return Effect.fn(function* (input: { value: string; wait?: boolean }) {
      const env = yield* Cloudflare.Workers.WorkerEnvironment;
      const event = yield* Cloudflare.Workflows.WorkflowEvent;

      const greeted = yield* Cloudflare.Workflows.task(
        "greet",
        Effect.gen(function* () {
          const context = yield* Cloudflare.Workflows.WorkflowStepContext;
          return {
            text: `Hello, ${input.value}!`,
            attempt: context.attempt,
          };
        }),
        {
          retries: { limit: 3, delay: "1 second", backoff: "linear" },
          timeout: "1 minute",
        },
      );

      if (input.wait) {
        const external = yield* Cloudflare.Workflows.waitForEvent<{
          message: string;
        }>("external-event", { type: "test-event", timeout: "5 minutes" });

        return {
          greeting: external.payload.message,
          envBindingCount: Object.keys(env).length,
          workflowName: event.workflowName,
          stepAttempt: greeted.attempt,
          instanceId: event.instanceId,
        };
      }

      yield* Cloudflare.Workflows.sleep("cooldown", "1 second");

      const finalized = yield* Cloudflare.Workflows.task(
        "finalize",
        Effect.succeed({
          greeting: greeted.text,
          envBindingCount: Object.keys(env).length,
          workflowName: event.workflowName,
          stepAttempt: greeted.attempt,
          instanceId: event.instanceId,
        }),
        {
          rollback: () => Effect.void,
          rollbackConfig: { retries: { limit: 1, delay: "1 second" } },
        },
      );

      return finalized;
    });
  }),
) {}
