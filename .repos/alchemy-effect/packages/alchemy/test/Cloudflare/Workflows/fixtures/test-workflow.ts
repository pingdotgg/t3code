import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * Fixture workflow used by `Workflow.local.test.ts`.
 *
 * Minimal durable body: one named `task`, a short `sleep`, and event
 * metadata in the result — enough to prove the workflow engine (local
 * workerd emulation or real Cloudflare) actually ran the instance.
 */
export default class LocalTestWorkflow extends Cloudflare.Workflow<LocalTestWorkflow>()(
  "LocalTestWorkflow",
  Effect.gen(function* () {
    return Effect.fn(function* (input: { value: string }) {
      const event = yield* Cloudflare.Workflows.WorkflowEvent;

      const greeted = yield* Cloudflare.Workflows.task(
        "greet",
        Effect.succeed({ text: `Hello, ${input.value}!` }),
      );

      yield* Cloudflare.Workflows.sleep("cooldown", "1 second");

      return {
        greeting: greeted.text,
        workflowName: event.workflowName,
        instanceId: event.instanceId,
      };
    });
  }),
) {}
